const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");

const BACKEND_DIR = path.resolve(__dirname, "..");

test("backend exposes Discord, AI, proxy, account, chat, and save surfaces", async (t) => {
  const port = await getOpenPort();
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "antarctic-backend-surface-"));
  const configPath = path.join(tempDir, "palladium.env");

  await fsp.writeFile(
    configPath,
    [
      "SITE_HOST=127.0.0.1",
      `SITE_PORT=${port}`,
      "CORS_ORIGIN=*",
      "OLLAMA_AUTOSTART=false",
      "DISCORD_BOTS_AUTOSTART=false",
      "GIT_AUTO_PULL_ENABLED=false"
    ].join("\n") + "\n",
    "utf8"
  );

  const { child, output } = startBackend(configPath);

  t.after(async () => {
    await stopBackend(child);
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  const backendBase = `http://127.0.0.1:${port}`;
  await waitForServer(`${backendBase}/health`, output);

  const healthResponse = await fetch(`${backendBase}/health`);
  assert.equal(healthResponse.status, 200);

  const health = await healthResponse.json();
  assert.equal(health.ok, true);
  assert.equal(health.service, "antarctic-backend");
  assert.deepEqual(health.features, [
    "api/proxy/fetch",
    "wisp",
    "api/ai/chat",
    "api/discord/widget",
    "link-check",
    "api/account/session",
    "api/community/bootstrap",
    "api/chat/threads",
    "api/saves"
  ]);

  const legacyRoutes = [
    "/",
    "/api/games",
    "/api/games/trending",
    "/api/games/play",
    "/api/categories",
    "/games/bullet-hell/brotato.html",
    "/swf/chibi-knight.swf",
    "/images/game-img/brotato.jpeg"
  ];

  for (const route of legacyRoutes) {
    const response = await fetch(`${backendBase}${route}`);
    assert.equal(response.status, 404, `Expected ${route} to stay removed`);
  }
});

test("backend can optionally serve a separate static frontend checkout", async (t) => {
  const port = await getOpenPort();
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "antarctic-backend-frontend-"));
  const frontendDir = path.join(tempDir, "Antarctic-Frontend");
  const configPath = path.join(tempDir, "palladium.env");

  await fsp.mkdir(path.join(frontendDir, "assets"), { recursive: true });
  await fsp.writeFile(path.join(frontendDir, "index.html"), "<!doctype html><title>Antarctic</title><div id=\"app\">shell</div>\n", "utf8");
  await fsp.writeFile(path.join(frontendDir, "styles.css"), "body{background:#001122;}\n", "utf8");
  await fsp.writeFile(path.join(frontendDir, "sw.js"), "self.addEventListener('fetch',()=>{});\n", "utf8");
  await fsp.writeFile(path.join(frontendDir, "assets", "logo.txt"), "antarctic\n", "utf8");

  await fsp.writeFile(
    configPath,
    [
      "SITE_HOST=127.0.0.1",
      `SITE_PORT=${port}`,
      "CORS_ORIGIN=*",
      "OLLAMA_AUTOSTART=false",
      "DISCORD_BOTS_AUTOSTART=false",
      "GIT_AUTO_PULL_ENABLED=false",
      `FRONTEND_STATIC_DIR=${frontendDir}`
    ].join("\n") + "\n",
    "utf8"
  );

  const { child, output } = startBackend(configPath);

  t.after(async () => {
    await stopBackend(child);
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  const backendBase = `http://127.0.0.1:${port}`;
  await waitForServer(`${backendBase}/health`, output);

  const shellResponse = await fetch(`${backendBase}/`);
  assert.equal(shellResponse.status, 200);
  assert.match(shellResponse.headers.get("content-type") || "", /text\/html/);
  assert.match(await shellResponse.text(), /<div id="app">shell<\/div>/);

  const cssResponse = await fetch(`${backendBase}/styles.css`);
  assert.equal(cssResponse.status, 200);
  assert.match(cssResponse.headers.get("content-type") || "", /text\/css/);
  assert.match(await cssResponse.text(), /background:#001122/);
  assert.equal(cssResponse.headers.get("cache-control"), "no-cache");

  const serviceWorkerResponse = await fetch(`${backendBase}/sw.js`);
  assert.equal(serviceWorkerResponse.status, 200);
  assert.match(serviceWorkerResponse.headers.get("content-type") || "", /text\/javascript/);
  assert.equal(serviceWorkerResponse.headers.get("cache-control"), "no-cache");

  const assetResponse = await fetch(`${backendBase}/assets/logo.txt`);
  assert.equal(assetResponse.status, 200);
  assert.equal(await assetResponse.text(), "antarctic\n");

  const shellFallbackResponse = await fetch(`${backendBase}/settings`);
  assert.equal(shellFallbackResponse.status, 200);
  assert.match(shellFallbackResponse.headers.get("content-type") || "", /text\/html/);

  const traversalResponse = await fetch(`${backendBase}/%2e%2e/%2e%2e/package.json`);
  assert.equal(traversalResponse.status, 404);
});

function startBackend(configPath) {
  const child = spawn(process.execPath, ["apps.js"], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      PALLADIUM_CONFIG: configPath
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const output = [];
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  return { child, output };
}

async function stopBackend(child) {
  if (child.exitCode === null && !child.killed) {
    child.kill("SIGTERM");
    await waitForExit(child, 2000).catch(() => {
      child.kill("SIGKILL");
    });
  }
}

async function getOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
    server.once("error", reject);
  });
}

async function waitForServer(url, output) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the process is ready.
    }
    await sleep(200);
  }

  throw new Error(`Backend server did not start in time.\n${output.join("")}`);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return;

  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(timeoutMs).then(() => {
      throw new Error("Timed out waiting for backend process to exit.");
    })
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

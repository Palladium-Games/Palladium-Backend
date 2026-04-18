const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const { spawn } = require("node:child_process");

const BACKEND_DIR = path.resolve(__dirname, "..");

test("backend reports that built-in web browsing is ready over the fallback proxy contract", async (t) => {
  const port = await getOpenPort();
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "antarctic-proxy-config-"));
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

  t.after(async () => {
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
      await waitForExit(child, 2000).catch(() => {
        child.kill("SIGKILL");
      });
    }
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  const backendBase = `http://127.0.0.1:${port}`;
  await waitForServer(`${backendBase}/health`, output);

  const proxyHealthResponse = await fetch(`${backendBase}/api/proxy/health`);
  assert.equal(proxyHealthResponse.status, 200);

  const proxyHealth = await proxyHealthResponse.json();
  assert.equal(proxyHealth.ok, true);
  assert.equal(proxyHealth.service, "backend");
  assert.equal(proxyHealth.transport, "http-fallback");
  assert.equal(proxyHealth.message, "Built-in web browsing is ready.");
  assert.equal(proxyHealth.proxyFetch, "/api/proxy/fetch");
  assert.equal(proxyHealth.proxyRequest, "/api/proxy/request");
  assert.equal(proxyHealth.wispUrl, `ws://127.0.0.1:${port}/wisp/`);

  const configResponse = await fetch(`${backendBase}/api/config/public`);
  assert.equal(configResponse.status, 200);

  const payload = await configResponse.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.backendBase, backendBase);
  assert.equal(payload.services.proxyBase, backendBase);
  assert.equal(payload.services.proxyMode, "http-fallback");
  assert.equal(payload.services.proxyTransport, "http-fallback");
  assert.equal(payload.services.wispPath, "/wisp/");
  assert.equal(payload.services.wispUrl, `ws://127.0.0.1:${port}/wisp/`);
  assert.equal(payload.services.proxy, "/api/proxy/fetch");
  assert.equal(payload.services.proxyFetch, "/api/proxy/fetch");
  assert.equal(payload.services.proxyRequest, "/api/proxy/request");
  assert.equal(payload.services.aiChat, "/api/ai/chat");
  assert.equal(payload.services.accountSession, "/api/account/session");
  assert.equal(payload.services.communityBootstrap, "/api/community/bootstrap");
  assert.equal(payload.services.chatThreads, "/api/chat/threads");
  assert.equal(payload.services.saves, "/api/saves");
  assert.equal(payload.services.defaultAiModel, "qwen3.5:0.8b");
  assert.ok(!("assetBase" in payload.services));
  assert.ok(!("gamesBase" in payload.services));
  assert.ok(!("monochromeBase" in payload.services));
  assert.equal(payload.discord.inviteUrl, "https://discord.gg/FNACSCcE26");
  assert.equal(payload.discord.widgetUrl, "https://discord.com/api/guilds/1479914434460913707/widget.json");
});

test("backend forwards arbitrary upstream requests through proxy request bridge", async (t) => {
  const port = await getOpenPort();
  const upstreamPort = await getOpenPort();
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "antarctic-proxy-request-"));
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

  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf8");

    res.writeHead(207, {
      "content-type": "application/json; charset=utf-8",
      "x-upstream-method": req.method,
      "x-upstream-header-accept": req.headers.accept || "",
      "x-upstream-header-content-type": req.headers["content-type"] || ""
    });
    res.end(
      JSON.stringify({
        method: req.method,
        url: req.url,
        headerValue: req.headers["x-test-header"] || "",
        body
      })
    );
  });

  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(upstreamPort, "127.0.0.1", resolve);
  });

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

  t.after(async () => {
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
      await waitForExit(child, 2000).catch(() => {
        child.kill("SIGKILL");
      });
    }
    await new Promise((resolve) => upstream.close(resolve));
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  const backendBase = `http://127.0.0.1:${port}`;
  await waitForServer(`${backendBase}/health`, output);

  const proxyResponse = await fetch(
    `${backendBase}/api/proxy/request?url=${encodeURIComponent(`http://127.0.0.1:${upstreamPort}/echo?via=proxy`)}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-antarctic-proxy-method": "POST",
        "x-antarctic-proxy-headers": JSON.stringify({
          "x-test-header": "hello",
          accept: "application/json",
          "content-type": "text/plain"
        })
      },
      body: "payload=antarctic"
    }
  );

  assert.equal(proxyResponse.status, 207);
  assert.equal(proxyResponse.headers.get("x-upstream-method"), "POST");
  assert.equal(proxyResponse.headers.get("x-upstream-header-accept"), "application/json");
  assert.equal(proxyResponse.headers.get("x-upstream-header-content-type"), "text/plain");
  assert.equal(proxyResponse.headers.get("x-antarctic-proxy-status-text"), "Multi-Status");
  assert.match(proxyResponse.headers.get("x-antarctic-final-url") || "", new RegExp(`127\\.0\\.0\\.1:${upstreamPort}`));

  const payload = await proxyResponse.json();
  assert.equal(payload.method, "POST");
  assert.equal(payload.headerValue, "hello");
  assert.equal(payload.body, "payload=antarctic");
  assert.equal(payload.url, "/echo?via=proxy");
});

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

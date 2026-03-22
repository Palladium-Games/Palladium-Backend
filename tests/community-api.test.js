const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");

const BACKEND_DIR = path.resolve(__dirname, "..");

test("backend serves account auth, chat, and cloud save endpoints on top of sqlite", async (t) => {
  const port = await getOpenPort();
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "antarctic-community-api-"));
  const configPath = path.join(tempDir, "palladium.env");
  const dbPath = path.join(tempDir, "community.sqlite");

  await fsp.writeFile(
    configPath,
    [
      "SITE_HOST=127.0.0.1",
      `SITE_PORT=${port}`,
      "CORS_ORIGIN=*",
      "OLLAMA_AUTOSTART=false",
      "DISCORD_BOTS_AUTOSTART=false",
      "GIT_AUTO_PULL_ENABLED=false",
      `ACCOUNT_SQLITE_PATH=${dbPath}`,
      "ACCOUNT_SESSION_TTL_DAYS=30"
    ].join("\n") + "\n",
    "utf8"
  );

  const { child, output } = startBackend(configPath);

  t.after(async () => {
    await stopBackend(child);
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/health`, output);

  const signup = await fetchJson(`${base}/api/account/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "snowfox", password: "icepass123" })
  });
  assert.equal(signup.status, 201);
  assert.equal(signup.body.ok, true);
  assert.equal(signup.body.user.username, "snowfox");

  const token = signup.body.token;
  const authHeaders = { "x-antarctic-session": token, "content-type": "application/json" };

  const session = await fetchJson(`${base}/api/account/session`, { headers: authHeaders });
  assert.equal(session.status, 200);
  assert.equal(session.body.authenticated, true);
  assert.equal(session.body.user.username, "snowfox");

  const room = await fetchJson(`${base}/api/chat/rooms`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "Late Night Games" })
  });
  assert.equal(room.status, 201);
  assert.equal(room.body.thread.name, "Late Night Games");

  const message = await fetchJson(`${base}/api/chat/threads/${room.body.thread.id}/messages`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ content: "hello antarctic" })
  });
  assert.equal(message.status, 201);
  assert.equal(message.body.message.content, "hello antarctic");

  const threads = await fetchJson(`${base}/api/chat/threads`, { headers: authHeaders });
  assert.equal(threads.status, 200);
  assert.ok(Array.isArray(threads.body.threads));
  assert.ok(threads.body.threads.some((thread) => thread.name === "Late Night Games"));

  const saveResponse = await fetchJson(`${base}/api/saves/${encodeURIComponent("games/platformer/ovo.html")}`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({
      summary: "OvO cloud",
      data: {
        localStorage: {
          ovo: "42"
        }
      }
    })
  });
  assert.equal(saveResponse.status, 200);
  assert.equal(saveResponse.body.save.summary, "OvO cloud");

  const saves = await fetchJson(`${base}/api/saves`, { headers: authHeaders });
  assert.equal(saves.status, 200);
  assert.equal(saves.body.saves.length, 1);
  assert.equal(saves.body.saves[0].gameKey, "games/platformer/ovo.html");

  const loadedSave = await fetchJson(`${base}/api/saves/${encodeURIComponent("games/platformer/ovo.html")}`, {
    headers: authHeaders
  });
  assert.equal(loadedSave.status, 200);
  assert.deepEqual(loadedSave.body.save.data, {
    localStorage: {
      ovo: "42"
    }
  });
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
    await waitForExit(child, 3000).catch(() => {
      child.kill("SIGKILL");
    });
  }
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : {}
  };
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

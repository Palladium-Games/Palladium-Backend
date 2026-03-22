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
  assert.equal(signup.body.authenticated, true);
  assert.equal(signup.body.user.username, "snowfox");
  assert.equal(signup.body.bootstrap.stats.threadCount, 1);
  assert.equal(signup.body.bootstrap.stats.roomCount, 1);
  assert.equal(signup.body.bootstrap.stats.directCount, 0);
  assert.equal(signup.body.bootstrap.stats.incomingDirectRequestCount, 0);
  assert.equal(signup.body.bootstrap.stats.saveCount, 0);

  const token = signup.body.token;
  const authHeaders = { "x-antarctic-session": token, "content-type": "application/json" };

  const session = await fetchJson(`${base}/api/account/session`, { headers: authHeaders });
  assert.equal(session.status, 200);
  assert.equal(session.body.authenticated, true);
  assert.equal(session.body.user.username, "snowfox");
  assert.equal(session.body.bootstrap.stats.threadCount, 1);

  const secondSignup = await fetchJson(`${base}/api/account/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "blizzard", password: "windpass123" })
  });
  assert.equal(secondSignup.status, 201);
  assert.equal(secondSignup.body.user.username, "blizzard");
  const secondToken = secondSignup.body.token;
  const secondAuthHeaders = { "x-antarctic-session": secondToken, "content-type": "application/json" };

  const thirdSignup = await fetchJson(`${base}/api/account/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "aurora", password: "polarpass123" })
  });
  assert.equal(thirdSignup.status, 201);
  const thirdToken = thirdSignup.body.token;
  const thirdAuthHeaders = { "x-antarctic-session": thirdToken, "content-type": "application/json" };

  const room = await fetchJson(`${base}/api/chat/rooms`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ name: "Late Night Games" })
  });
  assert.equal(room.status, 201);
  assert.equal(room.body.thread.name, "Late Night Games");

  const leaveRoom = await fetchJson(`${base}/api/chat/threads/${room.body.thread.id}/leave`, {
    method: "POST",
    headers: authHeaders
  });
  assert.equal(leaveRoom.status, 200);
  assert.equal(leaveRoom.body.leftThreadId, room.body.thread.id);
  assert.equal(leaveRoom.body.threads.some((thread) => thread.id === room.body.thread.id), false);

  const rejoinRoom = await fetchJson(`${base}/api/chat/threads/${room.body.thread.id}/join`, {
    method: "POST",
    headers: authHeaders
  });
  assert.equal(rejoinRoom.status, 200);

  const direct = await fetchJson(`${base}/api/chat/dms`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ username: "blizzard" })
  });
  assert.equal(direct.status, 201);
  assert.equal(direct.body.kind, "request");
  assert.equal(direct.body.request.target.username, "blizzard");

  const secondBootstrap = await fetchJson(`${base}/api/community/bootstrap`, { headers: secondAuthHeaders });
  assert.equal(secondBootstrap.status, 200);
  assert.equal(secondBootstrap.body.bootstrap.incomingDirectRequests.length, 1);
  assert.equal(secondBootstrap.body.bootstrap.stats.incomingDirectRequestCount, 1);

  const acceptDirect = await fetchJson(
    `${base}/api/chat/dms/${secondBootstrap.body.bootstrap.incomingDirectRequests[0].id}/accept`,
    {
      method: "POST",
      headers: secondAuthHeaders
    }
  );
  assert.equal(acceptDirect.status, 200);
  assert.equal(acceptDirect.body.kind, "thread");
  assert.equal(acceptDirect.body.thread.type, "direct");
  assert.equal(acceptDirect.body.thread.peer.username, "snowfox");

  const deniedDirect = await fetchJson(`${base}/api/chat/dms`, {
    method: "POST",
    headers: thirdAuthHeaders,
    body: JSON.stringify({ username: "snowfox" })
  });
  assert.equal(deniedDirect.status, 201);
  assert.equal(deniedDirect.body.kind, "request");

  const incomingForSnowfox = await fetchJson(`${base}/api/community/bootstrap`, { headers: authHeaders });
  assert.equal(incomingForSnowfox.status, 200);
  assert.equal(incomingForSnowfox.body.bootstrap.incomingDirectRequests.length, 1);

  const denyDirect = await fetchJson(
    `${base}/api/chat/dms/${incomingForSnowfox.body.bootstrap.incomingDirectRequests[0].id}/deny`,
    {
      method: "POST",
      headers: authHeaders
    }
  );
  assert.equal(denyDirect.status, 200);
  assert.equal(denyDirect.body.kind, "request");
  assert.equal(denyDirect.body.request.status, "denied");

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
  assert.ok(threads.body.threads.some((thread) => thread.type === "direct"));
  assert.ok(Array.isArray(threads.body.incomingDirectRequests));

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

  const bootstrap = await fetchJson(`${base}/api/community/bootstrap`, { headers: authHeaders });
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.body.authenticated, true);
  assert.equal(bootstrap.body.user.username, "snowfox");
  assert.equal(bootstrap.body.bootstrap.stats.threadCount, 3);
  assert.equal(bootstrap.body.bootstrap.stats.roomCount, 2);
  assert.equal(bootstrap.body.bootstrap.stats.joinedRoomCount, 2);
  assert.equal(bootstrap.body.bootstrap.stats.directCount, 1);
  assert.equal(bootstrap.body.bootstrap.stats.incomingDirectRequestCount, 0);
  assert.equal(bootstrap.body.bootstrap.stats.saveCount, 1);
  assert.equal(bootstrap.body.bootstrap.saves[0].gameKey, "games/platformer/ovo.html");
  assert.equal(bootstrap.body.bootstrap.incomingDirectRequests.length, 0);
});

test("backend supports private-room invites, Antarctic invite DMs, and chat automod", async (t) => {
  const port = await getOpenPort();
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "antarctic-community-private-api-"));
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

  const ownerSignup = await fetchJson(`${base}/api/account/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "icepass123" })
  });
  const guestSignup = await fetchJson(`${base}/api/account/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "guest", password: "windpass123" })
  });
  const outsiderSignup = await fetchJson(`${base}/api/account/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "outsider", password: "polarpass123" })
  });

  const ownerHeaders = { "x-antarctic-session": ownerSignup.body.token, "content-type": "application/json" };
  const guestHeaders = { "x-antarctic-session": guestSignup.body.token, "content-type": "application/json" };
  const outsiderHeaders = { "x-antarctic-session": outsiderSignup.body.token, "content-type": "application/json" };

  const privateRoom = await fetchJson(`${base}/api/chat/rooms`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({
      name: "Secret Ops",
      visibility: "private",
      invitedUsers: ["guest"]
    })
  });
  assert.equal(privateRoom.status, 201);
  assert.equal(privateRoom.body.thread.visibility, "private");

  const guestThreads = await fetchJson(`${base}/api/chat/threads`, { headers: guestHeaders });
  assert.equal(guestThreads.status, 200);
  const invitedRoom = guestThreads.body.rooms.find((room) => room.name === "Secret Ops");
  assert.ok(invitedRoom);
  assert.equal(invitedRoom.invited, true);
  assert.equal(invitedRoom.joinable, true);
  const antarcticThread = guestThreads.body.threads.find((thread) => thread.type === "direct" && thread.peer && thread.peer.username === "antarctic");
  assert.ok(antarcticThread);

  const antarcticMessages = await fetchJson(`${base}/api/chat/threads/${antarcticThread.id}/messages`, { headers: guestHeaders });
  assert.equal(antarcticMessages.status, 200);
  assert.ok(antarcticMessages.body.messages.some((message) => message.content.includes("Secret Ops")));

  const outsiderJoin = await fetchJson(`${base}/api/chat/threads/${privateRoom.body.thread.id}/join`, {
    method: "POST",
    headers: outsiderHeaders
  });
  assert.equal(outsiderJoin.status, 404);
  assert.match(String(outsiderJoin.body.error || ""), /invite-only/i);

  const outsiderThreads = await fetchJson(`${base}/api/chat/threads`, { headers: outsiderHeaders });
  assert.equal(outsiderThreads.status, 200);
  assert.equal(outsiderThreads.body.rooms.some((room) => room.name === "Secret Ops"), false);

  const guestJoin = await fetchJson(`${base}/api/chat/threads/${privateRoom.body.thread.id}/join`, {
    method: "POST",
    headers: guestHeaders
  });
  assert.equal(guestJoin.status, 200);
  assert.equal(guestJoin.body.thread.visibility, "private");

  const automod = await fetchJson(`${base}/api/chat/threads/${privateRoom.body.thread.id}/messages`, {
    method: "POST",
    headers: guestHeaders,
    body: JSON.stringify({ content: "shit this room is loud" })
  });
  assert.equal(automod.status, 400);
  assert.match(String(automod.body.error || ""), /Automod muted you for 3 minutes/i);

  const mutedFollowup = await fetchJson(`${base}/api/chat/threads/${privateRoom.body.thread.id}/messages`, {
    method: "POST",
    headers: guestHeaders,
    body: JSON.stringify({ content: "hello?" })
  });
  assert.equal(mutedFollowup.status, 400);
  assert.match(String(mutedFollowup.body.error || ""), /You are muted until/i);

  const tooLong = await fetchJson(`${base}/api/chat/threads/${privateRoom.body.thread.id}/messages`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({ content: "x".repeat(2001) })
  });
  assert.equal(tooLong.status, 400);
  assert.match(String(tooLong.body.error || ""), /2000 characters/i);
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

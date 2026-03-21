const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");

const BACKEND_ONLY_ROOT = path.resolve(__dirname, "..");
const HAS_BACKEND_ONLY_LAYOUT = fs.existsSync(path.join(BACKEND_ONLY_ROOT, "apps.js"));
const REPO_DIR = HAS_BACKEND_ONLY_LAYOUT ? BACKEND_ONLY_ROOT : path.resolve(__dirname, "..", "..");
const BACKEND_DIR = HAS_BACKEND_ONLY_LAYOUT ? BACKEND_ONLY_ROOT : path.join(REPO_DIR, "backend");
test("games api serves discovered catalog entries and backend thumbnails", async (t) => {
  const port = await getOpenPort();
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "palladium-games-api-"));
  const configPath = path.join(tempDir, "palladium.env");
  const playStatsPath = path.join(tempDir, "game-play-stats.json");

  await fsp.writeFile(
    configPath,
    [
      "SITE_HOST=127.0.0.1",
      `SITE_PORT=${port}`,
      "CORS_ORIGIN=*",
      "FRONTEND_DIR=disabled",
      `GAMES_DIR=${path.join(BACKEND_DIR, "games")}`,
      `SWF_DIR=${path.join(BACKEND_DIR, "swf")}`,
      `GAME_IMAGE_DIR=${path.join(BACKEND_DIR, "images", "game-img")}`,
      `GAME_CATALOG_PATH=${path.join(BACKEND_DIR, "config", "game-catalog.json")}`,
      `PLAY_STATS_PATH=${playStatsPath}`,
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

  await waitForServer(`http://127.0.0.1:${port}/health`, output);

  const response = await fetch(`http://127.0.0.1:${port}/api/games`);
  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.games));
  assert.ok(payload.games.length >= 20);

  const brotato = payload.games.find((entry) => entry.path === "games/bullet-hell/brotato.html");
  assert.ok(brotato, "Expected Brotato in the games catalog");
  assert.equal(brotato.title, "Brotato");
  assert.equal(brotato.author, "Blobfish");
  assert.equal(brotato.image, "/images/game-img/brotato.jpeg");

  const achievementUnlocked = payload.games.find((entry) => entry.path === "games/platformer/achievement-unlocked.html");
  assert.ok(achievementUnlocked, "Expected Achievement Unlocked in the games catalog");
  assert.equal(achievementUnlocked.title, "Achievement Unlocked");
  assert.equal(achievementUnlocked.author, "Revelance Match");
  assert.equal(achievementUnlocked.image, "/images/game-img/achievement-unlocked.png");

  const achievementUnlocked2 = payload.games.find((entry) => entry.path === "games/platformer/achievement-unlocked-2.html");
  assert.ok(achievementUnlocked2, "Expected Achievement Unlocked 2 in the games catalog");
  assert.equal(achievementUnlocked2.title, "Achievement Unlocked 2");
  assert.equal(achievementUnlocked2.author, "Revelance Match");
  assert.equal(achievementUnlocked2.image, "/images/game-img/achievement-unlocked.png");

  const chibiKnight = payload.games.find((entry) => entry.path === "games/swf/chibi-knight.html");
  assert.ok(chibiKnight, "Expected the SWF launcher in the games catalog");
  assert.equal(chibiKnight.title, "Chibi Knight");
  assert.equal(chibiKnight.author, "Armor Games");
  assert.equal(chibiKnight.image, "/images/game-img/chibi-knight.jpg");

  const impossibleQuiz = payload.games.find((entry) => entry.path === "games/swf/the-impossible-quiz.html");
  assert.ok(impossibleQuiz, "Expected The Impossible Quiz in the games catalog");
  assert.equal(impossibleQuiz.title, "The Impossible Quiz");
  assert.equal(impossibleQuiz.author, "Splapp-me-do");
  assert.equal(impossibleQuiz.image, "/images/game-img/the-impossible-quiz.png");

  const stickWar1 = payload.games.find((entry) => entry.path === "games/swf/stick-war-1.html");
  assert.ok(stickWar1, "Expected Stick War 1 in the games catalog");
  assert.equal(stickWar1.title, "Stick War 1");
  assert.equal(stickWar1.author, "Max Games Studios");
  assert.equal(stickWar1.image, "/images/game-img/stick-war-legacy.png");

  const thumbResponse = await fetch(`http://127.0.0.1:${port}${brotato.image}`);
  assert.equal(thumbResponse.status, 200);
  assert.match(thumbResponse.headers.get("content-type") || "", /^image\//i);

  const achievementThumbResponse = await fetch(`http://127.0.0.1:${port}${achievementUnlocked.image}`);
  assert.equal(achievementThumbResponse.status, 200);
  assert.match(achievementThumbResponse.headers.get("content-type") || "", /^image\//i);

  const impossibleThumbResponse = await fetch(`http://127.0.0.1:${port}${impossibleQuiz.image}`);
  assert.equal(impossibleThumbResponse.status, 200);
  assert.match(impossibleThumbResponse.headers.get("content-type") || "", /^image\//i);

  const chibiThumbResponse = await fetch(`http://127.0.0.1:${port}${chibiKnight.image}`);
  assert.equal(chibiThumbResponse.status, 200);
  assert.match(chibiThumbResponse.headers.get("content-type") || "", /^image\//i);

  const gameResponse = await fetch(`http://127.0.0.1:${port}/games/bullet-hell/brotato.html`);
  assert.equal(gameResponse.status, 200);
  assert.equal(gameResponse.headers.get("x-frame-options"), null);

  const rootResponse = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(rootResponse.status, 404);
  assert.match(await rootResponse.text(), /Frontend not configured/i);
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

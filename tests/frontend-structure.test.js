const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const BACKEND_ONLY_ROOT = path.resolve(__dirname, "..");
const HAS_BACKEND_ONLY_LAYOUT = fs.existsSync(path.join(BACKEND_ONLY_ROOT, "apps.js"));
const REPO_DIR = HAS_BACKEND_ONLY_LAYOUT ? BACKEND_ONLY_ROOT : path.resolve(__dirname, "..", "..");
const BACKEND_DIR = HAS_BACKEND_ONLY_LAYOUT ? BACKEND_ONLY_ROOT : path.join(REPO_DIR, "backend");
const FRONTEND_CANDIDATES = [
  path.join(REPO_DIR, "frontend"),
  path.join(REPO_DIR, "palladium-frontend"),
  path.resolve(BACKEND_DIR, "..", "palladium-frontend")
];
const FRONTEND_DIR = FRONTEND_CANDIDATES.find((candidate) => fs.existsSync(path.join(candidate, "index.html"))) || "";
const HAS_FRONTEND_DIR = fs.existsSync(path.join(FRONTEND_DIR, "index.html"));

const REQUIRED_FRONTEND_FILES = [
  "index.html",
  "styles.css",
  "settings-shell.css",
  "backend.js",
  "games-static.js",
  "shell-core.js",
  "shell.js",
  "sw.js",
  "site-settings.js",
  "favicon.ico",
  "render.yaml"
];

test("frontend directory contains the required static entrypoints", () => {
  if (!HAS_FRONTEND_DIR) {
    assert.ok(true, "Backend-only checkout does not ship the frontend directory.");
    return;
  }

  for (const relativePath of REQUIRED_FRONTEND_FILES) {
    const absolutePath = path.join(FRONTEND_DIR, relativePath);
    assert.ok(fs.existsSync(absolutePath), `Missing frontend file: ${relativePath}`);
  }
});

test("frontend shell ships the built-in games search box", () => {
  if (!HAS_FRONTEND_DIR) {
    assert.ok(true, "Backend-only checkout does not ship the frontend directory.");
    return;
  }

  const shellPage = fs.readFileSync(path.join(FRONTEND_DIR, "index.html"), "utf8");
  assert.match(shellPage, /games-search-input/);
  assert.match(shellPage, /Search games, authors, or categories/);
  assert.match(shellPage, /antarctic:\/\/games/);
  assert.match(shellPage, /antarctic:\/\/settings/);
  assert.match(shellPage, /scram\/scramjet\.all\.js/);
  assert.match(shellPage, /baremux\/index\.js/);
});

test("frontend root only keeps one app shell html entrypoint", () => {
  if (!HAS_FRONTEND_DIR) {
    assert.ok(true, "Backend-only checkout does not ship the frontend directory.");
    return;
  }

  const htmlFiles = fs
    .readdirSync(FRONTEND_DIR)
    .filter((entry) => entry.endsWith(".html"))
    .sort();

  assert.deepEqual(htmlFiles, ["index.html"]);
});

test("frontend directory keeps shared images available for the static host", () => {
  if (HAS_FRONTEND_DIR) {
    assert.ok(fs.existsSync(path.join(FRONTEND_DIR, "images", "favicon.png")));
    assert.ok(fs.existsSync(path.join(FRONTEND_DIR, "images", "discord.png")));
    assert.ok(fs.existsSync(path.join(FRONTEND_DIR, "images", "game-img")));
    assert.ok(fs.existsSync(path.join(FRONTEND_DIR, "scram", "scramjet.all.js")));
    assert.ok(fs.existsSync(path.join(FRONTEND_DIR, "baremux", "worker.js")));
    assert.ok(fs.existsSync(path.join(FRONTEND_DIR, "libcurl", "index.mjs")));
  }
  assert.ok(fs.existsSync(path.join(BACKEND_DIR, "images", "game-img")));
});

test("backend owns the proxy sync tooling while frontend keeps only static runtime assets", () => {
  assert.ok(fs.existsSync(path.join(BACKEND_DIR, "scripts", "sync-frontend-proxy-assets.js")));

  if (HAS_FRONTEND_DIR) {
    assert.ok(!fs.existsSync(path.join(FRONTEND_DIR, "scripts", "sync-proxy-assets.js")));
  }
});

test("repo root no longer needs duplicate static page copies", () => {
  if (HAS_BACKEND_ONLY_LAYOUT) {
    assert.ok(fs.existsSync(path.join(REPO_DIR, "apps.js")));
    return;
  }

  assert.ok(!fs.existsSync(path.join(REPO_DIR, "index.html")));
  assert.ok(!fs.existsSync(path.join(REPO_DIR, "styles.css")));
  assert.ok(!fs.existsSync(path.join(REPO_DIR, "images")));
});

test("backend ships a Ruffle launcher for SWF games", () => {
  const launcherPath = path.join(BACKEND_DIR, "games", "swf", "chibi-knight.html");
  const source = fs.readFileSync(launcherPath, "utf8");
  assert.match(source, /@ruffle-rs\/ruffle/);
  assert.match(source, /\/swf\/chibi-knight\.swf/);
});

test("backend ships a Ruffle launcher for The Impossible Quiz", () => {
  const launcherPath = path.join(BACKEND_DIR, "games", "swf", "the-impossible-quiz.html");
  const source = fs.readFileSync(launcherPath, "utf8");
  assert.match(source, /@ruffle-rs\/ruffle/);
  assert.match(source, /\/swf\/impossible-quiz\.swf/);
});

test("backend Cookie Clicker launcher uses the GitHub-backed mirror", () => {
  const launcherPath = path.join(BACKEND_DIR, "games", "clickers", "cookie-clicker.html");
  const source = fs.readFileSync(launcherPath, "utf8");
  assert.match(source, /rawcdn\.githack\.com\/bubbls\/UGS-Assets\/main\/cookieclicker\//);
  assert.doesNotMatch(source, /cdn\.jsdelivr\.net\/gh\/bubbls\/UGS-Assets/);
});

test("backend no longer ships removed Stick War launchers", () => {
  assert.ok(!fs.existsSync(path.join(BACKEND_DIR, "games", "swf", "stick-war-1.html")));
  assert.ok(!fs.existsSync(path.join(BACKEND_DIR, "games", "stick-ragdoll", "stick-war-legacy.html")));
  assert.ok(!fs.existsSync(path.join(BACKEND_DIR, "swf", "stick-war-1.swf")));
});

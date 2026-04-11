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
  path.join(REPO_DIR, "antarctic-frontend"),
  path.join(REPO_DIR, "palladium-frontend"),
  path.resolve(BACKEND_DIR, "..", "antarctic-frontend"),
  path.resolve(BACKEND_DIR, "..", "palladium-frontend")
];
const FRONTEND_DIR = FRONTEND_CANDIDATES.find((candidate) => fs.existsSync(path.join(candidate, "index.html"))) || "";
const HAS_FRONTEND_DIR = fs.existsSync(path.join(FRONTEND_DIR, "index.html"));

const REQUIRED_FRONTEND_FILES = [
  "index.html",
  "styles.css",
  "settings-shell.css",
  "backend.js",
  "social-client.js",
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

test("frontend shell ships the built-in antarctic routes with the bundled proxy runtime", () => {
  if (!HAS_FRONTEND_DIR) {
    assert.ok(true, "Backend-only checkout does not ship the frontend directory.");
    return;
  }

  const shellPage = fs.readFileSync(path.join(FRONTEND_DIR, "index.html"), "utf8");
  assert.match(shellPage, /games-search-input/);
  assert.match(shellPage, /antarctic:\/\/games/);
  assert.match(shellPage, /antarctic:\/\/account/);
  assert.match(shellPage, /antarctic:\/\/chats/);
  assert.match(shellPage, /antarctic:\/\/settings/);
  assert.match(shellPage, /scram\/scramjet\.all\.js/);
  assert.match(shellPage, /baremux\/index\.js/);
  assert.match(shellPage, /Preparing built-in web browsing/);
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

test("frontend directory keeps static assets available for the static host", () => {
  if (!HAS_FRONTEND_DIR) {
    assert.ok(true, "Backend-only checkout does not ship the frontend directory.");
    return;
  }

  assert.ok(fs.existsSync(path.join(FRONTEND_DIR, "images", "favicon.png")));
  assert.ok(fs.existsSync(path.join(FRONTEND_DIR, "images", "discord.png")));
  assert.ok(fs.existsSync(path.join(FRONTEND_DIR, "images", "game-img")));
  assert.ok(fs.existsSync(path.join(FRONTEND_DIR, "scram", "scramjet.all.js")));
  assert.ok(fs.existsSync(path.join(FRONTEND_DIR, "baremux", "worker.js")));
  assert.ok(fs.existsSync(path.join(FRONTEND_DIR, "libcurl", "index.mjs")));
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

test("backend ships user and agent guides for the trimmed API surface", () => {
  assert.ok(fs.existsSync(path.join(BACKEND_DIR, "docs", "user-guide.md")));
  assert.ok(fs.existsSync(path.join(BACKEND_DIR, "docs", "agent-guide.md")));
  assert.ok(fs.existsSync(path.join(BACKEND_DIR, "docs", "main-site-cutover.md")));
});

test("backend ships main-site deployment templates for backend-served hosting", () => {
  const serviceTemplatePath = path.join(BACKEND_DIR, "deploy", "antarctic-backend.service");
  const nginxTemplatePath = path.join(BACKEND_DIR, "deploy", "nginx", "antarctic.games.conf");

  assert.ok(fs.existsSync(serviceTemplatePath));
  assert.ok(fs.existsSync(nginxTemplatePath));

  const serviceTemplate = fs.readFileSync(serviceTemplatePath, "utf8");
  const nginxTemplate = fs.readFileSync(nginxTemplatePath, "utf8");
  const cutoverGuide = fs.readFileSync(path.join(BACKEND_DIR, "docs", "main-site-cutover.md"), "utf8");

  assert.match(serviceTemplate, /ExecStart=\/opt\/Antarctic-Backend\/start\.sh/);
  assert.match(nginxTemplate, /proxy_pass http:\/\/127\.0\.0\.1:8080/);
  assert.match(nginxTemplate, /server_name antarctic\.games www\.antarctic\.games api\.antarctic\.games;/);
  assert.match(cutoverGuide, /FRONTEND_STATIC_DIR=\/opt\/Antarctic-Games/);
  assert.match(cutoverGuide, /Rollback:/);
});

test("config template documents optional frontend passthrough without reintroducing hosted games", () => {
  const template = fs.readFileSync(path.join(BACKEND_DIR, "config", "palladium.env.example"), "utf8");
  assert.match(template, /^FRONTEND_STATIC_DIR=/m);
  assert.match(template, /^ACCOUNT_PROVIDER=auto$/m);
  assert.match(template, /^SUPABASE_DB_URL=$/m);
  assert.doesNotMatch(template, /^GAME_CATALOG/m);
});

test("backend no longer ships legacy hosted frontend, games, thumbnails, or monochrome files", () => {
  assert.ok(!fs.existsSync(path.join(BACKEND_DIR, "games")));
  assert.ok(!fs.existsSync(path.join(BACKEND_DIR, "swf")));
  assert.ok(!fs.existsSync(path.join(BACKEND_DIR, "images", "game-img")));
  assert.ok(!fs.existsSync(path.join(BACKEND_DIR, "config", "game-catalog.json")));
  assert.ok(!fs.existsSync(path.join(BACKEND_DIR, "config", "game-play-stats.json")));
  assert.ok(!fs.existsSync(path.join(BACKEND_DIR, "services", "monochrome")));
});

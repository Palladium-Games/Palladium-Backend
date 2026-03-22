const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const BACKEND_DIR = path.resolve(__dirname, "..");

test("backend AI normalization keeps the fast chat defaults", () => {
  const source = fs.readFileSync(path.join(BACKEND_DIR, "apps.js"), "utf8");

  assert.match(source, /options\.num_predict = 64;/);
  assert.match(source, /options\.num_ctx = 768;/);
  assert.match(source, /normalized\.keep_alive = "24h";/);
  assert.match(source, /normalized\.think = false;/);
});

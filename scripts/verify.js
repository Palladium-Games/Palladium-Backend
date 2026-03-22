#!/usr/bin/env node

const path = require("node:path");
const { execFileSync } = require("node:child_process");

const backendDir = path.resolve(__dirname, "..");
const filesToCheck = [
  path.join(backendDir, "apps.js"),
  path.join(backendDir, "server.js"),
  path.join(backendDir, "scripts", "ensure-runtime-deps.js"),
  path.join(backendDir, "services", "community-sqlite-store.js")
];

for (const filePath of filesToCheck) {
  execFileSync(process.execPath, ["--check", filePath], {
    cwd: backendDir,
    stdio: "inherit"
  });
}

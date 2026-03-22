const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const BACKEND_DIR = path.resolve(__dirname, "..");

test("discord bot scripts use Antarctic branding while keeping legacy rules detection", () => {
  const commitBot = fs.readFileSync(path.join(BACKEND_DIR, "discord-bots", "discord-commit-presence.js"), "utf8");
  const linkBot = fs.readFileSync(path.join(BACKEND_DIR, "discord-bots", "discord-link-command-bot.js"), "utf8");
  const communityBot = fs.readFileSync(path.join(BACKEND_DIR, "discord-bots", "discord-community-bot.js"), "utf8");
  const gatewayPresence = fs.readFileSync(path.join(BACKEND_DIR, "discord-bots", "discord-gateway-presence.js"), "utf8");
  const configTemplate = fs.readFileSync(path.join(BACKEND_DIR, "config", "palladium.env.example"), "utf8");

  assert.match(commitBot, /Palladium-Games\/Antarctic-Games/);
  assert.match(commitBot, /Antarctic-Commit-Bot\/1\.0/);
  assert.match(commitBot, /Antarctic Commits/);

  assert.match(linkBot, /Antarctic Link Drop/);
  assert.match(linkBot, /Antarctic Link Intelligence/);
  assert.match(linkBot, /Antarctic link command bot running/);

  assert.match(communityBot, /Antarctic Rules/);
  assert.match(communityBot, /antarctic-rules-v1/);
  assert.match(communityBot, /LEGACY_RULES_SIGNATURE = "palladium-rules-v1"/);
  assert.match(communityBot, /Welcome .* to Antarctic Games!/);
  assert.match(communityBot, /Antarctic Community/);

  assert.match(gatewayPresence, /antarctic-bot/);
  assert.match(gatewayPresence, /Antarctic shutdown/);

  assert.match(configTemplate, /DISCORD_COMMIT_REPO=Palladium-Games\/Antarctic-Games/);
});

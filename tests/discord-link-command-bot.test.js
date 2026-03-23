const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSavedLinkPayload,
  buildSlashCommandPayloads,
  hasLinkAdminPermissions,
  normalizeSavedLinkEntry,
  pickSavedLink,
  resolveAppsBases,
  sanitizeSavedLinks,
  upsertSavedLink,
} = require("../discord-bots/discord-link-command-bot");

test("slash command payloads include link checking and saved-link commands", () => {
  const payloads = buildSlashCommandPayloads();
  const names = payloads.map((payload) => payload.name);

  assert.deepEqual(names, ["link", "addlink", "getlink"]);

  const addLinkPayload = payloads.find((payload) => payload.name === "addlink");
  assert.equal(addLinkPayload.options.length, 1);
  assert.equal(addLinkPayload.options[0].name, "url");
  assert.match(addLinkPayload.description, /Antarctic pool/);

  const getLinkPayload = payloads.find((payload) => payload.name === "getlink");
  assert.match(getLinkPayload.description, /Antarctic pool/);
});

test("saved link entries normalize urls and timestamps", () => {
  const entry = normalizeSavedLinkEntry({
    url: "example.com/path",
    addedBy: "12345",
    addedAt: "2026-03-14T12:00:00Z",
  });

  assert.ok(entry);
  assert.equal(entry.url, "https://example.com/path");
  assert.equal(entry.addedBy, "12345");
  assert.equal(entry.addedAt, "2026-03-14T12:00:00.000Z");
});

test("saved link sanitizing drops invalid items and duplicate urls", () => {
  const links = sanitizeSavedLinks([
    { url: "https://example.com" },
    { url: "example.com" },
    { url: "notaurl:::" },
    { url: "https://second.example.com" },
  ]);

  assert.equal(links.length, 2);
  assert.equal(links[0].url, "https://example.com/");
  assert.equal(links[1].url, "https://second.example.com/");
});

test("upsertSavedLink adds a new link and prevents duplicates", () => {
  const firstInsert = upsertSavedLink([], "https://palladium.dev/play", { addedBy: "99" });
  assert.equal(firstInsert.added, true);
  assert.equal(firstInsert.duplicate, false);
  assert.equal(firstInsert.links.length, 1);
  assert.equal(firstInsert.entry.addedBy, "99");

  const secondInsert = upsertSavedLink(firstInsert.links, "palladium.dev/play", { addedBy: "100" });
  assert.equal(secondInsert.added, false);
  assert.equal(secondInsert.duplicate, true);
  assert.equal(secondInsert.links.length, 1);
  assert.equal(secondInsert.entry.url, "https://palladium.dev/play");
});

test("pickSavedLink returns deterministic entries when provided a random value", () => {
  const links = sanitizeSavedLinks([
    { url: "https://one.example.com" },
    { url: "https://two.example.com" },
    { url: "https://three.example.com" },
  ]);

  assert.equal(pickSavedLink(links, 0).url, "https://one.example.com/");
  assert.equal(pickSavedLink(links, 0.5).url, "https://two.example.com/");
  assert.equal(pickSavedLink(links, 0.99).url, "https://three.example.com/");
});

test("link admin permissions accept administrator and moderation bits", () => {
  assert.equal(hasLinkAdminPermissions("8"), true);
  assert.equal(hasLinkAdminPermissions("32"), true);
  assert.equal(hasLinkAdminPermissions("8192"), true);
  assert.equal(hasLinkAdminPermissions("0"), false);
});

test("saved link payload presents the link and pool metadata", () => {
  const payload = buildSavedLinkPayload(
    {
      url: "https://palladium.games/play",
      addedBy: "42",
      addedAt: "2026-03-14T00:00:00.000Z",
    },
    7
  );

  assert.ok(Array.isArray(payload.embeds));
  assert.equal(payload.embeds[0].title, "Antarctic Link Drop");
  assert.match(payload.embeds[0].description, /Open link/);
  assert.equal(payload.embeds[0].fields[0].value, "<@42>");
  assert.equal(payload.embeds[0].fields[1].value, "7");
  assert.equal(payload.embeds[0].footer.text, "Antarctic Links");
});

test("apps base resolution accepts Antarctic env aliases", () => {
  const previousAntarctic = process.env.ANTARCTIC_APPS_URL;
  const previousPalladium = process.env.PALLADIUM_APPS_URL;
  const previousBackend = process.env.BACKEND_BASE_URL;

  process.env.ANTARCTIC_APPS_URL = "api.antarctic.games";
  process.env.PALLADIUM_APPS_URL = "";
  process.env.BACKEND_BASE_URL = "";

  try {
    const bases = resolveAppsBases();
    assert.equal(bases[0], "http://api.antarctic.games");
  } finally {
    restoreEnv("ANTARCTIC_APPS_URL", previousAntarctic);
    restoreEnv("PALLADIUM_APPS_URL", previousPalladium);
    restoreEnv("BACKEND_BASE_URL", previousBackend);
  }
});

function restoreEnv(key, value) {
  if (typeof value === "undefined") {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

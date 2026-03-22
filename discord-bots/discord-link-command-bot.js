#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { startDiscordPresence } = require("./discord-gateway-presence");

const DISCORD_API_BASE = process.env.DISCORD_API_BASE || "https://discord.com/api/v10";
const POLL_MS = Math.max(5000, Number(process.env.DISCORD_LINK_POLL_MS || 60_000));
const COMMAND_SYNC_MS = Math.max(60_000, Number(process.env.DISCORD_LINK_COMMAND_SYNC_MS || 60 * 60 * 1000));
const LEGACY_POLLING_ENABLED = parseBool(process.env.DISCORD_LINK_LEGACY_POLLING_ENABLED, false);
const STATE_PATH = process.env.DISCORD_LINK_STATE_PATH || path.join(__dirname, "..", ".discord-link-command-state.json");
const LINK_COMMAND_NAME = "link";
const ADD_LINK_COMMAND_NAME = "addlink";
const GET_LINK_COMMAND_NAME = "getlink";
const ADMINISTRATOR_PERMISSION = 0x00000008n;
const MANAGE_GUILD_PERMISSION = 0x00000020n;
const MANAGE_MESSAGES_PERMISSION = 0x00002000n;
const MAX_SAVED_LINKS = Math.max(10, Number(process.env.DISCORD_LINK_MAX_SAVED_LINKS || 250));
const GETLINK_LIMIT_PER_WEEK = Math.max(1, Number(process.env.DISCORD_LINK_GETLINK_LIMIT_PER_WEEK || 2));
const GETLINK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const BOT_TOKEN = normalizeDiscordToken(
  process.env.DISCORD_BOT_TOKEN ||
  tryReadGitConfig("discord.botToken") ||
  ""
);

const CHANNEL_IDS = parseChannelIds(
  process.env.DISCORD_LINK_COMMAND_CHANNEL_IDS ||
  tryReadGitConfig("discord.linkCommandChannelIds") ||
  tryReadGitConfig("discord.linkCheckerChannelId") ||
  ""
);

const state = loadState();
if (!state.lastMessageIds || typeof state.lastMessageIds !== "object") state.lastMessageIds = {};
if (!state.bootstrapped || typeof state.bootstrapped !== "object") state.bootstrapped = {};
if (!state.getlinkUsage || typeof state.getlinkUsage !== "object") state.getlinkUsage = {};
state.savedLinks = sanitizeSavedLinks(state.savedLinks);
if (state.savedLinks.length > 0) {
  console.log(`Link bot: loaded ${state.savedLinks.length} saved link(s) from ${STATE_PATH}`);
}

let appId = "";
let guildIds = [];
let lastCommandSyncAt = 0;
const channelAllowCache = new Map();
let presence = { stop() {} };

function normalizeBaseUrl(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return "";
  const value = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const parsed = new URL(value);
    return parsed.origin.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

const DEFAULT_APPS_BASES = [
  "http://127.0.0.1:8080",
  "http://127.0.0.1:443",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5000",
  "http://localhost:8080",
  "http://localhost:443",
  "http://localhost:3000",
];

function resolveAppsBases() {
  const candidates = [
    process.env.ANTARCTIC_APPS_URL,
    process.env.ANTARCTIC_BACKEND_BASE,
    process.env.ANTARCTIC_PUBLIC_BASE,
    process.env.PALLADIUM_APPS_URL,
    process.env.PALLADIUM_BACKEND_BASE,
    process.env.BACKEND_BASE_URL,
    process.env.PALLADIUM_PUBLIC_BASE,
    "http://127.0.0.1:443",
    "http://localhost:443",
    "https://127.0.0.1:443",
    "https://localhost:443",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:8080",
    "http://127.0.0.1:5000",
    "http://localhost:8080",
    "http://localhost:3000",
  ]
    .map(normalizeBaseUrl)
    .filter(Boolean);

  const bases = unique(candidates);
  if (bases.length === 0) {
    return unique(DEFAULT_APPS_BASES.map(normalizeBaseUrl).filter(Boolean));
  }
  return bases;
}

const APPS_BASES = resolveAppsBases();

function tryReadGitConfig(key) {
  if (!key) return "";
  try {
    return execSync(`git config --get ${key}`, {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).replace(/\r/g, "").trim();
  } catch {
    return "";
  }
}

function parseChannelIds(raw) {
  return String(raw || "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBool(raw, fallback = false) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  return fallback;
}

function unique(values) {
  return Array.from(new Set(values.map((v) => String(v).trim()).filter(Boolean)));
}

function parsePermissionBits(raw) {
  try {
    return BigInt(String(raw || "0"));
  } catch {
    return 0n;
  }
}

function hasPermission(permissionBits, mask) {
  const bits = parsePermissionBits(permissionBits);
  return (bits & mask) === mask;
}

function hasLinkAdminPermissions(permissionBits) {
  return (
    hasPermission(permissionBits, ADMINISTRATOR_PERMISSION) ||
    hasPermission(permissionBits, MANAGE_GUILD_PERMISSION) ||
    hasPermission(permissionBits, MANAGE_MESSAGES_PERMISSION)
  );
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveState() {
  try {
    const dir = path.dirname(STATE_PATH);
    if (dir) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn("Link bot: could not save state to", STATE_PATH, err && err.message);
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function discordRequest(method, route, body) {
  while (true) {
    const response = await fetch(`${DISCORD_API_BASE}${route}`, {
      method,
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.status === 429) {
      let retryMs = 1500;
      try {
        const data = await response.json();
        if (data && typeof data.retry_after === "number") {
          retryMs = Math.ceil(data.retry_after * 1000);
        }
      } catch {
        // Use fallback retry.
      }
      await sleep(retryMs);
      continue;
    }

    if (response.status === 401) {
      const text = await response.text().catch(() => "");
      const error = new Error(
        `Discord API ${method} ${route} failed (401): ${text || "Unauthorized"}`
      );
      error.code = "DISCORD_UNAUTHORIZED";
      throw error;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const error = new Error(`Discord API ${method} ${route} failed (${response.status}): ${text}`);
      error.code = `DISCORD_HTTP_${response.status}`;
      throw error;
    }

    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
}

function isUnauthorizedDiscordError(error) {
  if (error && error.code === "DISCORD_UNAUTHORIZED") return true;
  const message = String(error && error.message ? error.message : error || "");
  return message.includes("failed (401)") || message.includes("401: Unauthorized");
}

function normalizeDiscordToken(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return "";

  let token = raw.replace(/^bot\s+/i, "").trim();
  token = token.split(/\s+/)[0] || "";
  if (!token) return "";

  const upper = token.toUpperCase();
  if (upper.includes("YOUR_") || upper.includes("REPLACE_ME")) return "";
  return token;
}

async function interactionCallback(interactionId, interactionToken, body) {
  const response = await fetch(`${DISCORD_API_BASE}/interactions/${interactionId}/${interactionToken}/callback`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Interaction callback failed (${response.status}): ${text}`);
  }
}

async function interactionEditOriginal(interactionToken, body) {
  if (!appId) {
    appId = await resolveAppId();
  }
  if (!appId) {
    throw new Error("Unable to resolve application id for interaction follow-up.");
  }

  const response = await fetch(`${DISCORD_API_BASE}/webhooks/${appId}/${interactionToken}/messages/@original`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Interaction edit failed (${response.status}): ${text}`);
  }
}

function decodeBotIdFromToken(token) {
  const value = String(token || "");
  const segment = value.split(".")[0];
  if (!segment) return "";
  try {
    return Buffer.from(segment, "base64").toString("utf8").trim();
  } catch {
    return "";
  }
}

async function resolveAppId() {
  if (appId) return appId;

  try {
    const appInfo = await discordRequest("GET", "/oauth2/applications/@me");
    if (appInfo && appInfo.id) {
      appId = String(appInfo.id);
      return appId;
    }
  } catch {
    // Fall back to token-derived bot id.
  }

  const derived = decodeBotIdFromToken(BOT_TOKEN);
  if (derived) {
    appId = derived;
  }

  return appId;
}

function normalizeUrl(candidateRaw) {
  let candidate = String(candidateRaw || "").trim();
  if (!candidate) return "";

  if (candidate.startsWith("<") && candidate.endsWith(">")) {
    candidate = candidate.slice(1, -1).trim();
  }

  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;

  try {
    const parsed = new URL(candidate);
    if (!/^https?:$/i.test(parsed.protocol)) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function normalizeSavedLinkEntry(rawEntry) {
  const source = (rawEntry && typeof rawEntry === "object")
    ? rawEntry
    : { url: rawEntry };
  const url = normalizeUrl(source.url);
  if (!url) return null;

  const addedBy = String(source.addedBy || "").trim();
  const addedAtRaw = String(source.addedAt || "").trim();
  const parsedAddedAt = addedAtRaw ? Date.parse(addedAtRaw) : Date.now();

  return {
    url,
    addedBy,
    addedAt: Number.isNaN(parsedAddedAt) ? new Date().toISOString() : new Date(parsedAddedAt).toISOString(),
  };
}

function sanitizeSavedLinks(entries) {
  const seen = new Set();
  const normalized = [];

  for (const entry of Array.isArray(entries) ? entries : []) {
    const normalizedEntry = normalizeSavedLinkEntry(entry);
    if (!normalizedEntry) continue;

    const key = normalizedEntry.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(normalizedEntry);
  }

  return normalized.slice(-MAX_SAVED_LINKS);
}

function upsertSavedLink(entries, rawUrl, metadata = {}) {
  const url = normalizeUrl(rawUrl);
  if (!url) {
    return {
      added: false,
      duplicate: false,
      entry: null,
      links: sanitizeSavedLinks(entries),
    };
  }

  const links = sanitizeSavedLinks(entries);
  const existing = links.find((entry) => entry.url === url);
  if (existing) {
    return {
      added: false,
      duplicate: true,
      entry: existing,
      links,
    };
  }

  const entry = normalizeSavedLinkEntry({
    url,
    addedBy: metadata.addedBy || "",
    addedAt: metadata.addedAt || new Date().toISOString(),
  });

  return {
    added: true,
    duplicate: false,
    entry,
    links: [...links, entry].slice(-MAX_SAVED_LINKS),
  };
}

function pickSavedLink(entries, randomValue = Math.random()) {
  const links = sanitizeSavedLinks(entries);
  if (!links.length) return null;

  const value = Number.isFinite(randomValue) ? randomValue : Math.random();
  const clamped = Math.min(0.999999, Math.max(0, value));
  const index = Math.floor(clamped * links.length);
  return links[index];
}

function parseLinkCommand(content) {
  const text = String(content || "").trim();
  if (!text) return "";

  const match = text.match(/^\/link\s+(.+)$/i);
  if (!match) return "";

  return normalizeUrl(match[1]);
}

function getSlashOptionValue(interactionData, name) {
  const options = interactionData && Array.isArray(interactionData.options) ? interactionData.options : [];
  const item = options.find((option) => option && option.name === name);
  return item && typeof item.value !== "undefined" ? item.value : "";
}

function formatSavedLinkAuthor(addedBy) {
  const value = String(addedBy || "").trim();
  if (!value) return "Unknown";
  return /^\d+$/.test(value) ? `<@${value}>` : clamp(value, 120);
}

function buildSavedLinkPayload(entry, totalLinks) {
  return {
    embeds: [
      {
        title: "Antarctic Link Drop",
        description: [
          `[Open link](${entry.url})`,
          "",
          clamp(entry.url, 900),
        ].join("\n"),
        color: 0x38bdf8,
        fields: [
          { name: "Added By", value: formatSavedLinkAuthor(entry.addedBy), inline: true },
          { name: "Pool Size", value: String(totalLinks), inline: true },
        ],
        footer: { text: "Antarctic Links" },
        timestamp: entry.addedAt || new Date().toISOString(),
      },
    ],
  };
}

function createTimeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
    return { signal: AbortSignal.timeout(ms), cleanup: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

async function runLinkCheck(url) {
  const errors = [];
  const timeoutMs = 20_000;

  for (const base of APPS_BASES) {
    const endpoint = `${base}/link-check?url=${encodeURIComponent(url)}`;
    const { signal, cleanup } = createTimeoutSignal(timeoutMs);

    try {
      const response = await fetch(endpoint, { method: "GET", signal });
      let data = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }
      cleanup();

      if (!response.ok || !data || data.ok !== true) {
        errors.push(`${base}: ${(data && data.error) || `HTTP ${response.status}`}`);
        continue;
      }

      return data;
    } catch (error) {
      cleanup();
      const msg = error && error.message ? error.message : String(error);
      errors.push(`${base}: ${msg}`);
    }
  }

  throw new Error(`Link check backend unavailable. Tried ${APPS_BASES.length} base(s). ${errors.join(" | ")}`);
}

const PROVIDER_STYLE = {
  securly: { icon: "⚙️", label: "Securly" },
  lightspeed: { icon: "🔧", label: "Lightspeed" },
  goguardian: { icon: "🔒", label: "GoGuardian" },
  palo_alto: { icon: "🔥", label: "Palo Alto" },
  contentkeeper: { icon: "🔑", label: "ContentKeeper" },
  fortiguard: { icon: "🛡️", label: "FortiGuard" },
  blocksi: { icon: "🧱", label: "Blocksi" },
  linewize: { icon: "🌐", label: "Linewize" },
  cisco_talos: { icon: "☁️", label: "Cisco Talos" },
  aristotle: { icon: "🎓", label: "Aristotle" },
  lanschool: { icon: "📚", label: "LanSchool" },
  deledao: { icon: "🤖", label: "Deledao" },
};

function verdictColor(result) {
  const verdict = result && result.summary ? result.summary.verdict : "unknown";
  if (verdict === "likely_unblocked") return 0x22c55e;
  if (verdict === "likely_blocked") return 0xef4444;
  if (verdict === "partial") return 0xf59e0b;
  return 0xf59e0b;
}

function clamp(value, max = 950) {
  const text = String(value || "");
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function providerStatus(provider) {
  const status = String(provider && provider.status ? provider.status : "unknown").toLowerCase();
  if (status === "detected" || status === "blocked") {
    return { mark: "⛔", label: "Blocked", pass: false };
  }
  if (status === "not_detected" || status === "allowed" || status === "unknown") {
    return { mark: "❔", label: "No Signal", pass: false, unknown: true };
  }
  return { mark: "⚪", label: "Unknown", pass: false, unknown: true };
}

function providerCategory(provider) {
  if (!provider || typeof provider !== "object") return "Unknown";
  if (provider.category) return String(provider.category);

  if (provider.status === "detected" || provider.status === "blocked") {
    return "Known block-page signature";
  }
  if (provider.status === "not_detected" || provider.status === "allowed" || provider.status === "unknown") {
    return "No signal from server-side probe";
  }

  const note = String(provider && provider.note ? provider.note : "").toLowerCase();
  if (note.includes("matched signature")) return "Known block-page signature";
  if (note.includes("could not be completed")) return "Probe unavailable";
  if (note.includes("no known block-page")) return "No known block signature detected";
  return "Insufficient signal";
}

function overallLine(providers) {
  const list = Array.isArray(providers) ? providers : [];
  const total = list.length;
  if (!total) return { text: "No provider data available", passCount: 0, total: 0 };

  let passCount = 0;
  let blockedCount = 0;
  let unknownCount = 0;

  for (const provider of list) {
    const status = providerStatus(provider);
    if (status.pass) passCount += 1;
    else if (status.unknown) unknownCount += 1;
    else blockedCount += 1;
  }

  let headline = "Inconclusive (Server-Side Only)";
  if (blockedCount === total) headline = "Likely Blocked";
  else if (blockedCount > 0) headline = "Potentially Blocked";

  return {
    text: `${headline} • ${blockedCount}/${total} blocked signatures • ${unknownCount}/${total} no-signal`,
    passCount,
    total,
  };
}

function buildProviderFields(result) {
  const providers = Array.isArray(result && result.providers) ? result.providers : [];
  return providers.slice(0, 18).map((provider) => {
    const style = PROVIDER_STYLE[provider.id] || { icon: "🔍", label: provider.name || provider.id || "Provider" };
    const status = providerStatus(provider);
    const category = providerCategory(provider);
    return {
      name: `${style.icon} ${style.label}`.slice(0, 256),
      value: clamp(`${status.mark} **${status.label}**\nCategory: ${category}`, 1024),
      inline: true,
    };
  });
}

function buildResultPayload(requesterMention, url, result, errorText) {
  if (errorText) {
    return {
      content: `${requesterMention} requested a filter check for ${url}`.slice(0, 1800),
      embeds: [
        {
          title: "🔍 Filter Analysis",
          color: 0xef4444,
          description: [
            `**${safeHost(url)}**`,
            "",
            `❌ **Failed**`,
            "",
            `Error: ${clamp(errorText, 500)}`
          ].join("\n"),
          fields: [
            { name: "Requested By", value: requesterMention, inline: true },
            { name: "URL", value: clamp(url, 900), inline: false }
          ],
          footer: { text: "Antarctic Link Intelligence" },
          timestamp: new Date().toISOString(),
        },
      ],
    };
  }

  const summaryText = (result && result.summary && result.summary.text) || "No summary returned.";
  const directProbe = result && result.probes ? result.probes.direct : null;
  const directState = directProbe
    ? (directProbe.reachable ? `${directProbe.ok ? "ok" : "not-ok"} (HTTP ${directProbe.status})` : `unreachable${directProbe.error ? ` (${directProbe.error})` : ""}`)
    : "unknown";

  const providers = Array.isArray(result && result.providers) ? result.providers : [];
  const overview = overallLine(providers);
  const providerFields = buildProviderFields(result);

  const fields = [
    { name: "Requested By", value: requesterMention, inline: true },
    { name: "Direct Probe", value: clamp(directState, 900), inline: true },
    { name: "Scope", value: "Server-side probe only (school network filtering may differ).", inline: false },
    { name: "URL", value: clamp(url, 900), inline: false },
    ...providerFields,
  ].slice(0, 25);

  return {
    embeds: [
      {
        title: "🔍 Filter Analysis",
        description: [
          `**${safeHost(url)}**`,
          "",
          `**${overview.text}**`,
          "",
          `[Open URL](${url})`,
          "",
          `Summary: ${summaryText}`
        ].join("\n"),
        color: verdictColor(result),
        fields,
        footer: { text: "Antarctic Link Intelligence" },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}
async function postResult(channelId, message, url, result, errorText) {
  const requesterId = message && message.author ? message.author.id : "";
  const requesterMention = requesterId ? `<@${requesterId}>` : "Someone";
  const payload = buildResultPayload(requesterMention, url, result, errorText);
  await discordRequest("POST", `/channels/${channelId}/messages`, payload);
}

function sortBySnowflakeAsc(messages) {
  return [...messages].sort((a, b) => {
    try {
      const aid = BigInt(a.id || "0");
      const bid = BigInt(b.id || "0");
      if (aid < bid) return -1;
      if (aid > bid) return 1;
      return 0;
    } catch {
      return String(a.id || "").localeCompare(String(b.id || ""));
    }
  });
}

async function pollChannel(channelId) {
  const lastMessageId = state.lastMessageIds[channelId] || "";
  const route = `/channels/${channelId}/messages?limit=50${lastMessageId ? `&after=${lastMessageId}` : ""}`;
  const messages = await discordRequest("GET", route);
  const list = Array.isArray(messages) ? messages : [];

  if (!state.bootstrapped[channelId]) {
    if (list.length) {
      const newest = sortBySnowflakeAsc(list).at(-1);
      if (newest && newest.id) state.lastMessageIds[channelId] = newest.id;
    }
    state.bootstrapped[channelId] = true;
    saveState();
    return;
  }

  if (!list.length) return;

  const ordered = sortBySnowflakeAsc(list);
  for (const message of ordered) {
    if (!message || !message.id) continue;

    state.lastMessageIds[channelId] = message.id;

    const isBotAuthor = !!(message.author && message.author.bot);
    if (isBotAuthor) continue;

    const commandUrl = parseLinkCommand(message.content || "");
    if (!commandUrl) continue;

    try {
      const result = await runLinkCheck(commandUrl);
      await postResult(channelId, message, commandUrl, result, "");
    } catch (error) {
      const msg = (error && error.message) ? error.message : "Unknown error";
      await postResult(channelId, message, commandUrl, null, msg);
    }
  }

  saveState();
}

async function resolveGuildIds() {
  const ids = [];
  for (const channelId of CHANNEL_IDS) {
    try {
      const channel = await discordRequest("GET", `/channels/${channelId}`);
      if (channel && channel.guild_id) {
        ids.push(String(channel.guild_id));
      }
    } catch (error) {
      const msg = error && error.message ? error.message : String(error);
      console.warn(`Unable to resolve guild for channel ${channelId}: ${msg}`);
    }
  }
  guildIds = unique(ids);
  return guildIds;
}

function buildSlashCommandPayloads() {
  return [
    {
      name: LINK_COMMAND_NAME,
      description: "Check if a link is reachable and likely blocked/unblocked.",
      options: [
        {
          type: 3,
          name: "url",
          description: "URL to check",
          required: true,
        },
      ],
    },
    {
      name: ADD_LINK_COMMAND_NAME,
      description: "Admin only: save a link for the shared Antarctic pool.",
      default_member_permissions: MANAGE_GUILD_PERMISSION.toString(),
      options: [
        {
          type: 3,
          name: "url",
          description: "URL to save",
          required: true,
        },
      ],
    },
    {
      name: GET_LINK_COMMAND_NAME,
      description: "Get a random saved link from the Antarctic pool.",
    },
  ];
}

async function upsertGuildCommand(guildId, commandPayload) {
  const commands = await discordRequest("GET", `/applications/${appId}/guilds/${guildId}/commands`);
  const list = Array.isArray(commands) ? commands : [];
  const existing = list.find((cmd) => cmd && cmd.name === commandPayload.name);

  if (!existing || !existing.id) {
    await discordRequest("POST", `/applications/${appId}/guilds/${guildId}/commands`, commandPayload);
    return;
  }

  await discordRequest("PATCH", `/applications/${appId}/guilds/${guildId}/commands/${existing.id}`, commandPayload);
}

async function ensureSlashCommands() {
  if (!appId) {
    appId = await resolveAppId();
  }

  const resolvedGuildIds = guildIds.length ? guildIds : await resolveGuildIds();
  if (!resolvedGuildIds.length || !appId) return;

  const payloads = buildSlashCommandPayloads();
  for (const guildId of resolvedGuildIds) {
    for (const payload of payloads) {
      try {
        await upsertGuildCommand(guildId, payload);
        console.log(`Registered /${payload.name} in guild ${guildId}`);
      } catch (error) {
        const msg = error && error.message ? error.message : String(error);
        console.warn(`Failed to register /${payload.name} in guild ${guildId}: ${msg}`);
      }
    }
  }

  lastCommandSyncAt = Date.now();
}

async function isAllowedChannel(channelId) {
  const normalized = String(channelId || "").trim();
  if (!normalized) return false;
  if (CHANNEL_IDS.includes(normalized)) return true;

  const cached = channelAllowCache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.allowed;
  }

  let allowed = false;
  try {
    const channel = await discordRequest("GET", `/channels/${normalized}`);
    const parentId = channel && channel.parent_id ? String(channel.parent_id) : "";
    allowed = parentId ? CHANNEL_IDS.includes(parentId) : false;
  } catch {
    allowed = false;
  }

  channelAllowCache.set(normalized, {
    allowed,
    expiresAt: Date.now() + 5 * 60 * 1000
  });

  return allowed;
}

function interactionUserId(interaction) {
  if (interaction && interaction.member && interaction.member.user && interaction.member.user.id) {
    return String(interaction.member.user.id);
  }
  if (interaction && interaction.user && interaction.user.id) {
    return String(interaction.user.id);
  }
  return "";
}

async function isAdminInteraction(interaction) {
  const permissionBits = interaction && interaction.member ? interaction.member.permissions : undefined;
  return hasLinkAdminPermissions(permissionBits);
}

async function replyEphemeral(interaction, content) {
  await interactionCallback(interaction.id, interaction.token, {
    type: 4,
    data: {
      flags: 64,
      content,
    },
  });
}

async function ensureAllowedInteractionChannel(interaction) {
  const channelId = String(interaction && interaction.channel_id ? interaction.channel_id : "");
  if (!channelId) return false;

  if (!(await isAllowedChannel(channelId))) {
    await replyEphemeral(interaction, "This command is not enabled in this channel.");
    return false;
  }

  return true;
}

async function handleSlashLinkInteraction(interaction) {
  if (!(await ensureAllowedInteractionChannel(interaction))) return;

  const rawUrl = getSlashOptionValue(interaction.data, "url");
  const url = normalizeUrl(rawUrl);

  if (!url) {
    await replyEphemeral(interaction, "Please provide a valid http(s) URL.");
    return;
  }

  const requesterId = interactionUserId(interaction);
  const requesterMention = requesterId ? `<@${requesterId}>` : "Someone";

  try {
    await interactionCallback(interaction.id, interaction.token, {
      type: 5,
    });

    const result = await runLinkCheck(url);
    const payload = buildResultPayload(requesterMention, url, result, "");
    await interactionEditOriginal(interaction.token, payload);
  } catch (error) {
    const msg = error && error.message ? error.message : "Unknown error";
    try {
      await interactionEditOriginal(interaction.token, {
        flags: 64,
        content: `${requesterMention} link check failed for ${url}: ${msg}`,
      });
    } catch {
      try {
        await interactionCallback(interaction.id, interaction.token, {
          type: 4,
          data: {
            flags: 64,
            content: `${requesterMention} link check failed for ${url}: ${msg}`,
          },
        });
      } catch {
        // Interaction already acknowledged or expired.
      }
    }
  }
}

async function handleSlashAddLinkInteraction(interaction) {
  if (!(await ensureAllowedInteractionChannel(interaction))) return;

  if (!(await isAdminInteraction(interaction))) {
    await replyEphemeral(interaction, "Only admins can save links with /addlink.");
    return;
  }

  const rawUrl = getSlashOptionValue(interaction.data, "url");
  const requesterId = interactionUserId(interaction);
  const result = upsertSavedLink(state.savedLinks, rawUrl, { addedBy: requesterId });

  if (!result.entry) {
    await replyEphemeral(interaction, "Please provide a valid http(s) URL.");
    return;
  }

  state.savedLinks = result.links;
  saveState();

  if (result.duplicate) {
    await replyEphemeral(interaction, `That link is already saved: ${result.entry.url}`);
    return;
  }

  await replyEphemeral(
    interaction,
    `Saved link #${state.savedLinks.length}: ${result.entry.url}`
  );
}

function getGetlinkUsageInWindow(userId) {
  const list = state.getlinkUsage[userId];
  if (!Array.isArray(list)) return [];
  const cutoff = Date.now() - GETLINK_WINDOW_MS;
  return list.filter((t) => typeof t === "number" && t >= cutoff);
}

function recordGetlinkUse(userId) {
  if (!userId) return;
  const list = getGetlinkUsageInWindow(userId);
  list.push(Date.now());
  state.getlinkUsage[userId] = list;
}

async function handleSlashGetLinkInteraction(interaction) {
  if (!(await ensureAllowedInteractionChannel(interaction))) return;

  const entry = pickSavedLink(state.savedLinks);
  if (!entry) {
    await replyEphemeral(interaction, "No saved links have been added yet. Ask an admin to use /addlink first.");
    return;
  }

  const userId = interactionUserId(interaction);
  const usedInWindow = getGetlinkUsageInWindow(userId);
  if (usedInWindow.length >= GETLINK_LIMIT_PER_WEEK) {
    const oldest = Math.min(...usedInWindow);
    const resetsAt = oldest + GETLINK_WINDOW_MS;
    const msLeft = Math.max(0, resetsAt - Date.now());
    const hoursLeft = Math.ceil(msLeft / (60 * 60 * 1000));
    const message =
      hoursLeft >= 24
        ? `You've used /getlink ${GETLINK_LIMIT_PER_WEEK} times this week. Limit resets in about ${Math.ceil(hoursLeft / 24)} day(s).`
        : `You've used /getlink ${GETLINK_LIMIT_PER_WEEK} times this week. Limit resets in about ${hoursLeft} hour(s).`;
    await replyEphemeral(interaction, message);
    return;
  }

  recordGetlinkUse(userId);
  saveState();

  await interactionCallback(interaction.id, interaction.token, {
    type: 4,
    data: buildSavedLinkPayload(entry, state.savedLinks.length),
  });
}

async function handleSlashInteraction(interaction) {
  const commandName = String(interaction && interaction.data && interaction.data.name ? interaction.data.name : "").toLowerCase();
  if (commandName === LINK_COMMAND_NAME) {
    await handleSlashLinkInteraction(interaction);
    return;
  }
  if (commandName === ADD_LINK_COMMAND_NAME) {
    await handleSlashAddLinkInteraction(interaction);
    return;
  }
  if (commandName === GET_LINK_COMMAND_NAME) {
    await handleSlashGetLinkInteraction(interaction);
  }
}

async function handleGatewayDispatch(eventType, eventData) {
  if (eventType !== "INTERACTION_CREATE") return;
  if (!eventData || eventData.type !== 2 || !eventData.data) return;
  await handleSlashInteraction(eventData);
}

async function mainLoop() {
  validateRuntimeConfig();
  presence = startDiscordPresence({
    token: BOT_TOKEN,
    intents: 1,
    status: "online",
    logPrefix: "Antarctic Links",
    activity: {
      name: "Antarctic links",
      type: 3,
    },
    onReady: async () => {
      await ensureSlashCommands();
    },
    onDispatch: handleGatewayDispatch,
  });

  await ensureSlashCommands();
  console.log(`Antarctic link command bot running for channels: ${CHANNEL_IDS.join(", ")}`);
  console.log(`Antarctic link checker backends: ${APPS_BASES.join(", ")}`);
  console.log(
    LEGACY_POLLING_ENABLED
      ? `Legacy /link message polling enabled (${POLL_MS}ms interval).`
      : "Legacy /link message polling disabled (slash commands only)."
  );

  const loopSleepMs = LEGACY_POLLING_ENABLED ? POLL_MS : Math.min(COMMAND_SYNC_MS, 60_000);

  while (true) {
    const shouldSyncCommands = !lastCommandSyncAt || (Date.now() - lastCommandSyncAt) >= COMMAND_SYNC_MS;
    if (shouldSyncCommands) {
      try {
        await ensureSlashCommands();
      } catch (error) {
        const msg = error && error.message ? error.message : String(error);
        console.warn(`Slash command sync error: ${msg}`);
        if (isUnauthorizedDiscordError(error)) {
          console.error("Link bot token unauthorized. Stopping bot to prevent reconnect spam.");
          shutdown(1);
          return;
        }
      }
    }

    if (LEGACY_POLLING_ENABLED) {
      for (const channelId of CHANNEL_IDS) {
        try {
          await pollChannel(channelId);
        } catch (error) {
          const msg = error && error.message ? error.message : String(error);
          console.error(`Channel ${channelId} poll error: ${msg}`);
          if (isUnauthorizedDiscordError(error)) {
            console.error("Link bot token unauthorized. Stopping bot to prevent reconnect spam.");
            shutdown(1);
            return;
          }
        }
      }
    }

    await sleep(loopSleepMs);
  }
}

function validateRuntimeConfig() {
  if (!BOT_TOKEN) {
    throw new Error("Missing DISCORD_BOT_TOKEN (or git config discord.botToken).");
  }
  if (!CHANNEL_IDS.length) {
    throw new Error("Missing DISCORD_LINK_COMMAND_CHANNEL_IDS (or git config discord.linkCommandChannelIds). Ex: 123,456");
  }
}

function shutdown(code) {
  try {
    presence.stop();
  } catch {
    // Ignore shutdown errors.
  }
  process.exit(code);
}

module.exports = {
  buildSavedLinkPayload,
  buildSlashCommandPayloads,
  hasLinkAdminPermissions,
  normalizeSavedLinkEntry,
  normalizeUrl,
  pickSavedLink,
  resolveAppsBases,
  sanitizeSavedLinks,
  upsertSavedLink,
};

if (require.main === module) {
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  mainLoop().catch((error) => {
    console.error(error && error.message ? error.message : String(error));
    shutdown(1);
  });
}

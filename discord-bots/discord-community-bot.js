#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { startDiscordPresence } = require("./discord-gateway-presence");

const DISCORD_API_BASE = process.env.DISCORD_API_BASE || "https://discord.com/api/v10";
const POLL_MS = Math.max(5000, Number(process.env.DISCORD_COMMUNITY_POLL_MS || 30_000));
const MEMBER_SYNC_MS = Math.max(POLL_MS, Number(process.env.DISCORD_MEMBER_SYNC_MS || 120_000));
const RULES_CHECK_MS = Number(process.env.DISCORD_RULES_CHECK_MS || 5 * 60 * 1000);
const ROLE_CACHE_MS = Number(process.env.DISCORD_ROLE_CACHE_MS || 10 * 60 * 1000);
const COMMUNITY_GATEWAY_INTENTS = Number(process.env.DISCORD_COMMUNITY_GATEWAY_INTENTS || 1);
const MODERATION_ENABLED = String(process.env.DISCORD_MODERATION_ENABLED || "true").toLowerCase() !== "false";
const MODERATION_TIMEOUT_MINUTES = Number(process.env.DISCORD_MODERATION_TIMEOUT_MINUTES || 15);
const MODERATION_LOOKBACK_MS = Number(process.env.DISCORD_MODERATION_LOOKBACK_MS || 12_000);
const MODERATION_MAX_MESSAGES = Number(process.env.DISCORD_MODERATION_MAX_MESSAGES || 6);
const MODERATION_COOLDOWN_MS = Number(process.env.DISCORD_MODERATION_COOLDOWN_MS || 10 * 60 * 1000);
const MODERATION_USE_QWEN = String(process.env.DISCORD_MODERATION_USE_QWEN || "true").toLowerCase() !== "false";
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3.5:0.8b";
const MODERATION_QWEN_TIMEOUT_MS = Number(process.env.DISCORD_MODERATION_QWEN_TIMEOUT_MS || 8_000);
const STATE_PATH = process.env.DISCORD_COMMUNITY_STATE_PATH || path.join(__dirname, "..", ".discord-community-bot-state.json");
const RULES_EMBED_TITLE = "Antarctic Rules";
const RULES_SIGNATURE = "antarctic-rules-v1";
const LEGACY_RULES_EMBED_TITLE = "Palladium Rules";
const LEGACY_RULES_SIGNATURE = "palladium-rules-v1";
const RULES_COMMAND_NAME = "rules";
const INVITES_COMMAND_NAME = "invites";

const BOT_TOKEN = normalizeDiscordToken(
  process.env.DISCORD_COMMUNITY_BOT_TOKEN ||
  process.env.DISCORD_BOT_TOKEN ||
  tryReadGitConfig("discord.communityBotToken") ||
  tryReadGitConfig("discord.botToken") ||
  ""
);

const WELCOME_CHANNEL_ID =
  process.env.DISCORD_WELCOME_CHANNEL_ID ||
  tryReadGitConfig("discord.welcomeChannelId") ||
  "";

const RULES_CHANNEL_ID =
  process.env.DISCORD_RULES_CHANNEL_ID ||
  tryReadGitConfig("discord.rulesChannelId") ||
  "";

const CONFIGURED_COMMAND_CHANNEL_IDS = unique(
  parseChannelIds(
    process.env.DISCORD_COMMUNITY_COMMAND_CHANNEL_IDS ||
      tryReadGitConfig("discord.communityCommandChannelIds") ||
      ""
  )
);

let COMMAND_CHANNEL_IDS = [...CONFIGURED_COMMAND_CHANNEL_IDS];
const CONFIGURED_MODERATION_CHANNEL_IDS = unique(
  parseChannelIds(
    process.env.DISCORD_MODERATION_CHANNEL_IDS ||
    tryReadGitConfig("discord.moderationChannelIds") ||
    ""
  )
);
let MODERATION_CHANNEL_IDS = [...CONFIGURED_MODERATION_CHANNEL_IDS];

let GUILD_ID =
  process.env.DISCORD_GUILD_ID ||
  tryReadGitConfig("discord.communityGuildId") ||
  "";

const DEFAULT_RULE_SECTIONS = [
  {
    title: "Respect Everyone",
    details: [
      "Treat members, staff, and guests with respect at all times.",
      "Harassment, personal attacks, hate speech, and threats are not allowed."
    ]
  },
  {
    title: "No Scams, Spam, or Abuse",
    details: [
      "Do not send scam links, phishing attempts, mass promotions, or repeated spam.",
      "Excessive repeated messages can trigger an automatic timeout."
    ]
  },
  {
    title: "Keep Content Appropriate",
    details: [
      "No NSFW, illegal, or harmful content.",
      "Do not post malicious files, doxxing content, or privacy-violating material."
    ]
  },
  {
    title: "Use Channels Correctly",
    details: [
      "Keep discussions in the correct channels and avoid derailing conversations.",
      "Use commands where they belong and follow moderator instructions."
    ]
  },
  {
    title: "Follow Discord ToS",
    details: [
      "All Discord Terms of Service and Community Guidelines are enforced here."
    ]
  },
  {
    title: "Enforcement Policy",
    details: [
      "Rule-breaking can result in message removal, timeout (mute), kick, or ban depending on severity.",
      "Staff decisions and safety actions are final during active incidents."
    ]
  }
];

const DEFAULT_RULES_TEXT = DEFAULT_RULE_SECTIONS
  .map((section, index) => `${index + 1}. ${section.title}`)
  .join("\n");

const RULES_TEXT =
  process.env.DISCORD_RULES_TEXT ||
  tryReadGitConfig("discord.rulesText") ||
  DEFAULT_RULES_TEXT;

if (!BOT_TOKEN) {
  console.error("Missing community bot token. Set DISCORD_COMMUNITY_BOT_TOKEN or git config discord.communityBotToken.");
  process.exit(1);
}

if (!WELCOME_CHANNEL_ID || !RULES_CHANNEL_ID) {
  console.error("Missing welcome/rules channels. Set discord.welcomeChannelId and discord.rulesChannelId.");
  process.exit(1);
}

const state = loadState();
if (!Array.isArray(state.knownMemberIds)) state.knownMemberIds = [];
if (typeof state.bootstrapped !== "boolean") state.bootstrapped = false;
if (typeof state.lastRulesCheck !== "number") state.lastRulesCheck = 0;
if (typeof state.rulesMessageId !== "string") state.rulesMessageId = "";
if (!state.commandLastMessageIds || typeof state.commandLastMessageIds !== "object") state.commandLastMessageIds = {};
if (!state.commandBootstrapped || typeof state.commandBootstrapped !== "object") state.commandBootstrapped = {};
if (!state.moderationLastMessageIds || typeof state.moderationLastMessageIds !== "object") state.moderationLastMessageIds = {};
if (!state.moderationBootstrapped || typeof state.moderationBootstrapped !== "object") state.moderationBootstrapped = {};
if (!state.inviteSnapshot || typeof state.inviteSnapshot !== "object") state.inviteSnapshot = {};
if (!Array.isArray(state.welcomedMemberIds)) state.welcomedMemberIds = [];

let botUser = null;
let memberPollingEnabled = true;
let inviteTrackingEnabled = true;
let moderationEnabled = MODERATION_ENABLED;
let guildRolesById = new Map();
let guildRolesFetchedAt = 0;
let guildInfo = null;
let appId = "";
let lastMemberSyncAt = 0;
let activeGatewayIntents = COMMUNITY_GATEWAY_INTENTS;
const recentMessagesByUser = new Map();
const recentModerationActions = new Map();

const MODERATION_PATTERNS = [
  { id: "hate-speech", reason: "hate speech", regex: /\b(?:racial\s+slur|nazi\s+propaganda|kill\s+all\s+\w+)\b/i },
  { id: "threats", reason: "threatening language", regex: /\b(?:kys|kill yourself|i will kill you|im going to kill you)\b/i },
  { id: "scam", reason: "scam/phishing language", regex: /\b(?:free nitro|steam gift|gift card drop|claim reward|verify account now)\b/i },
  { id: "phishing-link", reason: "suspicious phishing link", regex: /\b(?:discord\.(?:gift|gg)\/[a-z0-9]+)\b/i }
];

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

function unique(values) {
  return Array.from(new Set(values.map((v) => String(v).trim()).filter(Boolean)));
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

function isUnauthorizedDiscordError(error) {
  if (error && error.code === "DISCORD_UNAUTHORIZED") return true;
  const message = String(error && error.message ? error.message : error || "");
  return message.includes("failed (401)") || message.includes("401: Unauthorized");
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
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch {
    // Non-fatal.
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function sortSnowflakeAsc(values) {
  return [...values].sort((a, b) => {
    try {
      const aid = BigInt(String(a || "0"));
      const bid = BigInt(String(b || "0"));
      if (aid < bid) return -1;
      if (aid > bid) return 1;
      return 0;
    } catch {
      return String(a || "").localeCompare(String(b || ""));
    }
  });
}

function sortMessagesAsc(messages) {
  return [...messages].sort((a, b) => {
    try {
      const aid = BigInt(String((a && a.id) || "0"));
      const bid = BigInt(String((b && b.id) || "0"));
      if (aid < bid) return -1;
      if (aid > bid) return 1;
      return 0;
    } catch {
      const aid = String((a && a.id) || "");
      const bid = String((b && b.id) || "");
      return aid.localeCompare(bid);
    }
  });
}

function limitKnownMembers(ids, max = 15000) {
  if (ids.length <= max) return ids;
  const sorted = sortSnowflakeAsc(ids);
  return sorted.slice(sorted.length - max);
}

function hasWelcomedMember(memberId) {
  const id = String(memberId || "").trim();
  if (!id) return false;
  return state.welcomedMemberIds.includes(id);
}

function markMemberWelcomed(memberId) {
  const id = String(memberId || "").trim();
  if (!id) return;
  if (!state.welcomedMemberIds.includes(id)) {
    state.welcomedMemberIds.push(id);
  }
  if (state.welcomedMemberIds.length > 5000) {
    state.welcomedMemberIds = state.welcomedMemberIds.slice(state.welcomedMemberIds.length - 5000);
  }
  saveState();
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

function hasModeratorPermissions(bits) {
  const ADMINISTRATOR = 0x00000008n;
  const MANAGE_GUILD = 0x00000020n;
  const MANAGE_MESSAGES = 0x00002000n;
  return (
    hasPermission(bits, ADMINISTRATOR) ||
    hasPermission(bits, MANAGE_GUILD) ||
    hasPermission(bits, MANAGE_MESSAGES)
  );
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
        // Use default retry.
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

async function resolveGuildId() {
  if (GUILD_ID) return GUILD_ID;
  const welcomeChannel = await discordRequest("GET", `/channels/${WELCOME_CHANNEL_ID}`);
  if (!welcomeChannel || !welcomeChannel.guild_id) {
    throw new Error("Unable to resolve guild_id from welcome channel.");
  }
  GUILD_ID = String(welcomeChannel.guild_id);
  return GUILD_ID;
}

async function fetchAllMembers(guildId) {
  const members = [];
  let after = "0";

  while (true) {
    const batch = await discordRequest("GET", `/guilds/${guildId}/members?limit=1000&after=${after}`);
    const list = Array.isArray(batch) ? batch : [];
    if (!list.length) break;

    members.push(...list);

    const last = list[list.length - 1];
    if (!last || !last.user || !last.user.id) break;
    after = String(last.user.id);

    if (list.length < 1000) break;
  }

  return members;
}

async function fetchGuildInfo() {
  if (guildInfo && guildInfo.id) return guildInfo;
  guildInfo = await discordRequest("GET", `/guilds/${GUILD_ID}`);
  return guildInfo;
}

async function fetchGuildRoles() {
  const now = Date.now();
  if (guildRolesById.size > 0 && now - guildRolesFetchedAt < ROLE_CACHE_MS) {
    return guildRolesById;
  }

  const roles = await discordRequest("GET", `/guilds/${GUILD_ID}/roles`);
  const map = new Map();
  const list = Array.isArray(roles) ? roles : [];
  for (const role of list) {
    if (!role || !role.id) continue;
    map.set(String(role.id), role);
  }

  guildRolesById = map;
  guildRolesFetchedAt = now;
  return guildRolesById;
}

async function fetchGuildMember(userId) {
  if (!userId) return null;
  try {
    return await discordRequest("GET", `/guilds/${GUILD_ID}/members/${userId}`);
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (message.includes("failed (404)") || isAccessDeniedError(error)) return null;
    throw error;
  }
}

async function resolveCommandChannels() {
  if (COMMAND_CHANNEL_IDS.length) return COMMAND_CHANNEL_IDS;

  const defaults = [RULES_CHANNEL_ID, WELCOME_CHANNEL_ID];
  try {
    const channels = await discordRequest("GET", `/guilds/${GUILD_ID}/channels`);
    const textChannels = (Array.isArray(channels) ? channels : [])
      .filter((channel) => channel && (channel.type === 0 || channel.type === 5) && channel.id)
      .map((channel) => String(channel.id));
    COMMAND_CHANNEL_IDS = unique([...defaults, ...textChannels]).slice(0, 30);
    return COMMAND_CHANNEL_IDS;
  } catch {
    COMMAND_CHANNEL_IDS = unique(defaults);
    return COMMAND_CHANNEL_IDS;
  }
}

async function resolveModerationChannels() {
  if (MODERATION_CHANNEL_IDS.length) return MODERATION_CHANNEL_IDS;

  try {
    const channels = await discordRequest("GET", `/guilds/${GUILD_ID}/channels`);
    const textChannels = (Array.isArray(channels) ? channels : [])
      .filter((channel) => channel && (channel.type === 0 || channel.type === 5) && channel.id)
      .map((channel) => String(channel.id));
    MODERATION_CHANNEL_IDS = unique(textChannels).slice(0, 60);
    return MODERATION_CHANNEL_IDS;
  } catch {
    MODERATION_CHANNEL_IDS = await resolveCommandChannels();
    return MODERATION_CHANNEL_IDS;
  }
}

function buildRulesCommandPayload() {
  return {
    name: RULES_COMMAND_NAME,
    description: "Repost the server rules in the rules channel (admin/mod only)",
  };
}

function buildInvitesCommandPayload() {
  return {
    name: INVITES_COMMAND_NAME,
    description: "Check how many invites a member has.",
    options: [
      {
        type: 3,
        name: "username",
        description: "Username, @mention, or user ID (optional). Defaults to you.",
        required: false,
      },
    ],
  };
}

async function ensureAppId() {
  if (!GUILD_ID) return;

  if (!appId) {
    const appInfo = await discordRequest("GET", "/oauth2/applications/@me");
    appId = appInfo && appInfo.id ? String(appInfo.id) : "";
  }

  if (!appId) return;
}

async function upsertGuildCommand(commandName, payload) {
  await ensureAppId();
  if (!GUILD_ID || !appId) return;
  const commands = await discordRequest("GET", `/applications/${appId}/guilds/${GUILD_ID}/commands`);
  const list = Array.isArray(commands) ? commands : [];
  const existing = list.find((cmd) => cmd && cmd.name === commandName);

  if (!existing || !existing.id) {
    await discordRequest("POST", `/applications/${appId}/guilds/${GUILD_ID}/commands`, payload);
    console.log(`Registered /${commandName} in guild ${GUILD_ID}`);
    return;
  }

  await discordRequest("PATCH", `/applications/${appId}/guilds/${GUILD_ID}/commands/${existing.id}`, payload);
  console.log(`Updated /${commandName} in guild ${GUILD_ID}`);
}

async function syncSlashCommands() {
  await upsertGuildCommand(RULES_COMMAND_NAME, buildRulesCommandPayload());
  await upsertGuildCommand(INVITES_COMMAND_NAME, buildInvitesCommandPayload());
}

function isAccessDeniedError(error) {
  const message = String(error && error.message ? error.message : error);
  return (
    message.includes("failed (403)") &&
    (message.includes("50001") || message.toLowerCase().includes("missing access"))
  );
}

function extractMemberId(member) {
  if (!member || !member.user || !member.user.id) return "";
  return String(member.user.id);
}

function normalizeRules() {
  const lines = String(RULES_TEXT || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return ["Be respectful to everyone.", "Follow Discord Terms of Service."];
  }

  return lines.map((line) => line.replace(/^[-*\d.)\s]+/, "").trim()).filter(Boolean);
}

function buildRuleSections() {
  const normalizedRules = normalizeRules();
  if (!normalizedRules.length) {
    return DEFAULT_RULE_SECTIONS;
  }

  const defaultNames = DEFAULT_RULE_SECTIONS.map((section) => section.title.toLowerCase());
  const normalizedNames = normalizedRules.map((rule) => rule.toLowerCase());
  if (
    normalizedNames.length === defaultNames.length &&
    normalizedNames.every((name, index) => name === defaultNames[index])
  ) {
    return DEFAULT_RULE_SECTIONS;
  }

  return normalizedRules.slice(0, 12).map((rule) => ({
    title: rule,
    details: [
      "Follow this rule in all channels.",
      "Breaking this rule may result in timeout (mute), kick, or ban."
    ]
  }));
}

function buildRulesEmbed() {
  const sections = buildRuleSections();
  const descriptionLines = [
    "# ANTARCTIC RULES",
    "Read and follow these rules to keep the server safe, fair, and fun.",
    ""
  ];

  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    descriptionLines.push(`## ${index + 1}. ${section.title}`);
    const details = Array.isArray(section.details) ? section.details : [];
    for (const detail of details.slice(0, 3)) {
      descriptionLines.push(`- ${detail}`);
    }
    descriptionLines.push("");
  }

  return {
    title: RULES_EMBED_TITLE,
    description: descriptionLines.join("\n").slice(0, 3900),
    color: 0x60a5fa,
    footer: {
      text: `Antarctic Community • ${RULES_SIGNATURE}`,
    },
    timestamp: new Date().toISOString(),
  };
}

function isRulesMessage(message) {
  if (!message || typeof message !== "object") return false;

  const content = String(message.content || "");
  if (content.includes("[ANTARCTIC_RULES_V1]")) return true;
  if (content.includes("[PALLADIUM_RULES_V1]")) return true;

  const embeds = Array.isArray(message.embeds) ? message.embeds : [];
  for (const embed of embeds) {
    const title = String((embed && embed.title) || "");
    const footerText = String((embed && embed.footer && embed.footer.text) || "").toLowerCase();
    if (title === RULES_EMBED_TITLE) return true;
    if (title === LEGACY_RULES_EMBED_TITLE) return true;
    if (footerText.includes(RULES_SIGNATURE) || footerText.includes(LEGACY_RULES_SIGNATURE)) return true;
  }

  return false;
}

async function getMessageById(channelId, messageId) {
  if (!channelId || !messageId) return null;
  try {
    return await discordRequest("GET", `/channels/${channelId}/messages/${messageId}`);
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (message.includes("failed (404)")) return null;
    throw error;
  }
}

async function deleteMessage(channelId, messageId) {
  if (!channelId || !messageId) return;
  try {
    await discordRequest("DELETE", `/channels/${channelId}/messages/${messageId}`);
  } catch (error) {
    const msg = String(error && error.message ? error.message : error);
    if (msg.includes("failed (404)")) return;
    console.warn(`Unable to delete message ${messageId}: ${msg}`);
  }
}

function memberDisplayName(member, fallbackId) {
  const user = member && member.user ? member.user : null;
  if (user && user.global_name) return String(user.global_name);
  if (user && user.username) return String(user.username);
  return fallbackId ? `User-${fallbackId}` : "Unknown User";
}

function parseInviteUses(rawValue) {
  const value = Number(rawValue);
  if (Number.isFinite(value) && value >= 0) return value;
  return 0;
}

function mapInvitesToSnapshot(invites) {
  const snapshot = {};
  for (const invite of Array.isArray(invites) ? invites : []) {
    if (!invite || !invite.code) continue;
    const code = String(invite.code);
    const inviter = invite.inviter || {};
    snapshot[code] = {
      code,
      uses: parseInviteUses(invite.uses),
      inviterId: inviter.id ? String(inviter.id) : "",
      inviterName: inviter.global_name || inviter.username || "Unknown",
    };
  }
  return snapshot;
}

async function fetchInviteSnapshot() {
  const invites = await discordRequest("GET", `/guilds/${GUILD_ID}/invites`);
  return mapInvitesToSnapshot(invites);
}

function buildInviteAttributionQueue(previousSnapshot, currentSnapshot) {
  const previous = previousSnapshot && typeof previousSnapshot === "object" ? previousSnapshot : {};
  const current = currentSnapshot && typeof currentSnapshot === "object" ? currentSnapshot : {};
  const queue = [];

  for (const [code, currentEntry] of Object.entries(current)) {
    const previousEntry = previous[code] || {};
    const prevUses = parseInviteUses(previousEntry.uses);
    const currUses = parseInviteUses(currentEntry.uses);
    const delta = Math.max(0, currUses - prevUses);
    if (!delta) continue;

    let inviterTotalInvites = currUses;
    if (currentEntry.inviterId) {
      inviterTotalInvites = Object.values(current)
        .filter((entry) => entry && entry.inviterId && entry.inviterId === currentEntry.inviterId)
        .reduce((sum, entry) => sum + parseInviteUses(entry.uses), 0);
    }

    for (let index = 0; index < delta; index += 1) {
      queue.push({
        inviterId: currentEntry.inviterId || "",
        inviterName: currentEntry.inviterName || "Unknown",
        invites: inviterTotalInvites
      });
    }
  }

  return queue;
}

async function refreshInviteSnapshot() {
  if (!inviteTrackingEnabled) return state.inviteSnapshot;
  try {
    const snapshot = await fetchInviteSnapshot();
    state.inviteSnapshot = snapshot;
    saveState();
    return snapshot;
  } catch (error) {
    if (isAccessDeniedError(error)) {
      inviteTrackingEnabled = false;
      console.warn("Invite tracking disabled (missing Manage Guild permission).");
      return state.inviteSnapshot;
    }
    throw error;
  }
}

async function resolveInviteContextForJoin() {
  const previousInviteSnapshot = state.inviteSnapshot && typeof state.inviteSnapshot === "object"
    ? state.inviteSnapshot
    : {};
  const refreshedInviteSnapshot = await refreshInviteSnapshot().catch((error) => {
    const msg = String(error && error.message ? error.message : error);
    console.warn(`Invite context refresh error: ${msg}`);
    return previousInviteSnapshot;
  });

  const queue = buildInviteAttributionQueue(previousInviteSnapshot, refreshedInviteSnapshot);
  if (queue.length > 0) {
    return queue[0];
  }

  return { inviterId: "", inviterName: "Unknown", invites: 0 };
}

async function postWelcome(member, inviteContext) {
  const memberId = extractMemberId(member);
  if (!memberId) return;
  if (hasWelcomedMember(memberId)) return;

  const memberName = memberDisplayName(member, memberId);
  const memberMention = `<@${memberId}>`;
  const inviterId = inviteContext && inviteContext.inviterId ? String(inviteContext.inviterId) : "";
  const inviterMention = inviterId ? `<@${inviterId}>` : "";
  const inviterName = inviteContext && inviteContext.inviterName ? String(inviteContext.inviterName) : "Unknown";
  const inviteCount = inviteContext && Number.isFinite(Number(inviteContext.invites))
    ? Number(inviteContext.invites)
    : 0;
  const inviterDisplay = inviterMention || inviterName;

  await discordRequest("POST", `/channels/${WELCOME_CHANNEL_ID}/messages`, {
    content: `Welcome ${memberMention} (${memberName}) to Antarctic Games! You were invited by ${inviterDisplay}, who now has ${inviteCount} invites.`,
  });

  markMemberWelcomed(memberId);
}

async function postRulesMessage(requestedById) {
  const content = requestedById
    ? `Rules refreshed by <@${requestedById}>.`
    : "Please read these rules before participating in the server.";

  return await discordRequest("POST", `/channels/${RULES_CHANNEL_ID}/messages`, {
    content,
    embeds: [buildRulesEmbed()],
  });
}

async function ensureRulesMessage(options = {}) {
  const forceRepost = !!options.forceRepost;
  const requestedById = options.requestedById ? String(options.requestedById) : "";
  const now = Date.now();

  if (!forceRepost && now - state.lastRulesCheck < RULES_CHECK_MS) {
    return { posted: false, messageId: state.rulesMessageId || "" };
  }

  let existing = null;
  if (state.rulesMessageId) {
    existing = await getMessageById(RULES_CHANNEL_ID, state.rulesMessageId);
    if (existing && !isRulesMessage(existing)) {
      existing = null;
      state.rulesMessageId = "";
      saveState();
    }
  }

  const recentMessages = await discordRequest("GET", `/channels/${RULES_CHANNEL_ID}/messages?limit=100`);
  const list = Array.isArray(recentMessages) ? recentMessages : [];

  const rulesMessages = sortMessagesAsc(
    list.filter((message) => {
      if (!isRulesMessage(message)) return false;
      if (!message || !message.id) return false;
      return true;
    })
  );

  if (!existing && rulesMessages.length) {
    existing = rulesMessages[rulesMessages.length - 1];
    state.rulesMessageId = String(existing.id);
    saveState();
  }

  if (!forceRepost && existing) {
    state.lastRulesCheck = now;
    saveState();
    return { posted: false, messageId: String(existing.id) };
  }

  for (const message of rulesMessages) {
    if (!message || !message.id) continue;
    await deleteMessage(RULES_CHANNEL_ID, String(message.id));
  }

  const posted = await postRulesMessage(requestedById);
  if (posted && posted.id) {
    state.rulesMessageId = String(posted.id);
  }

  state.lastRulesCheck = now;
  saveState();

  return { posted: true, messageId: state.rulesMessageId || "" };
}

function isRulesCommand(content) {
  const text = String(content || "").trim();
  if (!text) return false;
  return /^\/(rules)\b/i.test(text) || /^!(rules)\b/i.test(text);
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

function interactionDisplayName(interaction) {
  const member = interaction && interaction.member ? interaction.member : null;
  const user = (member && member.user) || (interaction && interaction.user) || null;
  if (!user) return "Unknown";
  if (user.global_name) return String(user.global_name);
  if (user.username) return String(user.username);
  return user.id ? `User-${user.id}` : "Unknown";
}

function getSlashOptionValue(interactionData, optionName) {
  const options = interactionData && Array.isArray(interactionData.options) ? interactionData.options : [];
  const option = options.find((item) => item && item.name === optionName);
  return option && typeof option.value !== "undefined" ? String(option.value) : "";
}

function normalizeNameKey(value) {
  return String(value || "").trim().replace(/^@+/, "").toLowerCase();
}

function parseMentionOrUserId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const mention = raw.match(/^<@!?(\d+)>$/);
  if (mention) return mention[1];
  if (/^\d+$/.test(raw)) return raw;
  return "";
}

function summarizeInvites(snapshot) {
  const byId = new Map();
  const byName = new Map();

  for (const entry of Object.values(snapshot && typeof snapshot === "object" ? snapshot : {})) {
    if (!entry || typeof entry !== "object") continue;
    const uses = parseInviteUses(entry.uses);
    const inviterId = entry.inviterId ? String(entry.inviterId) : "";
    const inviterName = entry.inviterName ? String(entry.inviterName) : "Unknown";

    if (inviterId) {
      const current = byId.get(inviterId) || { invites: 0, name: inviterName };
      current.invites += uses;
      if ((!current.name || current.name === "Unknown") && inviterName) {
        current.name = inviterName;
      }
      byId.set(inviterId, current);
    }

    const nameKey = normalizeNameKey(inviterName);
    if (nameKey) {
      byName.set(nameKey, (byName.get(nameKey) || 0) + uses);
    }
  }

  return { byId, byName };
}

async function isAdminByUserId(userId, permissionBitsFromPayload) {
  if (!userId) return false;

  if (typeof permissionBitsFromPayload !== "undefined" && hasModeratorPermissions(permissionBitsFromPayload)) {
    return true;
  }

  const freshMember = await fetchGuildMember(userId);
  if (freshMember) {
    if (typeof freshMember.permissions !== "undefined" && hasModeratorPermissions(freshMember.permissions)) {
      return true;
    }

    const memberRoles = Array.isArray(freshMember.roles) ? freshMember.roles.map((id) => String(id)) : [];
    if (memberRoles.length) {
      try {
        const rolesById = await fetchGuildRoles();
        for (const roleId of memberRoles) {
          const role = rolesById.get(roleId);
          if (!role) continue;
          if (hasModeratorPermissions(role.permissions)) return true;
        }
      } catch {
        // Continue to owner check.
      }
    }
  }

  try {
    const guild = await fetchGuildInfo();
    if (guild && guild.owner_id && String(guild.owner_id) === String(userId)) return true;
  } catch {
    // Ignore owner check failures.
  }

  return false;
}

async function isAdminMessage(message) {
  if (!message || !message.author || !message.author.id) return false;
  const permissionBits = message && message.member ? message.member.permissions : undefined;
  return await isAdminByUserId(String(message.author.id), permissionBits);
}

async function isAdminInteraction(interaction) {
  const userId = interactionUserId(interaction);
  const permissionBits = interaction && interaction.member ? interaction.member.permissions : undefined;
  return await isAdminByUserId(userId, permissionBits);
}

function firstJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    // Try to recover JSON object embedded in text.
  }

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function evaluateHeuristicViolations(message, channelId) {
  const userId = message && message.author && message.author.id ? String(message.author.id) : "";
  if (!userId) return [];

  const content = String((message && message.content) || "").trim();
  const lowered = content.toLowerCase();
  const reasons = [];

  for (const pattern of MODERATION_PATTERNS) {
    if (pattern.regex.test(lowered)) {
      reasons.push(pattern.reason);
    }
  }

  const now = Date.now();
  const history = recentMessagesByUser.get(userId) || [];
  const normalizedContent = lowered.replace(/\s+/g, " ").trim();
  const active = history.filter((entry) => now - entry.timestamp <= MODERATION_LOOKBACK_MS);
  active.push({ timestamp: now, normalizedContent, channelId: String(channelId || "") });
  recentMessagesByUser.set(userId, active.slice(-20));

  if (active.length >= MODERATION_MAX_MESSAGES) {
    reasons.push("spam flood");
  }

  if (normalizedContent) {
    const duplicates = active.filter((entry) => entry.normalizedContent === normalizedContent).length;
    if (duplicates >= 4) {
      reasons.push("repeated spam");
    }
  }

  return Array.from(new Set(reasons));
}

async function classifyMessageWithQwen(message) {
  if (!MODERATION_USE_QWEN) return { violation: false, reason: "" };

  const content = String((message && message.content) || "").trim();
  if (!content) return { violation: false, reason: "" };

  const prompt = [
    "You are a Discord moderation classifier.",
    "Rules:",
    "1) Be respectful. No hate speech, harassment, or threats.",
    "2) No spam or scams.",
    "3) Keep content appropriate and safe.",
    "4) Follow Discord ToS.",
    "Return only strict JSON with this schema:",
    "{\"violation\":true|false,\"reason\":\"short reason\",\"severity\":\"low|medium|high\"}",
    "Set violation=true only when the message clearly breaks a rule.",
    `Message: ${JSON.stringify(content.slice(0, 1200))}`
  ].join("\n");

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        prompt,
        options: {
          temperature: 0,
          num_predict: 80
        },
        keep_alive: "10m",
        think: false
      }),
      signal: AbortSignal.timeout(MODERATION_QWEN_TIMEOUT_MS)
    });

    if (!response.ok) {
      return { violation: false, reason: "" };
    }

    const payload = firstJsonObject(await response.text());
    const rawClassifierText = payload && typeof payload.response === "string" ? payload.response : "";
    const classifier = firstJsonObject(rawClassifierText);
    if (!classifier) {
      return { violation: false, reason: "" };
    }

    const violation = Boolean(classifier.violation);
    const reason = classifier.reason ? String(classifier.reason).trim() : "";
    return { violation, reason };
  } catch {
    return { violation: false, reason: "" };
  }
}

async function timeoutMember(userId) {
  const minutes = Math.max(1, MODERATION_TIMEOUT_MINUTES);
  const timeoutUntil = new Date(Date.now() + minutes * 60 * 1000).toISOString();

  try {
    await discordRequest("PATCH", `/guilds/${GUILD_ID}/members/${userId}`, {
      communication_disabled_until: timeoutUntil
    });
    return true;
  } catch (error) {
    if (isAccessDeniedError(error)) {
      moderationEnabled = false;
      console.warn("Moderation disabled: missing permission to timeout members.");
      return false;
    }
    throw error;
  }
}

async function moderateMessage(channelId, message) {
  if (!moderationEnabled) return;
  if (!message || !message.id || !message.author || !message.author.id) return;
  if (message.author.bot) return;

  const content = String(message.content || "").trim();
  const hasAttachments = Array.isArray(message.attachments) && message.attachments.length > 0;
  if (!content && !hasAttachments) return;

  const isAdmin = await isAdminMessage(message);
  if (isAdmin) return;

  const heuristicReasons = evaluateHeuristicViolations(message, channelId);
  const qwenDecision = await classifyMessageWithQwen(message);
  const reasons = [...heuristicReasons];
  if (qwenDecision.violation) {
    reasons.push(qwenDecision.reason || "rule violation detected by Qwen");
  }

  const uniqueReasons = Array.from(new Set(reasons.filter(Boolean)));
  if (!uniqueReasons.length) return;

  const userId = String(message.author.id);
  const lastAction = recentModerationActions.get(userId) || 0;
  const now = Date.now();
  if (now - lastAction < MODERATION_COOLDOWN_MS) {
    return;
  }

  const reasonText = uniqueReasons.join("; ").slice(0, 180);
  await deleteMessage(channelId, String(message.id));

  const timedOut = await timeoutMember(userId);
  if (!timedOut) return;

  recentModerationActions.set(userId, now);

  await discordRequest("POST", `/channels/${channelId}/messages`, {
    content: `⚠️ <@${userId}> was timed out for ${MODERATION_TIMEOUT_MINUTES} minutes for breaking rules (${reasonText}).`,
  });
}

async function pollCommandChannel(channelId) {
  const lastMessageId = state.commandLastMessageIds[channelId] || "";
  const route = `/channels/${channelId}/messages?limit=50${lastMessageId ? `&after=${lastMessageId}` : ""}`;
  const messages = await discordRequest("GET", route);
  const list = Array.isArray(messages) ? messages : [];

  if (!state.commandBootstrapped[channelId]) {
    if (list.length) {
      const newest = sortMessagesAsc(list).at(-1);
      if (newest && newest.id) state.commandLastMessageIds[channelId] = String(newest.id);
    }
    state.commandBootstrapped[channelId] = true;
    saveState();
    return;
  }

  if (!list.length) return;

  const ordered = sortMessagesAsc(list);
  for (const message of ordered) {
    if (!message || !message.id) continue;

    state.commandLastMessageIds[channelId] = String(message.id);

    const isBotAuthor = !!(message.author && message.author.bot);
    if (isBotAuthor) continue;

    if (!isRulesCommand(message.content || "")) continue;

    const isAdmin = await isAdminMessage(message);
    if (!isAdmin) {
      await discordRequest("POST", `/channels/${channelId}/messages`, {
        content: `<@${message.author.id}> only admins/moderators can run /rules.`,
      });
      continue;
    }

    await ensureRulesMessage({ forceRepost: true, requestedById: message.author.id });

    if (String(channelId) !== String(RULES_CHANNEL_ID)) {
      await discordRequest("POST", `/channels/${channelId}/messages`, {
        content: `Rules were reposted in <#${RULES_CHANNEL_ID}>.`,
      });
    }
  }

  saveState();
}

async function pollModerationChannel(channelId) {
  if (!moderationEnabled) return;

  const lastMessageId = state.moderationLastMessageIds[channelId] || "";
  const route = `/channels/${channelId}/messages?limit=50${lastMessageId ? `&after=${lastMessageId}` : ""}`;
  const messages = await discordRequest("GET", route);
  const list = Array.isArray(messages) ? messages : [];

  if (!state.moderationBootstrapped[channelId]) {
    if (list.length) {
      const newest = sortMessagesAsc(list).at(-1);
      if (newest && newest.id) state.moderationLastMessageIds[channelId] = String(newest.id);
    }
    state.moderationBootstrapped[channelId] = true;
    saveState();
    return;
  }

  if (!list.length) return;

  const ordered = sortMessagesAsc(list);
  for (const message of ordered) {
    if (!message || !message.id) continue;
    state.moderationLastMessageIds[channelId] = String(message.id);
    await moderateMessage(channelId, message);
  }

  saveState();
}

async function handleRulesSlashInteraction(interaction) {
  const channelId = String(interaction && interaction.channel_id ? interaction.channel_id : "");
  const commandChannels = await resolveCommandChannels();

  if (channelId && commandChannels.length && !commandChannels.includes(channelId)) {
    await interactionCallback(interaction.id, interaction.token, {
      type: 4,
      data: {
        flags: 64,
        content: "This command is not enabled in this channel.",
      },
    });
    return;
  }

  const isAdmin = await isAdminInteraction(interaction);
  if (!isAdmin) {
    await interactionCallback(interaction.id, interaction.token, {
      type: 4,
      data: {
        flags: 64,
        content: "Only admins/moderators can run /rules.",
      },
    });
    return;
  }

  const userId = interactionUserId(interaction);
  await ensureRulesMessage({ forceRepost: true, requestedById: userId });

  await interactionCallback(interaction.id, interaction.token, {
    type: 4,
    data: {
      flags: 64,
      content: `Rules were reposted in <#${RULES_CHANNEL_ID}>.`,
    },
  });
}

async function handleInvitesSlashInteraction(interaction) {
  const channelId = String(interaction && interaction.channel_id ? interaction.channel_id : "");
  const commandChannels = await resolveCommandChannels();

  if (channelId && commandChannels.length && !commandChannels.includes(channelId)) {
    await interactionCallback(interaction.id, interaction.token, {
      type: 4,
      data: {
        flags: 64,
        content: "This command is not enabled in this channel.",
      },
    });
    return;
  }

  const requesterId = interactionUserId(interaction);
  const requesterName = interactionDisplayName(interaction);
  const requestedRaw = getSlashOptionValue(interaction.data, "username").trim();
  const requestedId = parseMentionOrUserId(requestedRaw);
  const requestedName = requestedRaw || requesterName;

  let snapshot = {};
  try {
    snapshot = await refreshInviteSnapshot();
  } catch (error) {
    const msg = String(error && error.message ? error.message : error);
    await interactionCallback(interaction.id, interaction.token, {
      type: 4,
      data: {
        flags: 64,
        content: `Invite lookup failed: ${msg.slice(0, 240)}`,
      },
    });
    return;
  }

  if (!inviteTrackingEnabled && Object.keys(snapshot || {}).length === 0) {
    await interactionCallback(interaction.id, interaction.token, {
      type: 4,
      data: {
        flags: 64,
        content: "Invite tracking is unavailable. Grant the bot **Manage Server** permission to read invites.",
      },
    });
    return;
  }

  const summary = summarizeInvites(snapshot);
  let invites = 0;
  let targetName = requestedName;
  let targetMention = "";
  let found = false;

  const fallbackRequesterId = requestedId || requesterId;
  if (fallbackRequesterId && summary.byId.has(fallbackRequesterId)) {
    const item = summary.byId.get(fallbackRequesterId);
    invites = Number(item && item.invites ? item.invites : 0);
    targetName = item && item.name ? String(item.name) : targetName;
    targetMention = `<@${fallbackRequesterId}>`;
    found = true;
  } else if (requestedRaw) {
    const key = normalizeNameKey(requestedRaw);
    if (key && summary.byName.has(key)) {
      invites = Number(summary.byName.get(key) || 0);
      targetName = requestedRaw.replace(/^@+/, "");
      found = true;
    }
  } else {
    targetMention = requesterId ? `<@${requesterId}>` : "";
  }

  if (!found && !requestedRaw && fallbackRequesterId && summary.byId.has(fallbackRequesterId)) {
    const item = summary.byId.get(fallbackRequesterId);
    invites = Number(item && item.invites ? item.invites : 0);
    targetName = item && item.name ? String(item.name) : targetName;
    targetMention = `<@${fallbackRequesterId}>`;
    found = true;
  }

  const label = targetMention || `**${targetName || "Unknown"}**`;
  const content = found
    ? `${label} has **${invites}** invite${invites === 1 ? "" : "s"}.`
    : `No invite data found for **${targetName || "that user"}** yet.`;

  await interactionCallback(interaction.id, interaction.token, {
    type: 4,
    data: {
      content,
    },
  });
}

async function handleGatewayDispatch(eventType, eventData) {
  if (eventType === "INTERACTION_CREATE") {
    if (!eventData || eventData.type !== 2 || !eventData.data) return;
    const commandName = String(eventData.data.name || "").toLowerCase();
    if (commandName === RULES_COMMAND_NAME) {
      await handleRulesSlashInteraction(eventData);
      return;
    }
    if (commandName === INVITES_COMMAND_NAME) {
      await handleInvitesSlashInteraction(eventData);
      return;
    }
    return;
  }

  if (eventType === "GUILD_MEMBER_ADD") {
    if (!eventData || String(eventData.guild_id || "") !== String(GUILD_ID)) return;

    const inviteContext = await resolveInviteContextForJoin();
    await postWelcome(eventData, inviteContext);
  }
}

let presence = null;

function createPresence(intents) {
  return startDiscordPresence({
    token: BOT_TOKEN,
    intents,
    status: "online",
    logPrefix: "Antarctic Community",
    activity: {
      name: "Antarctic rules",
      type: 3,
    },
    onReady: async () => {
      try {
        await syncSlashCommands();
      } catch (error) {
        if (isUnauthorizedDiscordError(error)) {
          console.error("Community bot token unauthorized during slash command sync. Stopping bot.");
          shutdown(1);
          return;
        }
        throw error;
      }
    },
    onDispatch: handleGatewayDispatch,
    onFatal: ({ code }) => {
      if ((code === 4013 || code === 4014) && intents !== 1) {
        console.warn(
          "Community gateway intents were rejected; falling back to intents=1 " +
          "to prevent reconnect spam. Set DISCORD_COMMUNITY_GATEWAY_INTENTS=1 " +
          "or enable privileged intents in the Discord Developer Portal."
        );
        activeGatewayIntents = 1;
        try {
          if (presence && typeof presence.stop === "function") {
            presence.stop();
          }
        } catch {
          // Ignore cleanup errors.
        }
        presence = createPresence(1);
      }
    },
});
}

presence = createPresence(activeGatewayIntents);

async function initialize() {
  await resolveGuildId();
  await resolveCommandChannels();
  await resolveModerationChannels();
  botUser = await discordRequest("GET", "/users/@me");

  await refreshInviteSnapshot().catch((error) => {
    const msg = String(error && error.message ? error.message : error);
    console.warn(`Invite snapshot init error: ${msg}`);
  });

  try {
    const members = await fetchAllMembers(GUILD_ID);
    const ids = members.map(extractMemberId).filter(Boolean);

    if (!state.bootstrapped) {
      state.knownMemberIds = limitKnownMembers(Array.from(new Set(ids)));
      state.bootstrapped = true;
      saveState();
    }
  } catch (error) {
    if (!isAccessDeniedError(error)) {
      throw error;
    }
    memberPollingEnabled = false;
    state.bootstrapped = true;
    saveState();
    console.warn(
      "Community bot cannot list guild members (Missing Access). " +
      "Welcome messages are disabled until Server Members Intent/permissions are fixed."
    );
  }

  await ensureRulesMessage();
  await syncSlashCommands();

  console.log(
    `Community bot ready as ${botUser && botUser.username ? botUser.username : "bot"} in guild ${GUILD_ID}` +
    (memberPollingEnabled ? "" : " (rules-only mode)")
  );
  console.log(
    `Community polling: loop ${POLL_MS}ms, member sync ${MEMBER_SYNC_MS}ms, gateway intents ${activeGatewayIntents}`
  );
  console.log(`Community /rules command channels: ${COMMAND_CHANNEL_IDS.join(", ")}`);
  console.log(`Community moderation channels: ${MODERATION_CHANNEL_IDS.join(", ")}`);
}

async function pollLoop() {
  while (true) {
    try {
      const shouldSyncMembers =
        memberPollingEnabled && (!lastMemberSyncAt || (Date.now() - lastMemberSyncAt) >= MEMBER_SYNC_MS);

      if (shouldSyncMembers) {
        const members = await fetchAllMembers(GUILD_ID);
        const membersById = new Map();
        for (const member of members) {
          const memberId = extractMemberId(member);
          if (!memberId) continue;
          membersById.set(memberId, member);
        }

        const currentIds = members.map(extractMemberId).filter(Boolean);
        const knownSet = new Set(state.knownMemberIds.map(String));
        const newMembers = currentIds.filter((id) => !knownSet.has(String(id)));

        let inviteQueue = [];
        if (newMembers.length > 0) {
          const previousInviteSnapshot = state.inviteSnapshot && typeof state.inviteSnapshot === "object"
            ? state.inviteSnapshot
            : {};
          const refreshedInviteSnapshot = await refreshInviteSnapshot().catch((error) => {
            const msg = String(error && error.message ? error.message : error);
            console.warn(`Invite snapshot refresh error: ${msg}`);
            return previousInviteSnapshot;
          });
          inviteQueue = buildInviteAttributionQueue(previousInviteSnapshot, refreshedInviteSnapshot);
        }
        for (const memberId of sortSnowflakeAsc(newMembers)) {
          const member = membersById.get(String(memberId)) || { user: { id: memberId, username: `User-${memberId}` } };
          const inviteContext = inviteQueue.length
            ? inviteQueue.shift()
            : { inviterId: "", inviterName: "Unknown", invites: 0 };
          await postWelcome(member, inviteContext);
        }

        state.knownMemberIds = limitKnownMembers(Array.from(new Set(currentIds.map(String))));
        lastMemberSyncAt = Date.now();
        saveState();
      }

      await ensureRulesMessage();

      if (moderationEnabled) {
        const moderationChannels = await resolveModerationChannels();
        for (const channelId of moderationChannels) {
          try {
            await pollModerationChannel(channelId);
          } catch (error) {
            if (isUnauthorizedDiscordError(error)) {
              throw error;
            }
            const msg = error && error.message ? error.message : String(error);
            console.error(`Community moderation poll error in ${channelId}: ${msg}`);
          }
        }
      }

      const commandChannels = await resolveCommandChannels();
      for (const channelId of commandChannels) {
        try {
          await pollCommandChannel(channelId);
        } catch (error) {
          if (isUnauthorizedDiscordError(error)) {
            throw error;
          }
          const msg = error && error.message ? error.message : String(error);
          console.error(`Community command poll error in ${channelId}: ${msg}`);
        }
      }
    } catch (error) {
      const msg = error && error.message ? error.message : String(error);
      if (isUnauthorizedDiscordError(error)) {
        console.error(`Community bot token unauthorized: ${msg}`);
        console.error("Stopping community bot to prevent repeated unauthorized requests.");
        shutdown(1);
        return;
      }
      if (memberPollingEnabled && isAccessDeniedError(error)) {
        memberPollingEnabled = false;
        console.warn(
          "Community bot lost member-list access (Missing Access). " +
          "Continuing in rules-only mode."
        );
      } else {
        console.error(`Community bot poll error: ${msg}`);
      }
    }

    await sleep(POLL_MS);
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

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

initialize()
  .then(pollLoop)
  .catch((error) => {
    console.error(error && error.message ? error.message : String(error));
    shutdown(1);
  });

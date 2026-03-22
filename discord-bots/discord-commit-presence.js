#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const { startDiscordPresence } = require("./discord-gateway-presence");

const OFFICIAL_REPO_FALLBACK = "Palladium-Games/Antarctic-Games";
const OFFICIAL_BRANCH_FALLBACK = "main";
const DISCORD_API_BASE = process.env.DISCORD_API_BASE || "https://discord.com/api/v10";
const GITHUB_API_BASE = (process.env.DISCORD_COMMIT_GITHUB_API_BASE || "https://api.github.com").replace(/\/+$/, "");
const FETCH_LIMIT = Math.max(5, Math.min(40, Number(process.env.DISCORD_COMMIT_FETCH_LIMIT || 20)));
const POST_ON_BOOTSTRAP = String(process.env.DISCORD_COMMIT_POST_ON_BOOTSTRAP || "true").toLowerCase() !== "false";
const BOOTSTRAP_POST_COUNT = Math.max(1, Math.min(5, Number(process.env.DISCORD_COMMIT_BOOTSTRAP_POST_COUNT || 1)));
const STATE_PATH = process.env.DISCORD_COMMIT_STATE_PATH || path.join(__dirname, "..", ".discord-commit-bot-state.json");

function tryReadGitConfig(key) {
  if (!key) return "";
  try {
    return execSync(`git config --get ${key}`, {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    })
      .replace(/\r/g, "")
      .trim();
  } catch {
    return "";
  }
}

function tryReadCurrentBranch() {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    })
      .replace(/\r/g, "")
      .trim();
  } catch {
    return "";
  }
}

function tryReadOriginRemote() {
  return tryReadGitConfig("remote.origin.url");
}

function parseGithubRepo(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const shortMatch = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (shortMatch) {
    return { owner: shortMatch[1], name: shortMatch[2] };
  }

  const sshMatch = raw.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    return { owner: sshMatch[1], name: sshMatch[2] };
  }

  const httpsMatch = raw.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (httpsMatch) {
    return { owner: httpsMatch[1], name: httpsMatch[2] };
  }

  return null;
}

function normalizeBranchName(value) {
  const branch = String(value || "").trim();
  if (!branch || branch.toUpperCase() === "HEAD") {
    return "";
  }
  return branch;
}

function normalizeSnowflake(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return /^[0-9]{15,25}$/.test(raw) ? raw : "";
}

function truncate(value, max = 1000) {
  const text = String(value || "");
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function cleanMessageFirstLine(message) {
  return String(message || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) || "No commit message";
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

function saveState(state) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (error) {
    const msg = String(error && error.message ? error.message : error);
    console.warn(`Unable to persist commit bot state at ${STATE_PATH}: ${msg}`);
  }
}

const BOT_TOKEN = normalizeDiscordToken(
  process.env.DISCORD_COMMIT_BOT_TOKEN ||
  process.env.DISCORD_BOT_TOKEN ||
  tryReadGitConfig("discord.commitBotToken") ||
  tryReadGitConfig("discord.botToken") ||
  ""
);

const CHANNEL_ID =
  process.env.DISCORD_COMMIT_CHANNEL_ID ||
  tryReadGitConfig("discord.commitChannelId") ||
  "";
const COMMIT_PING_ROLE_NAME = String(
  process.env.DISCORD_COMMIT_PING_ROLE_NAME ||
    tryReadGitConfig("discord.commitPingRoleName") ||
    "Dev Following"
).trim();
const COMMIT_PING_ROLE_ID = normalizeSnowflake(
  process.env.DISCORD_COMMIT_PING_ROLE_ID ||
    tryReadGitConfig("discord.commitPingRoleId") ||
    ""
);

const GITHUB_TOKEN =
  process.env.DISCORD_COMMIT_GITHUB_TOKEN ||
  process.env.GITHUB_TOKEN ||
  tryReadGitConfig("discord.commitGithubToken") ||
  "";
const HAS_GITHUB_TOKEN = Boolean(String(GITHUB_TOKEN || "").trim());
const DEFAULT_POLL_MS = HAS_GITHUB_TOKEN ? 15_000 : 120_000;
const POLL_MS = Math.max(5000, Number(process.env.DISCORD_COMMIT_POLL_MS || DEFAULT_POLL_MS));

const resolvedRepo =
  parseGithubRepo(process.env.DISCORD_COMMIT_REPO || "") ||
  parseGithubRepo(tryReadGitConfig("discord.commitRepo")) ||
  parseGithubRepo(tryReadOriginRemote()) ||
  parseGithubRepo(OFFICIAL_REPO_FALLBACK);

const CONFIGURED_BRANCH = normalizeBranchName(
  process.env.DISCORD_COMMIT_BRANCH ||
  tryReadGitConfig("discord.commitBranch") ||
  tryReadCurrentBranch() ||
  OFFICIAL_BRANCH_FALLBACK
);

if (!BOT_TOKEN) {
  console.error("Missing commit bot token. Set DISCORD_COMMIT_BOT_TOKEN or git config discord.commitBotToken.");
  process.exit(1);
}

if (!CHANNEL_ID) {
  console.error("Missing DISCORD_COMMIT_CHANNEL_ID (or git config discord.commitChannelId).");
  process.exit(1);
}

if (!resolvedRepo) {
  console.error(
    "Missing GitHub repo. Set DISCORD_COMMIT_REPO to owner/repo or configure remote.origin.url to a GitHub repository."
  );
  process.exit(1);
}

const REPO = `${resolvedRepo.owner}/${resolvedRepo.name}`;
const REPO_LABEL = String(resolvedRepo.name || "repository").toUpperCase();
const state = loadState();
if (!state.byRef || typeof state.byRef !== "object") state.byRef = {};
let activeBranch = CONFIGURED_BRANCH || "main";
let defaultBranchCache = "";
let channelGuildIdCache = "";
let mentionRoleIdCache = COMMIT_PING_ROLE_ID;
let mentionRoleResolutionAttempted = Boolean(mentionRoleIdCache);

function branchRefKey(branch = activeBranch) {
  return `${REPO}#${branch}`;
}

function getLastSha() {
  return String(state.byRef[branchRefKey()] || state.lastSha || "").trim();
}

function setLastSha(sha) {
  const normalized = String(sha || "").trim();
  if (!normalized) return;
  state.byRef[branchRefKey()] = normalized;
  state.lastSha = normalized;
  saveState(state);
}

function githubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Antarctic-Commit-Bot/1.0"
  };
  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }
  return headers;
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

async function githubRequest(route) {
  while (true) {
    const response = await fetch(`${GITHUB_API_BASE}${route}`, {
      method: "GET",
      headers: githubHeaders()
    });

    if (response.status === 429) {
      await sleep(2000);
      continue;
    }

    if (response.status === 403) {
      const resetEpoch = Number(response.headers.get("x-ratelimit-reset") || 0);
      const remaining = Number(response.headers.get("x-ratelimit-remaining") || 0);
      if (remaining === 0 && resetEpoch > 0) {
        const waitMs = Math.max(1000, resetEpoch * 1000 - Date.now());
        await sleep(Math.min(waitMs, 60000));
        continue;
      }
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`GitHub ${route} failed (${response.status}): ${text}`);
    }

    return response.json();
  }
}

async function fetchRepoDefaultBranch() {
  if (defaultBranchCache) {
    return defaultBranchCache;
  }

  const payload = await githubRequest(`/repos/${resolvedRepo.owner}/${resolvedRepo.name}`);
  const fromApi = normalizeBranchName(payload && payload.default_branch ? payload.default_branch : "");
  if (fromApi) {
    defaultBranchCache = fromApi;
  }
  return defaultBranchCache;
}

function isBranchNotFoundError(error) {
  const message = String(error && error.message ? error.message : error);
  return message.includes("commits?sha=") && message.includes("failed (404)");
}

function withActiveBranch(routeTemplate, branch) {
  return routeTemplate.replace("{branch}", encodeURIComponent(branch));
}

async function fetchRecentCommits() {
  const branchCandidates = [];
  let repoDefaultBranch = "";
  const pushBranch = (branch) => {
    const normalized = normalizeBranchName(branch);
    if (!normalized) return;
    if (!branchCandidates.includes(normalized)) {
      branchCandidates.push(normalized);
    }
  };

  try {
    repoDefaultBranch = normalizeBranchName(await fetchRepoDefaultBranch());
    pushBranch(repoDefaultBranch);
  } catch (error) {
    const msg = String(error && error.message ? error.message : error);
    console.warn(`Unable to fetch repo default branch for ${REPO}: ${msg}`);
  }

  pushBranch(activeBranch);
  pushBranch("main");
  pushBranch("master");

  let lastError = null;
  const results = [];

  for (const candidate of branchCandidates) {
    const route = withActiveBranch(
      `/repos/${resolvedRepo.owner}/${resolvedRepo.name}/commits?sha={branch}&per_page=${FETCH_LIMIT}`,
      candidate
    );

    try {
      const payload = await githubRequest(route);
      results.push({
        branch: candidate,
        commits: Array.isArray(payload) ? payload : []
      });
    } catch (error) {
      lastError = error;
      if (!isBranchNotFoundError(error)) {
        throw error;
      }
    }
  }

  if (!results.length) {
    throw lastError || new Error(`Unable to resolve a valid branch for ${REPO}.`);
  }

  const commitTimestamp = (commit) => {
    const rawDate =
      (commit && commit.commit && commit.commit.author && commit.commit.author.date) ||
      (commit && commit.commit && commit.commit.committer && commit.commit.committer.date) ||
      "";
    const parsed = Date.parse(String(rawDate || ""));
    return Number.isFinite(parsed) ? parsed : 0;
  };

  let chosen = results[0];
  for (const result of results) {
    const chosenHead = chosen.commits[0] || null;
    const currentHead = result.commits[0] || null;
    const chosenTime = commitTimestamp(chosenHead);
    const currentTime = commitTimestamp(currentHead);
    if (currentTime > chosenTime) {
      chosen = result;
    }
  }

  if (repoDefaultBranch) {
    const defaultResult = results.find((result) => result.branch === repoDefaultBranch);
    if (defaultResult && !defaultResult.commits.length && chosen.commits.length) {
      // Keep chosen branch with commits when default branch is empty.
    } else if (defaultResult && defaultResult.commits.length) {
      const defaultTime = commitTimestamp(defaultResult.commits[0]);
      const chosenTime = commitTimestamp((chosen.commits && chosen.commits[0]) || null);
      if (defaultTime >= chosenTime) {
        chosen = defaultResult;
      }
    }
  }

  if (chosen.branch !== activeBranch) {
    console.warn(`Commit bot switched branches: ${activeBranch} -> ${chosen.branch} for ${REPO}.`);
    activeBranch = chosen.branch;
  }

  return chosen.commits;
}

async function fetchCommitDetail(sha) {
  const route = `/repos/${resolvedRepo.owner}/${resolvedRepo.name}/commits/${encodeURIComponent(sha)}`;
  return githubRequest(route);
}

async function discordRequest(method, route, body) {
  while (true) {
    const response = await fetch(`${DISCORD_API_BASE}${route}`, {
      method,
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined
    });

    if (response.status === 429) {
      let retryMs = 1500;
      try {
        const payload = await response.json();
        if (payload && typeof payload.retry_after === "number") {
          retryMs = Math.ceil(payload.retry_after * 1000);
        }
      } catch {
        // Ignore and use fallback retry.
      }
      await sleep(retryMs);
      continue;
    }

    if (response.status === 401) {
      const text = await response.text().catch(() => "");
      const error = new Error(`Discord ${method} ${route} failed (401): ${text || "Unauthorized"}`);
      error.code = "DISCORD_UNAUTHORIZED";
      throw error;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const error = new Error(`Discord ${method} ${route} failed (${response.status}): ${text}`);
      error.code = `DISCORD_HTTP_${response.status}`;
      throw error;
    }

    if (response.status === 204) return null;
    const contentType = String(response.headers.get("content-type") || "");
    if (contentType.includes("application/json")) {
      return response.json().catch(() => null);
    }
    return response.text().catch(() => null);
  }
}

async function fetchCommitChannelGuildId() {
  if (channelGuildIdCache) return channelGuildIdCache;
  const channel = await discordRequest("GET", `/channels/${CHANNEL_ID}`);
  const guildId = normalizeSnowflake(channel && channel.guild_id ? channel.guild_id : "");
  if (!guildId) return "";
  channelGuildIdCache = guildId;
  return channelGuildIdCache;
}

async function resolveCommitMentionRoleId() {
  if (mentionRoleIdCache) return mentionRoleIdCache;
  if (mentionRoleResolutionAttempted) return "";
  mentionRoleResolutionAttempted = true;

  if (!COMMIT_PING_ROLE_NAME) return "";

  let guildId = "";
  try {
    guildId = await fetchCommitChannelGuildId();
  } catch (error) {
    console.warn(`Unable to resolve commit channel guild id: ${String(error && error.message ? error.message : error)}`);
    return "";
  }
  if (!guildId) {
    console.warn("Unable to resolve commit mention role because the commit channel has no guild_id.");
    return "";
  }

  try {
    const roles = await discordRequest("GET", `/guilds/${guildId}/roles`);
    if (!Array.isArray(roles)) return "";
    const loweredTarget = COMMIT_PING_ROLE_NAME.toLowerCase();
    const role = roles.find((candidate) => {
      const name = String(candidate && candidate.name ? candidate.name : "").trim().toLowerCase();
      return name === loweredTarget;
    });
    const roleId = normalizeSnowflake(role && role.id ? role.id : "");
    if (!roleId) {
      console.warn(`Commit mention role '${COMMIT_PING_ROLE_NAME}' was not found in guild ${guildId}.`);
      return "";
    }
    mentionRoleIdCache = roleId;
    console.log(`Commit bot mention role resolved: ${COMMIT_PING_ROLE_NAME} (${mentionRoleIdCache}).`);
    return mentionRoleIdCache;
  } catch (error) {
    console.warn(
      `Unable to resolve commit mention role '${COMMIT_PING_ROLE_NAME}': ${String(error && error.message ? error.message : error)}`
    );
    return "";
  }
}

function buildCommitEmbed(commitSummary, commitDetail) {
  const sha = String(commitSummary && commitSummary.sha ? commitSummary.sha : "");
  const shortSha = sha ? sha.slice(0, 7) : "unknown";
  const htmlUrl =
    String(commitSummary && commitSummary.html_url ? commitSummary.html_url : "") ||
    `https://github.com/${REPO}/commit/${sha}`;

  const message = cleanMessageFirstLine(
    (commitDetail && commitDetail.commit && commitDetail.commit.message) ||
      (commitSummary && commitSummary.commit && commitSummary.commit.message) ||
      ""
  );

  const author =
    String(
      (commitSummary && commitSummary.author && commitSummary.author.login) ||
        (commitDetail && commitDetail.author && commitDetail.author.login) ||
        (commitSummary && commitSummary.commit && commitSummary.commit.author && commitSummary.commit.author.name) ||
        "Unknown"
    ) || "Unknown";

  const commitDate =
    (commitSummary && commitSummary.commit && commitSummary.commit.author && commitSummary.commit.author.date) ||
    new Date().toISOString();

  const files = Array.isArray(commitDetail && commitDetail.files) ? commitDetail.files : [];
  const filesChanged = Number.isFinite(commitDetail && commitDetail.files && commitDetail.files.length)
    ? commitDetail.files.length
    : 0;
  const fileLines = files.slice(0, 10).map((file) => `• ${file.filename}`);
  if (files.length > 10) {
    fileLines.push(`• +${files.length - 10} more`);
  }
  const fileList = fileLines.length > 0 ? fileLines.join("\n") : "No file metadata available";

  return {
    title: `New Commit in ${REPO_LABEL}`,
    url: htmlUrl,
    color: 0x2563eb,
    fields: [
      { name: "Commit", value: `[\`${shortSha}\`](${htmlUrl})`, inline: true },
      { name: "Branch", value: activeBranch, inline: true },
      { name: "Posted By", value: author, inline: true },
      { name: "Files Changed", value: String(filesChanged), inline: true },
      { name: "Commit Message", value: truncate(message, 900), inline: false },
      { name: "File List", value: truncate(fileList, 1000), inline: false }
    ],
    timestamp: commitDate
  };
}

async function postCommit(commitSummary) {
  let detail = null;
  try {
    detail = await fetchCommitDetail(commitSummary.sha);
  } catch (error) {
    console.warn(`Failed to load commit details for ${commitSummary.sha}: ${String(error && error.message ? error.message : error)}`);
  }

  const mentionRoleId = await resolveCommitMentionRoleId();
  const payload = {
    embeds: [buildCommitEmbed(commitSummary, detail)],
    allowed_mentions: mentionRoleId
      ? { parse: [], roles: [mentionRoleId] }
      : { parse: [] }
  };
  if (mentionRoleId) {
    payload.content = `<@&${mentionRoleId}>`;
  }

  await discordRequest("POST", `/channels/${CHANNEL_ID}/messages`, payload);
}

async function pollRemoteCommits() {
  const commits = await fetchRecentCommits();
  if (!commits.length) return;

  const newestSha = String(commits[0].sha || "").trim();
  const lastSha = getLastSha();
  if (!newestSha) return;

  if (!lastSha) {
    if (POST_ON_BOOTSTRAP) {
      const toPost = commits.slice(0, BOOTSTRAP_POST_COUNT).reverse();
      for (const commit of toPost) {
        await postCommit(commit);
      }
      console.log(
        `Commit bot bootstrap posted ${toPost.length} commit update(s) (${REPO}@${activeBranch}).`
      );
    }

    setLastSha(newestSha);
    console.log(`Commit bot bootstrapped at ${newestSha.slice(0, 7)} (${REPO}@${activeBranch}).`);
    return;
  }

  if (lastSha === newestSha) return;

  const pending = [];
  for (const commit of commits) {
    const sha = String(commit && commit.sha ? commit.sha : "").trim();
    if (!sha) continue;
    if (sha === lastSha) break;
    pending.push(commit);
  }

  if (!pending.length) {
    pending.push(commits[0]);
  }

  pending.reverse();
  for (const commit of pending) {
    await postCommit(commit);
    setLastSha(commit.sha);
  }

  console.log(`Posted ${pending.length} new remote commit update(s) for ${REPO}@${activeBranch}.`);
}

const presence = startDiscordPresence({
  token: BOT_TOKEN,
  intents: 0,
  status: "online",
  logPrefix: "Antarctic Commits",
  activity: {
    name: "Antarctic commits",
    type: 3
  }
});

function shutdown(code) {
  try {
    presence.stop();
  } catch {
    // Ignore shutdown issues.
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log(
  `Antarctic commit bot running for ${REPO}@${activeBranch} (poll ${POLL_MS}ms, channel ${CHANNEL_ID}, state ${STATE_PATH}).`
);
if (COMMIT_PING_ROLE_ID) {
  console.log(`Commit update mention role ID configured: ${COMMIT_PING_ROLE_ID}.`);
} else if (COMMIT_PING_ROLE_NAME) {
  console.log(`Commit update mention role name configured: ${COMMIT_PING_ROLE_NAME}.`);
}
if (!HAS_GITHUB_TOKEN) {
  console.warn(
    "Commit bot is running without DISCORD_COMMIT_GITHUB_TOKEN/GITHUB_TOKEN. " +
    "Using slower polling to reduce GitHub rate-limit issues."
  );
}

(async function loop() {
  while (true) {
    try {
      await pollRemoteCommits();
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      console.error(`Commit poll error: ${message}`);
      if (isUnauthorizedDiscordError(error)) {
        console.error("Commit bot token unauthorized. Stopping bot to prevent repeated 401 requests.");
        shutdown(1);
        return;
      }
    }
    await sleep(POLL_MS);
  }
})();

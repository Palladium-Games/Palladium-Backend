#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const { AntarcticCommunityStore } = require("../services/community-sqlite-store");
const { AntarcticSupabaseCommunityStore } = require("../services/community-supabase-store");
const { migrateCommunityStores } = require("../services/community-migration");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_CONFIG_PATH = path.join(ROOT_DIR, "config", "palladium.env");

/**
 * Parses basic `KEY=value` environment files without additional dependencies.
 *
 * @param {string} filePath - Env file path.
 * @returns {Record<string, string>} Parsed key/value pairs.
 */
function readSimpleEnvFile(filePath) {
  const env = {};
  if (!filePath || !fs.existsSync(filePath)) {
    return env;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/g)) {
    const trimmed = String(line || "").trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }

  return env;
}

/**
 * Parses command-line flags for the migration script.
 *
 * @param {string[]} argv - Raw CLI arguments excluding the node and script paths.
 * @returns {{
 *   configPath: string,
 *   resetTarget: boolean,
 *   showHelp: boolean,
 *   sqlitePath: string,
 *   supabaseDbUrl: string
 * }} Parsed options.
 */
function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const options = {
    configPath: "",
    resetTarget: true,
    showHelp: false,
    sqlitePath: "",
    supabaseDbUrl: ""
  };

  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index] || "");
    if (value === "--help" || value === "-h") {
      options.showHelp = true;
      continue;
    }
    if (value === "--no-reset-target") {
      options.resetTarget = false;
      continue;
    }
    if (value === "--config") {
      options.configPath = String(args[index + 1] || "");
      index += 1;
      continue;
    }
    if (value === "--sqlite") {
      options.sqlitePath = String(args[index + 1] || "");
      index += 1;
      continue;
    }
    if (value === "--supabase") {
      options.supabaseDbUrl = String(args[index + 1] || "");
      index += 1;
    }
  }

  return options;
}

/**
 * Resolves a potentially relative filesystem path against the backend root.
 *
 * @param {string} rawPath - Candidate path from env or flags.
 * @returns {string} Absolute path.
 */
function resolveAgainstRoot(rawPath) {
  const normalized = String(rawPath || "").trim();
  if (!normalized) return "";
  return path.isAbsolute(normalized) ? normalized : path.resolve(ROOT_DIR, normalized);
}

/**
 * Prints usage guidance for the migration script.
 */
function printHelp() {
  console.log([
    "Usage: npm run migrate:supabase -- [--config config/palladium.env] [--sqlite target/antarctic-community.sqlite] [--supabase postgresql://...] [--no-reset-target]",
    "",
    "Defaults:",
    "  --config      " + DEFAULT_CONFIG_PATH,
    "  --sqlite      ACCOUNT_SQLITE_PATH from the config file or target/antarctic-community.sqlite",
    "  --supabase    SUPABASE_DB_URL from the config file",
    "",
    "The migration resets the target Supabase tables by default so ids, sessions, rooms, messages, invites, and saves can be copied exactly."
  ].join("\n"));
}

/**
 * Renders a human-readable migration summary.
 *
 * @param {{ resetTarget: boolean, tables: Record<string, { rows: number }>, totalRows: number }} summary - Migration summary.
 * @returns {string} Summary text.
 */
function renderSummary(summary) {
  const tableLines = Object.keys(summary.tables || {})
    .map((tableName) => `  ${tableName}: ${summary.tables[tableName].rows}`)
    .join("\n");

  return [
    "Antarctic Supabase migration complete.",
    `Reset target: ${summary.resetTarget ? "yes" : "no"}`,
    `Total rows copied: ${summary.totalRows}`,
    "Per-table rows:",
    tableLines
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.showHelp) {
    printHelp();
    return;
  }

  const configPath = resolveAgainstRoot(options.configPath || process.env.PALLADIUM_CONFIG || DEFAULT_CONFIG_PATH);
  const configEnv = readSimpleEnvFile(configPath);
  const mergedEnv = Object.assign({}, configEnv, process.env);

  const sqlitePath = resolveAgainstRoot(
    options.sqlitePath ||
      mergedEnv.ACCOUNT_SQLITE_PATH ||
      path.join("target", "antarctic-community.sqlite")
  );
  const supabaseDbUrl = String(options.supabaseDbUrl || mergedEnv.SUPABASE_DB_URL || "").trim();

  if (!sqlitePath || !fs.existsSync(sqlitePath)) {
    throw new Error(`Could not find the source SQLite database: ${sqlitePath || "(missing path)"}`);
  }
  if (!supabaseDbUrl) {
    throw new Error("Missing SUPABASE_DB_URL. Set it in config/palladium.env or pass --supabase.");
  }

  const sourceStore = await new AntarcticCommunityStore({ dbPath: sqlitePath }).initialize();
  const targetStore = await new AntarcticSupabaseCommunityStore({ connectionString: supabaseDbUrl }).initialize();

  try {
    const summary = await migrateCommunityStores({
      sourceStore,
      targetStore,
      resetTarget: options.resetTarget
    });
    console.log(renderSummary(summary));
  } finally {
    await sourceStore.flush();
    await targetStore.close();
  }
}

main().catch((error) => {
  console.error(String(error && error.stack ? error.stack : error));
  process.exitCode = 1;
});

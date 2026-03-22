const { AntarcticCommunityStore } = require("./community-sqlite-store");
const { AntarcticSupabaseCommunityStore } = require("./community-supabase-store");

/**
 * Builds the configured community store implementation for the backend runtime.
 *
 * @param {object} config - Backend configuration.
 * @param {"auto"|"sqlite"|"supabase"} [config.accountProvider="auto"] - Requested persistence provider.
 * @param {string} [config.accountSqlitePath] - SQLite path used by the legacy provider.
 * @param {string} [config.supabaseDbUrl] - Supabase Postgres connection string.
 * @param {number} [config.accountSessionTtlDays=30] - Number of days a session remains valid.
 * @param {() => Date|number|string} [config.now] - Injectable clock for tests.
 * @returns {{ store: object, status: string, provider: string }} Store instance plus human-readable status.
 */
function createCommunityStore(config) {
  const provider = String(config && config.accountProvider ? config.accountProvider : "auto").trim().toLowerCase() || "auto";
  const normalizedProvider = provider === "supabase" || provider === "sqlite" ? provider : "auto";
  const supabaseDbUrl = String(config && config.supabaseDbUrl ? config.supabaseDbUrl : "").trim();

  if (normalizedProvider === "supabase" || (normalizedProvider === "auto" && supabaseDbUrl)) {
    return {
      store: new AntarcticSupabaseCommunityStore({
        connectionString: supabaseDbUrl,
        sessionTtlDays: config.accountSessionTtlDays,
        now: config.now
      }),
      status: "supabase",
      provider: "supabase"
    };
  }

  return {
    store: new AntarcticCommunityStore({
      dbPath: config.accountSqlitePath,
      sessionTtlDays: config.accountSessionTtlDays,
      now: config.now
    }),
    status: `sqlite (${config.accountSqlitePath})`,
    provider: "sqlite"
  };
}

module.exports = {
  createCommunityStore
};

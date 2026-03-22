/**
 * Ordered table definitions for migrating Antarctic community data between stores.
 *
 * Each table definition captures the row order and column set required to preserve
 * ids, foreign keys, sessions, chat history, room invites, and cloud saves.
 *
 * @type {ReadonlyArray<{
 *   name: string,
 *   columns: string[],
 *   orderBy: string,
 *   identityColumn?: string
 * }>}
 */
const COMMUNITY_TABLES = Object.freeze([
  {
    name: "users",
    columns: [
      "id",
      "username",
      "username_normalized",
      "password_hash",
      "password_salt",
      "muted_until",
      "muted_reason",
      "created_at",
      "updated_at"
    ],
    orderBy: "id ASC",
    identityColumn: "id"
  },
  {
    name: "sessions",
    columns: ["id", "user_id", "token", "created_at", "expires_at"],
    orderBy: "id ASC",
    identityColumn: "id"
  },
  {
    name: "threads",
    columns: [
      "id",
      "type",
      "name",
      "visibility",
      "owner_user_id",
      "direct_key",
      "created_at",
      "updated_at"
    ],
    orderBy: "id ASC",
    identityColumn: "id"
  },
  {
    name: "thread_participants",
    columns: ["thread_id", "user_id", "joined_at"],
    orderBy: "thread_id ASC, user_id ASC"
  },
  {
    name: "messages",
    columns: ["id", "thread_id", "user_id", "content", "created_at"],
    orderBy: "id ASC",
    identityColumn: "id"
  },
  {
    name: "direct_requests",
    columns: [
      "id",
      "requester_user_id",
      "target_user_id",
      "status",
      "resolved_thread_id",
      "created_at",
      "updated_at"
    ],
    orderBy: "id ASC",
    identityColumn: "id"
  },
  {
    name: "room_invitations",
    columns: [
      "thread_id",
      "user_id",
      "invited_by_user_id",
      "status",
      "created_at",
      "updated_at"
    ],
    orderBy: "thread_id ASC, user_id ASC"
  },
  {
    name: "game_saves",
    columns: ["id", "user_id", "game_key", "save_data", "summary", "updated_at"],
    orderBy: "id ASC",
    identityColumn: "id"
  }
]);

/**
 * Returns the canonical delete order for target stores.
 *
 * Child tables are cleared before their parents so foreign-key constraints remain valid.
 *
 * @returns {string[]} Ordered table names.
 */
function getResetOrder() {
  return COMMUNITY_TABLES
    .map((definition) => definition.name)
    .slice()
    .reverse();
}

/**
 * Builds a `SELECT` statement for a migration table definition.
 *
 * @param {{ columns: string[], name: string, orderBy: string }} definition - Table definition.
 * @returns {string} SQL query.
 */
function buildSelectSql(definition) {
  return `SELECT ${definition.columns.join(", ")} FROM ${definition.name} ORDER BY ${definition.orderBy}`;
}

/**
 * Builds an `INSERT` statement for a migration table definition.
 *
 * @param {{ columns: string[], name: string }} definition - Table definition.
 * @returns {string} SQL query using `?` placeholders.
 */
function buildInsertSql(definition) {
  return `INSERT INTO ${definition.name} (${definition.columns.join(", ")}) VALUES (${definition.columns.map(() => "?").join(", ")})`;
}

/**
 * Loads the raw rows for one migration table.
 *
 * @param {{ all(sql: string, params?: unknown[]): Promise<object[]>|object[] }} store - Source store.
 * @param {{ columns: string[], name: string, orderBy: string }} definition - Table definition.
 * @returns {Promise<object[]>} Ordered table rows.
 */
async function loadTableRows(store, definition) {
  return await store.all(buildSelectSql(definition), []);
}

/**
 * Returns row counts for every community table in a store.
 *
 * @param {{ get(sql: string, params?: unknown[]): Promise<object>|object }} store - Source or target store.
 * @returns {Promise<Record<string, number>>} Per-table row counts.
 */
async function countCommunityRows(store) {
  const counts = {};
  for (const definition of COMMUNITY_TABLES) {
    const row = await store.get(`SELECT COUNT(*) AS count FROM ${definition.name}`, []);
    counts[definition.name] = Number((row && row.count) || 0);
  }
  return counts;
}

/**
 * Returns whether the target store already contains migrated community rows.
 *
 * @param {{ get(sql: string, params?: unknown[]): Promise<object>|object }} store - Target store.
 * @returns {Promise<boolean>} Whether any table currently has rows.
 */
async function hasAnyCommunityRows(store) {
  const counts = await countCommunityRows(store);
  return Object.values(counts).some((value) => Number(value) > 0);
}

/**
 * Clears all target community tables in foreign-key-safe order.
 *
 * @param {{ run(sql: string, params?: unknown[]): Promise<void>|void }} store - Target store.
 * @returns {Promise<void>}
 */
async function resetTargetTables(store) {
  for (const tableName of getResetOrder()) {
    await store.run(`DELETE FROM ${tableName}`, []);
  }
}

/**
 * Copies one table into the target store while preserving primary keys.
 *
 * @param {{ run(sql: string, params?: unknown[]): Promise<void>|void }} store - Target store.
 * @param {{ columns: string[], name: string }} definition - Table definition.
 * @param {object[]} rows - Ordered source rows.
 * @returns {Promise<void>}
 */
async function insertTableRows(store, definition, rows) {
  if (!rows.length) {
    return;
  }

  const insertSql = buildInsertSql(definition);
  for (const row of rows) {
    const params = definition.columns.map((columnName) =>
      Object.prototype.hasOwnProperty.call(row || {}, columnName) ? row[columnName] : null
    );
    await store.run(insertSql, params);
  }
}

/**
 * Advances a Postgres identity/serial sequence to match the highest imported row id.
 *
 * @param {{
 *   exec(sql: string): Promise<void>|void,
 *   get(sql: string, params?: unknown[]): Promise<object>|object
 * }} store - Target Supabase/Postgres store.
 * @param {{ identityColumn?: string, name: string }} definition - Table definition.
 * @returns {Promise<void>}
 */
async function syncIdentitySequence(store, definition) {
  if (!definition.identityColumn) {
    return;
  }

  const row = await store.get(
    `SELECT COALESCE(MAX(${definition.identityColumn}), 0) AS max_id FROM ${definition.name}`,
    []
  );
  const maxId = Math.max(0, Number((row && row.max_id) || 0));
  if (maxId <= 0) {
    return;
  }

  try {
    await store.get(
      `SELECT setval(pg_get_serial_sequence('${definition.name}', '${definition.identityColumn}'), ?, true) AS current_value`,
      [maxId]
    );
  } catch (error) {
    const message = String(error && error.message ? error.message : error || "");
    if (
      /pg_get_serial_sequence/i.test(message) ||
      /function .*setval/i.test(message) ||
      /relation .*_seq does not exist/i.test(message)
    ) {
      return;
    }
    throw error;
  }
}

/**
 * Migrates every Antarctic community table from the SQLite store into the Supabase/Postgres store.
 *
 * The target schema is assumed to be initialized already. By default the target is cleared
 * first so ids, sessions, threads, and foreign-key references can be copied exactly.
 *
 * @param {object} options - Migration options.
 * @param {{ all(sql: string, params?: unknown[]): Promise<object[]>|object[] }} options.sourceStore - SQLite source store.
 * @param {{
 *   exec(sql: string): Promise<void>|void,
 *   get(sql: string, params?: unknown[]): Promise<object>|object,
 *   run(sql: string, params?: unknown[]): Promise<void>|void
 * }} options.targetStore - Supabase/Postgres target store.
 * @param {boolean} [options.resetTarget=true] - Whether to clear the target store before importing.
 * @returns {Promise<{ resetTarget: boolean, tables: Record<string, { rows: number }>, totalRows: number }>} Migration summary.
 */
async function migrateCommunityStores({ sourceStore, targetStore, resetTarget = true }) {
  if (!sourceStore || typeof sourceStore.all !== "function") {
    throw new Error("A readable source store is required for migration.");
  }
  if (!targetStore || typeof targetStore.run !== "function" || typeof targetStore.get !== "function") {
    throw new Error("A writable target store is required for migration.");
  }

  if (!resetTarget && await hasAnyCommunityRows(targetStore)) {
    throw new Error("Target Supabase store already contains community data. Re-run with reset enabled.");
  }

  if (resetTarget) {
    await resetTargetTables(targetStore);
  }

  const summary = {
    resetTarget: Boolean(resetTarget),
    tables: {},
    totalRows: 0
  };

  for (const definition of COMMUNITY_TABLES) {
    const rows = await loadTableRows(sourceStore, definition);
    await insertTableRows(targetStore, definition, rows);
    await syncIdentitySequence(targetStore, definition);

    summary.tables[definition.name] = {
      rows: rows.length
    };
    summary.totalRows += rows.length;
  }

  return summary;
}

module.exports = {
  COMMUNITY_TABLES,
  countCommunityRows,
  migrateCommunityStores
};

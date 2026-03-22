const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const initSqlJs = require("sql.js");

const DEFAULT_SESSION_TTL_DAYS = 30;
const DEFAULT_ROOM_NAME = "Lobby";
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_PASSWORD_LENGTH = 200;
const MAX_ROOM_NAME_LENGTH = 48;
const MAX_SAVE_BYTES = 500_000;
const MAX_SUMMARY_LENGTH = 140;
const MAX_USERNAME_LENGTH = 24;
const MIN_PASSWORD_LENGTH = 6;
const MIN_USERNAME_LENGTH = 3;

/**
 * Normalizes arbitrary text into a trimmed string.
 *
 * @param {unknown} value - Value to normalize.
 * @returns {string} Trimmed string.
 */
function cleanText(value) {
  return String(value == null ? "" : value).trim();
}

/**
 * Returns the current time as an ISO-8601 string.
 *
 * @param {Date|number|string} [nowValue=new Date()] - Time-like value to format.
 * @returns {string} ISO-8601 timestamp.
 */
function toIsoNow(nowValue = new Date()) {
  return new Date(nowValue).toISOString();
}

/**
 * Generates a random token suitable for sessions.
 *
 * @returns {string} Random session token.
 */
function createToken() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Hashes a password with scrypt.
 *
 * @param {string} password - Password to hash.
 * @param {string} saltHex - Salt encoded as hexadecimal.
 * @returns {string} Password hash encoded as hexadecimal.
 */
function hashPassword(password, saltHex) {
  return crypto.scryptSync(password, Buffer.from(saltHex, "hex"), 64).toString("hex");
}

/**
 * Encodes a direct-message participant pair into a stable unique key.
 *
 * @param {number} firstUserId - First participant id.
 * @param {number} secondUserId - Second participant id.
 * @returns {string} Stable pair key.
 */
function directKeyForUsers(firstUserId, secondUserId) {
  return [Number(firstUserId), Number(secondUserId)].sort((a, b) => a - b).join(":");
}

/**
 * Converts a SQLite statement row into a plain object with public-safe user fields.
 *
 * @param {object} row - Raw SQLite row.
 * @returns {{ id: number, username: string, createdAt: string }} Public user shape.
 */
function toPublicUser(row) {
  return {
    id: Number(row.id),
    username: String(row.username || ""),
    createdAt: String(row.created_at || "")
  };
}

/**
 * SQLite-backed persistence layer for Antarctic accounts, chat threads, and cloud saves.
 */
class AntarcticCommunityStore {
  /**
   * @param {object} options - Store configuration.
   * @param {string} options.dbPath - Absolute or relative SQLite database path.
   * @param {number} [options.sessionTtlDays=30] - Number of days a session remains valid.
   * @param {() => Date|number|string} [options.now=() => new Date()] - Injectable clock for tests.
   */
  constructor({ dbPath, sessionTtlDays = DEFAULT_SESSION_TTL_DAYS, now = () => new Date() }) {
    this.dbPath = path.resolve(String(dbPath || ""));
    this.sessionTtlDays = Math.max(1, Number(sessionTtlDays) || DEFAULT_SESSION_TTL_DAYS);
    this.now = now;
    this.SQL = null;
    this.db = null;
    this.writeChain = Promise.resolve();
  }

  /**
   * Boots the SQLite engine, loads the on-disk database, and runs schema migrations.
   *
   * @returns {Promise<AntarcticCommunityStore>} Initialized store.
   */
  async initialize() {
    await fsp.mkdir(path.dirname(this.dbPath), { recursive: true });

    const sqlJsDir = path.dirname(require.resolve("sql.js/dist/sql-wasm.js"));
    this.SQL = await initSqlJs({
      locateFile(file) {
        return path.join(sqlJsDir, file);
      }
    });

    const existingBytes = await this.readExistingBytes();
    this.db = existingBytes ? new this.SQL.Database(existingBytes) : new this.SQL.Database();

    this.runSchemaMigrations();
    this.ensureDefaultRoom();
    await this.flush();
    return this;
  }

  /**
   * Creates a new account, session, and default-room membership.
   *
   * @param {object} payload - Signup payload.
   * @param {string} payload.username - Desired username.
   * @param {string} payload.password - Plaintext password.
   * @returns {Promise<{ token: string, user: { id: number, username: string, createdAt: string } }>} Auth result.
   */
  async signUp({ username, password }) {
    const normalizedUsername = this.normalizeUsername(username);
    const normalizedPassword = this.normalizePassword(password);
    const nowIso = this.nowIso();

    if (this.findUserByUsername(normalizedUsername)) {
      throw new Error("That username is already taken.");
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = hashPassword(normalizedPassword, salt);
    this.run(
      [
        "INSERT INTO users (username, username_normalized, password_hash, password_salt, created_at, updated_at)",
        "VALUES (?, ?, ?, ?, ?, ?)"
      ].join(" "),
      [normalizedUsername, normalizedUsername.toLowerCase(), hash, salt, nowIso, nowIso]
    );

    const user = this.findUserByUsername(normalizedUsername);
    this.ensureLobbyMembership(Number(user.id));
    const session = this.createSessionForUser(Number(user.id));
    await this.flush();
    return {
      token: session.token,
      user: toPublicUser(user)
    };
  }

  /**
   * Authenticates an existing account and returns a fresh session token.
   *
   * @param {object} payload - Login payload.
   * @param {string} payload.username - Username.
   * @param {string} payload.password - Plaintext password.
   * @returns {Promise<{ token: string, user: { id: number, username: string, createdAt: string } }>} Auth result.
   */
  async login({ username, password }) {
    const normalizedUsername = this.normalizeUsername(username);
    const normalizedPassword = this.normalizePassword(password);
    const user = this.findUserByUsername(normalizedUsername);
    if (!user) {
      throw new Error("Invalid username or password.");
    }

    const expectedHash = hashPassword(normalizedPassword, String(user.password_salt || ""));
    const actualHash = String(user.password_hash || "");
    if (!this.safeHashEquals(actualHash, expectedHash)) {
      throw new Error("Invalid username or password.");
    }

    this.cleanupExpiredSessions();
    this.ensureLobbyMembership(Number(user.id));
    const session = this.createSessionForUser(Number(user.id));
    await this.flush();
    return {
      token: session.token,
      user: toPublicUser(user)
    };
  }

  /**
   * Deletes an active session token.
   *
   * @param {string} token - Session token to revoke.
   * @returns {Promise<void>}
   */
  async logout(token) {
    const normalized = cleanText(token);
    if (!normalized) return;
    this.run("DELETE FROM sessions WHERE token = ?", [normalized]);
    await this.flush();
  }

  /**
   * Resolves an authenticated session token into the current user.
   *
   * @param {string} token - Session token.
   * @returns {Promise<null|{ token: string, user: { id: number, username: string, createdAt: string } }>} Active session or null.
   */
  async getSession(token) {
    const normalized = cleanText(token);
    if (!normalized) return null;

    this.cleanupExpiredSessions();
    const row = this.get(
      [
        "SELECT sessions.token, users.id, users.username, users.created_at",
        "FROM sessions",
        "JOIN users ON users.id = sessions.user_id",
        "WHERE sessions.token = ? AND sessions.expires_at > ?"
      ].join(" "),
      [normalized, this.nowIso()]
    );

    if (!row) {
      await this.flush();
      return null;
    }

    const changed = this.ensureLobbyMembership(Number(row.id));
    if (changed) {
      await this.flush();
    }
    return {
      token: normalized,
      user: toPublicUser(row)
    };
  }

  /**
   * Searches other accounts by username for DM creation.
   *
   * @param {number} currentUserId - Authenticated user id.
   * @param {string} query - Search query.
   * @returns {{ id: number, username: string, createdAt: string }[]} Matching users.
   */
  searchUsers(currentUserId, query) {
    const term = cleanText(query).toLowerCase();
    if (!term) return [];

    return this.all(
      [
        "SELECT id, username, created_at",
        "FROM users",
        "WHERE username_normalized LIKE ?",
        "AND id <> ?",
        "ORDER BY username_normalized ASC",
        "LIMIT 12"
      ].join(" "),
      [`%${term}%`, Number(currentUserId)]
    ).map(toPublicUser);
  }

  /**
   * Returns the room catalog and joined thread list for a user.
   *
   * @param {number} userId - Authenticated user id.
   * @returns {{ threads: object[], rooms: object[] }} Thread catalog.
   */
  listThreadsForUser(userId) {
    const joinedThreadRows = this.all(
      [
        "SELECT threads.id, threads.type, threads.name, threads.owner_user_id, threads.created_at, threads.updated_at,",
        "messages.id AS last_message_id, messages.content AS last_message_content, messages.created_at AS last_message_created_at,",
        "message_author.username AS last_message_author_username,",
        "other_user.id AS other_user_id, other_user.username AS other_user_username",
        "FROM thread_participants participant",
        "JOIN threads ON threads.id = participant.thread_id",
        "LEFT JOIN messages ON messages.id = (",
        "  SELECT id FROM messages WHERE thread_id = threads.id ORDER BY id DESC LIMIT 1",
        ")",
        "LEFT JOIN users AS message_author ON message_author.id = messages.user_id",
        "LEFT JOIN thread_participants other_participant ON other_participant.thread_id = threads.id",
        "  AND other_participant.user_id <> participant.user_id",
        "LEFT JOIN users AS other_user ON other_user.id = other_participant.user_id",
        "WHERE participant.user_id = ?",
        "GROUP BY threads.id",
        "ORDER BY COALESCE(messages.created_at, threads.updated_at, threads.created_at) DESC, threads.id DESC"
      ].join(" "),
      [Number(userId)]
    );

    const rooms = this.all(
      [
        "SELECT threads.id, threads.type, threads.name, threads.owner_user_id, threads.created_at, threads.updated_at,",
        "COUNT(participants.user_id) AS member_count,",
        "SUM(CASE WHEN participants.user_id = ? THEN 1 ELSE 0 END) AS joined",
        "FROM threads",
        "LEFT JOIN thread_participants participants ON participants.thread_id = threads.id",
        "WHERE threads.type = 'room'",
        "GROUP BY threads.id",
        "ORDER BY LOWER(threads.name) ASC, threads.id ASC"
      ].join(" "),
      [Number(userId)]
    ).map((row) => ({
      id: Number(row.id),
      type: "room",
      name: String(row.name || ""),
      memberCount: Number(row.member_count || 0),
      joined: Boolean(Number(row.joined || 0)),
      ownerUserId: Number(row.owner_user_id || 0),
      createdAt: String(row.created_at || ""),
      updatedAt: String(row.updated_at || "")
    }));

    return {
      threads: joinedThreadRows.map((row) => this.toPublicThread(row)),
      rooms
    };
  }

  /**
   * Creates a new public chat room and joins the creator automatically.
   *
   * @param {number} userId - Creating user id.
   * @param {string} roomName - Desired room name.
   * @returns {Promise<object>} Created room thread.
   */
  async createRoom(userId, roomName) {
    const normalizedName = this.normalizeRoomName(roomName);
    const nowIso = this.nowIso();
    this.run(
      [
        "INSERT INTO threads (type, name, owner_user_id, direct_key, created_at, updated_at)",
        "VALUES ('room', ?, ?, NULL, ?, ?)"
      ].join(" "),
      [normalizedName, Number(userId), nowIso, nowIso]
    );
    const threadId = Number(this.get("SELECT last_insert_rowid() AS id").id);
    this.ensureThreadParticipant(threadId, Number(userId));
    await this.flush();
    return this.getThreadForUser(Number(userId), threadId);
  }

  /**
   * Ensures the authenticated user is a participant of a public room.
   *
   * @param {number} userId - User id.
   * @param {number} threadId - Room thread id.
   * @returns {Promise<object>} Joined room thread.
   */
  async joinRoom(userId, threadId) {
    const room = this.get("SELECT * FROM threads WHERE id = ? AND type = 'room'", [Number(threadId)]);
    if (!room) {
      throw new Error("That room does not exist.");
    }

    this.ensureThreadParticipant(Number(threadId), Number(userId));
    this.run("UPDATE threads SET updated_at = ? WHERE id = ?", [this.nowIso(), Number(threadId)]);
    await this.flush();
    return this.getThreadForUser(Number(userId), Number(threadId));
  }

  /**
   * Creates or reuses a direct message thread between two users.
   *
   * @param {number} userId - Authenticated user id.
   * @param {string} username - Target username.
   * @returns {Promise<object>} Direct thread details.
   */
  async createDirectThread(userId, username) {
    const target = this.findUserByUsername(this.normalizeUsername(username));
    if (!target) {
      throw new Error("That user does not exist.");
    }
    if (Number(target.id) === Number(userId)) {
      throw new Error("You are already talking to yourself in your head.");
    }

    const directKey = directKeyForUsers(Number(userId), Number(target.id));
    let thread = this.get("SELECT * FROM threads WHERE direct_key = ?", [directKey]);
    if (!thread) {
      const nowIso = this.nowIso();
      this.run(
        [
          "INSERT INTO threads (type, name, owner_user_id, direct_key, created_at, updated_at)",
          "VALUES ('direct', NULL, ?, ?, ?, ?)"
        ].join(" "),
        [Number(userId), directKey, nowIso, nowIso]
      );
      const threadId = Number(this.get("SELECT last_insert_rowid() AS id").id);
      this.ensureThreadParticipant(threadId, Number(userId));
      this.ensureThreadParticipant(threadId, Number(target.id));
      thread = this.get("SELECT * FROM threads WHERE id = ?", [threadId]);
      await this.flush();
    }

    return this.getThreadForUser(Number(userId), Number(thread.id));
  }

  /**
   * Lists recent messages for a thread the user belongs to.
   *
   * @param {number} userId - Authenticated user id.
   * @param {number} threadId - Thread id.
   * @returns {object[]} Ordered message list.
   */
  listMessages(userId, threadId) {
    const thread = this.getThreadForUser(Number(userId), Number(threadId));
    if (!thread) {
      throw new Error("That conversation is unavailable.");
    }

    return this.all(
      [
        "SELECT messages.id, messages.thread_id, messages.user_id, messages.content, messages.created_at, users.username",
        "FROM messages",
        "JOIN users ON users.id = messages.user_id",
        "WHERE messages.thread_id = ?",
        "ORDER BY messages.id ASC",
        "LIMIT 150"
      ].join(" "),
      [Number(threadId)]
    ).map((row) => ({
      id: Number(row.id),
      threadId: Number(row.thread_id),
      userId: Number(row.user_id),
      username: String(row.username || ""),
      content: String(row.content || ""),
      createdAt: String(row.created_at || "")
    }));
  }

  /**
   * Adds a message to a thread the user belongs to.
   *
   * @param {number} userId - Authenticated user id.
   * @param {number} threadId - Target thread id.
   * @param {string} content - Message content.
   * @returns {Promise<object>} Created message.
   */
  async addMessage(userId, threadId, content) {
    const thread = this.getThreadForUser(Number(userId), Number(threadId));
    if (!thread) {
      throw new Error("That conversation is unavailable.");
    }

    const normalized = cleanText(content);
    if (!normalized) {
      throw new Error("Message content is required.");
    }
    if (normalized.length > MAX_MESSAGE_LENGTH) {
      throw new Error(`Messages must stay under ${MAX_MESSAGE_LENGTH} characters.`);
    }

    const createdAt = this.nowIso();
    this.run(
      "INSERT INTO messages (thread_id, user_id, content, created_at) VALUES (?, ?, ?, ?)",
      [Number(threadId), Number(userId), normalized, createdAt]
    );
    this.run("UPDATE threads SET updated_at = ? WHERE id = ?", [createdAt, Number(threadId)]);
    const messageId = Number(this.get("SELECT last_insert_rowid() AS id").id);
    const author = this.get("SELECT username FROM users WHERE id = ?", [Number(userId)]);
    await this.flush();

    return {
      id: messageId,
      threadId: Number(threadId),
      userId: Number(userId),
      username: String(author && author.username ? author.username : ""),
      content: normalized,
      createdAt
    };
  }

  /**
   * Lists cloud saves available to the current user.
   *
   * @param {number} userId - Authenticated user id.
   * @returns {object[]} Save entries.
   */
  listGameSaves(userId) {
    return this.all(
      [
        "SELECT game_key, summary, updated_at, length(save_data) AS size_bytes",
        "FROM game_saves",
        "WHERE user_id = ?",
        "ORDER BY updated_at DESC, game_key ASC"
      ].join(" "),
      [Number(userId)]
    ).map((row) => ({
      gameKey: String(row.game_key || ""),
      summary: String(row.summary || ""),
      updatedAt: String(row.updated_at || ""),
      sizeBytes: Number(row.size_bytes || 0)
    }));
  }

  /**
   * Reads one saved game snapshot.
   *
   * @param {number} userId - Authenticated user id.
   * @param {string} gameKey - Game identifier, usually the launcher path.
   * @returns {object|null} Save entry or null.
   */
  getGameSave(userId, gameKey) {
    const normalizedKey = this.normalizeGameKey(gameKey);
    const row = this.get(
      "SELECT game_key, save_data, summary, updated_at FROM game_saves WHERE user_id = ? AND game_key = ?",
      [Number(userId), normalizedKey]
    );
    if (!row) return null;

    let parsedData = null;
    try {
      parsedData = JSON.parse(String(row.save_data || "null"));
    } catch {
      parsedData = null;
    }

    return {
      gameKey: String(row.game_key || ""),
      summary: String(row.summary || ""),
      updatedAt: String(row.updated_at || ""),
      data: parsedData
    };
  }

  /**
   * Creates or updates a cloud save snapshot.
   *
   * @param {number} userId - Authenticated user id.
   * @param {string} gameKey - Game identifier.
   * @param {unknown} data - Save payload.
   * @param {string} summary - Human summary shown in the UI.
   * @returns {Promise<object>} Saved entry.
   */
  async putGameSave(userId, gameKey, data, summary) {
    const normalizedKey = this.normalizeGameKey(gameKey);
    const normalizedSummary = cleanText(summary).slice(0, MAX_SUMMARY_LENGTH);
    const encodedData = JSON.stringify(data == null ? null : data);
    if (Buffer.byteLength(encodedData, "utf8") > MAX_SAVE_BYTES) {
      throw new Error(`Save payload exceeds ${MAX_SAVE_BYTES} bytes.`);
    }

    const nowIso = this.nowIso();
    this.run(
      [
        "INSERT INTO game_saves (user_id, game_key, save_data, summary, updated_at)",
        "VALUES (?, ?, ?, ?, ?)",
        "ON CONFLICT(user_id, game_key) DO UPDATE SET",
        "save_data = excluded.save_data,",
        "summary = excluded.summary,",
        "updated_at = excluded.updated_at"
      ].join(" "),
      [Number(userId), normalizedKey, encodedData, normalizedSummary, nowIso]
    );

    await this.flush();
    return this.getGameSave(Number(userId), normalizedKey);
  }

  /**
   * Deletes a cloud save snapshot.
   *
   * @param {number} userId - Authenticated user id.
   * @param {string} gameKey - Game identifier.
   * @returns {Promise<void>}
   */
  async deleteGameSave(userId, gameKey) {
    const normalizedKey = this.normalizeGameKey(gameKey);
    this.run("DELETE FROM game_saves WHERE user_id = ? AND game_key = ?", [Number(userId), normalizedKey]);
    await this.flush();
  }

  /**
   * Flushes the in-memory SQLite database back to disk.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    const exported = Buffer.from(this.db.export());
    const targetPath = this.dbPath;
    this.writeChain = this.writeChain.then(() => fsp.writeFile(targetPath, exported));
    await this.writeChain;
  }

  /**
   * Returns a stable ISO timestamp for the current logical clock.
   *
   * @returns {string} Current ISO timestamp.
   */
  nowIso() {
    return toIsoNow(this.now());
  }

  /**
   * Executes schema migrations required by the current application version.
   */
  runSchemaMigrations() {
    this.exec("PRAGMA foreign_keys = ON;");
    this.exec([
      "CREATE TABLE IF NOT EXISTS users (",
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  username TEXT NOT NULL UNIQUE,",
      "  username_normalized TEXT NOT NULL UNIQUE,",
      "  password_hash TEXT NOT NULL,",
      "  password_salt TEXT NOT NULL,",
      "  created_at TEXT NOT NULL,",
      "  updated_at TEXT NOT NULL",
      ");",
      "CREATE TABLE IF NOT EXISTS sessions (",
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
      "  token TEXT NOT NULL UNIQUE,",
      "  created_at TEXT NOT NULL,",
      "  expires_at TEXT NOT NULL",
      ");",
      "CREATE TABLE IF NOT EXISTS threads (",
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  type TEXT NOT NULL CHECK(type IN ('room', 'direct')),",
      "  name TEXT,",
      "  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
      "  direct_key TEXT UNIQUE,",
      "  created_at TEXT NOT NULL,",
      "  updated_at TEXT NOT NULL",
      ");",
      "CREATE TABLE IF NOT EXISTS thread_participants (",
      "  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,",
      "  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
      "  joined_at TEXT NOT NULL,",
      "  PRIMARY KEY(thread_id, user_id)",
      ");",
      "CREATE TABLE IF NOT EXISTS messages (",
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,",
      "  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
      "  content TEXT NOT NULL,",
      "  created_at TEXT NOT NULL",
      ");",
      "CREATE TABLE IF NOT EXISTS game_saves (",
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
      "  game_key TEXT NOT NULL,",
      "  save_data TEXT NOT NULL,",
      "  summary TEXT NOT NULL DEFAULT '',",
      "  updated_at TEXT NOT NULL,",
      "  UNIQUE(user_id, game_key)",
      ");",
      "CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);",
      "CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);",
      "CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id, id);",
      "CREATE INDEX IF NOT EXISTS idx_thread_participants_user_id ON thread_participants(user_id);",
      "CREATE INDEX IF NOT EXISTS idx_game_saves_user_id ON game_saves(user_id, updated_at);"
    ].join("\n"));
  }

  /**
   * Ensures the built-in lobby room exists.
   */
  ensureDefaultRoom() {
    const existing = this.get("SELECT id FROM threads WHERE type = 'room' AND LOWER(name) = LOWER(?)", [DEFAULT_ROOM_NAME]);
    if (existing) return false;

    const systemOwner = this.get("SELECT id FROM users ORDER BY id ASC LIMIT 1");
    if (!systemOwner) {
      const nowIso = this.nowIso();
      const salt = crypto.randomBytes(16).toString("hex");
      const hash = hashPassword(createToken(), salt);
      this.run(
        [
          "INSERT INTO users (username, username_normalized, password_hash, password_salt, created_at, updated_at)",
          "VALUES ('antarctic', 'antarctic', ?, ?, ?, ?)"
        ].join(" "),
        [hash, salt, nowIso, nowIso]
      );
    }

    const ownerId = Number(this.get("SELECT id FROM users ORDER BY id ASC LIMIT 1").id);
    const nowIso = this.nowIso();
    this.run(
      [
        "INSERT INTO threads (type, name, owner_user_id, direct_key, created_at, updated_at)",
        "VALUES ('room', ?, ?, NULL, ?, ?)"
      ].join(" "),
      [DEFAULT_ROOM_NAME, ownerId, nowIso, nowIso]
    );
    return true;
  }

  /**
   * Adds a user to the built-in lobby if they are not already a participant.
   *
   * @param {number} userId - User id.
   */
  ensureLobbyMembership(userId) {
    const lobby = this.get("SELECT id FROM threads WHERE type = 'room' AND LOWER(name) = LOWER(?)", [DEFAULT_ROOM_NAME]);
    if (!lobby) return false;
    return this.ensureThreadParticipant(Number(lobby.id), Number(userId));
  }

  /**
   * Adds a participant to a thread if needed.
   *
   * @param {number} threadId - Thread id.
   * @param {number} userId - User id.
   */
  ensureThreadParticipant(threadId, userId) {
    const existing = this.get(
      "SELECT 1 FROM thread_participants WHERE thread_id = ? AND user_id = ?",
      [Number(threadId), Number(userId)]
    );
    if (existing) return false;

    this.run(
      "INSERT INTO thread_participants (thread_id, user_id, joined_at) VALUES (?, ?, ?)",
      [Number(threadId), Number(userId), this.nowIso()]
    );
    return true;
  }

  /**
   * Creates a new session row for a user.
   *
   * @param {number} userId - User id.
   * @returns {{ token: string, expiresAt: string }} New session details.
   */
  createSessionForUser(userId) {
    const createdAt = this.nowIso();
    const expiresAt = toIsoNow(new Date(new Date(createdAt).getTime() + this.sessionTtlDays * 24 * 60 * 60 * 1000));
    const token = createToken();

    this.run(
      "INSERT INTO sessions (user_id, token, created_at, expires_at) VALUES (?, ?, ?, ?)",
      [Number(userId), token, createdAt, expiresAt]
    );

    return { token, expiresAt };
  }

  /**
   * Removes expired sessions from the database.
   */
  cleanupExpiredSessions() {
    this.run("DELETE FROM sessions WHERE expires_at <= ?", [this.nowIso()]);
  }

  /**
   * Looks up a user by username, case-insensitively.
   *
   * @param {string} username - Username to locate.
   * @returns {object|null} User row or null.
   */
  findUserByUsername(username) {
    return this.get(
      "SELECT * FROM users WHERE username_normalized = ?",
      [cleanText(username).toLowerCase()]
    );
  }

  /**
   * Fetches a thread only if the user belongs to it.
   *
   * @param {number} userId - User id.
   * @param {number} threadId - Thread id.
   * @returns {object|null} Public thread or null.
   */
  getThreadForUser(userId, threadId) {
    const row = this.get(
      [
        "SELECT threads.id, threads.type, threads.name, threads.owner_user_id, threads.created_at, threads.updated_at,",
        "other_user.id AS other_user_id, other_user.username AS other_user_username,",
        "messages.id AS last_message_id, messages.content AS last_message_content, messages.created_at AS last_message_created_at,",
        "message_author.username AS last_message_author_username",
        "FROM thread_participants participant",
        "JOIN threads ON threads.id = participant.thread_id",
        "LEFT JOIN thread_participants other_participant ON other_participant.thread_id = threads.id AND other_participant.user_id <> participant.user_id",
        "LEFT JOIN users AS other_user ON other_user.id = other_participant.user_id",
        "LEFT JOIN messages ON messages.id = (SELECT id FROM messages WHERE thread_id = threads.id ORDER BY id DESC LIMIT 1)",
        "LEFT JOIN users AS message_author ON message_author.id = messages.user_id",
        "WHERE participant.user_id = ? AND threads.id = ?",
        "GROUP BY threads.id"
      ].join(" "),
      [Number(userId), Number(threadId)]
    );

    return row ? this.toPublicThread(row) : null;
  }

  /**
   * Maps a raw thread row into the public API shape.
   *
   * @param {object} row - Raw SQLite row.
   * @returns {object} Public thread representation.
   */
  toPublicThread(row) {
    const type = String(row.type || "");
    const peer =
      type === "direct" && row.other_user_id
        ? {
            id: Number(row.other_user_id),
            username: String(row.other_user_username || "")
          }
        : null;

    return {
      id: Number(row.id),
      type,
      name: type === "direct" ? (peer ? peer.username : "Direct message") : String(row.name || ""),
      ownerUserId: Number(row.owner_user_id || 0),
      createdAt: String(row.created_at || ""),
      updatedAt: String(row.updated_at || ""),
      peer,
      lastMessage: row.last_message_id
        ? {
            id: Number(row.last_message_id),
            content: String(row.last_message_content || ""),
            createdAt: String(row.last_message_created_at || ""),
            username: String(row.last_message_author_username || "")
          }
        : null
    };
  }

  /**
   * Normalizes and validates a username.
   *
   * @param {string} username - Candidate username.
   * @returns {string} Sanitized username.
   */
  normalizeUsername(username) {
    const normalized = cleanText(username);
    if (normalized.length < MIN_USERNAME_LENGTH || normalized.length > MAX_USERNAME_LENGTH) {
      throw new Error(`Usernames must be ${MIN_USERNAME_LENGTH}-${MAX_USERNAME_LENGTH} characters long.`);
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(normalized)) {
      throw new Error("Usernames can only use letters, numbers, underscores, and hyphens.");
    }
    return normalized;
  }

  /**
   * Normalizes and validates a plaintext password.
   *
   * @param {string} password - Candidate password.
   * @returns {string} Sanitized password.
   */
  normalizePassword(password) {
    const normalized = cleanText(password);
    if (normalized.length < MIN_PASSWORD_LENGTH || normalized.length > MAX_PASSWORD_LENGTH) {
      throw new Error(`Passwords must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters long.`);
    }
    return normalized;
  }

  /**
   * Normalizes and validates a room name.
   *
   * @param {string} roomName - Candidate room name.
   * @returns {string} Sanitized room name.
   */
  normalizeRoomName(roomName) {
    const normalized = cleanText(roomName);
    if (!normalized) {
      throw new Error("Room name is required.");
    }
    if (normalized.length > MAX_ROOM_NAME_LENGTH) {
      throw new Error(`Room names must stay under ${MAX_ROOM_NAME_LENGTH} characters.`);
    }
    return normalized;
  }

  /**
   * Normalizes a game key used for cloud saves.
   *
   * @param {string} gameKey - Candidate key.
   * @returns {string} Sanitized game key.
   */
  normalizeGameKey(gameKey) {
    const normalized = cleanText(gameKey).replace(/\\/g, "/");
    if (!normalized) {
      throw new Error("Game key is required.");
    }
    if (normalized.length > 180) {
      throw new Error("Game key is too long.");
    }
    return normalized;
  }

  /**
   * Safely compares two hexadecimal password hashes.
   *
   * @param {string} actualHash - Persisted hash.
   * @param {string} expectedHash - Calculated hash.
   * @returns {boolean} Whether both hashes match.
   */
  safeHashEquals(actualHash, expectedHash) {
    try {
      return crypto.timingSafeEqual(Buffer.from(actualHash, "hex"), Buffer.from(expectedHash, "hex"));
    } catch {
      return false;
    }
  }

  /**
   * Reads the existing database file if one is present.
   *
   * @returns {Promise<Uint8Array|null>} SQLite bytes or null.
   */
  async readExistingBytes() {
    if (!fs.existsSync(this.dbPath)) {
      return null;
    }
    return new Uint8Array(await fsp.readFile(this.dbPath));
  }

  /**
   * Executes SQL that does not require bound parameters.
   *
   * @param {string} sql - SQL text.
   */
  exec(sql) {
    this.db.exec(sql);
  }

  /**
   * Executes SQL with bound parameters.
   *
   * @param {string} sql - SQL text.
   * @param {unknown[]} [params=[]] - Bound parameters.
   */
  run(sql, params = []) {
    this.db.run(sql, params);
  }

  /**
   * Returns the first row for a SQL query.
   *
   * @param {string} sql - SQL text.
   * @param {unknown[]} [params=[]] - Bound parameters.
   * @returns {object|null} First row or null.
   */
  get(sql, params = []) {
    const rows = this.all(sql, params);
    return rows[0] || null;
  }

  /**
   * Returns every row for a SQL query.
   *
   * @param {string} sql - SQL text.
   * @param {unknown[]} [params=[]] - Bound parameters.
   * @returns {object[]} Result rows.
   */
  all(sql, params = []) {
    const statement = this.db.prepare(sql, params);
    const rows = [];
    try {
      while (statement.step()) {
        rows.push(statement.getAsObject());
      }
    } finally {
      statement.free();
    }
    return rows;
  }
}

module.exports = {
  AntarcticCommunityStore,
  DEFAULT_ROOM_NAME
};

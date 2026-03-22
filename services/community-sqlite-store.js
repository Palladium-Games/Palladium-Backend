const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const initSqlJs = require("sql.js");

const DEFAULT_SESSION_TTL_DAYS = 30;
const DEFAULT_ROOM_NAME = "Lobby";
const DEFAULT_SYSTEM_USERNAME = "antarctic";
const AUTOMOD_MUTE_MS = 3 * 60 * 1000;
const AUTOMOD_MUTED_REASON = "language";
const AUTOMOD_PATTERNS = Object.freeze([
  /\bfuck(?:er|ers|ing|ings|ed|s)?\b/i,
  /\bshit(?:head|heads|ty|ting|tings|s)?\b/i,
  /\basshole(?:s)?\b/i,
  /\bbitch(?:es|ing|y)?\b/i,
  /\bbastard(?:s)?\b/i,
  /\bmotherfucker(?:s)?\b/i,
  /\bdickhead(?:s)?\b/i
]);
const FAST_PASSWORD_HASH_PREFIX = "scrypt-4096$";
const FAST_SCRYPT_OPTIONS = Object.freeze({
  N: 4096,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024
});
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_PASSWORD_LENGTH = 200;
const MAX_PRIVATE_ROOM_INVITES = 12;
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
 * Finds a blocked profanity pattern in a message if one exists.
 *
 * @param {string} value - Candidate message text.
 * @returns {string} Matched blocked term or an empty string.
 */
function findAutomodMatch(value) {
  const normalized = cleanText(value);
  if (!normalized) return "";

  for (const pattern of AUTOMOD_PATTERNS) {
    const match = normalized.match(pattern);
    if (match && match[0]) {
      return String(match[0]);
    }
  }

  return "";
}

/**
 * Hashes a password with scrypt.
 *
 * @param {string} password - Password to hash.
 * @param {string} saltHex - Salt encoded as hexadecimal.
 * @param {object} [options] - Optional scrypt tuning parameters.
 * @returns {string} Password hash encoded as hexadecimal.
 */
function hashPassword(password, saltHex, options) {
  return crypto.scryptSync(password, Buffer.from(saltHex, "hex"), 64, options).toString("hex");
}

/**
 * Hashes a password using the faster Antarctic auth format.
 *
 * @param {string} password - Password to hash.
 * @param {string} saltHex - Salt encoded as hexadecimal.
 * @returns {string} Prefixed password hash.
 */
function hashPasswordFast(password, saltHex) {
  return `${FAST_PASSWORD_HASH_PREFIX}${hashPassword(password, saltHex, FAST_SCRYPT_OPTIONS)}`;
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
 * Converts a raw direct-request row into the public API shape.
 *
 * @param {object} row - Raw SQLite row.
 * @returns {{
 *   id: number,
 *   status: string,
 *   createdAt: string,
 *   updatedAt: string,
 *   threadId: number|null,
 *   requester: { id: number, username: string, createdAt: string }|null,
 *   target: { id: number, username: string, createdAt: string }|null
 * }} Public direct-request representation.
 */
function toPublicDirectRequest(row) {
  return {
    id: Number(row.id),
    status: String(row.status || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
    threadId: row.resolved_thread_id ? Number(row.resolved_thread_id) : null,
    requester: row.requester_id
      ? {
          id: Number(row.requester_id),
          username: String(row.requester_username || ""),
          createdAt: String(row.requester_created_at || "")
        }
      : null,
    target: row.target_id
      ? {
          id: Number(row.target_id),
          username: String(row.target_username || ""),
          createdAt: String(row.target_created_at || "")
        }
      : null
  };
}

/**
 * Converts a raw room row into the public room catalog shape.
 *
 * @param {object} row - Raw SQLite row.
 * @returns {{
 *   id: number,
 *   type: "room",
 *   name: string,
 *   visibility: string,
 *   memberCount: number,
 *   joined: boolean,
 *   invited: boolean,
 *   joinable: boolean,
 *   ownerUserId: number,
 *   createdAt: string,
 *   updatedAt: string
 * }} Public room representation.
 */
function toPublicRoom(row) {
  const joined = Boolean(Number(row.joined || 0));
  const invited = Boolean(Number(row.invited || 0));
  const visibility = String(row.visibility || "public");
  const ownerUserId = Number(row.owner_user_id || 0);
  return {
    id: Number(row.id),
    type: "room",
    name: String(row.name || ""),
    visibility,
    memberCount: Number(row.member_count || 0),
    joined,
    invited,
    joinable: joined || invited || visibility === "public",
    ownerUserId,
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || "")
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
    this.flushTimer = null;
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
    const hash = hashPasswordFast(normalizedPassword, salt);
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
    this.queueFlush();
    return {
      token: session.token,
      user: toPublicUser(user),
      bootstrap: this.getCommunitySnapshot(Number(user.id))
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

    const verification = this.verifyPasswordHash(String(user.password_hash || ""), normalizedPassword, String(user.password_salt || ""));
    if (!verification.ok) {
      throw new Error("Invalid username or password.");
    }

    this.cleanupExpiredSessions();
    this.ensureLobbyMembership(Number(user.id));
    if (verification.needsUpgrade) {
      this.run("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", [
        verification.upgradedHash,
        this.nowIso(),
        Number(user.id)
      ]);
    }
    const session = this.createSessionForUser(Number(user.id));
    this.queueFlush();
    return {
      token: session.token,
      user: toPublicUser(user),
      bootstrap: this.getCommunitySnapshot(Number(user.id))
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
    this.queueFlush();
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
      this.queueFlush();
      return null;
    }

    const changed = this.ensureLobbyMembership(Number(row.id));
    if (changed) {
      this.queueFlush();
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
        "SELECT threads.id, threads.type, threads.name, threads.visibility, threads.owner_user_id, threads.created_at, threads.updated_at,",
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
        "SELECT threads.id, threads.type, threads.name, threads.visibility, threads.owner_user_id, threads.created_at, threads.updated_at,",
        "(SELECT COUNT(*) FROM thread_participants participants WHERE participants.thread_id = threads.id) AS member_count,",
        "EXISTS(SELECT 1 FROM thread_participants participants WHERE participants.thread_id = threads.id AND participants.user_id = ?) AS joined,",
        "EXISTS(SELECT 1 FROM room_invitations invites WHERE invites.thread_id = threads.id AND invites.user_id = ? AND invites.status = 'pending') AS invited",
        "FROM threads",
        "WHERE threads.type = 'room'",
        "AND (",
        "  threads.visibility = 'public'",
        "  OR threads.owner_user_id = ?",
        "  OR EXISTS(SELECT 1 FROM thread_participants participants WHERE participants.thread_id = threads.id AND participants.user_id = ?)",
        "  OR EXISTS(SELECT 1 FROM room_invitations invites WHERE invites.thread_id = threads.id AND invites.user_id = ? AND invites.status = 'pending')",
        ")",
        "ORDER BY LOWER(threads.name) ASC, threads.id ASC"
      ].join(" "),
      [Number(userId), Number(userId), Number(userId), Number(userId), Number(userId)]
    ).map(toPublicRoom);

    return {
      threads: joinedThreadRows.map((row) => this.toPublicThread(row)),
      rooms
    };
  }

  /**
   * Returns the logged-in community dashboard payload in one call.
   *
   * @param {number} userId - Authenticated user id.
   * @returns {{
   *   threads: object[],
   *   rooms: object[],
   *   saves: object[],
   *   incomingDirectRequests: object[],
   *   stats: {
   *     threadCount: number,
   *     roomCount: number,
   *     joinedRoomCount: number,
   *     directCount: number,
   *     incomingDirectRequestCount: number,
   *     saveCount: number
   *   }
   * }} Snapshot payload.
   */
  getCommunitySnapshot(userId) {
    const catalog = this.listThreadsForUser(Number(userId));
    const saves = this.listGameSaves(Number(userId));
    const incomingDirectRequests = this.listIncomingDirectRequests(Number(userId));
    const threads = Array.isArray(catalog.threads) ? catalog.threads : [];
    const rooms = Array.isArray(catalog.rooms) ? catalog.rooms : [];

    return {
      threads,
      rooms,
      saves,
      incomingDirectRequests,
      stats: {
        threadCount: threads.length,
        roomCount: rooms.length,
        joinedRoomCount: rooms.filter((room) => room && room.joined).length,
        directCount: threads.filter((thread) => thread && thread.type === "direct").length,
        incomingDirectRequestCount: incomingDirectRequests.length,
        saveCount: saves.length
      }
    };
  }

  /**
   * Creates a new chat room and joins the creator automatically.
   *
   * @param {number} userId - Creating user id.
   * @param {string} roomName - Desired room name.
   * @param {{ visibility?: string, invitedUsers?: string[]|string }} [options] - Room options.
   * @returns {Promise<object>} Created room thread.
   */
  async createRoom(userId, roomName, options = {}) {
    const normalizedName = this.normalizeRoomName(roomName);
    const visibility = this.normalizeRoomVisibility(options.visibility);
    const invitedUsers = visibility === "private"
      ? this.resolveInvitedUsers(options.invitedUsers, Number(userId))
      : [];
    const nowIso = this.nowIso();
    this.run(
      [
        "INSERT INTO threads (type, name, visibility, owner_user_id, direct_key, created_at, updated_at)",
        "VALUES ('room', ?, ?, ?, NULL, ?, ?)"
      ].join(" "),
      [normalizedName, visibility, Number(userId), nowIso, nowIso]
    );
    const threadId = Number(this.get("SELECT last_insert_rowid() AS id").id);
    this.ensureThreadParticipant(threadId, Number(userId));
    if (visibility === "private" && invitedUsers.length) {
      this.applyPrivateRoomInvitations(threadId, Number(userId), normalizedName, invitedUsers);
    }
    this.queueFlush();
    return this.getThreadForUser(Number(userId), threadId);
  }

  /**
   * Ensures the authenticated user is a participant of a room they can access.
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

    const alreadyJoined = this.get(
      "SELECT 1 FROM thread_participants WHERE thread_id = ? AND user_id = ?",
      [Number(threadId), Number(userId)]
    );
    if (String(room.visibility || "public") === "private" && !alreadyJoined && Number(room.owner_user_id) !== Number(userId)) {
      const invite = this.get(
        [
          "SELECT * FROM room_invitations",
          "WHERE thread_id = ?",
          "AND user_id = ?",
          "AND status = 'pending'"
        ].join(" "),
        [Number(threadId), Number(userId)]
      );
      if (!invite) {
        throw new Error("That private room is invite-only.");
      }
      this.run(
        "UPDATE room_invitations SET status = 'accepted', updated_at = ? WHERE thread_id = ? AND user_id = ?",
        [this.nowIso(), Number(threadId), Number(userId)]
      );
    }

    this.ensureThreadParticipant(Number(threadId), Number(userId));
    this.run("UPDATE threads SET updated_at = ? WHERE id = ?", [this.nowIso(), Number(threadId)]);
    this.queueFlush();
    return this.getThreadForUser(Number(userId), Number(threadId));
  }

  /**
   * Removes a participant from a room they previously joined.
   *
   * @param {number} userId - User id.
   * @param {number} threadId - Room thread id.
   * @returns {Promise<void>}
   */
  async leaveRoom(userId, threadId) {
    const room = this.getThreadForUser(Number(userId), Number(threadId));
    if (!room || room.type !== "room") {
      throw new Error("That room is unavailable.");
    }

    this.run(
      "DELETE FROM thread_participants WHERE thread_id = ? AND user_id = ?",
      [Number(threadId), Number(userId)]
    );
    this.run("UPDATE threads SET updated_at = ? WHERE id = ?", [this.nowIso(), Number(threadId)]);
    this.queueFlush();
  }

  /**
   * Records private-room invitations and notifies each invited user through the Antarctic system DM.
   *
   * @param {number} threadId - Private room thread id.
   * @param {number} invitedByUserId - User id who created the room.
   * @param {string} roomName - Room name used in notifications.
   * @param {string[]} invitedUsers - Validated usernames to invite.
   */
  applyPrivateRoomInvitations(threadId, invitedByUserId, roomName, invitedUsers) {
    const inviter = this.get("SELECT username FROM users WHERE id = ?", [Number(invitedByUserId)]);
    const invitedByUsername = String(inviter && inviter.username ? inviter.username : DEFAULT_SYSTEM_USERNAME);
    const nowIso = this.nowIso();

    for (const username of invitedUsers) {
      const target = this.findUserByUsername(username);
      if (!target || Number(target.id) === Number(invitedByUserId)) {
        continue;
      }

      this.run(
        [
          "INSERT INTO room_invitations (thread_id, user_id, invited_by_user_id, status, created_at, updated_at)",
          "VALUES (?, ?, ?, 'pending', ?, ?)",
          "ON CONFLICT(thread_id, user_id) DO UPDATE SET",
          "invited_by_user_id = excluded.invited_by_user_id,",
          "status = 'pending',",
          "updated_at = excluded.updated_at"
        ].join(" "),
        [Number(threadId), Number(target.id), Number(invitedByUserId), nowIso, nowIso]
      );
      this.notifyRoomInvite(Number(target.id), roomName, invitedByUsername);
    }
  }

  /**
   * Sends an Antarctic system DM notifying a user about a private-room invite.
   *
   * @param {number} invitedUserId - Invited user id.
   * @param {string} roomName - Invited room name.
   * @param {string} invitedByUsername - Inviter username.
   */
  notifyRoomInvite(invitedUserId, roomName, invitedByUsername) {
    const systemUser = this.getSystemUser();
    if (!systemUser) return;

    const directThread = this.createDirectThread(Number(systemUser.id), Number(invitedUserId));
    const message =
      `You were invited to the private room "${roomName}" by @${invitedByUsername}. ` +
      "Open Antarctic chat and accept the room from your room list when you are ready.";
    this.addSystemMessage(Number(systemUser.id), Number(directThread.id), message);
  }

  /**
   * Creates a pending DM request or reuses/accepts an existing direct thread.
   *
   * @param {number} userId - Authenticated user id.
   * @param {string} username - Target username.
   * @returns {Promise<{ kind: "request"|"thread", request?: object, thread?: object }>} DM creation result.
   */
  async requestDirectThread(userId, username) {
    const target = this.findUserByUsername(this.normalizeUsername(username));
    if (!target) {
      throw new Error("That user does not exist.");
    }
    if (Number(target.id) === Number(userId)) {
      throw new Error("You are already talking to yourself in your head.");
    }

    const directKey = directKeyForUsers(Number(userId), Number(target.id));
    const existingThread = this.get("SELECT * FROM threads WHERE direct_key = ?", [directKey]);
    if (existingThread) {
      return {
        kind: "thread",
        thread: this.getThreadForUser(Number(userId), Number(existingThread.id))
      };
    }

    const pendingIncoming = this.getPendingDirectRequest(Number(target.id), Number(userId));
    if (pendingIncoming) {
      return this.acceptDirectRequest(Number(userId), Number(pendingIncoming.id));
    }

    const existingOutgoing = this.getPendingDirectRequest(Number(userId), Number(target.id));
    if (existingOutgoing) {
      return {
        kind: "request",
        request: this.getDirectRequestForUser(Number(userId), Number(existingOutgoing.id))
      };
    }

    const nowIso = this.nowIso();
    this.run(
      [
        "INSERT INTO direct_requests (requester_user_id, target_user_id, status, resolved_thread_id, created_at, updated_at)",
        "VALUES (?, ?, 'pending', NULL, ?, ?)"
      ].join(" "),
      [Number(userId), Number(target.id), nowIso, nowIso]
    );
    const requestId = Number(this.get("SELECT last_insert_rowid() AS id").id);
    this.queueFlush();
    return {
      kind: "request",
      request: this.getDirectRequestForUser(Number(userId), requestId)
    };
  }

  /**
   * Creates or reuses a direct-message thread between two users immediately.
   *
   * @param {number} firstUserId - First participant id.
   * @param {number} secondUserId - Second participant id.
   * @returns {object} Direct thread details for the first user.
   */
  createDirectThread(firstUserId, secondUserId) {
    const directKey = directKeyForUsers(Number(firstUserId), Number(secondUserId));
    let thread = this.get("SELECT * FROM threads WHERE direct_key = ?", [directKey]);
    if (!thread) {
      const nowIso = this.nowIso();
      this.run(
        [
          "INSERT INTO threads (type, name, visibility, owner_user_id, direct_key, created_at, updated_at)",
          "VALUES ('direct', NULL, 'public', ?, ?, ?, ?)"
        ].join(" "),
        [Number(firstUserId), directKey, nowIso, nowIso]
      );
      const threadId = Number(this.get("SELECT last_insert_rowid() AS id").id);
      this.ensureThreadParticipant(threadId, Number(firstUserId));
      this.ensureThreadParticipant(threadId, Number(secondUserId));
      thread = this.get("SELECT * FROM threads WHERE id = ?", [threadId]);
      this.queueFlush();
    }

    return this.getThreadForUser(Number(firstUserId), Number(thread.id));
  }

  /**
   * Accepts a pending incoming DM request and opens the resulting direct thread.
   *
   * @param {number} userId - Authenticated target user id.
   * @param {number} requestId - Pending request id.
   * @returns {Promise<{ kind: "thread", request: object, thread: object }>} Accepted DM result.
   */
  async acceptDirectRequest(userId, requestId) {
    const request = this.getDirectRequestForUser(Number(userId), Number(requestId));
    if (!request || request.status !== "pending" || !request.target || Number(request.target.id) !== Number(userId)) {
      throw new Error("That DM request is unavailable.");
    }

    const thread = this.createDirectThread(Number(request.requester.id), Number(request.target.id));
    this.run(
      "UPDATE direct_requests SET status = 'accepted', resolved_thread_id = ?, updated_at = ? WHERE id = ?",
      [Number(thread.id), this.nowIso(), Number(requestId)]
    );
    this.queueFlush();
    return {
      kind: "thread",
      request: this.getDirectRequestForUser(Number(userId), Number(requestId)),
      thread: this.getThreadForUser(Number(userId), Number(thread.id))
    };
  }

  /**
   * Denies a pending incoming DM request.
   *
   * @param {number} userId - Authenticated target user id.
   * @param {number} requestId - Pending request id.
   * @returns {Promise<{ kind: "request", request: object }>} Denied DM result.
   */
  async denyDirectRequest(userId, requestId) {
    const request = this.getDirectRequestForUser(Number(userId), Number(requestId));
    if (!request || request.status !== "pending" || !request.target || Number(request.target.id) !== Number(userId)) {
      throw new Error("That DM request is unavailable.");
    }

    this.run(
      "UPDATE direct_requests SET status = 'denied', updated_at = ? WHERE id = ?",
      [this.nowIso(), Number(requestId)]
    );
    this.queueFlush();
    return {
      kind: "request",
      request: this.getDirectRequestForUser(Number(userId), Number(requestId))
    };
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
    const activeMute = this.getActiveMute(Number(userId));
    if (activeMute) {
      throw new Error(activeMute.message);
    }

    const blockedTerm = findAutomodMatch(content);
    if (blockedTerm) {
      throw new Error(this.applyAutomodMute(Number(userId), blockedTerm));
    }

    return this.addMessageInternal(Number(userId), Number(threadId), content);
  }

  /**
   * Adds a system-generated message without applying user moderation checks.
   *
   * @param {number} userId - Message author id.
   * @param {number} threadId - Target thread id.
   * @param {string} content - Message content.
   * @returns {object} Created message.
   */
  addSystemMessage(userId, threadId, content) {
    return this.addMessageInternal(Number(userId), Number(threadId), content);
  }

  /**
   * Inserts a message for a thread participant after validation.
   *
   * @param {number} userId - Message author id.
   * @param {number} threadId - Target thread id.
   * @param {string} content - Message content.
   * @returns {object} Created message.
   */
  addMessageInternal(userId, threadId, content) {
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
    this.queueFlush();

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

    this.queueFlush();
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
    this.queueFlush();
  }

  /**
   * Schedules a coalesced disk flush so auth/chat UI writes do not block the response path.
   */
  queueFlush() {
    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((error) => {
        console.error("Failed to persist Antarctic community data.", error);
      });
    }, 35);
    if (this.flushTimer && typeof this.flushTimer.unref === "function") {
      this.flushTimer.unref();
    }
  }

  /**
   * Flushes the in-memory SQLite database back to disk.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
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
   * Checks whether a table already contains a named column.
   *
   * @param {string} tableName - SQLite table name.
   * @param {string} columnName - Column name to look for.
   * @returns {boolean} Whether the column exists.
   */
  tableHasColumn(tableName, columnName) {
    return this.all(`PRAGMA table_info(${tableName})`, []).some((row) => String(row.name || "") === String(columnName));
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
      "  muted_until TEXT NOT NULL DEFAULT '',",
      "  muted_reason TEXT NOT NULL DEFAULT '',",
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
      "  visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public', 'private')),",
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
      "CREATE TABLE IF NOT EXISTS direct_requests (",
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  requester_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
      "  target_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
      "  status TEXT NOT NULL CHECK(status IN ('pending', 'accepted', 'denied')),",
      "  resolved_thread_id INTEGER REFERENCES threads(id) ON DELETE SET NULL,",
      "  created_at TEXT NOT NULL,",
      "  updated_at TEXT NOT NULL",
      ");",
      "CREATE TABLE IF NOT EXISTS room_invitations (",
      "  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,",
      "  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
      "  invited_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
      "  status TEXT NOT NULL CHECK(status IN ('pending', 'accepted', 'declined')),",
      "  created_at TEXT NOT NULL,",
      "  updated_at TEXT NOT NULL,",
      "  PRIMARY KEY(thread_id, user_id)",
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
      "CREATE INDEX IF NOT EXISTS idx_direct_requests_target_status ON direct_requests(target_user_id, status, created_at);",
      "CREATE INDEX IF NOT EXISTS idx_direct_requests_requester_status ON direct_requests(requester_user_id, status, created_at);",
      "CREATE INDEX IF NOT EXISTS idx_room_invitations_user_status ON room_invitations(user_id, status, updated_at);",
      "CREATE INDEX IF NOT EXISTS idx_game_saves_user_id ON game_saves(user_id, updated_at);"
    ].join("\n"));

    if (!this.tableHasColumn("threads", "visibility")) {
      this.run("ALTER TABLE threads ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'");
    }
    if (!this.tableHasColumn("users", "muted_until")) {
      this.run("ALTER TABLE users ADD COLUMN muted_until TEXT NOT NULL DEFAULT ''");
    }
    if (!this.tableHasColumn("users", "muted_reason")) {
      this.run("ALTER TABLE users ADD COLUMN muted_reason TEXT NOT NULL DEFAULT ''");
    }
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
          `VALUES ('${DEFAULT_SYSTEM_USERNAME}', '${DEFAULT_SYSTEM_USERNAME}', ?, ?, ?, ?)`
        ].join(" "),
        [hash, salt, nowIso, nowIso]
      );
    }

    const ownerId = Number(this.get("SELECT id FROM users ORDER BY id ASC LIMIT 1").id);
    const nowIso = this.nowIso();
    this.run(
      [
        "INSERT INTO threads (type, name, visibility, owner_user_id, direct_key, created_at, updated_at)",
        "VALUES ('room', ?, 'public', ?, NULL, ?, ?)"
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
        "SELECT threads.id, threads.type, threads.name, threads.visibility, threads.owner_user_id, threads.created_at, threads.updated_at,",
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
   * Lists pending incoming DM requests for a user.
   *
   * @param {number} userId - Authenticated user id.
   * @returns {object[]} Ordered pending incoming requests.
   */
  listIncomingDirectRequests(userId) {
    return this.all(
      [
        "SELECT direct_requests.id, direct_requests.status, direct_requests.created_at, direct_requests.updated_at, direct_requests.resolved_thread_id,",
        "requester.id AS requester_id, requester.username AS requester_username, requester.created_at AS requester_created_at,",
        "target.id AS target_id, target.username AS target_username, target.created_at AS target_created_at",
        "FROM direct_requests",
        "JOIN users AS requester ON requester.id = direct_requests.requester_user_id",
        "JOIN users AS target ON target.id = direct_requests.target_user_id",
        "WHERE direct_requests.target_user_id = ? AND direct_requests.status = 'pending'",
        "ORDER BY direct_requests.created_at DESC, direct_requests.id DESC"
      ].join(" "),
      [Number(userId)]
    ).map(toPublicDirectRequest);
  }

  /**
   * Fetches one DM request visible to the requester or target.
   *
   * @param {number} userId - Authenticated user id.
   * @param {number} requestId - DM request id.
   * @returns {object|null} Public request or null.
   */
  getDirectRequestForUser(userId, requestId) {
    const row = this.get(
      [
        "SELECT direct_requests.id, direct_requests.status, direct_requests.created_at, direct_requests.updated_at, direct_requests.resolved_thread_id,",
        "requester.id AS requester_id, requester.username AS requester_username, requester.created_at AS requester_created_at,",
        "target.id AS target_id, target.username AS target_username, target.created_at AS target_created_at",
        "FROM direct_requests",
        "JOIN users AS requester ON requester.id = direct_requests.requester_user_id",
        "JOIN users AS target ON target.id = direct_requests.target_user_id",
        "WHERE direct_requests.id = ?",
        "AND (direct_requests.requester_user_id = ? OR direct_requests.target_user_id = ?)"
      ].join(" "),
      [Number(requestId), Number(userId), Number(userId)]
    );

    return row ? toPublicDirectRequest(row) : null;
  }

  /**
   * Looks up one pending DM request between a requester and target.
   *
   * @param {number} requesterUserId - Requesting user id.
   * @param {number} targetUserId - Target user id.
   * @returns {object|null} Pending request row or null.
   */
  getPendingDirectRequest(requesterUserId, targetUserId) {
    return this.get(
      [
        "SELECT * FROM direct_requests",
        "WHERE requester_user_id = ?",
        "AND target_user_id = ?",
        "AND status = 'pending'",
        "ORDER BY id DESC",
        "LIMIT 1"
      ].join(" "),
      [Number(requesterUserId), Number(targetUserId)]
    );
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
      visibility: type === "room" ? String(row.visibility || "public") : "",
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
   * Normalizes room visibility for creation and rendering.
   *
   * @param {string} visibility - Candidate visibility.
   * @returns {"public"|"private"} Sanitized visibility mode.
   */
  normalizeRoomVisibility(visibility) {
    const normalized = cleanText(visibility || "public").toLowerCase();
    if (!normalized || normalized === "public") return "public";
    if (normalized === "private") return "private";
    throw new Error("Room visibility must be public or private.");
  }

  /**
   * Normalizes a list of usernames invited to a private room.
   *
   * @param {string[]|string} invitedUsers - Candidate usernames.
   * @param {number} currentUserId - Creating user id for self-filtering.
   * @returns {string[]} Sanitized unique usernames.
   */
  normalizeInvitedUsernames(invitedUsers, currentUserId) {
    const rawList = Array.isArray(invitedUsers)
      ? invitedUsers
      : String(invitedUsers || "").split(/[,\n]/g);
    const currentUser = this.get("SELECT username_normalized FROM users WHERE id = ?", [Number(currentUserId)]);
    const currentUsername = String(currentUser && currentUser.username_normalized ? currentUser.username_normalized : "");
    const seen = new Set();
    const normalized = [];

    for (const entry of rawList) {
      const value = cleanText(entry);
      if (!value) continue;
      const username = this.normalizeUsername(value).toLowerCase();
      if (!username || username === currentUsername || seen.has(username)) {
        continue;
      }
      seen.add(username);
      normalized.push(username);
    }

    if (normalized.length > MAX_PRIVATE_ROOM_INVITES) {
      throw new Error(`Private rooms can invite up to ${MAX_PRIVATE_ROOM_INVITES} users at once.`);
    }

    return normalized;
  }

  /**
   * Normalizes invited usernames and ensures each target account exists.
   *
   * @param {string[]|string} invitedUsers - Candidate usernames.
   * @param {number} currentUserId - Creating user id for self-filtering.
   * @returns {string[]} Existing usernames normalized for storage.
   */
  resolveInvitedUsers(invitedUsers, currentUserId) {
    const normalizedUsers = this.normalizeInvitedUsernames(invitedUsers, currentUserId);
    for (const username of normalizedUsers) {
      if (!this.findUserByUsername(username)) {
        throw new Error(`Could not find invited user @${username}.`);
      }
    }
    return normalizedUsers;
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
   * Returns the built-in Antarctic system user row used for service DMs.
   *
   * @returns {object|null} System user row or null.
   */
  getSystemUser() {
    return this.get("SELECT * FROM users WHERE username_normalized = ? LIMIT 1", [DEFAULT_SYSTEM_USERNAME]) ||
      this.get("SELECT * FROM users ORDER BY id ASC LIMIT 1");
  }

  /**
   * Returns the current mute state if the user is still muted.
   *
   * @param {number} userId - User id.
   * @returns {{ until: string, message: string }|null} Active mute details or null.
   */
  getActiveMute(userId) {
    const row = this.get("SELECT muted_until, muted_reason FROM users WHERE id = ?", [Number(userId)]);
    const mutedUntil = String(row && row.muted_until ? row.muted_until : "");
    if (!mutedUntil) {
      return null;
    }

    if (new Date(mutedUntil).getTime() <= new Date(this.nowIso()).getTime()) {
      this.run("UPDATE users SET muted_until = '', muted_reason = '' WHERE id = ?", [Number(userId)]);
      this.queueFlush();
      return null;
    }

    return {
      until: mutedUntil,
      message: `You are muted until ${mutedUntil} for ${String(row && row.muted_reason ? row.muted_reason : "automod")}.`
    };
  }

  /**
   * Applies the built-in language automod mute and returns the user-facing error text.
   *
   * @param {number} userId - User id to mute.
   * @param {string} blockedTerm - Matched blocked term.
   * @returns {string} Error text shown to the user.
   */
  applyAutomodMute(userId, blockedTerm) {
    const mutedUntil = toIsoNow(new Date(this.now()).getTime() + AUTOMOD_MUTE_MS);
    this.run(
      "UPDATE users SET muted_until = ?, muted_reason = ?, updated_at = ? WHERE id = ?",
      [mutedUntil, AUTOMOD_MUTED_REASON, this.nowIso(), Number(userId)]
    );
    this.queueFlush();
    return `Automod muted you for 3 minutes because of blocked language ("${blockedTerm}").`;
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
   * Verifies the provided password against both the fast Antarctic format and the legacy hash format.
   *
   * @param {string} storedHash - Persisted hash value.
   * @param {string} password - Plaintext password to verify.
   * @param {string} saltHex - Persisted salt encoded as hexadecimal.
   * @returns {{ ok: boolean, needsUpgrade: boolean, upgradedHash: string }} Verification result.
   */
  verifyPasswordHash(storedHash, password, saltHex) {
    const normalizedHash = cleanText(storedHash);
    const normalizedSalt = cleanText(saltHex);
    if (!normalizedHash || !normalizedSalt) {
      return { ok: false, needsUpgrade: false, upgradedHash: "" };
    }

    if (normalizedHash.startsWith(FAST_PASSWORD_HASH_PREFIX)) {
      const expectedFastHash = hashPassword(password, normalizedSalt, FAST_SCRYPT_OPTIONS);
      return {
        ok: this.safeHashEquals(normalizedHash.slice(FAST_PASSWORD_HASH_PREFIX.length), expectedFastHash),
        needsUpgrade: false,
        upgradedHash: ""
      };
    }

    const legacyHash = hashPassword(password, normalizedSalt);
    if (!this.safeHashEquals(normalizedHash, legacyHash)) {
      return { ok: false, needsUpgrade: false, upgradedHash: "" };
    }

    return {
      ok: true,
      needsUpgrade: true,
      upgradedHash: hashPasswordFast(password, normalizedSalt)
    };
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

const crypto = require("node:crypto");
const { Pool } = require("pg");

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
 * Converts a database row into a plain public user payload.
 *
 * @param {object} row - Raw database row.
 * @returns {{ id: number, username: string, createdAt: string }} Public user payload.
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
 * @param {object} row - Raw database row.
 * @returns {object} Public direct-request representation.
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
 * @param {object} row - Raw database row.
 * @returns {object} Public room representation.
 */
function toPublicRoom(row) {
  return {
    id: Number(row.id),
    type: "room",
    name: String(row.name || ""),
    visibility: String(row.visibility || "public"),
    memberCount: Number(row.member_count || 0),
    joined: Boolean(row.joined),
    invited: Boolean(row.invited),
    ownerUserId: Number(row.owner_user_id || 0),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || "")
  };
}

/**
 * Rewrites SQLite-style `?` placeholders into PostgreSQL `$1` parameters.
 *
 * @param {string} sql - SQL string using `?` placeholders.
 * @returns {string} PostgreSQL-compatible SQL string.
 */
function toPgSql(sql) {
  let index = 0;
  return String(sql || "").replace(/\?/g, () => `$${++index}`);
}

/**
 * Supabase Postgres-backed persistence layer for Antarctic accounts, chat threads, and cloud saves.
 */
class AntarcticSupabaseCommunityStore {
  /**
   * @param {object} options - Store configuration.
   * @param {string} [options.connectionString] - PostgreSQL connection string for the Supabase project.
   * @param {Pool} [options.pool] - Optional injected pg pool for tests.
   * @param {number} [options.sessionTtlDays=30] - Number of days a session remains valid.
   * @param {() => Date|number|string} [options.now=() => new Date()] - Injectable clock for tests.
   */
  constructor({ connectionString = "", pool = null, sessionTtlDays = DEFAULT_SESSION_TTL_DAYS, now = () => new Date() }) {
    this.connectionString = cleanText(connectionString);
    this.pool = pool || null;
    this.ownsPool = !pool;
    this.sessionTtlDays = Math.max(1, Number(sessionTtlDays) || DEFAULT_SESSION_TTL_DAYS);
    this.now = now;
  }

  /**
   * Connects to Postgres, applies schema migrations, and ensures the default room exists.
   *
   * @returns {Promise<AntarcticSupabaseCommunityStore>} Initialized store.
   */
  async initialize() {
    if (!this.pool) {
      if (!this.connectionString) {
        throw new Error("SUPABASE_DB_URL is required when account storage uses Supabase.");
      }
      this.pool = new Pool({
        connectionString: this.connectionString
      });
    }

    await this.runSchemaMigrations();
    await this.ensureDefaultRoom();
    return this;
  }

  /**
   * Closes the underlying database pool when owned by this store.
   *
   * @returns {Promise<void>}
   */
  async close() {
    if (this.pool && this.ownsPool && typeof this.pool.end === "function") {
      await this.pool.end();
    }
  }

  /**
   * Creates a new account, session, and default-room membership.
   *
   * @param {object} payload - Signup payload.
   * @param {string} payload.username - Desired username.
   * @param {string} payload.password - Plaintext password.
   * @returns {Promise<{ token: string, user: object, bootstrap: object }>} Auth result.
   */
  async signUp({ username, password }) {
    const normalizedUsername = this.normalizeUsername(username);
    const normalizedPassword = this.normalizePassword(password);
    const nowIso = this.nowIso();

    if (await this.findUserByUsername(normalizedUsername)) {
      throw new Error("That username is already taken.");
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = hashPasswordFast(normalizedPassword, salt);
    const user = await this.get(
      [
        "INSERT INTO users (username, username_normalized, password_hash, password_salt, created_at, updated_at)",
        "VALUES (?, ?, ?, ?, ?, ?)",
        "RETURNING id, username, created_at"
      ].join(" "),
      [normalizedUsername, normalizedUsername.toLowerCase(), hash, salt, nowIso, nowIso]
    );

    await this.ensureLobbyMembership(Number(user.id));
    const session = await this.createSessionForUser(Number(user.id));
    return {
      token: session.token,
      user: toPublicUser(user),
      bootstrap: await this.getCommunitySnapshot(Number(user.id))
    };
  }

  /**
   * Authenticates an existing account and returns a fresh session token.
   *
   * @param {object} payload - Login payload.
   * @param {string} payload.username - Username.
   * @param {string} payload.password - Plaintext password.
   * @returns {Promise<{ token: string, user: object, bootstrap: object }>} Auth result.
   */
  async login({ username, password }) {
    const normalizedUsername = this.normalizeUsername(username);
    const normalizedPassword = this.normalizePassword(password);
    const user = await this.findUserByUsername(normalizedUsername);
    if (!user) {
      throw new Error("Invalid username or password.");
    }

    const verification = this.verifyPasswordHash(
      String(user.password_hash || ""),
      normalizedPassword,
      String(user.password_salt || "")
    );
    if (!verification.ok) {
      throw new Error("Invalid username or password.");
    }

    await this.cleanupExpiredSessions();
    await this.ensureLobbyMembership(Number(user.id));
    if (verification.needsUpgrade) {
      await this.run("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", [
        verification.upgradedHash,
        this.nowIso(),
        Number(user.id)
      ]);
    }
    const session = await this.createSessionForUser(Number(user.id));
    return {
      token: session.token,
      user: toPublicUser(user),
      bootstrap: await this.getCommunitySnapshot(Number(user.id))
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
    await this.run("DELETE FROM sessions WHERE token = ?", [normalized]);
  }

  /**
   * Resolves an authenticated session token into the current user.
   *
   * @param {string} token - Session token.
   * @returns {Promise<null|{ token: string, user: object }>} Active session or null.
   */
  async getSession(token) {
    const normalized = cleanText(token);
    if (!normalized) return null;

    await this.cleanupExpiredSessions();
    const row = await this.get(
      [
        "SELECT sessions.token, users.id, users.username, users.created_at",
        "FROM sessions",
        "JOIN users ON users.id = sessions.user_id",
        "WHERE sessions.token = ? AND sessions.expires_at > ?"
      ].join(" "),
      [normalized, this.nowIso()]
    );
    if (!row) {
      return null;
    }

    await this.ensureLobbyMembership(Number(row.id));
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
   * @returns {Promise<object[]>} Matching users.
   */
  async searchUsers(currentUserId, query) {
    const term = cleanText(query).toLowerCase();
    if (!term) return [];

    return (await this.all(
      [
        "SELECT id, username, created_at",
        "FROM users",
        "WHERE username_normalized LIKE ?",
        "AND id <> ?",
        "ORDER BY username_normalized ASC",
        "LIMIT 12"
      ].join(" "),
      [`%${term}%`, Number(currentUserId)]
    )).map(toPublicUser);
  }

  /**
   * Returns the room catalog and joined thread list for a user.
   *
   * @param {number} userId - Authenticated user id.
   * @returns {Promise<{ threads: object[], rooms: object[] }>} Thread catalog.
   */
  async listThreadsForUser(userId) {
    const joinedThreadRows = await this.all(
      [
        "SELECT threads.id, threads.type, threads.name, threads.visibility, threads.owner_user_id, threads.created_at, threads.updated_at",
        "FROM thread_participants participant",
        "JOIN threads ON threads.id = participant.thread_id",
        "WHERE participant.user_id = ?",
        "ORDER BY threads.updated_at DESC, threads.id DESC"
      ].join(" "),
      [Number(userId)]
    );
    const hydratedThreads = [];
    for (const row of joinedThreadRows) {
      hydratedThreads.push(await this.hydrateThreadRowForUser(Number(userId), row));
    }
    hydratedThreads.sort((left, right) => {
      const leftTime = String((left.lastMessage && left.lastMessage.createdAt) || left.updatedAt || left.createdAt || "");
      const rightTime = String((right.lastMessage && right.lastMessage.createdAt) || right.updatedAt || right.createdAt || "");
      if (leftTime === rightTime) {
        return Number(right.id) - Number(left.id);
      }
      return rightTime.localeCompare(leftTime);
    });

    const roomRows = await this.all(
      [
        "SELECT threads.id, threads.type, threads.name, threads.visibility, threads.owner_user_id, threads.created_at, threads.updated_at",
        "FROM threads",
        "WHERE threads.type = 'room'",
        "ORDER BY LOWER(threads.name) ASC, threads.id ASC"
      ].join(" "),
      []
    );
    const rooms = [];
    for (const row of roomRows) {
      const memberCount = await this.get("SELECT COUNT(*) AS count FROM thread_participants WHERE thread_id = ?", [Number(row.id)]);
      const joined = await this.get("SELECT 1 FROM thread_participants WHERE thread_id = ? AND user_id = ?", [
        Number(row.id),
        Number(userId)
      ]);
      const invited = await this.get(
        "SELECT 1 FROM room_invitations WHERE thread_id = ? AND user_id = ? AND status = 'pending'",
        [Number(row.id), Number(userId)]
      );
      if (String(row.visibility || "public") !== "public" && Number(row.owner_user_id) !== Number(userId) && !joined && !invited) {
        continue;
      }
      rooms.push(toPublicRoom({
        ...row,
        member_count: memberCount ? Number(memberCount.count || 0) : 0,
        joined: Boolean(joined),
        invited: Boolean(invited)
      }));
    }

    return {
      threads: hydratedThreads,
      rooms
    };
  }

  /**
   * Returns the logged-in community dashboard payload in one call.
   *
   * @param {number} userId - Authenticated user id.
   * @returns {Promise<object>} Snapshot payload.
   */
  async getCommunitySnapshot(userId) {
    const catalog = await this.listThreadsForUser(Number(userId));
    const saves = await this.listGameSaves(Number(userId));
    const incomingDirectRequests = await this.listIncomingDirectRequests(Number(userId));
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
      ? await this.resolveInvitedUsers(options.invitedUsers, Number(userId))
      : [];
    const nowIso = this.nowIso();
    const inserted = await this.get(
      [
        "INSERT INTO threads (type, name, visibility, owner_user_id, direct_key, created_at, updated_at)",
        "VALUES ('room', ?, ?, ?, NULL, ?, ?)",
        "RETURNING id"
      ].join(" "),
      [normalizedName, visibility, Number(userId), nowIso, nowIso]
    );
    const threadId = Number(inserted.id);
    await this.ensureThreadParticipant(threadId, Number(userId));
    if (visibility === "private" && invitedUsers.length) {
      await this.applyPrivateRoomInvitations(threadId, Number(userId), normalizedName, invitedUsers);
    }
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
    const room = await this.get("SELECT * FROM threads WHERE id = ? AND type = 'room'", [Number(threadId)]);
    if (!room) {
      throw new Error("That room does not exist.");
    }

    const alreadyJoined = await this.get(
      "SELECT 1 FROM thread_participants WHERE thread_id = ? AND user_id = ?",
      [Number(threadId), Number(userId)]
    );
    if (String(room.visibility || "public") === "private" && !alreadyJoined && Number(room.owner_user_id) !== Number(userId)) {
      const invite = await this.get(
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
      await this.run(
        "UPDATE room_invitations SET status = 'accepted', updated_at = ? WHERE thread_id = ? AND user_id = ?",
        [this.nowIso(), Number(threadId), Number(userId)]
      );
    }

    await this.ensureThreadParticipant(Number(threadId), Number(userId));
    await this.run("UPDATE threads SET updated_at = ? WHERE id = ?", [this.nowIso(), Number(threadId)]);
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
    const room = await this.getThreadForUser(Number(userId), Number(threadId));
    if (!room || room.type !== "room") {
      throw new Error("That room is unavailable.");
    }

    await this.run("DELETE FROM thread_participants WHERE thread_id = ? AND user_id = ?", [Number(threadId), Number(userId)]);
    await this.run("UPDATE threads SET updated_at = ? WHERE id = ?", [this.nowIso(), Number(threadId)]);
  }

  /**
   * Records private-room invitations and notifies each invited user through the Antarctic system DM.
   *
   * @param {number} threadId - Private room thread id.
   * @param {number} invitedByUserId - User id who created the room.
   * @param {string} roomName - Room name used in notifications.
   * @param {string[]} invitedUsers - Validated usernames to invite.
   * @returns {Promise<void>}
   */
  async applyPrivateRoomInvitations(threadId, invitedByUserId, roomName, invitedUsers) {
    const inviter = await this.get("SELECT username FROM users WHERE id = ?", [Number(invitedByUserId)]);
    const invitedByUsername = String(inviter && inviter.username ? inviter.username : DEFAULT_SYSTEM_USERNAME);
    const nowIso = this.nowIso();

    for (const username of invitedUsers) {
      const target = await this.findUserByUsername(username);
      if (!target || Number(target.id) === Number(invitedByUserId)) {
        continue;
      }

      await this.run(
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
      await this.notifyRoomInvite(Number(target.id), roomName, invitedByUsername);
    }
  }

  /**
   * Sends an Antarctic system DM notifying a user about a private-room invite.
   *
   * @param {number} invitedUserId - Invited user id.
   * @param {string} roomName - Invited room name.
   * @param {string} invitedByUsername - Inviter username.
   * @returns {Promise<void>}
   */
  async notifyRoomInvite(invitedUserId, roomName, invitedByUsername) {
    const systemUser = await this.getSystemUser();
    if (!systemUser) return;

    const directThread = await this.createDirectThread(Number(systemUser.id), Number(invitedUserId));
    const message =
      `You were invited to the private room "${roomName}" by @${invitedByUsername}. ` +
      "Open Antarctic chat and accept the room from your room list when you are ready.";
    await this.addSystemMessage(Number(systemUser.id), Number(directThread.id), message);
  }

  /**
   * Creates a pending DM request or reuses/accepts an existing direct thread.
   *
   * @param {number} userId - Authenticated user id.
   * @param {string} username - Target username.
   * @returns {Promise<{ kind: string, request?: object, thread?: object }>} DM creation result.
   */
  async requestDirectThread(userId, username) {
    const target = await this.findUserByUsername(this.normalizeUsername(username));
    if (!target) {
      throw new Error("That user does not exist.");
    }
    if (Number(target.id) === Number(userId)) {
      throw new Error("You are already talking to yourself in your head.");
    }

    const directKey = directKeyForUsers(Number(userId), Number(target.id));
    const existingThread = await this.get("SELECT * FROM threads WHERE direct_key = ?", [directKey]);
    if (existingThread) {
      return {
        kind: "thread",
        thread: await this.getThreadForUser(Number(userId), Number(existingThread.id))
      };
    }

    const pendingIncoming = await this.getPendingDirectRequest(Number(target.id), Number(userId));
    if (pendingIncoming) {
      return this.acceptDirectRequest(Number(userId), Number(pendingIncoming.id));
    }

    const existingOutgoing = await this.getPendingDirectRequest(Number(userId), Number(target.id));
    if (existingOutgoing) {
      return {
        kind: "request",
        request: await this.getDirectRequestForUser(Number(userId), Number(existingOutgoing.id))
      };
    }

    const nowIso = this.nowIso();
    const inserted = await this.get(
      [
        "INSERT INTO direct_requests (requester_user_id, target_user_id, status, resolved_thread_id, created_at, updated_at)",
        "VALUES (?, ?, 'pending', NULL, ?, ?)",
        "RETURNING id"
      ].join(" "),
      [Number(userId), Number(target.id), nowIso, nowIso]
    );
    return {
      kind: "request",
      request: await this.getDirectRequestForUser(Number(userId), Number(inserted.id))
    };
  }

  /**
   * Creates or reuses a direct-message thread between two users immediately.
   *
   * @param {number} firstUserId - First participant id.
   * @param {number} secondUserId - Second participant id.
   * @returns {Promise<object>} Direct thread details for the first user.
   */
  async createDirectThread(firstUserId, secondUserId) {
    const directKey = directKeyForUsers(Number(firstUserId), Number(secondUserId));
    let thread = await this.get("SELECT * FROM threads WHERE direct_key = ?", [directKey]);
    if (!thread) {
      const nowIso = this.nowIso();
      const inserted = await this.get(
        [
          "INSERT INTO threads (type, name, visibility, owner_user_id, direct_key, created_at, updated_at)",
          "VALUES ('direct', NULL, 'public', ?, ?, ?, ?)",
          "RETURNING id"
        ].join(" "),
        [Number(firstUserId), directKey, nowIso, nowIso]
      );
      const threadId = Number(inserted.id);
      await this.ensureThreadParticipant(threadId, Number(firstUserId));
      await this.ensureThreadParticipant(threadId, Number(secondUserId));
      thread = await this.get("SELECT * FROM threads WHERE id = ?", [threadId]);
    }

    return this.getThreadForUser(Number(firstUserId), Number(thread.id));
  }

  /**
   * Accepts a pending incoming DM request and opens the resulting direct thread.
   *
   * @param {number} userId - Authenticated target user id.
   * @param {number} requestId - Pending request id.
   * @returns {Promise<{ kind: string, request: object, thread: object }>} Accepted DM result.
   */
  async acceptDirectRequest(userId, requestId) {
    const request = await this.getDirectRequestForUser(Number(userId), Number(requestId));
    if (!request || request.status !== "pending" || !request.target || Number(request.target.id) !== Number(userId)) {
      throw new Error("That DM request is unavailable.");
    }

    const thread = await this.createDirectThread(Number(request.requester.id), Number(request.target.id));
    await this.run(
      "UPDATE direct_requests SET status = 'accepted', resolved_thread_id = ?, updated_at = ? WHERE id = ?",
      [Number(thread.id), this.nowIso(), Number(requestId)]
    );
    return {
      kind: "thread",
      request: await this.getDirectRequestForUser(Number(userId), Number(requestId)),
      thread: await this.getThreadForUser(Number(userId), Number(thread.id))
    };
  }

  /**
   * Denies a pending incoming DM request.
   *
   * @param {number} userId - Authenticated target user id.
   * @param {number} requestId - Pending request id.
   * @returns {Promise<{ kind: string, request: object }>} Denied DM result.
   */
  async denyDirectRequest(userId, requestId) {
    const request = await this.getDirectRequestForUser(Number(userId), Number(requestId));
    if (!request || request.status !== "pending" || !request.target || Number(request.target.id) !== Number(userId)) {
      throw new Error("That DM request is unavailable.");
    }

    await this.run("UPDATE direct_requests SET status = 'denied', updated_at = ? WHERE id = ?", [
      this.nowIso(),
      Number(requestId)
    ]);
    return {
      kind: "request",
      request: await this.getDirectRequestForUser(Number(userId), Number(requestId))
    };
  }

  /**
   * Lists recent messages for a thread the user belongs to.
   *
   * @param {number} userId - Authenticated user id.
   * @param {number} threadId - Thread id.
   * @returns {Promise<object[]>} Ordered message list.
   */
  async listMessages(userId, threadId) {
    const thread = await this.getThreadForUser(Number(userId), Number(threadId));
    if (!thread) {
      throw new Error("That conversation is unavailable.");
    }

    return (await this.all(
      [
        "SELECT messages.id, messages.thread_id, messages.user_id, messages.content, messages.created_at, users.username",
        "FROM messages",
        "JOIN users ON users.id = messages.user_id",
        "WHERE messages.thread_id = ?",
        "ORDER BY messages.id ASC",
        "LIMIT 150"
      ].join(" "),
      [Number(threadId)]
    )).map((row) => ({
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
    const activeMute = await this.getActiveMute(Number(userId));
    if (activeMute) {
      throw new Error(activeMute.message);
    }

    const blockedTerm = findAutomodMatch(content);
    if (blockedTerm) {
      throw new Error(await this.applyAutomodMute(Number(userId), blockedTerm));
    }

    return this.addMessageInternal(Number(userId), Number(threadId), content);
  }

  /**
   * Adds a system-generated message without applying user moderation checks.
   *
   * @param {number} userId - Message author id.
   * @param {number} threadId - Target thread id.
   * @param {string} content - Message content.
   * @returns {Promise<object>} Created message.
   */
  async addSystemMessage(userId, threadId, content) {
    return this.addMessageInternal(Number(userId), Number(threadId), content);
  }

  /**
   * Inserts a message for a thread participant after validation.
   *
   * @param {number} userId - Message author id.
   * @param {number} threadId - Target thread id.
   * @param {string} content - Message content.
   * @returns {Promise<object>} Created message.
   */
  async addMessageInternal(userId, threadId, content) {
    const thread = await this.getThreadForUser(Number(userId), Number(threadId));
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
    const inserted = await this.get(
      [
        "INSERT INTO messages (thread_id, user_id, content, created_at)",
        "VALUES (?, ?, ?, ?)",
        "RETURNING id"
      ].join(" "),
      [Number(threadId), Number(userId), normalized, createdAt]
    );
    await this.run("UPDATE threads SET updated_at = ? WHERE id = ?", [createdAt, Number(threadId)]);
    const author = await this.get("SELECT username FROM users WHERE id = ?", [Number(userId)]);

    return {
      id: Number(inserted.id),
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
   * @returns {Promise<object[]>} Save entries.
   */
  async listGameSaves(userId) {
    return (await this.all(
      [
        "SELECT game_key, summary, updated_at, save_data",
        "FROM game_saves",
        "WHERE user_id = ?",
        "ORDER BY updated_at DESC, game_key ASC"
      ].join(" "),
      [Number(userId)]
    )).map((row) => ({
      gameKey: String(row.game_key || ""),
      summary: String(row.summary || ""),
      updatedAt: String(row.updated_at || ""),
      sizeBytes: Buffer.byteLength(String(row.save_data || ""), "utf8")
    }));
  }

  /**
   * Reads one saved game snapshot.
   *
   * @param {number} userId - Authenticated user id.
   * @param {string} gameKey - Game identifier.
   * @returns {Promise<object|null>} Save entry or null.
   */
  async getGameSave(userId, gameKey) {
    const normalizedKey = this.normalizeGameKey(gameKey);
    const row = await this.get(
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
    await this.run(
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
    await this.run("DELETE FROM game_saves WHERE user_id = ? AND game_key = ?", [Number(userId), normalizedKey]);
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
   * Creates the PostgreSQL schema expected by the community APIs.
   *
   * @returns {Promise<void>}
   */
  async runSchemaMigrations() {
    await this.exec([
      "CREATE TABLE IF NOT EXISTS users (",
      "  id BIGSERIAL PRIMARY KEY,",
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
      "  id BIGSERIAL PRIMARY KEY,",
      "  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
      "  token TEXT NOT NULL UNIQUE,",
      "  created_at TEXT NOT NULL,",
      "  expires_at TEXT NOT NULL",
      ");",
      "CREATE TABLE IF NOT EXISTS threads (",
      "  id BIGSERIAL PRIMARY KEY,",
      "  type TEXT NOT NULL CHECK(type IN ('room', 'direct')),",
      "  name TEXT,",
      "  visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public', 'private')),",
      "  owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
      "  direct_key TEXT UNIQUE,",
      "  created_at TEXT NOT NULL,",
      "  updated_at TEXT NOT NULL",
      ");",
      "CREATE TABLE IF NOT EXISTS thread_participants (",
      "  thread_id BIGINT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,",
      "  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
      "  joined_at TEXT NOT NULL,",
      "  PRIMARY KEY(thread_id, user_id)",
      ");",
      "CREATE TABLE IF NOT EXISTS messages (",
      "  id BIGSERIAL PRIMARY KEY,",
      "  thread_id BIGINT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,",
      "  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
      "  content TEXT NOT NULL,",
      "  created_at TEXT NOT NULL",
      ");",
      "CREATE TABLE IF NOT EXISTS direct_requests (",
      "  id BIGSERIAL PRIMARY KEY,",
      "  requester_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
      "  target_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
      "  status TEXT NOT NULL CHECK(status IN ('pending', 'accepted', 'denied')),",
      "  resolved_thread_id BIGINT REFERENCES threads(id) ON DELETE SET NULL,",
      "  created_at TEXT NOT NULL,",
      "  updated_at TEXT NOT NULL",
      ");",
      "CREATE TABLE IF NOT EXISTS room_invitations (",
      "  thread_id BIGINT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,",
      "  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
      "  invited_by_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
      "  status TEXT NOT NULL CHECK(status IN ('pending', 'accepted', 'declined')),",
      "  created_at TEXT NOT NULL,",
      "  updated_at TEXT NOT NULL,",
      "  PRIMARY KEY(thread_id, user_id)",
      ");",
      "CREATE TABLE IF NOT EXISTS game_saves (",
      "  id BIGSERIAL PRIMARY KEY,",
      "  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,",
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
  }

  /**
   * Ensures the built-in lobby room exists.
   *
   * @returns {Promise<boolean>} Whether a room was created.
   */
  async ensureDefaultRoom() {
    const existing = await this.get("SELECT id FROM threads WHERE type = 'room' AND LOWER(name) = LOWER(?)", [DEFAULT_ROOM_NAME]);
    if (existing) return false;

    let systemOwner = await this.get("SELECT id FROM users WHERE username_normalized = ? LIMIT 1", [DEFAULT_SYSTEM_USERNAME]);
    if (!systemOwner) {
      const nowIso = this.nowIso();
      const salt = crypto.randomBytes(16).toString("hex");
      const hash = hashPasswordFast(createToken(), salt);
      systemOwner = await this.get(
        [
          "INSERT INTO users (username, username_normalized, password_hash, password_salt, created_at, updated_at)",
          "VALUES (?, ?, ?, ?, ?, ?)",
          "RETURNING id"
        ].join(" "),
        [DEFAULT_SYSTEM_USERNAME, DEFAULT_SYSTEM_USERNAME, hash, salt, nowIso, nowIso]
      );
    }

    const nowIso = this.nowIso();
    await this.run(
      [
        "INSERT INTO threads (type, name, visibility, owner_user_id, direct_key, created_at, updated_at)",
        "VALUES ('room', ?, 'public', ?, NULL, ?, ?)"
      ].join(" "),
      [DEFAULT_ROOM_NAME, Number(systemOwner.id), nowIso, nowIso]
    );
    return true;
  }

  /**
   * Adds a user to the built-in lobby if they are not already a participant.
   *
   * @param {number} userId - User id.
   * @returns {Promise<boolean>} Whether a participant row was created.
   */
  async ensureLobbyMembership(userId) {
    const lobby = await this.get("SELECT id FROM threads WHERE type = 'room' AND LOWER(name) = LOWER(?)", [DEFAULT_ROOM_NAME]);
    if (!lobby) return false;
    return this.ensureThreadParticipant(Number(lobby.id), Number(userId));
  }

  /**
   * Adds a participant to a thread if needed.
   *
   * @param {number} threadId - Thread id.
   * @param {number} userId - User id.
   * @returns {Promise<boolean>} Whether a participant row was created.
   */
  async ensureThreadParticipant(threadId, userId) {
    const existing = await this.get("SELECT 1 FROM thread_participants WHERE thread_id = ? AND user_id = ?", [
      Number(threadId),
      Number(userId)
    ]);
    if (existing) return false;

    await this.run("INSERT INTO thread_participants (thread_id, user_id, joined_at) VALUES (?, ?, ?)", [
      Number(threadId),
      Number(userId),
      this.nowIso()
    ]);
    return true;
  }

  /**
   * Creates a new session row for a user.
   *
   * @param {number} userId - User id.
   * @returns {Promise<{ token: string, expiresAt: string }>} New session details.
   */
  async createSessionForUser(userId) {
    const createdAt = this.nowIso();
    const expiresAt = toIsoNow(new Date(new Date(createdAt).getTime() + this.sessionTtlDays * 24 * 60 * 60 * 1000));
    const token = createToken();
    await this.run("INSERT INTO sessions (user_id, token, created_at, expires_at) VALUES (?, ?, ?, ?)", [
      Number(userId),
      token,
      createdAt,
      expiresAt
    ]);
    return { token, expiresAt };
  }

  /**
   * Removes expired sessions from the database.
   *
   * @returns {Promise<void>}
   */
  async cleanupExpiredSessions() {
    await this.run("DELETE FROM sessions WHERE expires_at <= ?", [this.nowIso()]);
  }

  /**
   * Looks up a user by username, case-insensitively.
   *
   * @param {string} username - Username to locate.
   * @returns {Promise<object|null>} User row or null.
   */
  async findUserByUsername(username) {
    return this.get("SELECT * FROM users WHERE username_normalized = ?", [cleanText(username).toLowerCase()]);
  }

  /**
   * Fetches a thread only if the user belongs to it.
   *
   * @param {number} userId - User id.
   * @param {number} threadId - Thread id.
   * @returns {Promise<object|null>} Public thread or null.
   */
  async getThreadForUser(userId, threadId) {
    const row = await this.get(
      [
        "SELECT threads.id, threads.type, threads.name, threads.visibility, threads.owner_user_id, threads.created_at, threads.updated_at",
        "FROM thread_participants participant",
        "JOIN threads ON threads.id = participant.thread_id",
        "WHERE participant.user_id = ? AND threads.id = ?"
      ].join(" "),
      [Number(userId), Number(threadId)]
    );

    return row ? this.hydrateThreadRowForUser(Number(userId), row) : null;
  }

  /**
   * Adds peer and last-message metadata to a raw thread row.
   *
   * @param {number} userId - Current user id.
   * @param {object} row - Raw thread row.
   * @returns {Promise<object>} Hydrated public thread.
   */
  async hydrateThreadRowForUser(userId, row) {
    const lastMessage = await this.get(
      [
        "SELECT messages.id, messages.content, messages.created_at, users.username AS author_username",
        "FROM messages",
        "JOIN users ON users.id = messages.user_id",
        "WHERE messages.thread_id = ?",
        "ORDER BY messages.id DESC",
        "LIMIT 1"
      ].join(" "),
      [Number(row.id)]
    );
    const peer = await this.get(
      [
        "SELECT users.id, users.username",
        "FROM thread_participants other_participant",
        "JOIN users ON users.id = other_participant.user_id",
        "WHERE other_participant.thread_id = ?",
        "AND other_participant.user_id <> ?",
        "ORDER BY other_participant.user_id ASC",
        "LIMIT 1"
      ].join(" "),
      [Number(row.id), Number(userId)]
    );

    return this.toPublicThread({
      ...row,
      other_user_id: peer ? Number(peer.id) : null,
      other_user_username: peer ? String(peer.username || "") : "",
      last_message_id: lastMessage ? Number(lastMessage.id) : null,
      last_message_content: lastMessage ? String(lastMessage.content || "") : "",
      last_message_created_at: lastMessage ? String(lastMessage.created_at || "") : "",
      last_message_author_username: lastMessage ? String(lastMessage.author_username || "") : ""
    });
  }

  /**
   * Lists pending incoming DM requests for a user.
   *
   * @param {number} userId - Authenticated user id.
   * @returns {Promise<object[]>} Ordered pending incoming requests.
   */
  async listIncomingDirectRequests(userId) {
    return (await this.all(
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
    )).map(toPublicDirectRequest);
  }

  /**
   * Fetches one DM request visible to the requester or target.
   *
   * @param {number} userId - Authenticated user id.
   * @param {number} requestId - DM request id.
   * @returns {Promise<object|null>} Public request or null.
   */
  async getDirectRequestForUser(userId, requestId) {
    const row = await this.get(
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
   * @returns {Promise<object|null>} Pending request row or null.
   */
  async getPendingDirectRequest(requesterUserId, targetUserId) {
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
   * @param {object} row - Raw row.
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
   * @returns {Promise<string[]>} Sanitized unique usernames.
   */
  async normalizeInvitedUsernames(invitedUsers, currentUserId) {
    const rawList = Array.isArray(invitedUsers) ? invitedUsers : String(invitedUsers || "").split(/[,\n]/g);
    const currentUser = await this.get("SELECT username_normalized FROM users WHERE id = ?", [Number(currentUserId)]);
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
   * @returns {Promise<string[]>} Existing usernames normalized for storage.
   */
  async resolveInvitedUsers(invitedUsers, currentUserId) {
    const normalizedUsers = await this.normalizeInvitedUsernames(invitedUsers, currentUserId);
    for (const username of normalizedUsers) {
      if (!await this.findUserByUsername(username)) {
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
   * @returns {Promise<object|null>} System user row or null.
   */
  async getSystemUser() {
    return (
      await this.get("SELECT * FROM users WHERE username_normalized = ? LIMIT 1", [DEFAULT_SYSTEM_USERNAME])
    ) || (
      await this.get("SELECT * FROM users ORDER BY id ASC LIMIT 1")
    );
  }

  /**
   * Returns the current mute state if the user is still muted.
   *
   * @param {number} userId - User id.
   * @returns {Promise<{ until: string, message: string }|null>} Active mute details or null.
   */
  async getActiveMute(userId) {
    const row = await this.get("SELECT muted_until, muted_reason FROM users WHERE id = ?", [Number(userId)]);
    const mutedUntil = String(row && row.muted_until ? row.muted_until : "");
    if (!mutedUntil) {
      return null;
    }

    if (new Date(mutedUntil).getTime() <= new Date(this.nowIso()).getTime()) {
      await this.run("UPDATE users SET muted_until = '', muted_reason = '' WHERE id = ?", [Number(userId)]);
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
   * @returns {Promise<string>} Error text shown to the user.
   */
  async applyAutomodMute(userId, blockedTerm) {
    const mutedUntil = toIsoNow(new Date(this.now()).getTime() + AUTOMOD_MUTE_MS);
    await this.run("UPDATE users SET muted_until = ?, muted_reason = ?, updated_at = ? WHERE id = ?", [
      mutedUntil,
      AUTOMOD_MUTED_REASON,
      this.nowIso(),
      Number(userId)
    ]);
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
   * Executes SQL that does not require bound parameters.
   *
   * @param {string} sql - SQL text.
   * @returns {Promise<void>}
   */
  async exec(sql) {
    await this.pool.query(String(sql || ""));
  }

  /**
   * Executes SQL with bound parameters.
   *
   * @param {string} sql - SQL text using `?` placeholders.
   * @param {unknown[]} [params=[]] - Bound parameters.
   * @returns {Promise<void>}
   */
  async run(sql, params = []) {
    await this.pool.query(toPgSql(sql), params);
  }

  /**
   * Returns the first row for a SQL query.
   *
   * @param {string} sql - SQL text using `?` placeholders.
   * @param {unknown[]} [params=[]] - Bound parameters.
   * @returns {Promise<object|null>} First row or null.
   */
  async get(sql, params = []) {
    const result = await this.pool.query(toPgSql(sql), params);
    return result.rows[0] || null;
  }

  /**
   * Returns every row for a SQL query.
   *
   * @param {string} sql - SQL text using `?` placeholders.
   * @param {unknown[]} [params=[]] - Bound parameters.
   * @returns {Promise<object[]>} Result rows.
   */
  async all(sql, params = []) {
    const result = await this.pool.query(toPgSql(sql), params);
    return result.rows;
  }
}

module.exports = {
  AntarcticSupabaseCommunityStore,
  DEFAULT_ROOM_NAME
};

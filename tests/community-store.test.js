const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");

const { AntarcticCommunityStore, DEFAULT_ROOM_NAME } = require("../services/community-sqlite-store.js");

test("community store supports auth, rooms, DM requests, direct messages, and cloud saves", async (t) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "antarctic-community-store-"));
  const dbPath = path.join(tempDir, "community.sqlite");
  const store = new AntarcticCommunityStore({ dbPath });
  await store.initialize();

  t.after(async () => {
    await store.flush();
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  const firstAuth = await store.signUp({ username: "snowfox", password: "icepass123" });
  const secondAuth = await store.signUp({ username: "blizzard", password: "windpass123" });
  const thirdAuth = await store.signUp({ username: "aurora", password: "polarpass123" });

  assert.equal(firstAuth.user.username, "snowfox");
  assert.equal(secondAuth.user.username, "blizzard");
  assert.equal(firstAuth.bootstrap.stats.threadCount, 1);

  const firstUserRow = store.get(
    "SELECT password_hash, password_salt FROM users WHERE username_normalized = ?",
    ["snowfox"]
  );
  assert.match(firstUserRow.password_hash, /^scrypt-4096\$/);

  const legacyHash = crypto.scryptSync("icepass123", Buffer.from(firstUserRow.password_salt, "hex"), 64).toString("hex");
  store.run(
    "UPDATE users SET password_hash = ? WHERE username_normalized = ?",
    [legacyHash, "snowfox"]
  );

  const loggedIn = await store.login({ username: "snowfox", password: "icepass123" });
  const firstSession = await store.getSession(loggedIn.token);
  assert.equal(firstSession.user.username, "snowfox");
  assert.equal(loggedIn.bootstrap.stats.threadCount, 1);

  const upgradedUserRow = store.get(
    "SELECT password_hash FROM users WHERE username_normalized = ?",
    ["snowfox"]
  );
  assert.match(upgradedUserRow.password_hash, /^scrypt-4096\$/);

  const firstCatalog = store.listThreadsForUser(firstAuth.user.id);
  assert.ok(firstCatalog.rooms.some((room) => room.name === DEFAULT_ROOM_NAME));
  assert.ok(firstCatalog.threads.some((thread) => thread.name === DEFAULT_ROOM_NAME));

  const createdRoom = await store.createRoom(firstAuth.user.id, "Late Night Games");
  assert.equal(createdRoom.name, "Late Night Games");

  await store.joinRoom(secondAuth.user.id, createdRoom.id);
  const roomMessagesBefore = store.listMessages(secondAuth.user.id, createdRoom.id);
  assert.deepEqual(roomMessagesBefore, []);

  await store.leaveRoom(secondAuth.user.id, createdRoom.id);
  assert.equal(
    store.listThreadsForUser(secondAuth.user.id).threads.some((thread) => thread.id === createdRoom.id),
    false
  );
  await store.joinRoom(secondAuth.user.id, createdRoom.id);

  await store.addMessage(firstAuth.user.id, createdRoom.id, "Welcome to the room");
  const roomMessages = store.listMessages(secondAuth.user.id, createdRoom.id);
  assert.equal(roomMessages.length, 1);
  assert.equal(roomMessages[0].content, "Welcome to the room");

  const directRequest = await store.requestDirectThread(firstAuth.user.id, "blizzard");
  assert.equal(directRequest.kind, "request");
  assert.equal(directRequest.request.target.username, "blizzard");

  const pendingSnapshot = store.getCommunitySnapshot(secondAuth.user.id);
  assert.equal(pendingSnapshot.incomingDirectRequests.length, 1);
  assert.equal(pendingSnapshot.incomingDirectRequests[0].requester.username, "snowfox");

  const acceptedDirect = await store.acceptDirectRequest(secondAuth.user.id, pendingSnapshot.incomingDirectRequests[0].id);
  assert.equal(acceptedDirect.kind, "thread");
  assert.equal(acceptedDirect.thread.type, "direct");
  assert.equal(acceptedDirect.thread.peer.username, "snowfox");

  await store.addMessage(secondAuth.user.id, acceptedDirect.thread.id, "hey there");
  const directMessages = store.listMessages(firstAuth.user.id, acceptedDirect.thread.id);
  assert.equal(directMessages.length, 1);
  assert.equal(directMessages[0].content, "hey there");

  const deniedRequest = await store.requestDirectThread(thirdAuth.user.id, "snowfox");
  assert.equal(deniedRequest.kind, "request");
  const denialSnapshot = store.getCommunitySnapshot(firstAuth.user.id);
  assert.equal(denialSnapshot.incomingDirectRequests.length, 1);
  const deniedResult = await store.denyDirectRequest(firstAuth.user.id, denialSnapshot.incomingDirectRequests[0].id);
  assert.equal(deniedResult.kind, "request");
  assert.equal(deniedResult.request.status, "denied");
  assert.equal(store.getCommunitySnapshot(firstAuth.user.id).incomingDirectRequests.length, 0);

  await store.putGameSave(firstAuth.user.id, "games/platformer/ovo.html", { localStorage: { ovo: "42" } }, "OvO cloud");
  const save = store.getGameSave(firstAuth.user.id, "games/platformer/ovo.html");
  assert.equal(save.summary, "OvO cloud");
  assert.deepEqual(save.data, { localStorage: { ovo: "42" } });

  const saves = store.listGameSaves(firstAuth.user.id);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].gameKey, "games/platformer/ovo.html");

  const snapshot = store.getCommunitySnapshot(firstAuth.user.id);
  assert.equal(snapshot.threads.length, 3);
  assert.equal(snapshot.rooms.length, 2);
  assert.equal(snapshot.saves.length, 1);
  assert.equal(snapshot.incomingDirectRequests.length, 0);
  assert.equal(snapshot.stats.threadCount, 3);
  assert.equal(snapshot.stats.roomCount, 2);
  assert.equal(snapshot.stats.joinedRoomCount, 2);
  assert.equal(snapshot.stats.directCount, 1);
  assert.equal(snapshot.stats.incomingDirectRequestCount, 0);
  assert.equal(snapshot.stats.saveCount, 1);

  const matches = store.searchUsers(firstAuth.user.id, "bliz");
  assert.deepEqual(matches.map((entry) => entry.username), ["blizzard"]);
});

test("community store supports private room invites, Antarctic invite DMs, and automod mutes", async (t) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "antarctic-community-private-"));
  const dbPath = path.join(tempDir, "community.sqlite");
  const store = new AntarcticCommunityStore({ dbPath, now: () => new Date("2026-03-22T15:00:00.000Z") });
  await store.initialize();

  t.after(async () => {
    await store.flush();
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  const owner = await store.signUp({ username: "owner", password: "icepass123" });
  const invited = await store.signUp({ username: "guest", password: "windpass123" });
  const outsider = await store.signUp({ username: "outsider", password: "polarpass123" });

  const privateRoom = await store.createRoom(owner.user.id, "Secret Ops", {
    visibility: "private",
    invitedUsers: ["guest"]
  });
  assert.equal(privateRoom.visibility, "private");

  const invitedCatalog = store.listThreadsForUser(invited.user.id);
  const invitedRoom = invitedCatalog.rooms.find((room) => room.name === "Secret Ops");
  assert.ok(invitedRoom);
  assert.equal(invitedRoom.invited, true);
  assert.equal(invitedRoom.joined, false);
  assert.equal(invitedRoom.joinable, true);

  const outsiderCatalog = store.listThreadsForUser(outsider.user.id);
  assert.equal(outsiderCatalog.rooms.some((room) => room.name === "Secret Ops"), false);

  const antarcticThread = invitedCatalog.threads.find((thread) => thread.type === "direct" && thread.peer && thread.peer.username === "antarctic");
  assert.ok(antarcticThread);
  const antarcticMessages = store.listMessages(invited.user.id, antarcticThread.id);
  assert.ok(antarcticMessages.some((message) => message.content.includes("Secret Ops")));

  await assert.rejects(
    () => store.joinRoom(outsider.user.id, privateRoom.id),
    /invite-only/
  );

  await store.joinRoom(invited.user.id, privateRoom.id);
  const joinedCatalog = store.listThreadsForUser(invited.user.id);
  const joinedRoom = joinedCatalog.rooms.find((room) => room.name === "Secret Ops");
  assert.ok(joinedRoom);
  assert.equal(joinedRoom.joined, true);
  assert.equal(joinedRoom.invited, false);
  assert.equal(joinedRoom.joinable, true);

  await assert.rejects(
    () => store.addMessage(invited.user.id, privateRoom.id, "shit this is loud"),
    /Automod muted you for 3 minutes/
  );
  await assert.rejects(
    () => store.addMessage(invited.user.id, privateRoom.id, "can anyone hear me"),
    /You are muted until/
  );
  await assert.rejects(
    () => store.addMessage(owner.user.id, privateRoom.id, "x".repeat(2001)),
    /Messages must stay under 2000 characters/
  );
});

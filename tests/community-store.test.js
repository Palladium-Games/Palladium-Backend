const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");

const { AntarcticCommunityStore, DEFAULT_ROOM_NAME } = require("../services/community-sqlite-store.js");

test("community store supports auth, rooms, direct messages, and cloud saves", async (t) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "antarctic-community-store-"));
  const dbPath = path.join(tempDir, "community.sqlite");
  const store = new AntarcticCommunityStore({ dbPath });
  await store.initialize();

  t.after(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  const firstAuth = await store.signUp({ username: "snowfox", password: "icepass123" });
  const secondAuth = await store.signUp({ username: "blizzard", password: "windpass123" });

  assert.equal(firstAuth.user.username, "snowfox");
  assert.equal(secondAuth.user.username, "blizzard");

  const loggedIn = await store.login({ username: "snowfox", password: "icepass123" });
  const firstSession = await store.getSession(loggedIn.token);
  assert.equal(firstSession.user.username, "snowfox");

  const firstCatalog = store.listThreadsForUser(firstAuth.user.id);
  assert.ok(firstCatalog.rooms.some((room) => room.name === DEFAULT_ROOM_NAME));
  assert.ok(firstCatalog.threads.some((thread) => thread.name === DEFAULT_ROOM_NAME));

  const createdRoom = await store.createRoom(firstAuth.user.id, "Late Night Games");
  assert.equal(createdRoom.name, "Late Night Games");

  await store.joinRoom(secondAuth.user.id, createdRoom.id);
  const roomMessagesBefore = store.listMessages(secondAuth.user.id, createdRoom.id);
  assert.deepEqual(roomMessagesBefore, []);

  await store.addMessage(firstAuth.user.id, createdRoom.id, "Welcome to the room");
  const roomMessages = store.listMessages(secondAuth.user.id, createdRoom.id);
  assert.equal(roomMessages.length, 1);
  assert.equal(roomMessages[0].content, "Welcome to the room");

  const directThread = await store.createDirectThread(firstAuth.user.id, "blizzard");
  assert.equal(directThread.type, "direct");
  assert.equal(directThread.peer.username, "blizzard");

  await store.addMessage(secondAuth.user.id, directThread.id, "hey there");
  const directMessages = store.listMessages(firstAuth.user.id, directThread.id);
  assert.equal(directMessages.length, 1);
  assert.equal(directMessages[0].content, "hey there");

  await store.putGameSave(firstAuth.user.id, "games/platformer/ovo.html", { localStorage: { ovo: "42" } }, "OvO cloud");
  const save = store.getGameSave(firstAuth.user.id, "games/platformer/ovo.html");
  assert.equal(save.summary, "OvO cloud");
  assert.deepEqual(save.data, { localStorage: { ovo: "42" } });

  const saves = store.listGameSaves(firstAuth.user.id);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].gameKey, "games/platformer/ovo.html");

  const matches = store.searchUsers(firstAuth.user.id, "bliz");
  assert.deepEqual(matches.map((entry) => entry.username), ["blizzard"]);
});

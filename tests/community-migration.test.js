const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { newDb } = require("pg-mem");

const { AntarcticCommunityStore } = require("../services/community-sqlite-store.js");
const { AntarcticSupabaseCommunityStore } = require("../services/community-supabase-store.js");
const { countCommunityRows, migrateCommunityStores } = require("../services/community-migration.js");

function createPool() {
  const db = newDb();
  const adapter = db.adapters.createPg();
  return new adapter.Pool();
}

test("community migration copies SQLite accounts, sessions, rooms, invites, DMs, and saves into Supabase", async (t) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "antarctic-community-migration-"));
  const dbPath = path.join(tempDir, "community.sqlite");
  const sourceStore = await new AntarcticCommunityStore({ dbPath }).initialize();
  const pool = createPool();
  const targetStore = await new AntarcticSupabaseCommunityStore({ pool }).initialize();

  t.after(async () => {
    await sourceStore.flush();
    await targetStore.close();
    await pool.end();
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  const owner = await sourceStore.signUp({ username: "owner", password: "icepass123" });
  const guest = await sourceStore.signUp({ username: "guest", password: "windpass123" });
  const outsider = await sourceStore.signUp({ username: "outsider", password: "polarpass123" });

  const privateRoom = await sourceStore.createRoom(owner.user.id, "Secret Ops", {
    visibility: "private",
    invitedUsers: ["guest"]
  });
  await sourceStore.addMessage(owner.user.id, privateRoom.id, "Welcome inside.");

  const outgoingRequest = await sourceStore.requestDirectThread(owner.user.id, "outsider");
  assert.equal(outgoingRequest.kind, "request");

  const incomingForGuest = sourceStore.getCommunitySnapshot(guest.user.id).incomingDirectRequests;
  assert.equal(incomingForGuest.length, 0);

  const acceptedDirect = await sourceStore.requestDirectThread(guest.user.id, "owner");
  if (acceptedDirect.kind === "request") {
    const pendingForOwner = sourceStore.getCommunitySnapshot(owner.user.id).incomingDirectRequests;
    await sourceStore.acceptDirectRequest(owner.user.id, pendingForOwner[0].id);
  }

  const directThread = sourceStore
    .getCommunitySnapshot(owner.user.id)
    .threads.find((thread) => thread.type === "direct" && thread.peer && thread.peer.username === "guest");
  assert.ok(directThread);

  await sourceStore.addMessage(guest.user.id, directThread.id, "hey owner");
  await sourceStore.putGameSave(owner.user.id, "games/platformer/ovo.html", { localStorage: { ovo: "42" } }, "OvO cloud");
  await sourceStore.flush();

  const sourceCounts = await countCommunityRows(sourceStore);
  const summary = await migrateCommunityStores({
    sourceStore,
    targetStore,
    resetTarget: true
  });
  const targetCounts = await countCommunityRows(targetStore);

  assert.equal(summary.resetTarget, true);
  assert.deepEqual(
    Object.fromEntries(Object.entries(summary.tables).map(([name, details]) => [name, details.rows])),
    sourceCounts
  );
  assert.deepEqual(targetCounts, sourceCounts);

  const migratedOwnerSession = await targetStore.getSession(owner.token);
  assert.ok(migratedOwnerSession);
  assert.equal(migratedOwnerSession.user.username, "owner");

  const migratedOutsiderSession = await targetStore.getSession(outsider.token);
  assert.ok(migratedOutsiderSession);
  assert.equal(migratedOutsiderSession.user.username, "outsider");

  const migratedGuestCatalog = await targetStore.listThreadsForUser(guest.user.id);
  const invitedRoom = migratedGuestCatalog.rooms.find((room) => room.name === "Secret Ops");
  assert.ok(invitedRoom);
  assert.equal(invitedRoom.visibility, "private");
  assert.equal(invitedRoom.invited, true);
  assert.equal(invitedRoom.joinable, true);

  const antarcticThread = migratedGuestCatalog.threads.find(
    (thread) => thread.type === "direct" && thread.peer && thread.peer.username === "antarctic"
  );
  assert.ok(antarcticThread);
  const antarcticMessages = await targetStore.listMessages(guest.user.id, antarcticThread.id);
  assert.ok(antarcticMessages.some((message) => message.content.includes("Secret Ops")));

  const migratedOwnerSnapshot = await targetStore.getCommunitySnapshot(owner.user.id);
  assert.equal(migratedOwnerSnapshot.saves.length, 1);
  assert.equal(migratedOwnerSnapshot.saves[0].gameKey, "games/platformer/ovo.html");
  assert.equal(
    migratedOwnerSnapshot.threads.some((thread) => thread.type === "direct" && thread.peer && thread.peer.username === "guest"),
    true
  );

  const migratedPendingRequest = await targetStore.getCommunitySnapshot(outsider.user.id);
  assert.equal(migratedPendingRequest.incomingDirectRequests.length, 1);
  assert.equal(migratedPendingRequest.incomingDirectRequests[0].requester.username, "owner");
});

test("community migration refuses to merge into a non-empty Supabase target unless reset is enabled", async (t) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "antarctic-community-migration-guard-"));
  const dbPath = path.join(tempDir, "community.sqlite");
  const sourceStore = await new AntarcticCommunityStore({ dbPath }).initialize();
  const pool = createPool();
  const targetStore = await new AntarcticSupabaseCommunityStore({ pool }).initialize();

  t.after(async () => {
    await sourceStore.flush();
    await targetStore.close();
    await pool.end();
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  await sourceStore.signUp({ username: "owner", password: "icepass123" });

  await assert.rejects(
    () =>
      migrateCommunityStores({
        sourceStore,
        targetStore,
        resetTarget: false
      }),
    /already contains community data/i
  );
});

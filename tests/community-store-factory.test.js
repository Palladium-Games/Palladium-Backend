const test = require("node:test");
const assert = require("node:assert/strict");

const { createCommunityStore } = require("../services/community-store-factory.js");
const { AntarcticCommunityStore } = require("../services/community-sqlite-store.js");
const { AntarcticSupabaseCommunityStore } = require("../services/community-supabase-store.js");

test("community store factory defaults to sqlite when Supabase is not configured", () => {
  const runtime = createCommunityStore({
    accountProvider: "auto",
    accountSqlitePath: "/tmp/antarctic-community.sqlite",
    accountSessionTtlDays: 30
  });

  assert.equal(runtime.provider, "sqlite");
  assert.equal(runtime.status, "sqlite (/tmp/antarctic-community.sqlite)");
  assert.ok(runtime.store instanceof AntarcticCommunityStore);
});

test("community store factory prefers Supabase when a database URL is configured", () => {
  const runtime = createCommunityStore({
    accountProvider: "auto",
    supabaseDbUrl: "postgresql://postgres.example/antarctic",
    accountSessionTtlDays: 30
  });

  assert.equal(runtime.provider, "supabase");
  assert.equal(runtime.status, "supabase");
  assert.ok(runtime.store instanceof AntarcticSupabaseCommunityStore);
});

test("community store factory honors an explicit Supabase provider selection", () => {
  const runtime = createCommunityStore({
    accountProvider: "supabase",
    supabaseDbUrl: "postgresql://postgres.example/antarctic",
    accountSessionTtlDays: 30
  });

  assert.equal(runtime.provider, "supabase");
  assert.ok(runtime.store instanceof AntarcticSupabaseCommunityStore);
});

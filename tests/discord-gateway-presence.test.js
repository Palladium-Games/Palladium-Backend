const test = require("node:test");
const assert = require("node:assert/strict");

const {
  canResumeSession,
  shouldResetSessionForCloseCode,
  shouldUseLongReconnectBackoff,
} = require("../discord-bots/discord-gateway-presence");

test("gateway presence only resumes when session id and sequence are both present", () => {
  assert.equal(canResumeSession("session-1", 42), true);
  assert.equal(canResumeSession("session-1", 0), true);
  assert.equal(canResumeSession("", 42), false);
  assert.equal(canResumeSession("session-1", null), false);
});

test("gateway presence resets the session for invalidated close codes", () => {
  assert.equal(shouldResetSessionForCloseCode(4007), true);
  assert.equal(shouldResetSessionForCloseCode(4009), true);
  assert.equal(shouldResetSessionForCloseCode(4008), false);
  assert.equal(shouldResetSessionForCloseCode(1001), false);
});

test("gateway presence uses a long reconnect backoff after gateway rate limits", () => {
  assert.equal(shouldUseLongReconnectBackoff(4008), true);
  assert.equal(shouldUseLongReconnectBackoff(4007), false);
  assert.equal(shouldUseLongReconnectBackoff(1012), false);
});

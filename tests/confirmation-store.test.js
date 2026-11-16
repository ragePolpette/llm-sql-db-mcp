import test from "node:test";
import assert from "node:assert/strict";
import { CONFIRM_OUTCOME, ConfirmationStore, buildDdlScope, sqlHash } from "../src/lib/confirmation-store.js";

function createStore(options = {}) {
  const clock = { now: 1_000_000 };
  const store = new ConfirmationStore({ now: () => clock.now, ...options });
  return { clock, store };
}

const SCOPE = buildDdlScope("dev-main", "CREATE TABLE dbo.t (id int)");

test("issue returns a url-safe single-use token with a derived token id and an expiry", () => {
  const { store, clock } = createStore();
  const { token, tokenId, expiresAt } = store.issue(SCOPE);

  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(tokenId.length, 12);
  assert.equal(token.includes(tokenId), false);
  assert.equal(expiresAt, clock.now + store.ttlMs);
  assert.equal(store.ttlMs, 5 * 60 * 1000);
});

test("consume accepts a valid token once and then reports it as reused", () => {
  const { store } = createStore();
  const { token, tokenId } = store.issue(SCOPE);

  assert.deepEqual(store.consume(token, SCOPE), { outcome: CONFIRM_OUTCOME.USED, tokenId });
  assert.deepEqual(store.consume(token, SCOPE), { outcome: CONFIRM_OUTCOME.REUSED, tokenId });
});

test("consume rejects an expired token", () => {
  const { store, clock } = createStore();
  const { token, tokenId } = store.issue(SCOPE);

  clock.now += store.ttlMs;
  assert.deepEqual(store.consume(token, SCOPE), { outcome: CONFIRM_OUTCOME.EXPIRED, tokenId });
});

test("a token used with a different scope is rejected and burned", () => {
  const { store } = createStore();
  const { token, tokenId } = store.issue(SCOPE);
  const otherScope = buildDdlScope("dev-main", "CREATE TABLE dbo.other (id int)");

  assert.deepEqual(store.consume(token, otherScope), { outcome: CONFIRM_OUTCOME.SCOPE_MISMATCH, tokenId });
  assert.deepEqual(store.consume(token, SCOPE), { outcome: CONFIRM_OUTCOME.REUSED, tokenId });
});

test("consume reports unknown for invented, empty, non-string and oversized tokens", () => {
  const { store } = createStore();
  store.issue(SCOPE);

  for (const token of ["invented-token", "", "   ", undefined, null, 42, "x".repeat(129)]) {
    assert.deepEqual(store.consume(token, SCOPE), { outcome: CONFIRM_OUTCOME.UNKNOWN, tokenId: null });
  }
});

test("consume trims surrounding whitespace from the token", () => {
  const { store } = createStore();
  const { token } = store.issue(SCOPE);

  assert.equal(store.consume(`  ${token}\n`, SCOPE).outcome, CONFIRM_OUTCOME.USED);
});

test("expired entries are kept for one more ttl, then forgotten", () => {
  const { store, clock } = createStore();
  const { token } = store.issue(SCOPE);

  clock.now += store.ttlMs * 2;
  assert.equal(store.consume(token, SCOPE).outcome, CONFIRM_OUTCOME.UNKNOWN);
});

test("issue evicts the oldest pending token when the cap is reached", () => {
  const { store, clock } = createStore({ maxPending: 2 });
  const first = store.issue(SCOPE);
  clock.now += 1;
  const second = store.issue(SCOPE);
  clock.now += 1;
  const third = store.issue(SCOPE);

  assert.equal(store.consume(first.token, SCOPE).outcome, CONFIRM_OUTCOME.UNKNOWN);
  assert.equal(store.consume(second.token, SCOPE).outcome, CONFIRM_OUTCOME.USED);
  assert.equal(store.consume(third.token, SCOPE).outcome, CONFIRM_OUTCOME.USED);
});

test("two stores do not share tokens (a restart invalidates every token)", () => {
  const first = createStore().store;
  const second = createStore().store;
  const { token } = first.issue(SCOPE);

  assert.equal(second.consume(token, SCOPE).outcome, CONFIRM_OUTCOME.UNKNOWN);
});

test("buildDdlScope binds the target and the exact sql text, sqlHash is a short stable digest", () => {
  const sql = "CREATE TABLE dbo.t (n nvarchar(5) DEFAULT 'a')";

  assert.equal(buildDdlScope("dev-main", sql), buildDdlScope("dev-main", sql));
  assert.notEqual(buildDdlScope("dev-main", sql), buildDdlScope("dev-other", sql));
  assert.notEqual(buildDdlScope("dev-main", sql), buildDdlScope("dev-main", sql.replace("'a'", "'b'")));
  assert.match(sqlHash(sql), /^[0-9a-f]{16}$/);
  assert.equal(sqlHash(sql), sqlHash(sql));
});

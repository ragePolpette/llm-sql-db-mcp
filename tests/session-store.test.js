import test from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../src/lib/session-store.js";

test("SessionStore expires entries after the configured default TTL", () => {
  let now = 1_000;
  const store = new SessionStore({
    defaultTtlMs: 100,
    now: () => now
  });

  store.set("session-1", { ok: true });
  assert.deepEqual(store.get("session-1"), { ok: true });

  now = 1_101;
  assert.equal(store.get("session-1"), undefined);
});

test("SessionStore touch extends the expiry window", () => {
  let now = 5_000;
  const store = new SessionStore({
    defaultTtlMs: 100,
    now: () => now
  });

  store.set("session-2", { ok: true });
  now = 5_050;
  assert.equal(store.touch("session-2"), true);

  now = 5_120;
  assert.deepEqual(store.get("session-2"), { ok: true });

  now = 5_151;
  assert.equal(store.get("session-2"), undefined);
});

test("SessionStore supports ttlMs=0 for explicit non-expiring sessions", () => {
  let now = 10_000;
  const store = new SessionStore({
    defaultTtlMs: 100,
    now: () => now
  });

  store.set("session-3", { ok: true }, { ttlMs: 0 });
  now = 1_000_000;

  assert.deepEqual(store.get("session-3"), { ok: true });
});

function normalizeTtl(ttlMs) {
  if (!Number.isInteger(ttlMs) || ttlMs < 0) {
    throw new Error("Session TTL must be an integer greater than or equal to zero.");
  }

  return ttlMs;
}

export class SessionStore {
  #defaultTtlMs;
  #now;
  #sessions;

  constructor({ defaultTtlMs = 0, now = () => Date.now() } = {}) {
    this.#defaultTtlMs = normalizeTtl(defaultTtlMs);
    this.#now = now;
    this.#sessions = new Map();
  }

  set(sessionId, value, { ttlMs = this.#defaultTtlMs } = {}) {
    const effectiveTtlMs = normalizeTtl(ttlMs);
    const expiresAt = effectiveTtlMs === 0 ? null : this.#now() + effectiveTtlMs;

    this.#sessions.set(sessionId, {
      value,
      expiresAt
    });
  }

  get(sessionId) {
    const entry = this.#sessions.get(sessionId);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt !== null && entry.expiresAt <= this.#now()) {
      this.#sessions.delete(sessionId);
      return undefined;
    }

    return entry.value;
  }

  has(sessionId) {
    return this.get(sessionId) !== undefined;
  }

  touch(sessionId, { ttlMs = this.#defaultTtlMs } = {}) {
    const entry = this.#sessions.get(sessionId);
    if (!entry) {
      return false;
    }

    if (entry.expiresAt !== null && entry.expiresAt <= this.#now()) {
      this.#sessions.delete(sessionId);
      return false;
    }

    const effectiveTtlMs = normalizeTtl(ttlMs);
    entry.expiresAt = effectiveTtlMs === 0 ? null : this.#now() + effectiveTtlMs;
    return true;
  }

  delete(sessionId) {
    return this.#sessions.delete(sessionId);
  }

  drain() {
    const drained = [];

    for (const [sessionId, entry] of this.#sessions.entries()) {
      drained.push({
        sessionId,
        value: entry.value
      });
    }

    this.#sessions.clear();
    return drained;
  }

  pruneExpired() {
    const expired = [];
    const now = this.#now();

    for (const [sessionId, entry] of this.#sessions.entries()) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.#sessions.delete(sessionId);
        expired.push({
          sessionId,
          value: entry.value
        });
      }
    }

    return expired;
  }
}

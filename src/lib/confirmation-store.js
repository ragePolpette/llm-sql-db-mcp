import { createHash, randomBytes } from "node:crypto";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_TOKEN_LENGTH = 128;

export const CONFIRM_OUTCOME = Object.freeze({
  USED: "used",
  EXPIRED: "expired",
  REUSED: "reused",
  SCOPE_MISMATCH: "scope_mismatch",
  UNKNOWN: "unknown"
});

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sqlHash(sql) {
  return sha256Hex(String(sql)).slice(0, 16);
}

// Il token e' legato al target e al testo ESATTO dell'istruzione (non alla versione mascherata):
// due DDL che differiscono solo per un letterale non devono condividere la conferma.
export function buildDdlScope(targetId, sql) {
  return `${targetId}\n${sha256Hex(String(sql))}`;
}

/**
 * Token monouso per le operazioni in due fasi, con scadenza. Stessa logica di
 * llm-jenkins-mcp (ConfirmationStore.cs): in memoria (un riavvio li invalida, ed e' voluto),
 * si conserva solo l'hash del token e nei log compare un token_id derivato che non permette di
 * ricostruirlo. Un token usato con uno scope diverso viene bruciato.
 *
 * Limite noto: il token torna all'agente. Protegge dalle esecuzioni accidentali, non da un agente
 * che richiama subito la seconda fase: le difese reali sono la policy per target e la guardia SQL.
 */
export class ConfirmationStore {
  #entries = new Map();
  #now;
  #ttlMs;
  #maxPending;

  constructor({ now = () => Date.now(), ttlMs = DEFAULT_TTL_MS, maxPending = 50 } = {}) {
    this.#now = now;
    this.#ttlMs = ttlMs;
    this.#maxPending = maxPending;
  }

  get ttlMs() {
    return this.#ttlMs;
  }

  issue(scope) {
    const token = randomBytes(24).toString("base64url");
    const hash = sha256Hex(token);
    const issuedAt = this.#now();
    const entry = { scope, issuedAt, expiresAt: issuedAt + this.#ttlMs, tokenId: hash.slice(0, 12), burned: false };

    this.#purge(issuedAt);
    const pending = [...this.#entries.entries()].filter(([, value]) => !value.burned);
    if (pending.length >= this.#maxPending) {
      const [oldestKey] = pending.reduce((oldest, current) => (current[1].issuedAt < oldest[1].issuedAt ? current : oldest));
      this.#entries.delete(oldestKey);
    }
    this.#entries.set(hash, entry);

    return { token, tokenId: entry.tokenId, expiresAt: entry.expiresAt };
  }

  consume(token, scope) {
    const value = typeof token === "string" ? token.trim() : "";
    if (value.length === 0 || value.length > MAX_TOKEN_LENGTH) {
      return { outcome: CONFIRM_OUTCOME.UNKNOWN, tokenId: null };
    }

    const now = this.#now();
    this.#purge(now);
    const entry = this.#entries.get(sha256Hex(value));
    if (!entry) return { outcome: CONFIRM_OUTCOME.UNKNOWN, tokenId: null };
    if (entry.burned) return { outcome: CONFIRM_OUTCOME.REUSED, tokenId: entry.tokenId };
    if (now >= entry.expiresAt) return { outcome: CONFIRM_OUTCOME.EXPIRED, tokenId: entry.tokenId };

    entry.burned = true;
    return {
      outcome: entry.scope === scope ? CONFIRM_OUTCOME.USED : CONFIRM_OUTCOME.SCOPE_MISMATCH,
      tokenId: entry.tokenId
    };
  }

  // Le voci restano un altro TTL dopo la scadenza, per distinguere "scaduto" e "gia' usato"
  // da "sconosciuto" nei messaggi e negli eventi.
  #purge(now) {
    for (const [key, entry] of this.#entries) {
      if (now >= entry.expiresAt + this.#ttlMs) {
        this.#entries.delete(key);
      }
    }
  }
}

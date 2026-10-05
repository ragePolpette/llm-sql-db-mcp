import fs from "node:fs";
import path from "node:path";

const CATALOG_VERSION = 1;
const DISTINCT_CAP = 12;
const PROMOTE_MIN_USES = 3;
const PROMOTE_MIN_CELLS = 30;
const PROMOTE_MIN_REPEAT = 3;
const PROMOTE_MAX_LEN = 20;
const FLUSH_MIN_INTERVAL_MS = 2000;

export const HUMAN_VERDICTS = new Set(["safe", "sensitive"]);

function emptyCatalog() {
  return { version: CATALOG_VERSION, human: {}, targets: {} };
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeCatalogKey(key) {
  return String(key || "")
    .trim()
    .replace(/[\[\]"`]/g, "")
    .toLowerCase();
}

function readCatalogFile(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!isPlainObject(parsed)) return emptyCatalog();
    return {
      version: CATALOG_VERSION,
      human: isPlainObject(parsed.human) ? parsed.human : {},
      targets: isPlainObject(parsed.targets) ? parsed.targets : {}
    };
  } catch (error) {
    if (error?.code === "ENOENT") return emptyCatalog();
    throw error;
  }
}

function writeCatalogFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

// Evidence that a pending column is a closed set of machine-like values (status/enum/code),
// not people-related text. Deliberately conservative: Title Case words ("Mario", "Cliente") never
// qualify, so they stay pending until a human decides.
export function isEnumEvidence(entry) {
  if (!entry || entry.overflow || entry.pii || entry.titlecase) return false;
  const distinct = Array.isArray(entry.distinct) ? entry.distinct.length : 0;
  if (distinct === 0) return false;
  return (
    entry.uses >= PROMOTE_MIN_USES &&
    entry.cells >= PROMOTE_MIN_CELLS &&
    entry.max_len <= PROMOTE_MAX_LEN &&
    entry.cells / distinct >= PROMOTE_MIN_REPEAT
  );
}

function mergeEvidence(entry, observation) {
  entry.uses = (entry.uses ?? 0) + 1;
  entry.cells = (entry.cells ?? 0) + observation.cells;
  entry.max_len = Math.max(entry.max_len ?? 0, observation.max_len ?? 0);
  entry.pii = Boolean(entry.pii) || Boolean(observation.pii);
  entry.titlecase = Boolean(entry.titlecase) || Boolean(observation.titlecase);

  const distinct = new Set(entry.distinct ?? []);
  for (const hash of observation.hashes ?? []) {
    distinct.add(hash);
  }
  entry.overflow = Boolean(entry.overflow) || distinct.size > DISTINCT_CAP;
  entry.distinct = [...distinct].slice(0, DISTINCT_CAP);
}

function applyObservation(entry, observation, now) {
  if (!entry.first_seen) entry.first_seen = now;
  entry.last_seen = now;
  mergeEvidence(entry, observation);

  switch (observation.status) {
    case "sensitive":
      entry.status = "auto-sensitive";
      entry.kind = observation.kind;
      entry.reason = observation.reason;
      return;
    case "technical":
      if (entry.status !== "auto-sensitive") {
        entry.status = "auto-safe";
        entry.reason = "technical-name";
      }
      return;
    case "revalidate":
    case "pending":
    default:
      if (entry.status === "auto-sensitive") return;
      if (entry.reason === "technical-name" && entry.status === "auto-safe") return;
      if (isEnumEvidence(entry)) {
        entry.status = "auto-safe";
        entry.reason = "enum-evidence";
      } else {
        entry.status = "pending";
        entry.reason = observation.status === "revalidate" ? "enum-evidence-revoked" : observation.reason;
      }
  }
}

/**
 * Self-populating column catalog.
 *
 * - `human` verdicts are shared by every target and written only through the CLI.
 * - `targets[target_id]` holds machine observations. They are never shared across targets:
 *   evidence collected on dev data says nothing about prod data.
 * - No raw values are stored, only salted hashes of at most DISTINCT_CAP distinct values.
 */
export function createCatalog({ filePath, now = () => Date.now() }) {
  let memory = emptyCatalog();
  let lastMtimeMs = -1;
  let dirtyTargets = new Set();
  let lastFlushAt = 0;
  let lastError = null;

  function refresh() {
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs === lastMtimeMs) return;
      const disk = readCatalogFile(filePath);
      // Disk wins for human verdicts (CLI edits); in-memory wins for targets we are writing.
      memory = {
        version: CATALOG_VERSION,
        human: disk.human,
        targets: { ...disk.targets, ...Object.fromEntries([...dirtyTargets].map(id => [id, memory.targets[id]])) }
      };
      lastMtimeMs = stat.mtimeMs;
      lastError = null;
    } catch (error) {
      if (error?.code === "ENOENT") {
        lastMtimeMs = -1;
        return;
      }
      lastError = error;
    }
  }

  function lookup(targetId, key) {
    const normalized = normalizeCatalogKey(key);
    if (!normalized) return null;
    const human = memory.human[normalized] ?? null;
    const target = memory.targets[targetId]?.[normalized] ?? null;
    if (!human && !target) return null;
    return {
      human: human && HUMAN_VERDICTS.has(human.verdict) ? human : null,
      target
    };
  }

  function record(targetId, observations) {
    if (!targetId || !Array.isArray(observations) || observations.length === 0) return;
    try {
      const stamp = new Date(now()).toISOString();
      const section = (memory.targets[targetId] ??= {});
      for (const observation of observations) {
        const key = normalizeCatalogKey(observation.key);
        if (!key) continue;
        applyObservation((section[key] ??= {}), observation, stamp);
      }
      dirtyTargets.add(targetId);
      flush();
    } catch (error) {
      lastError = error;
    }
  }

  function flush({ force = false } = {}) {
    if (dirtyTargets.size === 0) return;
    if (!force && now() - lastFlushAt < FLUSH_MIN_INTERVAL_MS) return;
    try {
      // Re-read so human verdicts written by the CLI in the meantime are preserved.
      const disk = readCatalogFile(filePath);
      for (const id of dirtyTargets) {
        disk.targets[id] = memory.targets[id];
      }
      writeCatalogFile(filePath, disk);
      memory.human = disk.human;
      lastMtimeMs = fs.statSync(filePath).mtimeMs;
      dirtyTargets = new Set();
      lastFlushAt = now();
      lastError = null;
    } catch (error) {
      lastError = error;
    }
  }

  refresh();

  return {
    filePath,
    refresh,
    lookup,
    record,
    flush,
    get lastError() {
      return lastError;
    }
  };
}

// --- helpers shared with the CLI -------------------------------------------------------------

export function loadCatalogFile(filePath) {
  return readCatalogFile(filePath);
}

export function saveCatalogFile(filePath, data) {
  writeCatalogFile(filePath, data);
}

const catalogCache = new Map();

export function getCatalog(filePath) {
  if (!filePath) return null;
  let catalog = catalogCache.get(filePath);
  if (!catalog) {
    catalog = createCatalog({ filePath });
    catalogCache.set(filePath, catalog);
  }
  return catalog;
}

export const __catalogTestUtils = {
  DISTINCT_CAP,
  resetCatalogCache() {
    catalogCache.clear();
  }
};

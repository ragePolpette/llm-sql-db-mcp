import { createHash } from "node:crypto";
import { getRequestContext } from "./request-context.js";

const LOG_LEVELS = {
  error: 0,
  info: 1,
  debug: 2
};
const LOG_FORMATS = new Set(["json", "plain"]);

function toJsonLine(entry) {
  try {
    return JSON.stringify(entry);
  } catch {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      event: "log.serialization_failed",
      payload: {
        original_event: entry?.event ?? "unknown"
      }
    });
  }
}

function formatPlainValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function toPlainLine(entry) {
  const parts = [entry.timestamp, entry.level.toUpperCase(), entry.event];

  if (entry.request_id) {
    parts.push(`request_id=${entry.request_id}`);
  }

  if (entry.session_id) {
    parts.push(`session_id=${entry.session_id}`);
  }

  if (entry.payload && typeof entry.payload === "object" && !Array.isArray(entry.payload)) {
    const payloadParts = Object.entries(entry.payload)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${formatPlainValue(value)}`);

    if (payloadParts.length > 0) {
      parts.push(payloadParts.join(" "));
    }
  }

  return parts.join(" ");
}

function normalizeLogLevel(level) {
  const normalized = String(level || "info").trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(LOG_LEVELS, normalized)) {
    throw new Error(`Unsupported LOG_LEVEL "${level}".`);
  }

  return normalized;
}

function normalizeLogFormat(format) {
  const normalized = String(format || "json").trim().toLowerCase();
  if (!LOG_FORMATS.has(normalized)) {
    throw new Error(`Unsupported LOG_FORMAT "${format}".`);
  }

  return normalized;
}

function shouldLog(configuredLevel, candidateLevel) {
  return LOG_LEVELS[candidateLevel] <= LOG_LEVELS[configuredLevel];
}

function hashSql(sqlText) {
  if (typeof sqlText !== "string" || sqlText.trim() === "") {
    return null;
  }

  return createHash("sha256").update(sqlText).digest("hex").slice(0, 16);
}

function sqlPreview(sqlText) {
  if (typeof sqlText !== "string" || sqlText.trim() === "") {
    return null;
  }

  return sqlText.replace(/\s+/g, " ").trim().slice(0, 160);
}

function normalizeParameterKeys(parameters) {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return [];
  }

  return Object.keys(parameters).sort();
}

function redactDbPayload(event, payload, level) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  if (event === "query_in") {
    const parameterKeys = normalizeParameterKeys(payload.parameters);
    return {
      tool: payload.tool ?? null,
      target_id: payload.target_id ?? null,
      sql_hash: hashSql(payload.sql),
      sql_preview: level === "debug" ? sqlPreview(payload.sql) : null,
      parameter_count: parameterKeys.length,
      parameter_keys: parameterKeys,
      max_rows: payload.maxRows ?? null
    };
  }

  if (event === "query_out") {
    return {
      tool: payload.tool ?? null,
      target_id: payload.target_id ?? null,
      row_count: payload.rowCount ?? null,
      rows_affected: payload.rowsAffected ?? null,
      truncated: payload.truncated ?? null,
      anonymization_applied: payload.anonymizationApplied ?? null,
      anonymization_provider: payload.anonymizationProvider ?? null,
      anonymization_mode: payload.anonymizationMode ?? null
    };
  }

  if (["db_driver_start", "db_driver_done", "anonymizer_start", "anonymizer_done", "query_failed"].includes(event)) {
    return {
      tool: payload.tool ?? null,
      target_id: payload.target_id ?? null,
      runtime_status: payload.runtime_status ?? null,
      provider: payload.provider ?? null,
      mode: payload.mode ?? null,
      row_count: payload.rowCount ?? null,
      rows_affected: payload.rowsAffected ?? null,
      truncated: payload.truncated ?? null,
      duration_ms: payload.durationMs ?? null,
      error: payload.error ?? null
    };
  }

  return payload;
}

function buildEntry(level, event, payload) {
  const context = getRequestContext();
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    payload
  };

  if (context?.request_id) {
    entry.request_id = context.request_id;
  }

  if (context?.session_id) {
    entry.session_id = context.session_id;
  }

  return entry;
}

export function createLogger({
  level = "info",
  format = "json",
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  const normalizedLevel = normalizeLogLevel(level);
  const normalizedFormat = normalizeLogFormat(format);

  function writeLine(stream, entry) {
    const line = normalizedFormat === "plain" ? toPlainLine(entry) : toJsonLine(entry);
    stream.write(`${line}\n`);
  }

  return {
    level: normalizedLevel,
    format: normalizedFormat,
    error(event, payload = {}) {
      if (!shouldLog(normalizedLevel, "error")) {
        return;
      }

      writeLine(stderr, buildEntry("error", event, payload));
    },
    info(event, payload = {}) {
      if (!shouldLog(normalizedLevel, "info")) {
        return;
      }

      writeLine(stdout, buildEntry("info", event, payload));
    },
    debug(event, payload = {}) {
      if (!shouldLog(normalizedLevel, "debug")) {
        return;
      }

      writeLine(stdout, buildEntry("debug", event, payload));
    },
    dbEvent(event, payload = {}) {
      const sanitizedPayload = redactDbPayload(event, payload, normalizedLevel);
      if (normalizedLevel === "debug") {
        writeLine(stdout, buildEntry("debug", `db.${event}`, sanitizedPayload));
        return;
      }

      if (normalizedLevel === "info") {
        if (["query_out", "query_failed"].includes(event)) {
          writeLine(stdout, buildEntry("info", `db.${event}`, sanitizedPayload));
        }
        return;
      }
    }
  };
}

export const __loggerTestUtils = {
  hashSql,
  normalizeLogFormat,
  normalizeLogLevel,
  redactDbPayload,
  shouldLog,
  sqlPreview,
  toPlainLine
};

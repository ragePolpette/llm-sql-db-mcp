import { getCatalog } from "./anonymization/catalog.js";
import {
  anonymizeRows,
  extractJsonFromText,
  parseProviderJson,
  __anonymizationCoreTestUtils
} from "./anonymization/core.js";

const NON_PROD_ENVIRONMENTS = new Set(["dev", "test", "staging"]);

function normalizeMode(mode) {
  const value = String(mode || "hybrid").trim().toLowerCase();
  if (value === "direct") {
    return "llm-strict";
  }
  return value;
}

function computeRowsByteLength(rows) {
  return Buffer.byteLength(JSON.stringify(rows), "utf8");
}

function clampRowsToByteLimit(rows, maxResultBytes) {
  if (maxResultBytes === null) return rows;
  const acceptedRows = [];

  for (const row of rows) {
    const nextRows = [...acceptedRows, row];
    if (computeRowsByteLength(nextRows) > maxResultBytes) {
      break;
    }

    acceptedRows.push(row);
  }

  return acceptedRows;
}

function resolveFailOpen(target, providerConfig) {
  if (!providerConfig?.failOpen) {
    return false;
  }

  // Fail-open is an explicit opt-in for known non-production environments; a missing or
  // unrecognised environment label is treated as production.
  const environment = String(target?.environment || "").trim().toLowerCase();
  return NON_PROD_ENVIRONMENTS.has(environment);
}

function buildAnonymizerConfig(target, providerConfig) {
  const provider = String(target.llm_provider || "none").toLowerCase();
  const baseUrl = provider === "lmstudio"
    ? providerConfig.lmstudioBaseUrl
    : provider === "ollama"
      ? providerConfig.ollamaBaseUrl
      : "";

  return {
    provider,
    mode: normalizeMode(target.anonymization_mode),
    fieldIdentification: providerConfig.fieldIdentification,
    hashSalt: providerConfig.hashSalt,
    minConfidence: providerConfig.minConfidence,
    trust: target.anonymization_trust === "strict" ? "strict" : "corroborated",
    failOpen: resolveFailOpen(target, providerConfig),
    timeoutMs: providerConfig.timeoutMs,
    model: target.llm_model,
    baseUrl
  };
}

function splitOriginFields(queryResult) {
  const {
    column_origins: columnOrigins,
    column_origins_status: status,
    column_origins_reason: reason,
    column_origins_detail: detail,
    ...publicQueryResult
  } = queryResult;
  const resolved = status === "resolved" && columnOrigins && typeof columnOrigins === "object";
  return {
    publicQueryResult,
    columnOrigins: resolved ? columnOrigins : undefined,
    origins: {
      status: resolved ? "resolved" : "unavailable",
      reason: resolved ? null : reason ?? "not_provided",
      detail: resolved ? null : detail ?? null
    }
  };
}

function describeOriginReason(reason) {
  if (reason?.startsWith("unsupported_param_type:")) {
    const name = reason.slice("unsupported_param_type:".length);
    return `parameter @${name} has a type that cannot be described; pass a string, number, boolean, date or null`;
  }
  if (reason?.startsWith("describe_error") || reason === "describe_failed") {
    return "SQL Server could not describe the result set (for example temporary objects or constructs it cannot compile ahead of time); simplify the query";
  }
  if (reason === "describe_empty") {
    return "SQL Server returned no result-set description for this query";
  }
  return "column metadata was not available";
}

// Tells the calling client why its result is more masked than usual, so it can rewrite the query.
export function buildAnonymizationNotes(origins) {
  if (origins.status === "resolved") return [];
  return [
    `Column origins unavailable (${origins.reason}): ${describeOriginReason(origins.reason)}. ` +
      "Aliases cannot be verified, so every text column is masked."
  ];
}

export async function anonymizeQueryResult({
  target,
  queryResult,
  providerConfig,
  fetchImpl = globalThis.fetch,
  onReport
}) {
  if (!target.anonymization_enabled) {
    return {
      ...splitOriginFields(queryResult).publicQueryResult,
      anonymization_applied: false,
      anonymization_provider: "none",
      anonymization_mode: target.anonymization_mode
    };
  }

  // Column origins are an internal classification input: never forward schema details to the client.
  const { publicQueryResult, columnOrigins, origins } = splitOriginFields(queryResult);
  queryResult = publicQueryResult;
  const notes = buildAnonymizationNotes(origins);

  const anonymizerConfig = buildAnonymizerConfig(target, providerConfig);
  const maskedRows = await anonymizeRows(queryResult.rows, anonymizerConfig, {
    sqlText: queryResult.sql_text,
    columnOrigins,
    catalog: getCatalog(providerConfig.catalogPath),
    targetId: target.target_id,
    onReport: typeof onReport === "function" ? report => onReport({ ...report, origins }) : undefined,
    fetchImpl
  });
  const boundedRows = clampRowsToByteLimit(maskedRows, queryResult.max_result_bytes_applied);

  return {
    ...queryResult,
    rows: boundedRows,
    row_count: boundedRows.length,
    result_bytes: computeRowsByteLength(boundedRows),
    truncated: queryResult.truncated || boundedRows.length < maskedRows.length,
    anonymization_applied: true,
    anonymization_provider: target.llm_provider,
    anonymization_mode: normalizeMode(target.anonymization_mode),
    ...(notes.length > 0 ? { anonymization_notes: notes } : {})
  };
}

export {
  anonymizeRows,
  extractJsonFromText,
  parseProviderJson,
  __anonymizationCoreTestUtils
};

export const __anonymizerTestUtils = {
  clampRowsToByteLimit,
  normalizeMode,
  resolveFailOpen
};

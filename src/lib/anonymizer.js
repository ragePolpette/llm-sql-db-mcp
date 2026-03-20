import {
  anonymizeRows,
  extractJsonFromText,
  parseProviderJson,
  __anonymizationCoreTestUtils
} from "./anonymization/core.js";

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
    failOpen: providerConfig.failOpen,
    timeoutMs: providerConfig.timeoutMs,
    model: target.llm_model,
    baseUrl
  };
}

export async function anonymizeQueryResult({
  target,
  queryResult,
  providerConfig,
  fetchImpl = globalThis.fetch
}) {
  if (!target.anonymization_enabled) {
    return {
      ...queryResult,
      anonymization_applied: false,
      anonymization_provider: "none",
      anonymization_mode: target.anonymization_mode
    };
  }

  const anonymizerConfig = buildAnonymizerConfig(target, providerConfig);
  const maskedRows = await anonymizeRows(queryResult.rows, anonymizerConfig, {
    sqlText: queryResult.sql_text,
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
    anonymization_mode: normalizeMode(target.anonymization_mode)
  };
}

export {
  anonymizeRows,
  extractJsonFromText,
  parseProviderJson,
  __anonymizationCoreTestUtils
};

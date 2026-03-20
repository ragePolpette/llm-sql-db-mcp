import { anonymizeWithLmStudio } from "./providers/lmstudio.js";
import { anonymizeWithOllama } from "./providers/ollama.js";

function extractJsonCandidate(text) {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  return trimmed;
}

export function parseProviderJson(text) {
  const candidate = extractJsonCandidate(text);

  try {
    return JSON.parse(candidate);
  } catch {
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    }

    const firstBracket = candidate.indexOf("[");
    const lastBracket = candidate.lastIndexOf("]");
    if (firstBracket >= 0 && lastBracket > firstBracket) {
      return JSON.parse(candidate.slice(firstBracket, lastBracket + 1));
    }

    throw new Error("Provider response did not contain valid JSON.");
  }
}

function extractRowsFromProviderPayload(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.rows)) {
    return payload.rows;
  }

  if (Array.isArray(payload?.data?.rows)) {
    return payload.data.rows;
  }

  throw new Error("Provider response JSON must contain a rows array.");
}

function ensureRowObjects(rows) {
  if (!rows.every(row => row && typeof row === "object" && !Array.isArray(row))) {
    throw new Error("Provider rows must be objects.");
  }

  return rows;
}

function buildPrompts({ target, queryResult }) {
  return {
    systemPrompt:
      "You anonymize SQL query rows. Return JSON only. Preserve the same array length and the same object keys for each row. Replace personal or sensitive values with realistic but fictitious equivalents. Keep technical IDs non-sensitive when they are clearly synthetic.",
    userPrompt: JSON.stringify({
      task: "anonymize_query_rows",
      target_id: target.target_id,
      anonymization_mode: target.anonymization_mode,
      columns: queryResult.columns,
      rows: queryResult.rows
    })
  };
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

  const prompts = buildPrompts({ target, queryResult });
  let providerText;

  if (target.llm_provider === "lmstudio") {
    providerText = await anonymizeWithLmStudio({
      baseUrl: providerConfig.lmstudioBaseUrl,
      model: target.llm_model,
      fetchImpl,
      ...prompts
    });
  } else if (target.llm_provider === "ollama") {
    providerText = await anonymizeWithOllama({
      baseUrl: providerConfig.ollamaBaseUrl,
      model: target.llm_model,
      fetchImpl,
      ...prompts
    });
  } else if (target.llm_provider === "none") {
    throw new Error(`Target "${target.target_id}" requires anonymization but provider is "none".`);
  } else {
    throw new Error(`Unsupported anonymization provider: ${target.llm_provider}`);
  }

  const parsed = parseProviderJson(providerText);
  const parsedRows = ensureRowObjects(extractRowsFromProviderPayload(parsed));
  const boundedRows = clampRowsToByteLimit(parsedRows, queryResult.max_result_bytes_applied);

  return {
    ...queryResult,
    rows: boundedRows,
    row_count: boundedRows.length,
    result_bytes: computeRowsByteLength(boundedRows),
    truncated: queryResult.truncated || boundedRows.length < parsedRows.length,
    anonymization_applied: true,
    anonymization_provider: target.llm_provider,
    anonymization_mode: target.anonymization_mode
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import { parseProviderJson, anonymizeQueryResult } from "../src/lib/anonymizer.js";
import { anonymizeWithLmStudio } from "../src/lib/providers/lmstudio.js";
import { anonymizeWithOllama } from "../src/lib/providers/ollama.js";

test("parseProviderJson accepts fenced JSON", () => {
  const parsed = parseProviderJson("```json\n{\"rows\":[{\"name\":\"anon\"}]}\n```");
  assert.deepEqual(parsed, {
    rows: [{ name: "anon" }]
  });
});

test("LM Studio adapter extracts message content", async () => {
  const text = await anonymizeWithLmStudio({
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "gemma",
    systemPrompt: "sys",
    userPrompt: "user",
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: "```json\n{\"rows\":[{\"name\":\"anon\"}]}\n```"
              }
            }
          ]
        };
      }
    })
  });

  assert.match(text, /rows/);
});

test("Ollama adapter extracts message content", async () => {
  const text = await anonymizeWithOllama({
    baseUrl: "http://127.0.0.1:11434",
    model: "llama",
    systemPrompt: "sys",
    userPrompt: "user",
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          message: {
            content: "{\"rows\":[{\"name\":\"anon\"}]}"
          }
        };
      }
    })
  });

  assert.match(text, /rows/);
});

test("anonymizeQueryResult returns raw output when the target does not require anonymization", async () => {
  const result = await anonymizeQueryResult({
    target: {
      target_id: "dev-main",
      anonymization_enabled: false,
      anonymization_mode: "off",
      llm_provider: "none"
    },
    queryResult: {
      rows: [{ id: 1 }],
      row_count: 1,
      truncated: false,
      max_result_bytes_applied: 1024
    },
    providerConfig: {},
    fetchImpl: async () => {
      throw new Error("should not be called");
    }
  });

  assert.equal(result.anonymization_applied, false);
  assert.equal(result.anonymization_provider, "none");
  assert.deepEqual(result.rows, [{ id: 1 }]);
});

test("anonymizeQueryResult applies LM Studio anonymization and parses fenced JSON", async () => {
  const result = await anonymizeQueryResult({
    target: {
      target_id: "prod-main",
      anonymization_enabled: true,
      anonymization_mode: "hybrid",
      llm_provider: "lmstudio",
      llm_model: "gemma"
    },
    queryResult: {
      columns: [{ name: "name", nullable: true, type: "NVarChar" }],
      rows: [{ name: "Mario Rossi" }],
      row_count: 1,
      total_rows_before_limits: 1,
      max_rows_applied: 5,
      max_result_bytes_applied: 1024,
      result_bytes: 24,
      truncated: false,
      duration_ms: 2
    },
    providerConfig: {
      lmstudioBaseUrl: "http://127.0.0.1:1234/v1",
      ollamaBaseUrl: "http://127.0.0.1:11434"
    },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                content: "```json\n{\"rows\":[{\"name\":\"Nome Anonimo\"}]}\n```"
              }
            }
          ]
        };
      }
    })
  });

  assert.equal(result.anonymization_applied, true);
  assert.equal(result.anonymization_provider, "lmstudio");
  assert.deepEqual(result.rows, [{ name: "Nome Anonimo" }]);
});

test("anonymizeQueryResult rejects provider rows with different shape", async () => {
  await assert.rejects(
    () =>
      anonymizeQueryResult({
        target: {
          target_id: "prod-main",
          anonymization_enabled: true,
          anonymization_mode: "hybrid",
          llm_provider: "lmstudio",
          llm_model: "gemma"
        },
        queryResult: {
          columns: [{ name: "name", nullable: true, type: "NVarChar" }],
          rows: [{ name: "Mario Rossi" }],
          row_count: 1,
          total_rows_before_limits: 1,
          max_rows_applied: 5,
          max_result_bytes_applied: 1024,
          result_bytes: 24,
          truncated: false,
          duration_ms: 2
        },
        providerConfig: {
          lmstudioBaseUrl: "http://127.0.0.1:1234/v1",
          ollamaBaseUrl: "http://127.0.0.1:11434"
        },
        fetchImpl: async () => ({
          ok: true,
          async json() {
            return {
              choices: [
                {
                  message: {
                    content: "```json\n{\"rows\":[{\"different\":\"shape\"}]}\n```"
                  }
                }
              ]
            };
          }
        })
      }),
    /keys do not match|shape/
  );
});

test("anonymizeQueryResult rejects provider row count mismatches", async () => {
  await assert.rejects(
    () =>
      anonymizeQueryResult({
        target: {
          target_id: "prod-main",
          anonymization_enabled: true,
          anonymization_mode: "hybrid",
          llm_provider: "lmstudio",
          llm_model: "gemma"
        },
        queryResult: {
          columns: [{ name: "name", nullable: true, type: "NVarChar" }],
          rows: [{ name: "Mario Rossi" }, { name: "Luigi Verdi" }],
          row_count: 2,
          total_rows_before_limits: 2,
          max_rows_applied: 5,
          max_result_bytes_applied: 1024,
          result_bytes: 48,
          truncated: false,
          duration_ms: 2
        },
        providerConfig: {
          lmstudioBaseUrl: "http://127.0.0.1:1234/v1",
          ollamaBaseUrl: "http://127.0.0.1:11434"
        },
        fetchImpl: async () => ({
          ok: true,
          async json() {
            return {
              choices: [
                {
                  message: {
                    content: "```json\n{\"rows\":[{\"name\":\"Nome Anonimo\"}]}\n```"
                  }
                }
              ]
            };
          }
        })
      }),
    /expected 2/
  );
});

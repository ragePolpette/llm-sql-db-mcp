import test from "node:test";
import assert from "node:assert/strict";
import { anonymizeQueryResult, __anonymizerTestUtils } from "../src/lib/anonymizer.js";

function createTarget({ environment }) {
  return {
    target_id: `${environment}-strict`,
    display_name: `${environment} strict`,
    environment,
    anonymization_enabled: true,
    anonymization_mode: "llm-strict",
    llm_provider: "ollama",
    llm_model: "gemma3:4b"
  };
}

function createQueryResult() {
  return {
    sql_text: "SELECT Email FROM dbo.Users",
    columns: [{ name: "Email", nullable: true, type: "NVarChar" }],
    rows: [{ Email: "mario.rossi@example.com" }],
    row_count: 1,
    total_rows_before_limits: 1,
    max_rows_applied: 10,
    max_result_bytes_applied: 4096,
    result_bytes: 32,
    truncated: false,
    duration_ms: 2
  };
}

function createProviderConfig({ failOpen }) {
  return {
    lmstudioBaseUrl: "http://127.0.0.1:1234/v1",
    ollamaBaseUrl: "http://127.0.0.1:11434",
    fieldIdentification: "llm",
    hashSalt: "Super-Secret-Hash-Salt-123!",
    failOpen,
    timeoutMs: 5000
  };
}

test("resolveFailOpen forces fail-closed for prod targets", () => {
  assert.equal(
    __anonymizerTestUtils.resolveFailOpen(createTarget({ environment: "prod" }), { failOpen: true }),
    false
  );
  assert.equal(
    __anonymizerTestUtils.resolveFailOpen(createTarget({ environment: "dev" }), { failOpen: true }),
    true
  );
});

test("anonymizeQueryResult still fails closed for prod targets even when ANON_FAIL_OPEN=true", async () => {
  await assert.rejects(
    () =>
      anonymizeQueryResult({
        target: createTarget({ environment: "prod" }),
        queryResult: createQueryResult(),
        providerConfig: createProviderConfig({ failOpen: true }),
        fetchImpl: async () => {
          throw new Error("provider down");
        }
      }),
    /Field identification LLM failed/
  );
});

test("anonymizeQueryResult may fail open for non-prod targets when ANON_FAIL_OPEN=true", async () => {
  const result = await anonymizeQueryResult({
    target: createTarget({ environment: "dev" }),
    queryResult: createQueryResult(),
    providerConfig: createProviderConfig({ failOpen: true }),
    fetchImpl: async () => {
      throw new Error("provider down");
    }
  });

  assert.equal(result.anonymization_applied, true);
  assert.match(result.rows[0].Email, /^user_[a-f0-9]{10}@example\.invalid$/);
});

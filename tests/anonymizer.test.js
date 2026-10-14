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

test("anonymizeQueryResult uses column origins but never returns them to the client", async () => {
  const { anonymizeQueryResult } = await import("../src/lib/anonymizer.js");
  const result = await anonymizeQueryResult({
    target: { anonymization_enabled: true, anonymization_mode: "deterministic", llm_provider: "none", environment: "prod" },
    queryResult: {
      rows: [{ tipo: "Rossi" }],
      sql_text: "SELECT cognome AS tipo FROM dbo.u",
      max_result_bytes_applied: null,
      truncated: false,
      column_origins: { tipo: { table: "u", column: "cognome" } },
      column_origins_status: "resolved",
      column_origins_reason: null,
      column_origins_detail: null
    },
    providerConfig: { hashSalt: "salt-salt-salt", failOpen: false, timeoutMs: 1000, fieldIdentification: "heuristic" }
  });
  assert.match(result.rows[0].tipo, /^NAME_/);
  for (const key of ["column_origins", "column_origins_status", "column_origins_reason", "column_origins_detail"]) {
    assert.equal(key in result, false, `${key} is internal`);
  }
  assert.equal("anonymization_notes" in result, false, "no note when origins are resolved");
});

test("resolveFailOpen is closed for missing or unknown environments and open only for known non-prod ones", () => {
  const open = env => __anonymizerTestUtils.resolveFailOpen(createTarget({ environment: env }), { failOpen: true });
  assert.equal(open(""), false);
  assert.equal(open(undefined), false);
  assert.equal(open("production-eu"), false);
  assert.equal(open("staging"), true);
  assert.equal(open("test"), true);
  assert.equal(open("DEV"), true);
});

test("anonymizeQueryResult forwards the decision report to onReport", async () => {
  const { anonymizeQueryResult } = await import("../src/lib/anonymizer.js");
  let report;
  await anonymizeQueryResult({
    target: { anonymization_enabled: true, anonymization_mode: "deterministic", llm_provider: "none", environment: "prod" },
    queryResult: { rows: [{ email: "a@b.it" }], sql_text: "SELECT email FROM dbo.u", max_result_bytes_applied: null, truncated: false },
    providerConfig: { hashSalt: "salt-salt-salt", failOpen: false, timeoutMs: 1000, fieldIdentification: "heuristic" },
    onReport: r => { report = r; }
  });
  assert.equal(report.by_reason["heuristic:email"], 1);
});

test("clampRowsToByteLimit matches the serialized size exactly", () => {
  const rows = [{ a: "è" }, { b: 2 }, { c: null }];
  const total = Buffer.byteLength(JSON.stringify(rows), "utf8");
  assert.deepEqual(__anonymizerTestUtils.clampRowsToByteLimit(rows, total), rows);
  assert.deepEqual(__anonymizerTestUtils.clampRowsToByteLimit(rows, total - 1), rows.slice(0, 2));
  assert.deepEqual(__anonymizerTestUtils.clampRowsToByteLimit(rows, 2), []);
  assert.deepEqual(__anonymizerTestUtils.clampRowsToByteLimit(rows, Buffer.byteLength(JSON.stringify([rows[0]]))), [rows[0]]);
});

test("clampRowsToByteLimit runs in linear time", () => {
  const rows = Array.from({ length: 8000 }, (_, id) => ({ id, label: `row-${id}-${"x".repeat(40)}` }));
  const startedAt = performance.now();
  const clamped = __anonymizerTestUtils.clampRowsToByteLimit(rows, 10_000_000);
  const elapsedMs = performance.now() - startedAt;
  assert.equal(clamped.length, rows.length);
  assert.ok(elapsedMs < 1000, `took ${elapsedMs}ms`);
});

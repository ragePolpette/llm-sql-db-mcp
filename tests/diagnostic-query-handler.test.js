import test from "node:test";
import assert from "node:assert/strict";
import { TargetRegistry } from "../src/lib/target-registry.js";
import { createHandlers } from "../src/lib/handlers.js";

function createTestRegistry(includeProd = true) {
  const targets = [
    {
      target_id: "dev-main",
      display_name: "Dev Main",
      environment: "dev",
      db_kind: "sqlserver",
      status: "active",
      connection_env_var: "DB_DEV_MAIN_CONNECTION_STRING",
      read_enabled: true,
      write_enabled: true,
      anonymization_enabled: false,
      anonymization_mode: "off",
      llm_provider: "none",
      llm_model: "",
      max_rows: 5,
      max_result_bytes: 1024,
      allowed_tools: ["db_target_info", "db_policy_info", "db_read", "db_write"]
    }
  ];

  if (includeProd) {
    targets.push({
      target_id: "prod-main",
      display_name: "Prod Main",
      environment: "prod",
      db_kind: "sqlserver",
      status: "active",
      connection_env_var: "DB_PROD_MAIN_CONNECTION_STRING",
      read_enabled: true,
      write_enabled: false,
      anonymization_enabled: true,
      anonymization_mode: "hybrid",
      llm_provider: "lmstudio",
      llm_model: "gemma",
      max_rows: 5,
      max_result_bytes: 1024,
      allowed_tools: ["db_target_info", "db_policy_info", "db_read", "db_write"]
    });
  }

  return new TargetRegistry(targets);
}

test("runDiagnosticQuery maps database_target=dev to the dev target", async () => {
  let called = false;

  const handlers = createHandlers({
    targetRegistry: createTestRegistry(),
    env: {
      DB_DEV_MAIN_CONNECTION_STRING: "Server=dev;Database=Test;",
      DB_PROD_MAIN_CONNECTION_STRING: "Server=prod;Database=Test;"
    },
    executeSqlRead: async args => {
      called = true;
      assert.equal(args.connectionString, "Server=dev;Database=Test;");
      assert.equal(args.sqlText, "SELECT 1 AS value");
      assert.equal(args.maxRows, 5);
      return {
        columns: [{ name: "value", nullable: false, type: "Int" }],
        rows: [{ value: 1 }],
        row_count: 1,
        total_rows_before_limits: 1,
        max_rows_applied: 5,
        max_result_bytes_applied: 1024,
        result_bytes: 8,
        truncated: false,
        duration_ms: 2
      };
    }
  });

  const result = await handlers.runDiagnosticQuery({
    database_target: "dev",
    ticket_key: "TICKET-1",
    phase: "triage",
    query: "SELECT 1 AS value"
  });

  assert.equal(called, true);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.used.target_id, "dev-main");
  assert.deepEqual(result.structuredContent.rows, [{ value: 1 }]);
  assert.deepEqual(result.structuredContent.summary.column_names, ["value"]);
  assert.deepEqual(result.structuredContent.blockers, []);
});

test("runDiagnosticQuery maps database_target=prod to the prod target and preserves anonymization", async () => {
  let anonymizerCalled = false;

  const handlers = createHandlers({
    targetRegistry: createTestRegistry(),
    env: {
      DB_DEV_MAIN_CONNECTION_STRING: "Server=dev;Database=Test;",
      DB_PROD_MAIN_CONNECTION_STRING: "Server=prod;Database=Prod;"
    },
    providerConfig: {
      lmstudioBaseUrl: "http://127.0.0.1:1234/v1",
      ollamaBaseUrl: "http://127.0.0.1:11434"
    },
    executeSqlRead: async args => {
      assert.equal(args.connectionString, "Server=prod;Database=Prod;");
      return {
        columns: [{ name: "name", nullable: true, type: "NVarChar" }],
        rows: [{ name: "Mario Rossi" }],
        row_count: 1,
        total_rows_before_limits: 1,
        max_rows_applied: 5,
        max_result_bytes_applied: 1024,
        result_bytes: 24,
        truncated: false,
        duration_ms: 3
      };
    },
    anonymizeQueryResult: async ({ target, queryResult }) => {
      anonymizerCalled = true;
      assert.equal(target.target_id, "prod-main");
      return {
        ...queryResult,
        rows: [{ name: "Nome Anonimo" }],
        anonymization_applied: true,
        anonymization_provider: "lmstudio",
        anonymization_mode: "hybrid"
      };
    }
  });

  const result = await handlers.runDiagnosticQuery({
    database_target: "prod",
    ticket_key: "TICKET-2",
    phase: "execution",
    query: "SELECT name FROM dbo.Users"
  });

  assert.equal(anonymizerCalled, true);
  assert.equal(result.structuredContent.used.target_id, "prod-main");
  assert.equal(result.structuredContent.summary.anonymization_applied, true);
  assert.equal(result.structuredContent.summary.anonymization_provider, "lmstudio");
  assert.deepEqual(result.structuredContent.rows, [{ name: "Nome Anonimo" }]);
  assert.deepEqual(result.structuredContent.blockers, []);
});

test("runDiagnosticQuery returns a clear blocker when the target is unavailable", async () => {
  const handlers = createHandlers({
    targetRegistry: createTestRegistry(false),
    env: {
      DB_DEV_MAIN_CONNECTION_STRING: "Server=dev;Database=Test;"
    },
    executeSqlRead: async () => {
      throw new Error("should not be called");
    }
  });

  const result = await handlers.runDiagnosticQuery({
    database_target: "prod",
    ticket_key: "TICKET-3",
    phase: "triage",
    query: "SELECT 1"
  });

  assert.deepEqual(result.structuredContent.rows, []);
  assert.match(result.structuredContent.blockers[0], /No active target found for database_target "prod"/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { TargetRegistry } from "../src/lib/target-registry.js";
import { createHandlers } from "../src/lib/handlers.js";

function createTarget({
  target_id,
  display_name,
  environment,
  status,
  connection_env_var,
  read_enabled,
  write_enabled,
  anonymization_enabled,
  anonymization_mode,
  llm_provider,
  llm_model,
  max_rows,
  max_result_bytes,
  allowed_tools
}) {
  return {
    target_id,
    display_name,
    environment,
    db_kind: "sqlserver",
    status,
    connection_env_var,
    connection_binding: {
      source: "env",
      env_var: connection_env_var,
      vault_ref: null
    },
    read_enabled,
    write_enabled,
    anonymization_enabled,
    anonymization_mode,
    llm_provider,
    llm_model,
    max_rows,
    max_result_bytes,
    allowed_tools,
    declared: {
      read_enabled,
      write_enabled,
      anonymization_enabled,
      anonymization_mode,
      llm_provider,
      llm_model,
      max_rows,
      max_result_bytes,
      allowed_tools
    },
    effective: {
      read_enabled,
      write_enabled,
      anonymization_enabled,
      anonymization_mode,
      llm_provider,
      llm_model,
      max_rows,
      max_result_bytes,
      allowed_tools
    },
    policy: {
      read_enabled,
      write_enabled,
      anonymization_enabled,
      anonymization_mode,
      llm_provider,
      llm_model,
      max_rows,
      max_result_bytes,
      allowed_tools
    }
  };
}

function createTestRegistry() {
  return new TargetRegistry([
    createTarget({
      target_id: "dev-main",
      display_name: "Dev Main",
      environment: "dev",
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
    }),
    createTarget({
      target_id: "prod-main",
      display_name: "Prod Main",
      environment: "prod",
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
    })
  ]);
}

test("dbRead returns a clear error when the connection string env var is missing", async () => {
  const handlers = createHandlers({
    targetRegistry: createTestRegistry(),
    env: {},
    executeSqlRead: async () => {
      throw new Error("should not be called");
    }
  });

  const result = await handlers.dbRead({
    target_id: "dev-main",
    sql: "SELECT 1"
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /DB_DEV_MAIN_CONNECTION_STRING/);
  assert.match(result.content[0].text, /dev-main/);
});

test("dbRead rejects unsafe sql before executing the driver", async () => {
  let wasCalled = false;

  const handlers = createHandlers({
    targetRegistry: createTestRegistry(),
    env: {
      DB_DEV_MAIN_CONNECTION_STRING: "Server=.;Database=Test;Trusted_Connection=True;"
    },
    executeSqlRead: async () => {
      wasCalled = true;
      return {};
    }
  });

  const result = await handlers.dbRead({
    target_id: "dev-main",
    sql: "DELETE FROM dbo.Users"
  });

  assert.equal(result.isError, true);
  assert.equal(wasCalled, false);
  assert.match(result.content[0].text, /Only SELECT|Forbidden SQL keyword/i);
});

test("dbRead normalizes the handler response and clamps max_rows", async () => {
  const originalSql = "SELECT id FROM dbo.Users WHERE status = 'OPEN'";
  const handlers = createHandlers({
    targetRegistry: createTestRegistry(),
    sqlDriverConfig: {
      connectionTimeoutMs: 12000,
      requestTimeoutMs: 18000,
      pool: {
        max: 8,
        min: 0,
        idleTimeoutMs: 30000
      }
    },
    env: {
      DB_DEV_MAIN_CONNECTION_STRING: "Server=.;Database=Test;Trusted_Connection=True;"
    },
    executeSqlRead: async args => {
      assert.equal(args.maxRows, 5);
      assert.equal(args.maxResultBytes, 1024);
      assert.equal(args.sqlText, originalSql);
      assert.deepEqual(args.driverConfig, {
        connectionTimeoutMs: 12000,
        requestTimeoutMs: 18000,
        pool: {
          max: 8,
          min: 0,
          idleTimeoutMs: 30000
        }
      });

      return {
        columns: [{ name: "id", nullable: false, type: "Int" }],
        rows: [{ id: 1 }],
        row_count: 1,
        total_rows_before_limits: 1,
        max_rows_applied: 5,
        max_result_bytes_applied: 1024,
        result_bytes: 10,
        truncated: false,
        duration_ms: 3
      };
    }
  });

  const result = await handlers.dbRead({
    target_id: "dev-main",
    sql: originalSql,
    max_rows: 999
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.target_id, "dev-main");
  assert.equal(result.structuredContent.anonymization_applied, false);
  assert.deepEqual(result.structuredContent.rows, [{ id: 1 }]);
});

test("dbRead applies target-aware anonymization when the target policy requires it", async () => {
  let anonymizerCalled = false;

  const handlers = createHandlers({
    targetRegistry: createTestRegistry(),
    env: {
      DB_PROD_MAIN_CONNECTION_STRING: "Server=.;Database=Prod;Trusted_Connection=True;"
    },
    providerConfig: {
      lmstudioBaseUrl: "http://127.0.0.1:1234/v1",
      ollamaBaseUrl: "http://127.0.0.1:11434"
    },
    executeSqlRead: async () => ({
      columns: [{ name: "name", nullable: true, type: "NVarChar" }],
      rows: [{ name: "Mario Rossi" }],
      row_count: 1,
      total_rows_before_limits: 1,
      max_rows_applied: 5,
      max_result_bytes_applied: 1024,
      result_bytes: 24,
      truncated: false,
      duration_ms: 1
    }),
    anonymizeQueryResult: async ({ target, queryResult, providerConfig }) => {
      anonymizerCalled = true;
      assert.equal(target.target_id, "prod-main");
      assert.equal(providerConfig.lmstudioBaseUrl, "http://127.0.0.1:1234/v1");

      return {
        ...queryResult,
        rows: [{ name: "Nome Anonimo" }],
        anonymization_applied: true,
        anonymization_provider: "lmstudio",
        anonymization_mode: "hybrid"
      };
    }
  });

  const result = await handlers.dbRead({
    target_id: "prod-main",
    sql: "SELECT name FROM dbo.Users"
  });

  assert.equal(anonymizerCalled, true);
  assert.equal(result.structuredContent.anonymization_applied, true);
  assert.equal(result.structuredContent.anonymization_provider, "lmstudio");
  assert.deepEqual(result.structuredContent.rows, [{ name: "Nome Anonimo" }]);
});

test("dbRead emits query_in and query_out events for dashboard inspection", async () => {
  const events = [];

  const handlers = createHandlers({
    targetRegistry: createTestRegistry(),
    env: {
      DB_PROD_MAIN_CONNECTION_STRING: "Server=.;Database=Prod;Trusted_Connection=True;"
    },
    providerConfig: {
      lmstudioBaseUrl: "http://127.0.0.1:1234/v1",
      ollamaBaseUrl: "http://127.0.0.1:11434",
      fieldIdentification: "hybrid",
      hashSalt: "secret-1234567890-XYZ!",
      failOpen: false,
      timeoutMs: 5000
    },
    executeSqlRead: async () => ({
      columns: [{ name: "name", nullable: true, type: "NVarChar" }],
      rows: [{ name: "Mario Rossi" }],
      row_count: 1,
      total_rows_before_limits: 1,
      max_rows_applied: 5,
      max_result_bytes_applied: 1024,
      result_bytes: 24,
      truncated: false,
      duration_ms: 1
    }),
    anonymizeQueryResult: async ({ queryResult }) => ({
      ...queryResult,
      rows: [{ name: "Nome Anonimo" }],
      anonymization_applied: true,
      anonymization_provider: "lmstudio",
      anonymization_mode: "hybrid"
    }),
    logDbEvent: (event, payload) => {
      events.push({ event, payload });
    }
  });

  await handlers.dbRead({
    target_id: "prod-main",
    sql: "SELECT name FROM dbo.Users"
  });

  assert.equal(events.length, 2);
  assert.equal(events[0].event, "query_in");
  assert.equal(events[0].payload.tool, "db_read");
  assert.equal(events[1].event, "query_out");
  assert.equal(events[1].payload.rowCount, 1);
  assert.equal(events[1].payload.response.anonymizationApplied, true);
});

test("dbWrite executes a write statement when target write is enabled", async () => {
  let writeCalled = false;

  const handlers = createHandlers({
    targetRegistry: createTestRegistry(),
    env: {
      DB_DEV_MAIN_CONNECTION_STRING: "Server=.;Database=Test;Trusted_Connection=True;"
    },
    executeSqlRead: async () => {
      throw new Error("read should not be called");
    },
    executeSqlWrite: async args => {
      writeCalled = true;
      assert.equal(args.sqlText, "UPDATE dbo.Users SET status = 'OPEN' WHERE id = 1");
      return {
        columns: [],
        rows: [],
        row_count: 0,
        rows_affected: 1,
        max_result_bytes_applied: 1024,
        result_bytes: 2,
        truncated: false,
        duration_ms: 4
      };
    }
  });

  const result = await handlers.dbWrite({
    target_id: "dev-main",
    sql: "UPDATE dbo.Users SET status = 'OPEN' WHERE id = 1"
  });

  assert.equal(writeCalled, true);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.rows_affected, 1);
});

test("dbWrite is denied for prod targets by the hard fence", async () => {
  const handlers = createHandlers({
    targetRegistry: createTestRegistry(),
    env: {
      DB_PROD_MAIN_CONNECTION_STRING: "Server=.;Database=Prod;Trusted_Connection=True;"
    },
    executeSqlRead: async () => {
      throw new Error("read should not be called");
    },
    executeSqlWrite: async () => {
      throw new Error("write should not be called");
    }
  });

  const result = await handlers.dbWrite({
    target_id: "prod-main",
    sql: "UPDATE dbo.Users SET status = 'OPEN' WHERE id = 1"
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Write access is (disabled|hard-fenced off)/i);
});

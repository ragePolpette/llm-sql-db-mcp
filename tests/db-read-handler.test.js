import test from "node:test";
import assert from "node:assert/strict";
import { TargetRegistry } from "../src/lib/target-registry.js";
import { createHandlers } from "../src/lib/handlers.js";

function createTestRegistry() {
  return new TargetRegistry([
    {
      target_id: "dev-main",
      display_name: "Dev Main",
      environment: "dev",
      db_kind: "sqlserver",
      status: "active",
      connection_env_var: "DB_DEV_MAIN_CONNECTION_STRING",
      read_enabled: true,
      write_enabled: false,
      anonymization_enabled: false,
      anonymization_mode: "off",
      llm_provider: "none",
      llm_model: "",
      max_rows: 5,
      max_result_bytes: 1024,
      allowed_tools: ["db_target_info", "db_policy_info", "db_read"]
    }
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
  const handlers = createHandlers({
    targetRegistry: createTestRegistry(),
    env: {
      DB_DEV_MAIN_CONNECTION_STRING: "Server=.;Database=Test;Trusted_Connection=True;"
    },
    executeSqlRead: async args => {
      assert.equal(args.maxRows, 5);
      assert.equal(args.maxResultBytes, 1024);
      assert.equal(args.sqlText, "SELECT id FROM dbo.Users");

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
    sql: "SELECT id FROM dbo.Users",
    max_rows: 999
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.target_id, "dev-main");
  assert.equal(result.structuredContent.anonymization_applied, false);
  assert.deepEqual(result.structuredContent.rows, [{ id: 1 }]);
});

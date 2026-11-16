import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfirmationStore } from "../src/lib/confirmation-store.js";
import { createHandlers } from "../src/lib/handlers.js";
import { buildPolicyInfo, evaluateToolPolicy, toSafeTargetInfo, toSafeTargetSummary } from "../src/lib/policy-engine.js";
import { TargetRegistry, loadTargetRegistry } from "../src/lib/target-registry.js";
import { registerFixedTools } from "../src/lib/tools.js";

const CREATE_SQL = "CREATE TABLE dbo.Fat_Prova (Id INT IDENTITY(1,1) PRIMARY KEY, Nome NVARCHAR(100) NULL)";
const ALTER_SQL = "ALTER TABLE dbo.Fat_Prova ADD Note NVARCHAR(200) NULL";

function createTarget(overrides = {}) {
  return {
    target_id: "dev-main",
    display_name: "Dev Main",
    environment: "dev",
    db_kind: "sqlserver",
    status: "active",
    connection_env_var: "DB_DEV_MAIN_CONNECTION_STRING",
    connection_binding: { source: "env", env_var: "DB_DEV_MAIN_CONNECTION_STRING", vault_ref: null },
    read_enabled: true,
    write_enabled: true,
    ddl_enabled: true,
    anonymization_enabled: false,
    anonymization_mode: "off",
    llm_provider: "none",
    llm_model: "",
    max_rows: 5,
    max_result_bytes: 1024,
    allowed_tools: ["db_target_info", "db_policy_info", "db_read", "db_write", "db_ddl"],
    ...overrides
  };
}

// ---------------------------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------------------------

test("evaluateToolPolicy allows db_ddl on a non-prod, non-anonymized target with ddl enabled", () => {
  const policy = evaluateToolPolicy({ target: createTarget(), toolName: "db_ddl" });

  assert.equal(policy.allowed, true);
  assert.equal(policy.anonymization_required, false);
  assert.equal(policy.denial_reason, null);
});

test("evaluateToolPolicy denies db_ddl when ddl_enabled is false or missing", () => {
  for (const overrides of [{ ddl_enabled: false }, { ddl_enabled: undefined }]) {
    const policy = evaluateToolPolicy({ target: createTarget(overrides), toolName: "db_ddl" });
    assert.equal(policy.allowed, false);
    assert.match(policy.denial_reason, /DDL is disabled/);
  }
});

test("evaluateToolPolicy denies db_ddl when the tool is not in allowed_tools", () => {
  const policy = evaluateToolPolicy({
    target: createTarget({ allowed_tools: ["db_target_info", "db_policy_info", "db_read", "db_write"] }),
    toolName: "db_ddl"
  });

  assert.equal(policy.allowed, false);
  assert.match(policy.denial_reason, /not allowed/);
});

test("evaluateToolPolicy hard-fences db_ddl on prod even when the target object enables it", () => {
  const policy = evaluateToolPolicy({
    target: createTarget({ environment: "prod", target_id: "prod-main" }),
    toolName: "db_ddl"
  });

  assert.equal(policy.allowed, false);
  assert.match(policy.denial_reason, /hard-fenced/);
});

test("evaluateToolPolicy denies db_ddl on anonymized targets", () => {
  const policy = evaluateToolPolicy({
    target: createTarget({ anonymization_enabled: true, anonymization_mode: "deterministic" }),
    toolName: "db_ddl"
  });

  assert.equal(policy.allowed, false);
  assert.match(policy.denial_reason, /anonymized/);
});

test("buildPolicyInfo lists db_ddl and the safe summaries expose ddl_enabled as a boolean", () => {
  const info = buildPolicyInfo(createTarget());
  assert.equal(info.available_policies.find(item => item.tool_name === "db_ddl").allowed, true);

  assert.equal(toSafeTargetSummary(createTarget()).ddl_enabled, true);
  assert.equal(toSafeTargetSummary(createTarget({ ddl_enabled: undefined })).ddl_enabled, false);
  assert.equal(toSafeTargetInfo(createTarget()).ddl_enabled, true);
});

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

function writeTempTargetsFile(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-sql-db-mcp-ddl-"));
  const filePath = path.join(dir, "targets.json");
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  return filePath;
}

function fileTarget(overrides = {}) {
  const target = createTarget();
  delete target.connection_binding;
  return { ...target, ...overrides };
}

function captureWarnings() {
  const warnings = [];
  return { warnings, logger: { warn: (event, payload) => warnings.push({ event, payload }) } };
}

test("a targets file without ddl_enabled loads with ddl disabled", async () => {
  const withoutDdl = fileTarget();
  delete withoutDdl.ddl_enabled;
  const filePath = writeTempTargetsFile({ targets: [withoutDdl] });

  const target = (await loadTargetRegistry(filePath, { env: {}, logger: captureWarnings().logger })).get("dev-main");

  assert.equal(target.ddl_enabled, false);
});

test("a targets file can enable ddl on a dev target and an env override can flip it", async () => {
  const filePath = writeTempTargetsFile({ targets: [fileTarget({ ddl_enabled: true })] });
  const { logger } = captureWarnings();

  assert.equal((await loadTargetRegistry(filePath, { env: {}, logger })).get("dev-main").ddl_enabled, true);
  assert.equal(
    (await loadTargetRegistry(filePath, { env: { TARGET_DEV_MAIN_DDL_ENABLED: "false" }, logger })).get("dev-main").ddl_enabled,
    false
  );
  const disabledFile = writeTempTargetsFile({ targets: [fileTarget({ ddl_enabled: false })] });
  assert.equal(
    (await loadTargetRegistry(disabledFile, { env: { TARGET_DEV_MAIN_DDL_ENABLED: "true" }, logger })).get("dev-main").ddl_enabled,
    true
  );
});

test("prod fence forces ddl_enabled off and removes db_ddl from the targets file", async () => {
  const filePath = writeTempTargetsFile({
    targets: [
      fileTarget({
        target_id: "prod-main",
        environment: "prod",
        connection_env_var: "DB_PROD_MAIN_CONNECTION_STRING",
        write_enabled: false,
        ddl_enabled: true,
        allowed_tools: ["db_read", "db_ddl"]
      })
    ]
  });
  const { warnings, logger } = captureWarnings();

  const target = (await loadTargetRegistry(filePath, { env: {}, logger })).get("prod-main");

  assert.equal(target.ddl_enabled, false);
  assert.deepEqual(target.allowed_tools, ["db_read"]);
  assert.deepEqual(
    warnings.map(w => w.event).filter(event => event.includes("ddl")).sort(),
    ["target.prod_ddl_disabled", "target.prod_ddl_tool_removed"]
  );
});

test("prod fence ignores an env override that would enable ddl", async () => {
  const filePath = writeTempTargetsFile({
    targets: [
      fileTarget({
        target_id: "prod-main",
        environment: "prod",
        connection_env_var: "DB_PROD_MAIN_CONNECTION_STRING",
        write_enabled: false,
        ddl_enabled: false
      })
    ]
  });
  const { warnings, logger } = captureWarnings();

  const target = (await loadTargetRegistry(filePath, { env: { TARGET_PROD_MAIN_DDL_ENABLED: "true" }, logger })).get("prod-main");

  assert.equal(target.ddl_enabled, false);
  const ignored = warnings.filter(w => w.event === "target.prod_override_ignored").map(w => w.payload.env_var);
  assert.deepEqual(ignored, ["TARGET_PROD_MAIN_DDL_ENABLED"]);
});

test("TargetRegistry applies the prod fence to ddl when built directly", () => {
  const registry = new TargetRegistry([createTarget({ target_id: "prod-main", environment: "prod" })]);
  const target = registry.get("prod-main");

  assert.equal(target.ddl_enabled, false);
  assert.equal(target.allowed_tools.includes("db_ddl"), false);
});

// ---------------------------------------------------------------------------------------------
// Handler: two-phase flow
// ---------------------------------------------------------------------------------------------

function getDeclaredOutputKeys(toolName) {
  const declared = {};
  registerFixedTools(
    { registerTool: (name, config) => { declared[name] = Object.keys(config.outputSchema ?? {}); } },
    createHandlers({ targetRegistry: new TargetRegistry([createTarget()]) })
  );
  return new Set(declared[toolName]);
}

function assertOnlyDeclaredKeys(structuredContent) {
  const declared = getDeclaredOutputKeys("db_ddl");
  assert.deepEqual(Object.keys(structuredContent).filter(key => !declared.has(key)), []);
}

function createHarness({ targets = [createTarget()], executeSqlWrite, clock = { now: 1_000_000 }, env } = {}) {
  const calls = [];
  const events = [];
  const handlers = createHandlers({
    targetRegistry: new TargetRegistry(targets),
    env: env ?? { DB_DEV_MAIN_CONNECTION_STRING: "Server=.;Database=Dev;Trusted_Connection=True;" },
    executeSqlWrite:
      executeSqlWrite ??
      (async args => {
        calls.push(args);
        return { columns: [], rows: [], row_count: 0, rows_affected: 0, max_result_bytes_applied: 1024, result_bytes: 0, truncated: false, duration_ms: 4 };
      }),
    confirmationStore: new ConfirmationStore({ now: () => clock.now }),
    logDbEvent: (event, payload) => events.push({ event, payload })
  });
  return { handlers, calls, events, clock };
}

async function requestToken(handlers, sql = CREATE_SQL, targetId = "dev-main") {
  const result = await handlers.dbDdl({ target_id: targetId, sql });
  assert.equal(result.isError, undefined);
  return result.structuredContent;
}

function errorCode(result) {
  return JSON.parse(result.content[1].text).error;
}

test("dbDdl first phase executes nothing and returns a one-time token for the exact statement", async () => {
  const { handlers, calls } = createHarness();

  const result = await handlers.dbDdl({ target_id: "dev-main", sql: `  ${CREATE_SQL};  ` });

  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 0);
  const body = result.structuredContent;
  assert.equal(body.status, "confirmation_required");
  assert.equal(body.target_id, "dev-main");
  assert.equal(body.sql, `${CREATE_SQL};`);
  assert.match(body.confirmation_token, /^[A-Za-z0-9_-]{32}$/);
  assert.match(body.sql_hash, /^[0-9a-f]{16}$/);
  assert.equal(body.expires_in_s, 300);
  assert.match(body.message, /Nothing was executed/);
  assertOnlyDeclaredKeys(body);
});

test("dbDdl second phase executes the exact statement once and reports it", async () => {
  const { handlers, calls } = createHarness();
  const issued = await requestToken(handlers);

  const result = await handlers.dbDdl({ target_id: "dev-main", sql: CREATE_SQL, confirmation_token: issued.confirmation_token });

  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sqlText, CREATE_SQL);
  assert.deepEqual(calls[0].parameters, {});
  assert.match(calls[0].connectionString, /Database=Dev/);
  const body = result.structuredContent;
  assert.equal(body.status, "executed");
  assert.equal(body.sql, CREATE_SQL);
  assert.equal(body.sql_hash, issued.sql_hash);
  assert.equal(body.token_id, issued.token_id);
  assert.equal(body.rows_affected, 0);
  assert.equal(body.duration_ms, 4);
  assert.equal("confirmation_token" in body, false);
  assertOnlyDeclaredKeys(body);
});

test("dbDdl rejects a replayed token and does not execute twice", async () => {
  const { handlers, calls } = createHarness();
  const { confirmation_token: token } = await requestToken(handlers);

  await handlers.dbDdl({ target_id: "dev-main", sql: CREATE_SQL, confirmation_token: token });
  const replay = await handlers.dbDdl({ target_id: "dev-main", sql: CREATE_SQL, confirmation_token: token });

  assert.equal(replay.isError, true);
  assert.equal(errorCode(replay).code, "confirmation_invalid");
  assert.equal(errorCode(replay).details.reason, "reused");
  assert.equal(calls.length, 1);
});

test("dbDdl rejects a token issued for a different statement and burns it", async () => {
  const { handlers, calls } = createHarness();
  const { confirmation_token: token } = await requestToken(handlers, CREATE_SQL);

  const swapped = await handlers.dbDdl({ target_id: "dev-main", sql: ALTER_SQL, confirmation_token: token });
  const original = await handlers.dbDdl({ target_id: "dev-main", sql: CREATE_SQL, confirmation_token: token });

  assert.equal(errorCode(swapped).details.reason, "scope_mismatch");
  assert.equal(errorCode(original).details.reason, "reused");
  assert.equal(calls.length, 0);
});

test("dbDdl treats statements that differ only by a literal as different (token is bound to the exact text)", async () => {
  const { handlers, calls } = createHarness();
  const sqlA = "CREATE TABLE dbo.t (n NVARCHAR(5) DEFAULT 'a')";
  const sqlB = "CREATE TABLE dbo.t (n NVARCHAR(5) DEFAULT 'b')";
  const { confirmation_token: token } = await requestToken(handlers, sqlA);

  const result = await handlers.dbDdl({ target_id: "dev-main", sql: sqlB, confirmation_token: token });

  assert.equal(errorCode(result).details.reason, "scope_mismatch");
  assert.equal(calls.length, 0);
});

test("dbDdl rejects an expired token", async () => {
  const { handlers, calls, clock } = createHarness();
  const { confirmation_token: token } = await requestToken(handlers);

  clock.now += 5 * 60 * 1000;
  const result = await handlers.dbDdl({ target_id: "dev-main", sql: CREATE_SQL, confirmation_token: token });

  assert.equal(errorCode(result).details.reason, "expired");
  assert.equal(calls.length, 0);
});

test("dbDdl rejects an invented token", async () => {
  const { handlers, calls } = createHarness();

  const result = await handlers.dbDdl({ target_id: "dev-main", sql: CREATE_SQL, confirmation_token: "not-a-real-token" });

  assert.equal(errorCode(result).details.reason, "unknown");
  assert.equal(calls.length, 0);
});

test("dbDdl is denied by policy without issuing a token or touching the database", async () => {
  const cases = [
    [createTarget({ ddl_enabled: false }), /DDL is disabled/],
    [createTarget({ allowed_tools: ["db_read"] }), /not allowed/],
    [createTarget({ anonymization_enabled: true, anonymization_mode: "deterministic" }), /anonymized/],
    [createTarget({ environment: "prod", target_id: "prod-main" }), /hard-fenced|not allowed|disabled/]
  ];

  for (const [target, reason] of cases) {
    const { handlers, calls } = createHarness({ targets: [target] });
    const result = await handlers.dbDdl({ target_id: target.target_id, sql: CREATE_SQL });

    assert.equal(result.isError, true);
    assert.equal(errorCode(result).code, "policy_denied");
    assert.match(errorCode(result).message, reason);
    assert.equal(calls.length, 0);
  }
});

test("dbDdl returns target_not_found for an unknown target", async () => {
  const { handlers } = createHarness();

  const result = await handlers.dbDdl({ target_id: "nope", sql: CREATE_SQL });

  assert.equal(errorCode(result).code, "target_not_found");
});

test("dbDdl rejects statements outside CREATE TABLE / ALTER TABLE before any token is issued", async () => {
  const { handlers, calls } = createHarness();
  const rejected = [
    "DROP TABLE dbo.Fat_Prova",
    "TRUNCATE TABLE dbo.Fat_Prova",
    "ALTER TABLE dbo.Fat_Prova DROP COLUMN Note",
    "CREATE TABLE Fat_Prova (id int)",
    "CREATE TABLE dbo.t (id int, FOREIGN KEY (id) REFERENCES dbo.u (id))",
    "CREATE TABLE dbo.#t (id int)",
    "CREATE TABLE dbo.t (id int); CREATE TABLE dbo.u (id int)",
    "SELECT 1"
  ];

  for (const sql of rejected) {
    const result = await handlers.dbDdl({ target_id: "dev-main", sql });
    assert.equal(result.isError, true, sql);
    assert.equal(errorCode(result).code, "invalid_sql", sql);
  }
  assert.equal(calls.length, 0);
});

test("dbDdl still validates the statement on the second phase", async () => {
  const { handlers, calls } = createHarness();
  const { confirmation_token: token } = await requestToken(handlers);

  const result = await handlers.dbDdl({ target_id: "dev-main", sql: "DROP TABLE dbo.Fat_Prova", confirmation_token: token });

  assert.equal(errorCode(result).code, "invalid_sql");
  assert.equal(calls.length, 0);
});

test("dbDdl reports driver failures and does not allow the burned token to be retried", async () => {
  const { handlers } = createHarness({
    executeSqlWrite: async () => {
      throw new Error("There is already an object named 'Fat_Prova' in the database.");
    }
  });
  const { confirmation_token: token } = await requestToken(handlers);

  const failed = await handlers.dbDdl({ target_id: "dev-main", sql: CREATE_SQL, confirmation_token: token });
  const retry = await handlers.dbDdl({ target_id: "dev-main", sql: CREATE_SQL, confirmation_token: token });

  assert.equal(errorCode(failed).code, "db_ddl_failed");
  assert.match(errorCode(failed).message, /already an object/);
  assert.equal(errorCode(retry).details.reason, "reused");
});

test("dbDdl fails clearly when the connection string env var is missing", async () => {
  const { handlers, calls } = createHarness({ env: {} });
  const { confirmation_token: token } = await requestToken(handlers);

  const result = await handlers.dbDdl({ target_id: "dev-main", sql: CREATE_SQL, confirmation_token: token });

  assert.equal(result.isError, true);
  assert.equal(errorCode(result).code, "db_ddl_failed");
  assert.equal(calls.length, 0);
});

test("dbDdl never writes the confirmation token to the event log", async () => {
  const { handlers, events } = createHarness();
  const issued = await requestToken(handlers);
  await handlers.dbDdl({ target_id: "dev-main", sql: CREATE_SQL, confirmation_token: issued.confirmation_token });
  await handlers.dbDdl({ target_id: "dev-main", sql: CREATE_SQL, confirmation_token: issued.confirmation_token });

  const names = events.map(event => event.event);
  assert.ok(names.includes("ddl_confirmation_requested"));
  assert.ok(names.includes("query_in"));
  assert.ok(names.includes("query_out"));
  assert.ok(names.includes("ddl_confirmation_invalid"));
  assert.equal(JSON.stringify(events).includes(issued.confirmation_token), false);
  assert.ok(JSON.stringify(events).includes(issued.token_id));
});

test("db_ddl is registered with a destructive, non-read-only annotation and an optional confirmation_token", () => {
  const registered = {};
  registerFixedTools(
    { registerTool: (name, config) => { registered[name] = config; } },
    createHandlers({ targetRegistry: new TargetRegistry([createTarget()]) })
  );

  const tool = registered.db_ddl;
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, true);
  assert.deepEqual(Object.keys(tool.inputSchema).sort(), ["confirmation_token", "sql", "target_id"]);
  assert.equal(tool.inputSchema.confirmation_token.isOptional(), true);
  assert.equal(tool.inputSchema.sql.isOptional(), false);
});

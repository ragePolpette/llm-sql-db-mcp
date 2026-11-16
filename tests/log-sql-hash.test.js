import test from "node:test";
import assert from "node:assert/strict";
import { createHandlers } from "../src/lib/handlers.js";
import { createLogger } from "../src/lib/logger.js";
import { TargetRegistry } from "../src/lib/target-registry.js";

const READ_SQL = "SELECT codice_fiscale FROM dbo.Anagrafica WHERE partita_iva = '01234567890'";
const WRITE_SQL = "UPDATE dbo.Anagrafica SET nota = 'riservata' WHERE id = 7";

function memoryStream() {
  const lines = [];
  return { lines, write: value => { lines.push(String(value)); return true; } };
}

function parse(stream) {
  return stream.lines.map(line => JSON.parse(line));
}

function createTarget() {
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
    anonymization_enabled: false,
    anonymization_mode: "off",
    llm_provider: "none",
    llm_model: "",
    max_rows: 5,
    max_result_bytes: 1024,
    allowed_tools: ["db_target_info", "db_policy_info", "db_read", "db_write"]
  };
}

const OK_RESULT = {
  columns: [],
  rows: [],
  row_count: 0,
  total_rows_before_limits: 0,
  rows_affected: 1,
  max_rows_applied: 5,
  max_result_bytes_applied: 1024,
  result_bytes: 0,
  truncated: false,
  duration_ms: 2
};

function createHarness(level, { fail = false } = {}) {
  const stdout = memoryStream();
  const logger = createLogger({ level, stdout });
  const run = async () => {
    if (fail) throw new Error("Invalid object name 'dbo.Anagrafica'.");
    return OK_RESULT;
  };
  const handlers = createHandlers({
    targetRegistry: new TargetRegistry([createTarget()]),
    env: { DB_DEV_MAIN_CONNECTION_STRING: "Server=.;Database=Dev;Trusted_Connection=True;" },
    executeSqlRead: run,
    executeSqlWrite: run,
    logDbEvent: logger.dbEvent
  });
  return { handlers, stdout };
}

// ---------------------------------------------------------------------------------------------
// Logger: query_out / query_failed portano l'impronta della query, mai il testo
// ---------------------------------------------------------------------------------------------

test("logger: query_out carries the same sql_hash as query_in and never the sql text", () => {
  const debugOut = memoryStream();
  const infoOut = memoryStream();
  const debugLogger = createLogger({ level: "debug", stdout: debugOut });
  const infoLogger = createLogger({ level: "info", stdout: infoOut });

  debugLogger.dbEvent("query_in", { tool: "db_read", target_id: "dev-main", sql: READ_SQL, parameters: {} });
  infoLogger.dbEvent("query_out", { tool: "db_read", target_id: "dev-main", sql: READ_SQL, rowCount: 3, truncated: false });

  const queryIn = parse(debugOut)[0].payload;
  const queryOut = parse(infoOut)[0].payload;
  assert.match(queryOut.sql_hash, /^[0-9a-f]{16}$/);
  assert.equal(queryOut.sql_hash, queryIn.sql_hash);
  assert.equal(queryOut.row_count, 3);
  assert.equal(infoOut.lines.join("").includes("01234567890"), false);
  assert.equal(Object.keys(queryOut).includes("sql"), false);
  assert.equal(Object.keys(queryOut).includes("sql_preview"), false);
});

test("logger: query_out without sql keeps a null sql_hash", () => {
  const stdout = memoryStream();
  createLogger({ level: "info", stdout }).dbEvent("query_out", { tool: "db_read", target_id: "dev-main", rowCount: 1 });

  assert.equal(parse(stdout)[0].payload.sql_hash, null);
});

test("logger: query_failed carries sql_hash and the error, driver events carry no sql_hash", () => {
  const stdout = memoryStream();
  const logger = createLogger({ level: "debug", stdout });

  logger.dbEvent("query_failed", { tool: "db_write", target_id: "dev-main", sql: WRITE_SQL, error: "boom" });
  logger.dbEvent("db_driver_start", { tool: "db_write", target_id: "dev-main", runtime_status: "ready" });

  const [failed, driver] = parse(stdout);
  assert.match(failed.payload.sql_hash, /^[0-9a-f]{16}$/);
  assert.equal(failed.payload.error, "boom");
  assert.equal(stdout.lines[0].includes("riservata"), false);
  assert.equal(Object.keys(driver.payload).includes("sql_hash"), false);
});

// ---------------------------------------------------------------------------------------------
// End to end: handler + logger reali
// ---------------------------------------------------------------------------------------------

test("db_read: at debug level query_in and query_out share the sql_hash", async () => {
  const { handlers, stdout } = createHarness("debug");

  await handlers.dbRead({ target_id: "dev-main", sql: READ_SQL });

  const events = parse(stdout).filter(entry => ["db.query_in", "db.query_out"].includes(entry.event));
  const byEvent = Object.fromEntries(events.map(entry => [entry.event, entry.payload]));
  assert.match(byEvent["db.query_out"].sql_hash, /^[0-9a-f]{16}$/);
  assert.equal(byEvent["db.query_out"].sql_hash, byEvent["db.query_in"].sql_hash);
});

test("db_read and db_write: at info level query_out has sql_hash and no sql text anywhere", async () => {
  const { handlers, stdout } = createHarness("info");

  await handlers.dbRead({ target_id: "dev-main", sql: READ_SQL });
  await handlers.dbWrite({ target_id: "dev-main", sql: WRITE_SQL });

  const outs = parse(stdout).filter(entry => entry.event === "db.query_out");
  assert.equal(outs.length, 2);
  assert.deepEqual(outs.map(entry => entry.payload.tool), ["db_read", "db_write"]);
  for (const entry of outs) {
    assert.match(entry.payload.sql_hash, /^[0-9a-f]{16}$/);
  }
  assert.notEqual(outs[0].payload.sql_hash, outs[1].payload.sql_hash);
  const everything = stdout.lines.join("");
  assert.equal(everything.includes("01234567890"), false);
  assert.equal(everything.includes("riservata"), false);
});

test("db_read and db_write: a failed query logs db.query_failed with the sql_hash", async () => {
  const { handlers, stdout } = createHarness("info", { fail: true });

  await handlers.dbRead({ target_id: "dev-main", sql: READ_SQL });
  await handlers.dbWrite({ target_id: "dev-main", sql: WRITE_SQL });

  const failures = parse(stdout).filter(entry => entry.event === "db.query_failed");
  assert.equal(failures.length, 2);
  for (const entry of failures) {
    assert.match(entry.payload.sql_hash, /^[0-9a-f]{16}$/);
    assert.match(entry.payload.error, /Invalid object name/);
  }
  assert.notEqual(failures[0].payload.sql_hash, failures[1].payload.sql_hash);
  assert.equal(stdout.lines.join("").includes("01234567890"), false);
});

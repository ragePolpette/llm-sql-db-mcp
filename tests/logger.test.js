import test from "node:test";
import assert from "node:assert/strict";
import { createLogger, __loggerTestUtils } from "../src/lib/logger.js";

function createWritableMemoryStream() {
  const chunks = [];
  return {
    chunks,
    write(value) {
      chunks.push(String(value));
      return true;
    }
  };
}

test("createLogger redacts query_in payloads and keeps parameter keys only", () => {
  const stdout = createWritableMemoryStream();
  const logger = createLogger({
    level: "debug",
    stdout
  });

  logger.dbEvent("query_in", {
    tool: "db_read",
    target_id: "prod-main",
    sql: "SELECT email FROM dbo.Users WHERE id = @id",
    parameters: { id: 123, email: "sensitive@example.com" },
    maxRows: 25
  });

  assert.equal(stdout.chunks.length, 1);
  const entry = JSON.parse(stdout.chunks[0]);
  assert.equal(entry.event, "db.query_in");
  assert.equal(entry.payload.tool, "db_read");
  assert.equal(entry.payload.sql_hash.length, 16);
  assert.equal(entry.payload.parameter_count, 2);
  assert.deepEqual(entry.payload.parameter_keys, ["email", "id"]);
  assert.equal(Object.prototype.hasOwnProperty.call(entry.payload, "parameters"), false);
});

test("createLogger omits db query_in logs at info level but keeps sanitized query_out", () => {
  const stdout = createWritableMemoryStream();
  const logger = createLogger({
    level: "info",
    stdout
  });

  logger.dbEvent("query_in", {
    tool: "db_read",
    target_id: "dev-main",
    sql: "SELECT 1",
    parameters: {}
  });
  logger.dbEvent("query_out", {
    tool: "db_read",
    target_id: "dev-main",
    rowCount: 3,
    truncated: false,
    response: {
      rows: [{ secret: "should never be logged" }]
    }
  });

  assert.equal(stdout.chunks.length, 1);
  const entry = JSON.parse(stdout.chunks[0]);
  assert.equal(entry.event, "db.query_out");
  assert.equal(entry.payload.row_count, 3);
  assert.equal(Object.prototype.hasOwnProperty.call(entry.payload, "response"), false);
});

test("normalizeLogLevel rejects unsupported values", () => {
  assert.throws(
    () => __loggerTestUtils.normalizeLogLevel("trace"),
    /Unsupported LOG_LEVEL/
  );
});

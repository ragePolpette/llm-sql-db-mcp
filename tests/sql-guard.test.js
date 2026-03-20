import test from "node:test";
import assert from "node:assert/strict";
import {
  assertReadSafeSql,
  assertWriteSafeSql,
  inspectSqlSafety,
  inspectWriteSafety
} from "../src/lib/sql-guard.js";

test("sql guard allows plain select", () => {
  const result = inspectSqlSafety("SELECT id, name FROM dbo.Users");
  assert.equal(result.allowed, true);
});

test("sql guard allows read-only cte", () => {
  const result = inspectSqlSafety(`
    WITH latest AS (
      SELECT TOP 10 id FROM dbo.Users
    )
    SELECT * FROM latest
  `);

  assert.equal(result.allowed, true);
});

test("sql guard allows sql server cte with leading semicolon", () => {
  const result = inspectSqlSafety(`
    ;WITH latest AS (
      SELECT TOP 10 id FROM dbo.Users
    )
    SELECT * FROM latest;
  `);

  assert.equal(result.allowed, true);
});

test("assertReadSafeSql preserves string literals for execution", () => {
  const sql = "SELECT * FROM dbo.Users WHERE status = 'OPEN'";
  assert.equal(assertReadSafeSql(sql), sql);
});

test("sql guard rejects write keywords", () => {
  const result = inspectSqlSafety("UPDATE dbo.Users SET name = 'x'");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /Only SELECT|Forbidden SQL keyword/i);
});

test("sql guard rejects select into", () => {
  const result = inspectSqlSafety("SELECT * INTO #tmp FROM dbo.Users");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /INTO/i);
});

test("sql guard rejects multiple statements", () => {
  const result = inspectSqlSafety("SELECT 1; SELECT 2");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /Multiple SQL statements/i);
});

test("write guard allows update statements", () => {
  const sql = "UPDATE dbo.Users SET status = 'OPEN' WHERE id = 1";
  const result = inspectWriteSafety(sql);
  assert.equal(result.allowed, true);
  assert.equal(assertWriteSafeSql(sql), sql);
});

test("write guard rejects ddl and exec", () => {
  const ddl = inspectWriteSafety("DROP TABLE dbo.Users");
  assert.equal(ddl.allowed, false);
  assert.match(ddl.reason, /Only INSERT|Forbidden SQL keyword/i);

  const exec = inspectWriteSafety("EXEC dbo.DoThing");
  assert.equal(exec.allowed, false);
  assert.match(exec.reason, /Only INSERT|Forbidden SQL keyword/i);
});

test("write guard rejects multiple statements and select into", () => {
  const multi = inspectWriteSafety("UPDATE dbo.Users SET status = 'OPEN'; DELETE FROM dbo.Users");
  assert.equal(multi.allowed, false);
  assert.match(multi.reason, /Multiple SQL statements/i);

  const selectInto = inspectWriteSafety("WITH x AS (SELECT 1 AS id) SELECT * INTO #tmp FROM x");
  assert.equal(selectInto.allowed, false);
  assert.match(selectInto.reason, /SELECT INTO|Write CTEs must resolve/i);
});

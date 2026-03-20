import test from "node:test";
import assert from "node:assert/strict";
import { inspectSqlSafety } from "../src/lib/sql-guard.js";

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

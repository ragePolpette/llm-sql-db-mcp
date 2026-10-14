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

test("sql guard allows forbidden keywords inside string literals and comments", () => {
  const result = inspectSqlSafety(`
    SELECT 'DROP TABLE dbo.Users' AS command_text
    -- EXEC dbo.DoThing
    FROM dbo.Users
  `);

  assert.equal(result.allowed, true);
});

test("sql guard allows bracketed or quoted identifiers named like forbidden keywords", () => {
  const bracketed = inspectSqlSafety('SELECT [EXEC], [INTO] FROM dbo.Users');
  assert.equal(bracketed.allowed, true);

  const quoted = inspectSqlSafety('SELECT "UPDATE", "DELETE" FROM dbo.Users');
  assert.equal(quoted.allowed, true);
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

test("write guard allows quoted identifiers and string literals with forbidden keywords", () => {
  const bracketed = inspectWriteSafety("UPDATE dbo.Users SET [EXEC] = 'DROP TABLE' WHERE id = 1");
  assert.equal(bracketed.allowed, true);

  const quoted = inspectWriteSafety('UPDATE dbo.Users SET "ALTER" = \'CREATE TABLE\' WHERE id = 1');
  assert.equal(quoted.allowed, true);
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

test("sql guard still rejects hidden second statements after comments", () => {
  const result = inspectSqlSafety(`
    SELECT 1;
    -- harmless comment
    DELETE FROM dbo.Users
  `);

  assert.equal(result.allowed, false);
  assert.match(result.reason, /Multiple SQL statements/i);
});

test("sql guard rejects a second statement hidden behind a comment marker inside a string", () => {
  const result = inspectSqlSafety("SELECT '--'; DROP TABLE t");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /Multiple SQL statements/i);
});

test("sql guard rejects a second statement hidden behind an apostrophe inside a bracketed identifier", () => {
  const result = inspectSqlSafety("SELECT 1 AS [a']; DROP TABLE t; SELECT ']'");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /Multiple SQL statements/i);
});

test("sql guard rejects bypass variants built on quoting and comments", () => {
  const cases = [
    "SELECT '/*'; DROP TABLE t; SELECT '*/'",
    "SELECT \"a'\"; DROP TABLE t; SELECT '\"'",
    "SELECT 1 /* ' */; DELETE FROM t",
    "SELECT 'it''s'; DELETE FROM t",
    "SELECT [a]]';]; DELETE FROM t",
    "SELECT N'--'; DROP TABLE t",
    "SELECT 1 /* outer /* inner */ still comment */; UPDATE t SET a = 1",
    "SELECT 1\nGO\nDROP TABLE t",
    "SELECT 1 SELECT 2",
    "SELECT * FROM t WHERE id IN (1) SELECT * FROM u",
    "WITH x AS (SELECT 1 AS a) SELECT * FROM x SELECT 2",
    "SELECT 1 WAITFOR DELAY '00:01'",
    "SELECT * FROM OPENROWSET('SQLNCLI', 'Server=x;', 'SELECT 1')",
    "SELECT 1 DECLARE @x int",
    "SELECT 1 USE master",
    "SELECT 1; USE master"
  ];

  for (const sql of cases) {
    assert.equal(inspectSqlSafety(sql).allowed, false, sql);
  }
});

test("sql guard rejects unterminated literals, identifiers and comments", () => {
  for (const sql of ["SELECT 'abc", "SELECT [abc", "SELECT \"abc", "SELECT 1 /* open", "SELECT (1"]) {
    const result = inspectSqlSafety(sql);
    assert.equal(result.allowed, false, sql);
    assert.match(result.reason, /Unterminated|Unbalanced/i);
  }
});

test("sql guard rejects the GO batch separator", () => {
  const result = inspectSqlSafety("SELECT 1\nGO\nSELECT 2");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /GO/);
});

test("sql guard accepts legitimate queries with tricky quoting", () => {
  const cases = [
    "SELECT '--not a comment' AS a FROM dbo.t",
    "SELECT 'a;b' AS a, [c;d] AS b FROM dbo.t",
    "/* SELECT 'x'; DROP TABLE t; */ SELECT 1",
    "-- leading comment with ' apostrophe\nSELECT 1",
    "SELECT [a'b] FROM dbo.[weird ]] name]",
    "SELECT N'Città più bella' AS città FROM dbo.Comuni WHERE nome = N'Forlì'",
    "SELECT 'it''s fine' AS a",
    "SELECT \"quoted;identifier\" FROM dbo.t;",
    "WITH a AS (SELECT 1 AS id), b (id) AS (SELECT id FROM a) SELECT * FROM b",
    "SELECT * FROM dbo.t WHERE id IN (SELECT id FROM dbo.u WHERE x = 'y') AND EXISTS (SELECT 1 FROM dbo.v)",
    "SELECT id FROM dbo.a UNION ALL SELECT id FROM dbo.b EXCEPT SELECT id FROM dbo.c",
    "SELECT id FROM dbo.t WITH (NOLOCK) ORDER BY id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY",
    "SELECT x.* FROM (SELECT TOP 5 id FROM dbo.t) AS x",
    "SELECT @p AS value, #tmp_name = 1",
    "SELECT id FROM dbo.t OPTION (USE HINT ('FORCE_LEGACY_CARDINALITY_ESTIMATION'))",
    "SELECT id FROM dbo.t OPTION (MAXDOP 1, USE HINT ('DISABLE_OPTIMIZER_ROWGOAL'))"
  ];

  for (const sql of cases) {
    const result = inspectSqlSafety(sql);
    assert.equal(result.allowed, true, `${sql}: ${result.reason}`);
  }
});

test("sql guard masks literals and identifiers in normalizedSql", () => {
  const result = inspectSqlSafety("SELECT 'DROP' AS [EXEC] FROM t -- trailing");
  assert.equal(result.normalizedSql, "SELECT '' AS [] FROM t");
});

test("write guard rejects multi-statement batches and statements hidden in quoting", () => {
  const cases = [
    "UPDATE t SET a = '--'; DROP TABLE t",
    "UPDATE t SET [a'] = 1; DELETE FROM t; SELECT ']'",
    "UPDATE t SET a = 1 DELETE FROM t",
    "UPDATE t SET a = 1 SET b = 2",
    "INSERT INTO t VALUES (1) SELECT * FROM secrets",
    "INSERT INTO t SELECT 1 SELECT 2",
    "DELETE FROM t SELECT * FROM t",
    "UPDATE t SET a = 1\nGO\nDROP TABLE t",
    "INSERT INTO t SELECT a INTO #copy FROM u",
    "UPDATE STATISTICS dbo.t",
    "UPDATE dbo.t SET a = 1 USE master"
  ];

  for (const sql of cases) {
    assert.equal(inspectWriteSafety(sql).allowed, false, sql);
  }
});

test("write guard accepts single DML statements with subqueries, OUTPUT and MERGE", () => {
  const cases = [
    "INSERT INTO dbo.t (a, b) SELECT a, b FROM dbo.s UNION ALL SELECT a, b FROM dbo.s2",
    "INSERT dbo.t (a) VALUES (1), (2);",
    "UPDATE dbo.t SET a = (SELECT MAX(a) FROM dbo.s) OUTPUT inserted.id WHERE id IN (SELECT id FROM dbo.u)",
    "DELETE FROM dbo.t OUTPUT deleted.id INTO dbo.audit (id) WHERE id = 1",
    "WITH x AS (SELECT id FROM dbo.t WHERE a = 1) DELETE FROM x",
    "MERGE INTO dbo.t AS tgt USING (SELECT id, a FROM dbo.s) AS src ON tgt.id = src.id " +
      "WHEN MATCHED THEN UPDATE SET a = src.a WHEN NOT MATCHED THEN INSERT (id, a) VALUES (src.id, src.a) " +
      "WHEN NOT MATCHED BY SOURCE THEN DELETE;"
  ];

  for (const sql of cases) {
    const result = inspectWriteSafety(sql);
    assert.equal(result.allowed, true, `${sql}: ${result.reason}`);
  }
});

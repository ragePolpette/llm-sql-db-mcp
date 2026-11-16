import test from "node:test";
import assert from "node:assert/strict";
import { assertDdlSafeSql, inspectDdlSafety } from "../src/lib/sql-guard.js";

const ALLOWED = [
  "CREATE TABLE dbo.Fat_Prova (Id INT IDENTITY(1,1) PRIMARY KEY, Nome NVARCHAR(100) NOT NULL DEFAULT ('x'))",
  "create table [dbo].[Fat_Prova] (id int)",
  "CREATE TABLE dbo.Fat_Prova (id int);",
  "CREATE TABLE dbo.t (n nvarchar(10) DEFAULT 'DROP TABLE x') -- commento con EXEC",
  "CREATE TABLE dbo.t (id int) /* INSERT INTO */ ON [PRIMARY]",
  "ALTER TABLE dbo.Fat_Prova ADD Note NVARCHAR(200) NULL",
  "ALTER TABLE dbo.Fat_Prova ADD A INT NULL, B INT NULL",
  "ALTER TABLE dbo.Fat_Prova ALTER COLUMN Note NVARCHAR(400) NULL",
  "ALTER TABLE [dbo].[Fat_Prova] ADD CONSTRAINT PK_Fat_Prova PRIMARY KEY (Id)",
  "ALTER TABLE dbo.Fat_Prova ADD CONSTRAINT CK_x CHECK (Id > 0)"
];

const REJECTED = [
  ["", /required/i],
  ["SELECT 1", /Only CREATE TABLE or ALTER TABLE/i],
  ["INSERT INTO dbo.t VALUES (1)", /Only CREATE TABLE or ALTER TABLE/i],
  ["DROP TABLE dbo.t", /Only CREATE TABLE or ALTER TABLE/i],
  ["TRUNCATE TABLE dbo.t", /Only CREATE TABLE or ALTER TABLE/i],
  ["CREATE VIEW dbo.v AS SELECT 1", /Only CREATE TABLE or ALTER TABLE/i],
  ["CREATE PROCEDURE dbo.p AS SELECT 1", /Only CREATE TABLE or ALTER TABLE/i],
  ["CREATE INDEX ix ON dbo.t (id)", /Only CREATE TABLE or ALTER TABLE/i],
  ["CREATE TABLE Fat_Prova (id int)", /explicit.*dbo/i],
  ["CREATE TABLE sch.t (id int)", /schema must be dbo/i],
  ["CREATE TABLE db.dbo.t (id int)", /Multi-part/i],
  ["CREATE TABLE dbo.#t (id int)", /Temporary/i],
  ["CREATE TABLE #t (id int)", /explicit.*dbo/i],
  ["CREATE TABLE dbo.t", /column list/i],
  ["CREATE TABLE dbo.t (id int); DROP TABLE dbo.x", /Multiple SQL statements/i],
  ["CREATE TABLE dbo.a (id int) CREATE TABLE dbo.b (id int)", /Forbidden SQL keyword detected: CREATE/i],
  ["CREATE TABLE dbo.t (id int) INSERT INTO dbo.t VALUES (1)", /Forbidden SQL keyword detected: INSERT/i],
  ["CREATE TABLE dbo.t (id int) EXEC xp_cmdshell 'dir'", /Forbidden SQL keyword detected: EXEC/i],
  ["CREATE TABLE dbo.t (id int) GO", /Batch separator GO/i],
  ["CREATE TABLE dbo.t (id int) DROP TABLE dbo.x", /Forbidden SQL keyword detected: DROP/i],
  ["CREATE TABLE dbo.t (id int) SET IDENTITY_INSERT dbo.t ON", /Forbidden SQL keyword detected: SET/i],
  ["CREATE TABLE dbo.t (id int, x int REFERENCES dbo.u (id))", /Forbidden SQL keyword detected: REFERENCES/i],
  ["CREATE TABLE dbo.t (id int, FOREIGN KEY (id) REFERENCES dbo.u (id))", /Forbidden SQL keyword detected: FOREIGN/i],
  ["CREATE TABLE dbo.t (id int", /Unbalanced/i],
  ["CREATE TABLE dbo.t (n nvarchar(10) DEFAULT 'abc)", /Unterminated/i],
  ["ALTER TABLE dbo.t DROP COLUMN c", /Forbidden SQL keyword detected: DROP/i],
  ["ALTER TABLE dbo.t ADD c int FOREIGN KEY REFERENCES dbo.u (id)", /Forbidden SQL keyword detected: FOREIGN/i],
  ["ALTER TABLE dbo.t NOCHECK CONSTRAINT ALL", /ADD or ALTER COLUMN/i],
  ["ALTER TABLE dbo.t REBUILD", /ADD or ALTER COLUMN/i],
  ["ALTER TABLE dbo.t ALTER COLUMN c int ALTER TABLE dbo.u ADD d int", /Forbidden SQL keyword detected: ALTER/i],
  ["ALTER TABLE dbo.t ADD c int ALTER TABLE dbo.u ADD d int", /Forbidden SQL keyword detected: ALTER/i],
  ["ALTER TABLE dbo.t ALTER INDEX ix REBUILD", /Forbidden SQL keyword detected: ALTER/i],
  ["ALTER TABLE dbo.t ADD c int SELECT 1", /Forbidden SQL keyword detected: SELECT/i],
  ["CREATE TABLE dbo.t (id int) ADD SIGNATURE TO dbo.p BY CERTIFICATE c", /Forbidden SQL keyword detected: SIGNATURE/i]
];

for (const sql of ALLOWED) {
  test(`inspectDdlSafety allows: ${sql}`, () => {
    const inspection = inspectDdlSafety(sql);
    assert.equal(inspection.allowed, true, inspection.reason ?? "");
    assert.equal(inspection.reason, null);
    assert.equal(typeof inspection.normalizedSql, "string");
    assert.equal(assertDdlSafeSql(sql), sql.trim());
  });
}

for (const [sql, reason] of REJECTED) {
  test(`inspectDdlSafety rejects: ${sql || "(empty)"}`, () => {
    const inspection = inspectDdlSafety(sql);
    assert.equal(inspection.allowed, false);
    assert.match(inspection.reason, reason);
    assert.throws(() => assertDdlSafeSql(sql), reason);
  });
}

test("inspectDdlSafety masks literals and quoted identifiers in normalizedSql", () => {
  const { normalizedSql } = inspectDdlSafety("CREATE TABLE [dbo].[Segreta] (c nvarchar(5) DEFAULT 'pwd')");
  assert.equal(normalizedSql.includes("pwd"), false);
  assert.equal(normalizedSql.includes("Segreta"), false);
});

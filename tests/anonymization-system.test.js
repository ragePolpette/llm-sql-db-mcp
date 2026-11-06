import test from "node:test";
import assert from "node:assert/strict";
import { anonymizeRows } from "../src/lib/anonymizer.js";
import { isSystemMetadataQuery, isSystemOrigin } from "../src/lib/anonymization/system-objects.js";

const CFG = {
  provider: "none",
  mode: "deterministic",
  fieldIdentification: "heuristic",
  hashSalt: "Super-Secret-Hash-Salt-123!",
  failOpen: false,
  timeoutMs: 5000,
  model: "",
  baseUrl: ""
};

test("queries that only read system metadata are recognized", () => {
  for (const sql of [
    "SELECT name, type_desc FROM sys.tables",
    "SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'Aziende'",
    "SELECT * FROM [INFORMATION_SCHEMA].[TABLES]",
    "SELECT t.name, c.name FROM sys.tables t JOIN sys.columns c ON c.object_id = t.object_id",
    "SELECT t.name FROM sys.tables t, sys.schemas s WHERE s.schema_id = t.schema_id",
    "SELECT name FROM msdb.dbo.sysjobs",
    "SELECT name FROM msdb..sysjobs",
    "SELECT name FROM bpopilot.sys.tables",
    "SELECT OBJECT_NAME(object_id), name FROM sys.columns",
    "SELECT name FROM sys.tables WHERE object_id IN (SELECT object_id FROM sys.columns WHERE name = 'cognome')",
    "SELECT name FROM sys.tables WITH (NOLOCK) ORDER BY name, create_date",
    "SELECT definition FROM sys.sql_modules WHERE object_id = OBJECT_ID('dbo.SP_x')"
  ]) {
    assert.equal(isSystemMetadataQuery(sql), true, sql);
  }
});

test("any user object, unknown name or data-carrying system object disables the system rule", () => {
  for (const sql of [
    "SELECT t.name FROM sys.tables t, Aziende",
    "SELECT t.name FROM sys.tables t, dbo.Aziende a",
    "SELECT t.name FROM sys.tables t JOIN dbo.Aziende a ON 1 = 1",
    "SELECT t.name FROM sys.tables t CROSS APPLY dbo.fn_x(t.object_id) f",
    "SELECT dbo.fn_cognome(name) FROM sys.tables",
    "SELECT bpopilot.dbo.fn_cognome(name) FROM sys.tables",
    "SELECT (SELECT TOP 1 cognome FROM Aziende) AS x FROM sys.tables",
    "SELECT t.name FROM sys.tables t, (SELECT cognome FROM dbo.Aziende) x",
    "SELECT name FROM sys.tables UNION SELECT cognome FROM dbo.Aziende",
    "SELECT r.session_id, s.text FROM sys.dm_exec_requests r CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) s",
    "SELECT body FROM msdb.dbo.sysmail_allitems",
    "SELECT message FROM msdb.dbo.sysjobhistory",
    "WITH c AS (SELECT name FROM sys.tables) SELECT name FROM c",
    "SELECT * FROM #tmp",
    "SELECT * FROM @t",
    "SELECT 1 AS x",
    "SELECT 'unterminated"
  ]) {
    assert.equal(isSystemMetadataQuery(sql), false, sql);
  }
});

test("system origins are recognized, data-carrying system objects are not", () => {
  assert.equal(isSystemOrigin({ schema: "sys", table: "tables", column: "name" }), true);
  assert.equal(isSystemOrigin({ schema: "INFORMATION_SCHEMA", table: "COLUMNS", column: "COLUMN_NAME" }), true);
  assert.equal(isSystemOrigin({ database: "msdb", schema: "dbo", table: "sysjobs", column: "name" }), true);
  assert.equal(isSystemOrigin({ database: "msdb", schema: "dbo", table: "sysmail_allitems", column: "body" }), false);
  assert.equal(isSystemOrigin({ schema: "sys", table: "dm_exec_sql_text", column: "text" }), false);
  assert.equal(isSystemOrigin({ schema: "dbo", table: "Aziende", column: "cognome" }), false);
  assert.equal(isSystemOrigin(null), false);
});

test("system metadata stays in clear, the value floor still applies", async () => {
  let report;
  const rows = await anonymizeRows(
    [
      { name: "Aziende", type_desc: "USER_TABLE", schema_name: "dbo" },
      { name: "mario.rossi@example.com", type_desc: "USER_TABLE", schema_name: "dbo" }
    ],
    CFG,
    {
      sqlText: "SELECT t.name, t.type_desc, s.name AS schema_name FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id",
      columnOrigins: { name: null, type_desc: null, schema_name: null },
      onReport: r => { report = r; }
    }
  );
  assert.deepEqual(rows[0], { name: "Aziende", type_desc: "USER_TABLE", schema_name: "dbo" });
  assert.match(rows[1].name, /@example\.invalid$/);
  assert.ok(report.by_reason["safe:system-query"] >= 5);
});

test("in a mixed query only the columns coming from system objects stay in clear", async () => {
  const [row] = await anonymizeRows([{ name: "Aziende", cognome: "Rossi", calc: "Rossi" }], CFG, {
    sqlText: "SELECT t.name, a.cognome, UPPER(a.cognome) AS calc FROM sys.tables t CROSS JOIN dbo.Aziende a",
    columnOrigins: {
      name: { database: "bpopilot", schema: "sys", table: "tables", column: "name" },
      cognome: { database: "bpopilot", schema: "dbo", table: "Aziende", column: "cognome" },
      calc: null
    }
  });
  assert.equal(row.name, "Aziende");
  assert.match(row.cognome, /^NAME_/);
  assert.notEqual(row.calc, "Rossi");
});

test("text from data-carrying system objects stays masked", async () => {
  const [row] = await anonymizeRows([{ text: "SELECT * FROM dbo.Aziende WHERE cognome = 'Rossi'" }], CFG, {
    sqlText: "SELECT s.text FROM sys.dm_exec_requests r CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) s",
    columnOrigins: { text: { database: "bpopilot", schema: "sys", table: "dm_exec_sql_text", column: "text" } }
  });
  assert.match(row.text, /^TEXT_/);
});

test("numeric SQL columns are kept whatever their JSON form, text columns are not", async () => {
  let report;
  const [row] = await anonymizeRows(
    [{ codice_big: "9007199254740993", importo: "12.50", cognome: "Rossi", flag: true }],
    CFG,
    {
      sqlText: "SELECT CAST(Codice AS bigint) AS codice_big, importo, cognome, flag FROM dbo.t",
      columnOrigins: { codice_big: null, importo: null, cognome: { schema: "dbo", table: "t", column: "cognome" }, flag: null },
      columnTypes: { codice_big: "BigInt", importo: "Decimal", cognome: "NVarChar", flag: "Bit" },
      onReport: r => { report = r; }
    }
  );
  assert.equal(row.codice_big, "9007199254740993");
  assert.equal(row.importo, "12.50");
  assert.equal(row.flag, true);
  assert.match(row.cognome, /^NAME_/);
  assert.equal(report.by_reason["kept:numeric-type"], 3);
});

test("a numeric type claimed for a text column is not trusted without the type map", async () => {
  const [row] = await anonymizeRows([{ codice_big: "Mario Rossi" }], CFG, {
    sqlText: "SELECT cognome AS codice_big FROM dbo.t",
    columnOrigins: { codice_big: null }
  });
  assert.notEqual(row.codice_big, "Mario Rossi");
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { anonymizeRows } from "../src/lib/anonymizer.js";
import { createCatalog, isEnumEvidence } from "../src/lib/anonymization/catalog.js";
import { runCli } from "../src/cli/anon-catalog.js";

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

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "anon-catalog-")), "catalog.json");
}

function origins(column, table = "t") {
  return { [column]: { schema: "dbo", table, column } };
}

async function run(catalog, rows, column, { targetId = "prod-main", table = "t" } = {}) {
  let report;
  const out = await anonymizeRows(rows, CFG, {
    sqlText: `SELECT ${column} FROM dbo.${table}`,
    columnOrigins: origins(column, table),
    catalog,
    targetId,
    onReport: r => { report = r; }
  });
  catalog.flush({ force: true });
  return { out, report };
}

const ENUM_ROWS = Array.from({ length: 12 }, (_, i) => ({ xq: ["ATTIVO", "CHIUSO", "APERTO"][i % 3] }));

function memoryNow() {
  let t = 1_000_000;
  return () => (t += 5000);
}

test("an unknown enum column is masked at first, then auto-promoted to safe from repeated evidence", async () => {
  const catalog = createCatalog({ filePath: tempFile(), now: memoryNow() });

  for (let i = 0; i < 3; i += 1) {
    const { out } = await run(catalog, ENUM_ROWS, "xq");
    assert.match(out[0].xq, /^TEXT_/, `use ${i + 1} is still masked`);
  }

  const { out, report } = await run(catalog, ENUM_ROWS, "xq");
  assert.equal(out[0].xq, "ATTIVO");
  assert.equal(report.by_reason["catalog:auto-safe"], 12);

  const stored = JSON.parse(fs.readFileSync(catalog.filePath, "utf8"));
  assert.equal(stored.targets["prod-main"]["dbo.t.xq"].status, "auto-safe");
  assert.equal(stored.targets["prod-main"]["dbo.t.xq"].reason, "enum-evidence");
});

test("the catalog file never contains raw values", async () => {
  const catalog = createCatalog({ filePath: tempFile(), now: memoryNow() });
  await run(catalog, ENUM_ROWS, "xq");
  await run(catalog, [{ email: "mario.rossi@x.it" }], "email");
  const raw = fs.readFileSync(catalog.filePath, "utf8");
  assert.equal(raw.includes("ATTIVO"), false);
  assert.equal(raw.includes("mario.rossi"), false);
  assert.equal(fs.statSync(catalog.filePath).mode & 0o077, 0, "file is not group/world accessible");
});

test("Title Case values never auto-promote, so people-like columns stay masked", async () => {
  const catalog = createCatalog({ filePath: tempFile(), now: memoryNow() });
  const rows = Array.from({ length: 12 }, (_, i) => ({ xq: ["Rossi", "Bianchi", "Verdi"][i % 3] }));
  for (let i = 0; i < 5; i += 1) {
    const { out } = await run(catalog, rows, "xq");
    assert.match(out[0].xq, /^TEXT_/);
  }
  const stored = JSON.parse(fs.readFileSync(catalog.filePath, "utf8"));
  assert.equal(stored.targets["prod-main"]["dbo.t.xq"].status, "pending");
});

test("auto-safe is per target: evidence from one target is not applied to another", async () => {
  const catalog = createCatalog({ filePath: tempFile(), now: memoryNow() });
  for (let i = 0; i < 4; i += 1) await run(catalog, ENUM_ROWS, "xq", { targetId: "dev-main" });
  assert.equal((await run(catalog, ENUM_ROWS, "xq", { targetId: "dev-main" })).out[0].xq, "ATTIVO");
  assert.match((await run(catalog, ENUM_ROWS, "xq", { targetId: "prod-main" })).out[0].xq, /^TEXT_/);
});

test("an auto-safe column is not trusted for a result that contains name-like or PII values", async () => {
  const catalog = createCatalog({ filePath: tempFile(), now: memoryNow() });
  for (let i = 0; i < 4; i += 1) await run(catalog, ENUM_ROWS, "xq");

  const { out } = await run(catalog, [{ xq: "ATTIVO" }, { xq: "Mario Rossi" }], "xq");
  assert.match(out[0].xq, /^TEXT_/);
  assert.match(out[1].xq, /^TEXT_/);

  const stored = JSON.parse(fs.readFileSync(catalog.filePath, "utf8"));
  assert.equal(stored.targets["prod-main"]["dbo.t.xq"].status, "pending");
});

test("human verdicts override heuristics, apply to every target, and ignore computed columns", async () => {
  const file = tempFile();
  const catalog = createCatalog({ filePath: file, now: memoryNow() });
  let stderr = "";
  const io = { env: {}, stdout: { write() {} }, stderr: { write: m => { stderr += m; } } };
  assert.equal(runCli(["set", "dbo.t.nome_file", "safe", "--file", file], io), 0);
  assert.equal(runCli(["set", "dbo.t.xq", "sensitive", "--kind", "name", "--file", file], io), 0);
  assert.equal(stderr, "");

  const safe = await run(catalog, [{ nome_file: "report.pdf" }], "nome_file", { targetId: "any-target" });
  assert.equal(safe.out[0].nome_file, "report.pdf", "human-safe beats the name heuristic");
  assert.equal(safe.report.by_reason["catalog:human-safe"], 1);

  const sensitive = await run(catalog, [{ xq: "whatever" }], "xq", { targetId: "other-target" });
  assert.match(sensitive.out[0].xq, /^NAME_/);

  const [derived] = await anonymizeRows([{ nome_file: "Rossi" }], CFG, {
    sqlText: "SELECT cognome AS nome_file FROM dbo.t",
    columnOrigins: { nome_file: null },
    catalog,
    targetId: "any-target"
  });
  assert.notEqual(derived.nome_file, "Rossi", "human-safe never applies to computed columns");
});

test("the server picks up CLI edits made while it is running", async () => {
  const file = tempFile();
  const catalog = createCatalog({ filePath: file, now: memoryNow() });
  const first = await run(catalog, [{ xq: "abc def" }], "xq");
  assert.match(first.out[0].xq, /^TEXT_/);

  runCli(["set", "dbo.t.xq", "safe", "--file", file], { env: {}, stdout: { write() {} }, stderr: { write() {} } });
  const second = await run(catalog, [{ xq: "abc def" }], "xq");
  assert.equal(second.out[0].xq, "abc def");
});

test("a broken catalog file never breaks anonymization", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anon-catalog-"));
  const catalog = createCatalog({ filePath: dir }); // a directory, not a file
  const { out } = await run(catalog, [{ email: "a@b.it" }], "email");
  assert.match(out[0].email, /@example\.invalid$/);
});

test("without column origins the catalog is not consulted or written", async () => {
  const file = tempFile();
  const catalog = createCatalog({ filePath: file });
  await anonymizeRows([{ xq: "abc" }], CFG, { sqlText: "SELECT xq FROM t", catalog, targetId: "prod-main" });
  assert.equal(fs.existsSync(file), false);
});

test("isEnumEvidence requires repeated, short, non-name, non-PII values", () => {
  const base = { uses: 3, cells: 30, distinct: ["a", "b", "c"], max_len: 8, pii: false, titlecase: false, overflow: false };
  assert.equal(isEnumEvidence(base), true);
  assert.equal(isEnumEvidence({ ...base, uses: 2 }), false);
  assert.equal(isEnumEvidence({ ...base, cells: 20 }), false);
  assert.equal(isEnumEvidence({ ...base, titlecase: true }), false);
  assert.equal(isEnumEvidence({ ...base, pii: true }), false);
  assert.equal(isEnumEvidence({ ...base, overflow: true }), false);
  assert.equal(isEnumEvidence({ ...base, distinct: Array.from({ length: 12 }, (_, i) => String(i)) }), false);
});

test("CLI list shows pending columns most used first and rejects bad input", async () => {
  const file = tempFile();
  const catalog = createCatalog({ filePath: file, now: memoryNow() });
  await run(catalog, [{ aaa: "x y" }], "aaa");
  await run(catalog, [{ bbb: "x y" }], "bbb");
  await run(catalog, [{ bbb: "x y" }], "bbb");

  let out = "";
  let err = "";
  const io = { env: {}, stdout: { write: m => { out += m; } }, stderr: { write: m => { err += m; } } };
  assert.equal(runCli(["list", "--file", file], io), 0);
  const lines = out.trim().split("\n");
  assert.match(lines[1], /dbo\.t\.bbb/);
  assert.match(lines[2], /dbo\.t\.aaa/);

  assert.equal(runCli(["set", "dbo.t.x", "sensitive", "--file", file], io), 2);
  assert.equal(runCli(["list"], io), 2);
  assert.match(err, /--kind/);
  assert.match(err, /No catalog file/);
});

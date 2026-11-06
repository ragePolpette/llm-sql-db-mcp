import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROMPT_VERSION,
  acceptProposals,
  buildPrompts,
  classifyTables,
  decide,
  decideByRules,
  evaluateDecisions,
  groupSchema,
  loadProposals,
  proposalsPathFor,
  recordProposals,
  rejectProposals,
  validateAnswer
} from "../src/lib/anonymization/classifier.js";
import { loadCatalogFile, saveCatalogFile } from "../src/lib/anonymization/catalog.js";
import { runClassifyCli } from "../src/cli/anon-classify.js";

const SCHEMA_ROWS = [
  ["dbo", "Clienti", "U", "Id", "int"],
  ["dbo", "Clienti", "U", "Cognome", "nvarchar"],
  ["dbo", "Clienti", "U", "DataCreazione", "datetime"],
  ["dbo", "Clienti", "U", "DataNascita", "date"],
  ["dbo", "Clienti", "U", "NomeFile", "nvarchar"],
  ["dbo", "Clienti", "U", "CodiceInterno", "nvarchar"],
  ["dbo", "Clienti", "U", "Annotazioni", "nvarchar"],
  ["dbo", "Clienti", "U", "TokenAccesso", "nvarchar"]
].map(([schema_name, table_name, object_type, column_name, type_name], index) => ({
  schema_name, table_name, object_type, column_name, type_name, max_length: 100, column_id: index + 1
}));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "anon-classify-"));
}

function answer(columns) {
  return JSON.stringify({ columns });
}

function signals(overrides) {
  return { person_names: 0, contact_info: 0, free_text_personal: 0, credential: 0, technical_code: 0, kind: "unclear", reason: "r", ...overrides };
}

function modelFetch(columns, calls = []) {
  return async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, async json() { return { message: { content: answer(columns) } }; } };
  };
}

const MODEL_ANSWER = {
  CodiceInterno: signals({ technical_code: 0.97, kind: "technical" }),
  Annotazioni: signals({ free_text_personal: 0.8, kind: "text" }),
  TokenAccesso: signals({ credential: 0.9, kind: "credential" })
};

test("rules decide dates, birth dates, file names, system objects and recognized names", () => {
  const table = { schema: "dbo", table: "Clienti", columns: [] };
  assert.equal(decideByRules(table, { name: "DataCreazione", type: "datetime" }).status, "proposed-safe");
  assert.deepEqual(
    [decideByRules(table, { name: "DataNascita", type: "date" }).status, decideByRules(table, { name: "DataNascita", type: "date" }).kind],
    ["proposed-sensitive", "date"]
  );
  assert.equal(decideByRules(table, { name: "NomeFile", type: "nvarchar" }).source, "rule:file-name");
  assert.equal(decideByRules(table, { name: "Cognome", type: "nvarchar" }).kind, "name");
  assert.equal(decideByRules({ schema: "sys", table: "tables" }, { name: "name", type: "sysname" }).status, "proposed-safe");
  assert.equal(decideByRules(table, { name: "CodiceInterno", type: "nvarchar" }), null);
});

test("the prompt carries metadata only", () => {
  const [table] = groupSchema(SCHEMA_ROWS);
  const { userPrompt } = buildPrompts(table, [{ name: "Annotazioni" }]);
  const payload = JSON.parse(userPrompt);
  assert.equal(payload.table, "dbo.Clienti");
  assert.deepEqual(payload.classify, ["Annotazioni"]);
  assert.deepEqual(Object.keys(payload.all_columns[0]), ["name", "type"]);
});

test("model answers are validated strictly", () => {
  const candidates = [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }];
  const result = validateAnswer(
    answer({ a: signals({ kind: "technical", technical_code: 1 }), B: signals({ kind: "invented" }), C: signals({ person_names: 3 }), X: signals({}) }),
    candidates
  );
  assert.equal(result.get("A").kind, "technical", "names match case-insensitively");
  assert.equal(result.get("B"), null, "unknown kind");
  assert.equal(result.get("C"), null, "probability out of range");
  assert.equal(result.get("D"), null, "missing column");
  assert.equal(result.has("X"), false, "columns not asked for are ignored");
  assert.throws(() => validateAnswer("not json", candidates));
});

test("the decision policy is asymmetric and lives in code", () => {
  const d = s => decide({ signals: signals(s), kind: s.kind ?? "unclear", reason: "r" });
  assert.deepEqual([d({ credential: 0.6 }).status, d({ credential: 0.6 }).kind], ["proposed-sensitive", "text"]);
  assert.equal(d({ person_names: 0.7 }).kind, "name");
  assert.equal(d({ person_names: 0.7, kind: "org" }).kind, "org");
  assert.equal(d({ contact_info: 0.7, kind: "phone" }).kind, "phone");
  assert.equal(d({ free_text_personal: 0.6 }).kind, "text");
  assert.equal(d({ kind: "org" }).status, "proposed-sensitive");
  assert.equal(d({ technical_code: 0.95, kind: "technical" }).status, "proposed-safe");
  assert.equal(d({ technical_code: 0.95, person_names: 0.2, kind: "technical" }).status, "review", "a personal signal blocks safe");
  assert.equal(d({ technical_code: 0.8, kind: "technical" }).status, "review", "not confident enough for safe");
  assert.equal(decide(null).status, "review");
});

test("classifyTables combines rules and model, skips reviewed and unchanged columns", async () => {
  const tables = groupSchema(SCHEMA_ROWS);
  const calls = [];
  const result = await classifyTables({
    tables,
    human: { "dbo.clienti.datacreazione": { verdict: "safe" } },
    model: "m",
    baseUrl: "http://127.0.0.1:11434",
    fetchImpl: modelFetch(MODEL_ANSWER, calls)
  });
  const byKey = Object.fromEntries(result.decisions.map(d => [d.key, d]));
  assert.equal(byKey["dbo.clienti.datacreazione"], undefined, "human verdict wins");
  assert.equal(byKey["dbo.clienti.id"], undefined, "numeric columns are not classified");
  assert.equal(byKey["dbo.clienti.cognome"].source, "rule:heuristic-name");
  assert.equal(byKey["dbo.clienti.codiceinterno"].status, "proposed-safe");
  assert.equal(byKey["dbo.clienti.annotazioni"].status, "proposed-sensitive");
  assert.equal(byKey["dbo.clienti.tokenaccesso"].kind, "text");
  assert.equal(calls.length, 1, "one batch for the table");
  assert.deepEqual(JSON.parse(calls[0].messages[1].content).classify.sort(), ["Annotazioni", "CodiceInterno", "TokenAccesso"]);

  const existing = Object.fromEntries(result.decisions.map(d => [d.key, { input_hash: d.input_hash }]));
  const human = { "dbo.clienti.datacreazione": { verdict: "safe" } };
  const again = await classifyTables({ tables, human, existing, model: "m", baseUrl: "http://x", fetchImpl: modelFetch(MODEL_ANSWER) });
  assert.equal(again.decisions.length, 0, "same input, same model: nothing to redo");
  const otherModel = await classifyTables({ tables, human, existing, model: "m2", baseUrl: "http://x", fetchImpl: modelFetch(MODEL_ANSWER) });
  assert.ok(otherModel.decisions.length > 0, "a different model is a different input");
});

test("a failing provider leaves the columns in review and reports the error", async () => {
  const result = await classifyTables({
    tables: groupSchema(SCHEMA_ROWS),
    model: "m",
    baseUrl: "http://x",
    fetchImpl: async () => { throw new Error("connection refused"); }
  });
  assert.equal(result.errors.length, 1);
  assert.equal(result.decisions.filter(d => d.source === "model").every(d => d.status === "review"), true);
});

test("proposals are stored, rejected ones stay rejected, accepted ones become human verdicts", async () => {
  const dir = tempDir();
  const catalogPath = path.join(dir, "anon-catalog.json");
  const proposalsPath = proposalsPathFor(catalogPath);
  assert.equal(proposalsPath, path.join(dir, "anon-catalog.proposals.json"));
  saveCatalogFile(catalogPath, { version: 1, human: {}, targets: {} });

  const result = await classifyTables({ tables: groupSchema(SCHEMA_ROWS), model: "m", baseUrl: "http://x", fetchImpl: modelFetch(MODEL_ANSWER) });
  recordProposals(proposalsPath, result, { targetId: "dev", model: "m", provider: "ollama", startedAt: "t" });
  let store = loadProposals(proposalsPath);
  assert.equal(store.proposals["dbo.clienti.codiceinterno"].prompt_version, PROMPT_VERSION);
  assert.equal(store.runs.length, 1);

  rejectProposals({ proposalsPath, keys: ["dbo.Clienti.Annotazioni"] });
  recordProposals(proposalsPath, result, { targetId: "dev", model: "m", provider: "ollama", startedAt: "t" });
  assert.equal(loadProposals(proposalsPath).proposals["dbo.clienti.annotazioni"].status, "rejected");

  const accepted = acceptProposals({ catalogPath, proposalsPath, keys: ["dbo.clienti.codiceinterno", "dbo.clienti.tokenaccesso", "dbo.clienti.annotazioni"] });
  assert.deepEqual(accepted.accepted.map(a => [a.key, a.verdict, a.kind]), [
    ["dbo.clienti.codiceinterno", "safe", null],
    ["dbo.clienti.tokenaccesso", "sensitive", "text"]
  ]);
  assert.equal(accepted.skipped.length, 1, "a rejected proposal cannot be accepted");
  const human = loadCatalogFile(catalogPath).human;
  assert.equal(human["dbo.clienti.codiceinterno"].verdict, "safe");
  assert.match(human["dbo.clienti.tokenaccesso"].note, /accepted model m/);
  store = loadProposals(proposalsPath);
  assert.equal(store.proposals["dbo.clienti.codiceinterno"], undefined, "accepted proposals leave the queue");
});

test("a review proposal needs an explicit verdict", () => {
  const dir = tempDir();
  const catalogPath = path.join(dir, "c.json");
  const proposalsPath = proposalsPathFor(catalogPath);
  saveCatalogFile(catalogPath, { version: 1, human: {}, targets: {} });
  recordProposals(proposalsPath, { decisions: [{ key: "dbo.t.x", status: "review", kind: null, source: "model", reason: "r", signals: null, input_hash: "h" }], errors: [], counts: {} }, { targetId: "dev", model: "m", provider: "ollama", startedAt: "t" });
  assert.equal(acceptProposals({ catalogPath, proposalsPath, keys: ["dbo.t.x"] }).accepted.length, 0);
  assert.equal(acceptProposals({ catalogPath, proposalsPath, keys: ["dbo.t.x"], as: "sensitive", kind: "name" }).accepted[0].kind, "name");
});

test("evaluation measures the precision of safe proposals against human verdicts", () => {
  const metrics = evaluateDecisions(
    [
      { key: "a", status: "proposed-safe" },
      { key: "b", status: "proposed-safe" },
      { key: "c", status: "proposed-sensitive" },
      { key: "d", status: "review" }
    ],
    { a: { verdict: "safe" }, b: { verdict: "sensitive" }, c: { verdict: "sensitive" }, d: { verdict: "safe" } }
  );
  assert.equal(metrics.safe_precision, 0.5);
  assert.deepEqual(metrics.unsafe_leaks, ["b"]);
  assert.equal(metrics.sensitive_recall, 0.5);
  assert.equal(metrics.review_rate, 0.25);
});

function cliEnv(dir) {
  const targetsFile = path.join(dir, "targets.json");
  fs.writeFileSync(targetsFile, JSON.stringify({
    targets: [{
      target_id: "dev-main",
      display_name: "Dev",
      environment: "dev",
      db_kind: "sqlserver",
      status: "active",
      connection_env_var: "DB_DEV_MAIN_CONNECTION_STRING",
      read_enabled: true,
      write_enabled: false,
      anonymization_enabled: true,
      anonymization_mode: "deterministic",
      llm_provider: "none",
      llm_model: "",
      max_rows: 100,
      max_result_bytes: 1024,
      allowed_tools: ["db_target_info", "db_policy_info", "db_read"]
    }]
  }));
  const catalogPath = path.join(dir, "anon-catalog.json");
  saveCatalogFile(catalogPath, { version: 1, human: { "dbo.clienti.cognome": { verdict: "sensitive", kind: "name" } }, targets: {} });
  return {
    catalogPath,
    env: { TARGETS_FILE: targetsFile, ANON_CATALOG_PATH: catalogPath, DB_DEV_MAIN_CONNECTION_STRING: "Server=x;Database=y;User Id=u;Password=p;" }
  };
}

function io() {
  const sink = { out: "", err: "" };
  return { sink, stdout: { write: m => { sink.out += m; } }, stderr: { write: m => { sink.err += m; } } };
}

test("CLI classify writes proposals and a status file, proposals and accept work on them", async () => {
  const dir = tempDir();
  const { env, catalogPath } = cliEnv(dir);
  const statusFile = path.join(dir, "status.json");
  const { sink, stdout, stderr } = io();
  const code = await runClassifyCli(["classify", "--target", "dev-main", "--model", "m", "--status-file", statusFile, "--json"], {
    env, stdout, stderr, fetchImpl: modelFetch(MODEL_ANSWER), loadSchemaRows: async dsn => { assert.match(dsn, /Server=x/); return SCHEMA_ROWS; }
  });
  assert.equal(code, 0, sink.err);
  assert.equal(JSON.parse(fs.readFileSync(statusFile, "utf8")).state, "done");
  assert.equal(JSON.parse(sink.out).mode, "classify");

  const listed = io();
  await runClassifyCli(["proposals", "--status", "proposed-safe", "--json"], { env, stdout: listed.stdout, stderr: listed.stderr });
  const keys = JSON.parse(listed.sink.out).proposals.map(p => p.key);
  assert.ok(keys.includes("dbo.clienti.codiceinterno"));
  assert.ok(!keys.includes("dbo.clienti.cognome"), "columns with a human verdict are not proposed");

  const accepted = io();
  assert.equal(await runClassifyCli(["accept", "--status", "proposed-safe", "--json"], { env, stdout: accepted.stdout, stderr: accepted.stderr }), 0);
  assert.equal(loadCatalogFile(catalogPath).human["dbo.clienti.codiceinterno"].verdict, "safe");
});

test("CLI eval compares with human verdicts and stores nothing", async () => {
  const dir = tempDir();
  const { env, catalogPath } = cliEnv(dir);
  const { sink, stdout, stderr } = io();
  const code = await runClassifyCli(["classify", "--target", "dev-main", "--model", "m", "--eval", "10", "--json"], {
    env, stdout, stderr, fetchImpl: modelFetch(MODEL_ANSWER), loadSchemaRows: async () => SCHEMA_ROWS
  });
  assert.equal(code, 0, sink.err);
  const report = JSON.parse(sink.out);
  assert.equal(report.mode, "eval");
  assert.equal(report.metrics.total, 1);
  assert.equal(fs.existsSync(proposalsPathFor(catalogPath)), false);
});

test("CLI classify fails cleanly without a connection string", async () => {
  const dir = tempDir();
  const { env } = cliEnv(dir);
  delete env.DB_DEV_MAIN_CONNECTION_STRING;
  const statusFile = path.join(dir, "status.json");
  const { sink, stdout, stderr } = io();
  const code = await runClassifyCli(["classify", "--target", "dev-main", "--status-file", statusFile], { env, stdout, stderr, loadSchemaRows: async () => SCHEMA_ROWS });
  assert.equal(code, 1);
  assert.match(sink.err, /unlock the vault/);
  assert.equal(JSON.parse(fs.readFileSync(statusFile, "utf8")).state, "failed");
});

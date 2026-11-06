import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import sql from "mssql";
import { loadCatalogFile } from "../lib/anonymization/catalog.js";
import {
  PROPOSAL_STATUSES,
  SCHEMA_QUERY,
  acceptProposals,
  classifyTables,
  evaluateDecisions,
  groupSchema,
  loadProposals,
  proposalsPathFor,
  recordProposals,
  rejectProposals
} from "../lib/anonymization/classifier.js";
import { buildSqlServerConnectionConfig } from "../lib/drivers/sqlserver.js";
import { loadTargetRegistry } from "../lib/target-registry.js";

export const CLASSIFY_USAGE = `Schema classification (proposals only, a human accepts them):
  classify --target <id> [--model <name>] [--provider ollama|lmstudio] [--base-url <url>]
           [--timeout-ms <n>] [--force] [--eval <n>] [--report <path>] [--status-file <path>]
      Reads the target schema (metadata only), applies the rules, asks the model about the rest
      and stores proposals next to the catalog. --eval <n> runs on n columns that already have a
      human verdict and prints precision metrics without storing anything.
  proposals [--status review|proposed-safe|proposed-sensitive|rejected|all] [--limit <n>] [--json]
  accept <schema.table.column>... [--as safe|sensitive] [--kind <kind>] [--json]
  accept --status proposed-safe|proposed-sensitive [--json]
  reject <schema.table.column>... [--json]
`;

const DEFAULT_MODEL = "qwen2.5:3b-instruct";
const DEFAULT_TIMEOUT_MS = 180000;

function writeJsonFile(filePath, data) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

async function defaultLoadSchemaRows(connectionString) {
  const pool = await new sql.ConnectionPool(buildSqlServerConnectionConfig(connectionString, {})).connect();
  try {
    const result = await pool.request().query(SCHEMA_QUERY);
    return result.recordset ?? [];
  } finally {
    await pool.close();
  }
}

// Stable pseudo-random sample: same keys for the same catalog, so eval runs are comparable.
function sampleKeys(keys, count) {
  return keys
    .map(key => [createHash("sha256").update(key).digest("hex"), key])
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, count)
    .map(([, key]) => key);
}

const COMMON_OPTIONS = {
  file: { type: "string" },
  target: { type: "string" },
  model: { type: "string" },
  provider: { type: "string" },
  "base-url": { type: "string" },
  "timeout-ms": { type: "string" },
  force: { type: "boolean" },
  eval: { type: "string" },
  report: { type: "string" },
  "status-file": { type: "string" },
  status: { type: "string" },
  limit: { type: "string" },
  as: { type: "string" },
  kind: { type: "string" },
  json: { type: "boolean" }
};

export const CLASSIFY_COMMANDS = new Set(["classify", "proposals", "accept", "reject"]);

/**
 * Runs the schema classification commands. Async because classify talks to SQL Server and to the
 * model; the other commands only touch the proposal and catalog files.
 */
export async function runClassifyCli(
  argv,
  {
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    fetchImpl = globalThis.fetch,
    loadSchemaRows = defaultLoadSchemaRows
  } = {}
) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: COMMON_OPTIONS });
  } catch (error) {
    stderr.write(`${error.message}\n${CLASSIFY_USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...keys] = positionals;
  const catalogPath = values.file || env.ANON_CATALOG_PATH;
  if (!catalogPath) {
    stderr.write("No catalog file: pass --file or set ANON_CATALOG_PATH.\n");
    return 2;
  }
  const proposalsPath = proposalsPathFor(catalogPath);
  const out = data => stdout.write(`${JSON.stringify(data, null, 2)}\n`);

  if (command === "proposals") {
    const status = values.status ?? "all";
    if (status !== "all" && !PROPOSAL_STATUSES.has(status)) {
      stderr.write(`Unknown status: ${status}\n`);
      return 2;
    }
    const store = loadProposals(proposalsPath);
    const limit = values.limit ? Number.parseInt(values.limit, 10) : 500;
    const rows = Object.entries(store.proposals)
      .filter(([, proposal]) => status === "all" || proposal.status === status)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, limit)
      .map(([key, proposal]) => ({ key, ...proposal }));
    if (values.json) out({ proposals: rows, runs: store.runs });
    else for (const row of rows) stdout.write(`${row.key}\t${row.status}\t${row.kind ?? ""}\t${row.source}\t${row.reason}\n`);
    return 0;
  }

  if (command === "accept") {
    let targetKeys = keys;
    if (targetKeys.length === 0 && (values.status === "proposed-safe" || values.status === "proposed-sensitive")) {
      const store = loadProposals(proposalsPath);
      targetKeys = Object.entries(store.proposals).filter(([, p]) => p.status === values.status).map(([key]) => key);
    }
    if (targetKeys.length === 0) {
      stderr.write("accept needs column keys or --status proposed-safe|proposed-sensitive.\n");
      return 2;
    }
    if (values.as && !["safe", "sensitive"].includes(values.as)) {
      stderr.write("--as must be safe or sensitive.\n");
      return 2;
    }
    const result = acceptProposals({ catalogPath, proposalsPath, keys: targetKeys, as: values.as ?? null, kind: values.kind ?? null });
    if (values.json) out(result);
    else stdout.write(`accepted ${result.accepted.length}, skipped ${result.skipped.length}\n`);
    return result.accepted.length > 0 || result.skipped.length === 0 ? 0 : 1;
  }

  if (command === "reject") {
    if (keys.length === 0) {
      stderr.write("reject needs column keys.\n");
      return 2;
    }
    const result = rejectProposals({ proposalsPath, keys });
    if (values.json) out(result);
    else stdout.write(`rejected ${result.rejected.length}\n`);
    return 0;
  }

  if (command !== "classify") {
    stderr.write(`Unknown command: ${command}\n${CLASSIFY_USAGE}`);
    return 2;
  }

  const targetId = values.target;
  if (!targetId) {
    stderr.write("classify needs --target <id>.\n");
    return 2;
  }
  const statusFile = values["status-file"];
  const startedAt = new Date().toISOString();
  const status = (state, extra = {}) => writeJsonFile(statusFile, { state, target_id: targetId, started_at: startedAt, updated_at: new Date().toISOString(), ...extra });

  try {
    if (!env.TARGETS_FILE) throw new Error("TARGETS_FILE is not set.");
    const registry = await loadTargetRegistry(env.TARGETS_FILE, { env });
    const target = registry.get(targetId);
    if (!target) throw new Error(`Unknown target: ${targetId}`);
    const connectionString = env[target.connection_env_var];
    if (!connectionString) throw new Error(`No connection string for ${targetId}: unlock the vault and check the target connection.`);

    const provider = values.provider || env.ANON_CLASSIFIER_PROVIDER || "ollama";
    if (!["ollama", "lmstudio"].includes(provider)) throw new Error("Provider must be ollama or lmstudio (local models only).");
    const model = values.model || env.ANON_CLASSIFIER_MODEL || DEFAULT_MODEL;
    const baseUrl = values["base-url"] || (provider === "lmstudio" ? env.LMSTUDIO_BASE_URL : env.OLLAMA_BASE_URL)
      || (provider === "lmstudio" ? "http://127.0.0.1:1234/v1" : "http://127.0.0.1:11434");
    const timeoutMs = Number.parseInt(values["timeout-ms"] || env.ANON_CLASSIFIER_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);

    status("reading-schema");
    const tables = groupSchema(await loadSchemaRows(connectionString));
    const human = loadCatalogFile(catalogPath).human;
    const evalCount = values.eval ? Number.parseInt(values.eval, 10) : 0;
    let evalKeys = null;
    if (evalCount > 0) {
      const classifiable = new Set();
      for (const table of tables) {
        for (const column of table.columns) classifiable.add(`${table.schema}.${table.table}.${column.name}`.toLowerCase());
      }
      evalKeys = new Set(sampleKeys(Object.keys(human).filter(key => classifiable.has(key)), evalCount));
    }

    const result = await classifyTables({
      tables,
      human,
      existing: loadProposals(proposalsPath).proposals,
      model,
      provider,
      baseUrl,
      timeoutMs,
      fetchImpl,
      force: Boolean(values.force),
      evalKeys,
      onProgress: progress => status("classifying", progress)
    });

    const report = {
      target_id: targetId,
      model,
      provider,
      mode: evalKeys ? "eval" : "classify",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      counts: result.counts,
      errors: result.errors
    };
    if (evalKeys) {
      report.metrics = evaluateDecisions(result.decisions, human);
    } else {
      recordProposals(proposalsPath, result, { targetId, model, provider, startedAt });
    }
    writeJsonFile(values.report, report);
    status("done", { counts: result.counts, errors: result.errors.length, metrics: report.metrics ?? null });
    if (values.json) out(report);
    else stdout.write(`${report.mode}: ${JSON.stringify(result.counts)}; errors ${result.errors.length}\n`);
    return 0;
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 300);
    status("failed", { error: message });
    stderr.write(`${message}\n`);
    return 1;
  }
}

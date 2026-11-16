import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "../src/server.js";

const CREATE_SQL = "CREATE TABLE dbo.Fat_Prova (Id INT IDENTITY(1,1) PRIMARY KEY, Nome NVARCHAR(100) NULL)";
const ALTER_SQL = "ALTER TABLE dbo.Fat_Prova ADD Note NVARCHAR(200) NULL";
const ENV_KEYS = ["PORT", "TARGETS_FILE", "ANON_HASH_SALT", "DB_DEV_MAIN_CONNECTION_STRING", "DB_PROD_MAIN_CONNECTION_STRING"];

function parseErrorEnvelope(toolResult) {
  return JSON.parse(toolResult.content[1].text);
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(error => (error ? reject(error) : resolve(port)));
    });
    server.once("error", reject);
  });
}

function restoreEnv(original) {
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original[key];
    }
  }
}

async function connect(runtime, name) {
  const client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://${runtime.config.host}:${runtime.config.port}${runtime.config.mcpPath}`))
  );
  return client;
}

function baseTarget(overrides) {
  return {
    display_name: "Target",
    db_kind: "sqlserver",
    status: "active",
    read_enabled: true,
    write_enabled: false,
    max_rows: 100,
    max_result_bytes: 1024,
    ...overrides
  };
}

test("integration: db_ddl issues a token over MCP HTTP and the confirmation store is shared across sessions", async () => {
  const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  const port = await getFreePort();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-sql-db-mcp-ddl-"));
  const targetsPath = path.join(tempDir, "targets.runtime.json");
  await fs.writeFile(
    targetsPath,
    JSON.stringify({
      version: 1,
      publisher: "mcp-dashboard",
      service_id: "llm-sql-db-mcp",
      apply_strategy: "restart_or_start",
      targets: [
        baseTarget({
          target_id: "dev-main",
          environment: "dev",
          connection_env_var: "DB_DEV_MAIN_CONNECTION_STRING",
          write_enabled: true,
          ddl_enabled: true,
          anonymization_enabled: false,
          anonymization_mode: "off",
          llm_provider: "none",
          llm_model: "",
          allowed_tools: ["db_target_info", "db_policy_info", "db_read", "db_write", "db_ddl"]
        }),
        baseTarget({
          target_id: "prod-main",
          environment: "prod",
          connection_env_var: "DB_PROD_MAIN_CONNECTION_STRING",
          ddl_enabled: true,
          anonymization_enabled: true,
          anonymization_mode: "deterministic",
          llm_provider: "none",
          llm_model: "",
          allowed_tools: ["db_target_info", "db_policy_info", "db_read", "db_ddl"]
        })
      ]
    }),
    "utf8"
  );

  process.env.PORT = String(port);
  process.env.TARGETS_FILE = targetsPath;
  process.env.ANON_HASH_SALT = "integration-test-salt";
  process.env.DB_DEV_MAIN_CONNECTION_STRING = "Server=.;Database=Dev;";
  process.env.DB_PROD_MAIN_CONNECTION_STRING = "Server=.;Database=Prod;";

  const runtime = await startServer({ cwd: process.cwd() });
  const clientA = await connect(runtime, "ddl-session-a");
  const clientB = await connect(runtime, "ddl-session-b");

  try {
    const info = await clientA.callTool({ name: "db_target_info", arguments: { target_id: "dev-main" } });
    assert.equal(info.structuredContent.ddl_enabled, true);
    const prodInfo = await clientA.callTool({ name: "db_target_info", arguments: { target_id: "prod-main" } });
    assert.equal(prodInfo.structuredContent.ddl_enabled, false);
    assert.equal(prodInfo.structuredContent.allowed_tools.includes("db_ddl"), false);

    // Fase 1: il client SDK valida structuredContent contro l'outputSchema dichiarato.
    const first = await clientA.callTool({ name: "db_ddl", arguments: { target_id: "dev-main", sql: CREATE_SQL } });
    assert.equal(first.isError, undefined);
    assert.equal(first.structuredContent.status, "confirmation_required");
    const token = first.structuredContent.confirmation_token;
    assert.ok(token);

    // Un'altra sessione presenta lo stesso token con un'altra istruzione: se lo store fosse per
    // sessione sarebbe "unknown"; "scope_mismatch" dimostra che e' condiviso. Nessun accesso al DB.
    const swapped = await clientB.callTool({
      name: "db_ddl",
      arguments: { target_id: "dev-main", sql: ALTER_SQL, confirmation_token: token }
    });
    assert.equal(swapped.isError, true);
    assert.equal(parseErrorEnvelope(swapped).error.code, "confirmation_invalid");
    assert.equal(parseErrorEnvelope(swapped).error.details.reason, "scope_mismatch");

    const replay = await clientA.callTool({
      name: "db_ddl",
      arguments: { target_id: "dev-main", sql: CREATE_SQL, confirmation_token: token }
    });
    assert.equal(parseErrorEnvelope(replay).error.details.reason, "reused");

    // prod: negato dalla policy, nessun token emesso.
    const prod = await clientA.callTool({ name: "db_ddl", arguments: { target_id: "prod-main", sql: CREATE_SQL } });
    assert.equal(prod.isError, true);
    assert.equal(parseErrorEnvelope(prod).error.code, "policy_denied");

    const rejected = await clientA.callTool({ name: "db_ddl", arguments: { target_id: "dev-main", sql: "DROP TABLE dbo.Fat_Prova" } });
    assert.equal(parseErrorEnvelope(rejected).error.code, "invalid_sql");
  } finally {
    await clientA.close().catch(() => {});
    await clientB.close().catch(() => {});
    await runtime.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    restoreEnv(originalEnv);
  }
});

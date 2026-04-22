import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "../src/server.js";

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "llm-sql-db-mcp-multi-env-"));
}

function writeTargetsFile(cwd) {
  fs.writeFileSync(
    path.join(cwd, "targets.json"),
    JSON.stringify(
      {
        targets: [
          {
            target_id: "dev-main",
            display_name: "Dev Main",
            environment: "dev",
            db_kind: "sqlserver",
            status: "active",
            connection_env_var: "DB_DEV_MAIN_CONNECTION_STRING",
            read_enabled: true,
            write_enabled: true,
            anonymization_enabled: false,
            anonymization_mode: "off",
            llm_provider: "none",
            llm_model: "",
            max_rows: 25,
            max_result_bytes: 16384,
            allowed_tools: ["db_target_info", "db_policy_info", "db_read", "db_write"]
          },
          {
            target_id: "prod-main",
            display_name: "Prod Main",
            environment: "prod",
            db_kind: "sqlserver",
            status: "active",
            connection_env_var: "DB_PROD_MAIN_CONNECTION_STRING",
            read_enabled: true,
            write_enabled: false,
            anonymization_enabled: true,
            anonymization_mode: "hybrid",
            llm_provider: "lmstudio",
            llm_model: "gemma",
            max_rows: 25,
            max_result_bytes: 16384,
            allowed_tools: ["db_target_info", "db_policy_info", "db_read", "db_write"]
          },
          {
            target_id: "prod-reporting",
            display_name: "Prod Reporting",
            environment: "prod",
            db_kind: "sqlserver",
            status: "active",
            connection_env_var: "DB_PROD_REPORTING_CONNECTION_STRING",
            read_enabled: true,
            write_enabled: false,
            anonymization_enabled: true,
            anonymization_mode: "hybrid",
            llm_provider: "lmstudio",
            llm_model: "gemma",
            max_rows: 25,
            max_result_bytes: 16384,
            allowed_tools: ["db_target_info", "db_policy_info", "db_read", "db_write"]
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(error => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
    server.once("error", reject);
  });
}

test("integration: multiple active prod targets are surfaced by the registry and block ambiguous diagnostic routing", async () => {
  const cwd = createTempDir();
  writeTargetsFile(cwd);

  const port = await getFreePort();
  const originalEnv = {
    PORT: process.env.PORT,
    DB_DEV_MAIN_CONNECTION_STRING: process.env.DB_DEV_MAIN_CONNECTION_STRING,
    DB_PROD_MAIN_CONNECTION_STRING: process.env.DB_PROD_MAIN_CONNECTION_STRING,
    DB_PROD_REPORTING_CONNECTION_STRING: process.env.DB_PROD_REPORTING_CONNECTION_STRING
  };

  process.env.PORT = String(port);
  process.env.DB_DEV_MAIN_CONNECTION_STRING = "Server=dev;Database=Test;";
  process.env.DB_PROD_MAIN_CONNECTION_STRING = "Server=prod;Database=Main;";
  delete process.env.DB_PROD_REPORTING_CONNECTION_STRING;

  const runtime = await startServer({ cwd });
  const client = new Client({ name: "multi-env-test-client", version: "1.0.0" }, { capabilities: {} });

  try {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://${runtime.config.host}:${runtime.config.port}${runtime.config.mcpPath}`)
    );
    await client.connect(transport);

    const targetList = await client.callTool({ name: "db_target_list", arguments: {} });
    assert.equal(targetList.structuredContent.targets.length, 3);
    assert.deepEqual(
      targetList.structuredContent.targets
        .filter(target => target.environment === "prod")
        .map(target => target.target_id)
        .sort(),
      ["prod-main", "prod-reporting"]
    );

    const diagnosticResult = await client.callTool({
      name: "run_diagnostic_query",
      arguments: {
        database_target: "prod",
        ticket_key: "TICKET-REGISTRY-1",
        query: "SELECT 1 AS value"
      }
    });

    assert.equal(diagnosticResult.isError, undefined);
    assert.equal(diagnosticResult.structuredContent.used.target_id, null);
    assert.equal(diagnosticResult.structuredContent.rows.length, 0);
    assert.match(
      diagnosticResult.structuredContent.blockers[0],
      /Multiple active targets matched database_target "prod"/
    );
    assert.match(diagnosticResult.structuredContent.blockers[0], /prod-main, prod-reporting/);

    const explicitDiagnosticResult = await client.callTool({
      name: "run_diagnostic_query",
      arguments: {
        database_target: "prod",
        target_id: "prod-reporting",
        ticket_key: "TICKET-REGISTRY-2",
        query: "SELECT 1 AS value"
      }
    });

    assert.equal(explicitDiagnosticResult.isError, undefined);
    assert.equal(explicitDiagnosticResult.structuredContent.used.target_id, "prod-reporting");
    assert.equal(explicitDiagnosticResult.structuredContent.rows.length, 0);
    assert.match(
      explicitDiagnosticResult.structuredContent.blockers[0],
      /DB_PROD_REPORTING_CONNECTION_STRING/
    );
  } finally {
    await client.close().catch(() => {});
    await runtime.close();

    if (originalEnv.PORT === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = originalEnv.PORT;
    }

    if (originalEnv.DB_DEV_MAIN_CONNECTION_STRING === undefined) {
      delete process.env.DB_DEV_MAIN_CONNECTION_STRING;
    } else {
      process.env.DB_DEV_MAIN_CONNECTION_STRING = originalEnv.DB_DEV_MAIN_CONNECTION_STRING;
    }

    if (originalEnv.DB_PROD_MAIN_CONNECTION_STRING === undefined) {
      delete process.env.DB_PROD_MAIN_CONNECTION_STRING;
    } else {
      process.env.DB_PROD_MAIN_CONNECTION_STRING = originalEnv.DB_PROD_MAIN_CONNECTION_STRING;
    }

    if (originalEnv.DB_PROD_REPORTING_CONNECTION_STRING === undefined) {
      delete process.env.DB_PROD_REPORTING_CONNECTION_STRING;
    } else {
      process.env.DB_PROD_REPORTING_CONNECTION_STRING = originalEnv.DB_PROD_REPORTING_CONNECTION_STRING;
    }
  }
});

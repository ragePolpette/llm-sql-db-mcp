import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "../src/server.js";

function parseErrorEnvelope(toolResult) {
  return JSON.parse(toolResult.content[1].text);
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

test("integration: health, tool surface, target tools, and db_read error path work over MCP HTTP", async () => {
  const port = await getFreePort();
  const originalEnv = {
    PORT: process.env.PORT,
    DB_DEV_MAIN_CONNECTION_STRING: process.env.DB_DEV_MAIN_CONNECTION_STRING,
    DB_PROD_MAIN_CONNECTION_STRING: process.env.DB_PROD_MAIN_CONNECTION_STRING
  };

  process.env.PORT = String(port);
  delete process.env.DB_DEV_MAIN_CONNECTION_STRING;
  delete process.env.DB_PROD_MAIN_CONNECTION_STRING;

  const runtime = await startServer({ cwd: process.cwd() });
  const client = new Client({ name: "integration-test-client", version: "1.0.0" }, { capabilities: {} });

  try {
    const healthResponse = await fetch(`http://${runtime.config.host}:${runtime.config.port}${runtime.config.healthPath}`);
    const healthPayload = await healthResponse.json();
    assert.equal(healthResponse.status, 200);
    assert.equal(healthPayload.target_count, 2);

    const readinessResponse = await fetch(
      `http://${runtime.config.host}:${runtime.config.port}${runtime.config.readinessPath}`
    );
    const readinessPayload = await readinessResponse.json();
    assert.equal(readinessResponse.status, 503);
    assert.equal(readinessPayload.status, "not_ready");
    assert.equal(readinessPayload.checks.registry_loaded, true);
    assert.equal(readinessPayload.checks.active_target_count, 2);
    assert.deepEqual(
      readinessPayload.checks.active_targets_missing_connection_env.map(target => target.target_id).sort(),
      ["dev-main", "prod-main"]
    );

    const missingSessionResponse = await fetch(
      `http://${runtime.config.host}:${runtime.config.port}${runtime.config.mcpPath}`
    );
    const missingSessionPayload = await missingSessionResponse.json();
    assert.equal(missingSessionResponse.status, 400);
    assert.equal(missingSessionPayload.error.data.error_code, "session_id_required");
    assert.equal(
      missingSessionPayload.error.data.request_id,
      missingSessionResponse.headers.get("x-request-id")
    );

    const transport = new StreamableHTTPClientTransport(
      new URL(`http://${runtime.config.host}:${runtime.config.port}${runtime.config.mcpPath}`)
    );
    await client.connect(transport);

    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map(tool => tool.name).sort(),
      ["db_policy_info", "db_read", "db_target_info", "db_target_list", "db_tool_info", "db_write", "run_diagnostic_query"]
    );

    const toolInfo = await client.callTool({ name: "db_tool_info", arguments: {} });
    assert.equal(toolInfo.structuredContent.server, "llm-sql-db-mcp");
    assert.ok(toolInfo.structuredContent.tool_map.discovery.includes("db_target_list"));

    const targetList = await client.callTool({ name: "db_target_list", arguments: {} });
    assert.equal(targetList.structuredContent.targets.length, 2);

    const targetInfo = await client.callTool({
      name: "db_target_info",
      arguments: { target_id: "dev-main" }
    });
    assert.equal(targetInfo.structuredContent.target_id, "dev-main");

    const policyInfo = await client.callTool({
      name: "db_policy_info",
      arguments: { target_id: "prod-main", tool_name: "db_read" }
    });
    assert.equal(policyInfo.structuredContent.anonymization_required, true);

    const readResult = await client.callTool({
      name: "db_read",
      arguments: { target_id: "dev-main", sql: "SELECT 1 AS value" }
    });
    assert.equal(readResult.isError, true);
    assert.equal(parseErrorEnvelope(readResult).error.code, "db_read_failed");
    assert.match(readResult.content[0].text, /DB_DEV_MAIN_CONNECTION_STRING/);
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
  }
});

test("integration: readiness reports runtime-blocked targets exported by the dashboard", async () => {
  const port = await getFreePort();
  const originalEnv = {
    PORT: process.env.PORT,
    TARGETS_FILE: process.env.TARGETS_FILE,
    DB_DEV_MAIN_CONNECTION_STRING: process.env.DB_DEV_MAIN_CONNECTION_STRING
  };

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-sql-db-mcp-runtime-"));
  const runtimeTargetsPath = path.join(tempDir, "targets.runtime.json");
  await fs.writeFile(
    runtimeTargetsPath,
    JSON.stringify({
      version: 1,
      publisher: "mcp-dashboard",
      service_id: "llm-sql-db-mcp",
      apply_strategy: "restart_or_start",
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
          max_rows: 100,
          max_result_bytes: 1024,
          allowed_tools: ["db_target_info", "db_policy_info", "db_read", "db_write"],
          state: {
            runtime_status: "vault_locked",
            last_synced_at: "2026-04-22T10:00:00+02:00",
            last_error: "Vault bloccato"
          }
        }
      ]
    }),
    "utf8"
  );

  process.env.PORT = String(port);
  process.env.TARGETS_FILE = runtimeTargetsPath;
  process.env.DB_DEV_MAIN_CONNECTION_STRING = "Server=.;Database=Dev;";

  const runtime = await startServer({ cwd: process.cwd() });

  try {
    const readinessResponse = await fetch(
      `http://${runtime.config.host}:${runtime.config.port}${runtime.config.readinessPath}`
    );
    const readinessPayload = await readinessResponse.json();
    assert.equal(readinessResponse.status, 503);
    assert.equal(readinessPayload.status, "not_ready");
    assert.equal(readinessPayload.checks.active_targets_runtime_blocked.length, 1);
    assert.equal(readinessPayload.checks.active_targets_runtime_blocked[0].target_id, "dev-main");
    assert.equal(readinessPayload.checks.active_targets_runtime_blocked[0].runtime_status, "vault_locked");
  } finally {
    await runtime.close();
    await fs.rm(tempDir, { recursive: true, force: true });

    if (originalEnv.PORT === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = originalEnv.PORT;
    }

    if (originalEnv.TARGETS_FILE === undefined) {
      delete process.env.TARGETS_FILE;
    } else {
      process.env.TARGETS_FILE = originalEnv.TARGETS_FILE;
    }

    if (originalEnv.DB_DEV_MAIN_CONNECTION_STRING === undefined) {
      delete process.env.DB_DEV_MAIN_CONNECTION_STRING;
    } else {
      process.env.DB_DEV_MAIN_CONNECTION_STRING = originalEnv.DB_DEV_MAIN_CONNECTION_STRING;
    }
  }
});

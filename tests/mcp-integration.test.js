import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "../src/server.js";

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

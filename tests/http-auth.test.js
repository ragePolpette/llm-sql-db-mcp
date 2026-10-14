import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp, startServer } from "../src/server.js";

const MANAGED_ENV = ["PORT", "HOST", "DB_MCP_API_KEY", "ANON_HASH_SALT", "TARGETS_FILE", "ANON_CATALOG_PATH"];

function createWorkspace(targets) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "llm-sql-db-mcp-auth-"));
  fs.writeFileSync(path.join(cwd, "targets.json"), JSON.stringify({ targets }), "utf8");
  return cwd;
}

function devTarget() {
  return {
    target_id: "dev-main",
    display_name: "Dev Main",
    environment: "dev",
    db_kind: "sqlserver",
    status: "active",
    connection_env_var: "DB_DEV_MAIN_CONNECTION_STRING",
    read_enabled: true,
    write_enabled: false,
    anonymization_enabled: false,
    anonymization_mode: "off",
    llm_provider: "none",
    llm_model: "",
    max_rows: 10,
    max_result_bytes: 4096,
    allowed_tools: ["db_target_info", "db_policy_info", "db_read"]
  };
}

function prodAnonymizedTarget() {
  return {
    ...devTarget(),
    target_id: "prod-main",
    environment: "prod",
    connection_env_var: "DB_PROD_MAIN_CONNECTION_STRING",
    anonymization_enabled: true,
    anonymization_mode: "hybrid",
    llm_provider: "lmstudio",
    llm_model: "gemma"
  };
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

async function withEnv(values, fn) {
  const saved = Object.fromEntries(MANAGED_ENV.map(key => [key, process.env[key]]));
  for (const key of MANAGED_ENV) delete process.env[key];
  Object.assign(process.env, values);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("with DB_MCP_API_KEY set, requests need a matching bearer token or x-api-key", async () => {
  const cwd = createWorkspace([devTarget()]);
  const port = await getFreePort();
  await withEnv({ PORT: String(port), DB_MCP_API_KEY: "s3cret-token" }, async () => {
    const runtime = await startServer({ cwd });
    const base = `http://127.0.0.1:${port}`;
    const client = new Client({ name: "auth-test-client", version: "1.0.0" }, { capabilities: {} });
    try {
      assert.equal((await fetch(`${base}/health`)).status, 200, "liveness probe stays reachable without a token");
      const missing = await fetch(`${base}/ready`);
      assert.equal(missing.status, 401);
      assert.equal(missing.headers.get("www-authenticate"), "Bearer");
      assert.equal((await missing.json()).error.data.error_code, "unauthorized");

      for (const headers of [
        { authorization: "Bearer wrong" },
        { authorization: "Bearer s3cret-token-longer" },
        { authorization: "Basic s3cret-token" },
        { "x-api-key": "s3cret-toke" }
      ]) {
        assert.equal((await fetch(`${base}/ready`, { headers })).status, 401, JSON.stringify(headers));
      }

      assert.equal((await fetch(`${base}/health`, { headers: { authorization: "Bearer s3cret-token" } })).status, 200);
      assert.equal((await fetch(`${base}/health`, { headers: { authorization: "bearer  s3cret-token " } })).status, 200);
      assert.equal((await fetch(`${base}/health`, { headers: { "x-api-key": "s3cret-token" } })).status, 200);

      const unauthorizedInit = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      });
      assert.equal(unauthorizedInit.status, 401);

      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: "Bearer s3cret-token" } }
      });
      await client.connect(transport);
      const list = await client.callTool({ name: "db_target_list", arguments: {} });
      assert.equal(list.structuredContent.targets.length, 1);
    } finally {
      await client.close().catch(() => {});
      await runtime.close();
    }
  });
});

test("without DB_MCP_API_KEY the loopback server stays open", async () => {
  const cwd = createWorkspace([devTarget()]);
  const port = await getFreePort();
  await withEnv({ PORT: String(port) }, async () => {
    const runtime = await startServer({ cwd });
    try {
      assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    } finally {
      await runtime.close();
    }
  });
});

test("startup refuses a non-loopback HOST without DB_MCP_API_KEY", async () => {
  const cwd = createWorkspace([devTarget()]);
  await withEnv({ HOST: "0.0.0.0" }, async () => {
    await assert.rejects(createApp({ cwd, closeSqlPools: async () => {} }), /DB_MCP_API_KEY is required when HOST is not a loopback address/);
  });
  await withEnv({ HOST: "0.0.0.0", DB_MCP_API_KEY: "s3cret-token" }, async () => {
    const runtime = await createApp({ cwd, closeSqlPools: async () => {} });
    await runtime.stop();
  });
});

test("startup refuses anonymized targets when ANON_HASH_SALT is missing", async () => {
  const cwd = createWorkspace([devTarget(), prodAnonymizedTarget()]);
  await withEnv({}, async () => {
    await assert.rejects(createApp({ cwd, closeSqlPools: async () => {} }), /ANON_HASH_SALT is required.*prod-main/);
  });
  await withEnv({ ANON_HASH_SALT: "a-stable-secret" }, async () => {
    const runtime = await createApp({ cwd, closeSqlPools: async () => {} });
    await runtime.stop();
  });
});

test("stop flushes the anonymization catalog and logs flush failures", async () => {
  const cwd = createWorkspace([devTarget()]);
  const failures = [{ filePath: "/nowhere/catalog.json", error: new Error("EACCES: permission denied") }];
  let flushed = 0;
  const lines = [];
  const originalWrite = process.stderr.write;
  await withEnv({}, async () => {
    const runtime = await createApp({
      cwd,
      closeSqlPools: async () => {},
      flushCatalogs: () => {
        flushed += 1;
        return failures;
      }
    });
    process.stderr.write = chunk => {
      lines.push(String(chunk));
      return true;
    };
    try {
      await runtime.stop();
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  assert.equal(flushed, 1);
  const entry = lines.map(line => JSON.parse(line)).find(item => item.event === "anon.catalog_flush_failed");
  assert.equal(entry.payload.catalog_path, "/nowhere/catalog.json");
  assert.match(entry.payload.error, /EACCES/);
});

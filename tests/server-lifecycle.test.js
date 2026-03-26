import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server.js";

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "llm-sql-db-mcp-stop-"));
}

function writeTargetsFile(cwd) {
  fs.writeFileSync(
    path.join(cwd, "targets.json"),
    JSON.stringify({
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
        }
      ]
    }),
    "utf8"
  );
}

test("createApp.stop invokes SQL pool shutdown", async () => {
  const cwd = createTempDir();
  writeTargetsFile(cwd);
  let closeSqlPoolsCalls = 0;

  const runtime = await createApp({
    cwd,
    closeSqlPools: async () => {
      closeSqlPoolsCalls += 1;
    }
  });

  await runtime.stop();

  assert.equal(closeSqlPoolsCalls, 1);
});

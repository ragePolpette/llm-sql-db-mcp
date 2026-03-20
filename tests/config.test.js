import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRuntimeConfig } from "../src/lib/config.js";

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "llm-sql-db-mcp-config-"));
}

test("loadRuntimeConfig returns defaults when no .env is present", () => {
  const cwd = createTempDir();
  const config = loadRuntimeConfig({
    cwd,
    env: {}
  });

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 3000);
  assert.equal(path.basename(config.targetsFile), "targets.json");
  assert.equal(config.sessionTtlMs, 0);
});

test("loadRuntimeConfig rejects forbidden secrets in project .env", () => {
  const cwd = createTempDir();
  fs.writeFileSync(
    path.join(cwd, ".env"),
    "DB_DEV_MAIN_CONNECTION_STRING=Server=.;Database=Test;\n",
    "utf8"
  );

  assert.throws(
    () => loadRuntimeConfig({ cwd, env: {} }),
    /Forbidden secret keys/i
  );
});

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
  assert.equal(config.readinessPath, "/ready");
  assert.equal(path.basename(config.targetsFile), "targets.json");
  assert.equal(config.sessionTtlMs, 1_800_000);
  assert.equal(config.providers.fieldIdentification, "hybrid");
  assert.equal(config.providers.timeoutMs, 5000);
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

test("loadRuntimeConfig parses LOG_LEVEL and rejects unsupported values", () => {
  const cwd = createTempDir();
  const config = loadRuntimeConfig({
    cwd,
    env: {
      LOG_LEVEL: "debug"
    }
  });

  assert.equal(config.logLevel, "debug");
  assert.throws(
    () => loadRuntimeConfig({ cwd, env: { LOG_LEVEL: "trace" } }),
    /LOG_LEVEL must be one of/
  );
});

test("loadRuntimeConfig allows explicit SESSION_TTL_MS=0 to disable expiry", () => {
  const cwd = createTempDir();
  const config = loadRuntimeConfig({
    cwd,
    env: {
      SESSION_TTL_MS: "0"
    }
  });

  assert.equal(config.sessionTtlMs, 0);
});

test("loadRuntimeConfig exposes SQL timeout and pool settings", () => {
  const cwd = createTempDir();
  const config = loadRuntimeConfig({
    cwd,
    env: {
      DB_CONNECTION_TIMEOUT_MS: "12000",
      DB_REQUEST_TIMEOUT_MS: "22000",
      DB_POOL_MAX: "15",
      DB_POOL_MIN: "2",
      DB_POOL_IDLE_TIMEOUT_MS: "45000"
    }
  });

  assert.deepEqual(config.sqlServer, {
    connectionTimeoutMs: 12000,
    requestTimeoutMs: 22000,
    pool: {
      max: 15,
      min: 2,
      idleTimeoutMs: 45000
    }
  });
});

test("loadRuntimeConfig rejects invalid SQL timeout and pool settings", () => {
  const cwd = createTempDir();

  assert.throws(
    () => loadRuntimeConfig({ cwd, env: { DB_CONNECTION_TIMEOUT_MS: "0" } }),
    /DB_CONNECTION_TIMEOUT_MS must be greater than zero/
  );
  assert.throws(
    () => loadRuntimeConfig({ cwd, env: { DB_REQUEST_TIMEOUT_MS: "-1" } }),
    /DB_REQUEST_TIMEOUT_MS must be greater than zero/
  );
  assert.throws(
    () => loadRuntimeConfig({ cwd, env: { DB_POOL_MAX: "1", DB_POOL_MIN: "2" } }),
    /DB_POOL_MAX must be greater than or equal to DB_POOL_MIN/
  );
});

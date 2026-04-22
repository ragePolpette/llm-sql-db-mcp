import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadTargetRegistry } from "../src/lib/target-registry.js";

function writeTempTargetsFile(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-sql-db-mcp-targets-"));
  const filePath = path.join(dir, "targets.json");
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  return filePath;
}

test("loadTargetRegistry loads valid SQL Server targets", async () => {
  const filePath = writeTempTargetsFile({
    targets: [
      {
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
        max_rows: 100,
        max_result_bytes: 1024,
        allowed_tools: ["db_target_info", "db_policy_info", "db_read"]
      }
    ]
  });

  const registry = await loadTargetRegistry(filePath);
  assert.equal(registry.size, 1);
  assert.equal(registry.get("dev-main").db_kind, "sqlserver");
});

test("loadTargetRegistry rejects duplicate target ids", async () => {
  const filePath = writeTempTargetsFile({
    targets: [
      {
        target_id: "dup",
        display_name: "One",
        environment: "dev",
        db_kind: "sqlserver",
        status: "active",
        connection_env_var: "DB_ONE_CONNECTION_STRING",
        read_enabled: true,
        write_enabled: false,
        anonymization_enabled: false,
        anonymization_mode: "off",
        llm_provider: "none",
        llm_model: "",
        max_rows: 100,
        max_result_bytes: 1024,
        allowed_tools: ["db_target_info", "db_policy_info", "db_read"]
      },
      {
        target_id: "dup",
        display_name: "Two",
        environment: "prod",
        db_kind: "sqlserver",
        status: "active",
        connection_env_var: "DB_TWO_CONNECTION_STRING",
        read_enabled: true,
        write_enabled: false,
        anonymization_enabled: true,
        anonymization_mode: "hybrid",
        llm_provider: "lmstudio",
        llm_model: "gemma",
        max_rows: 100,
        max_result_bytes: 1024,
        allowed_tools: ["db_target_info", "db_policy_info", "db_read"]
      }
    ]
  });

  await assert.rejects(
    () => loadTargetRegistry(filePath),
    /Duplicate target_id/i
  );
});

test("loadTargetRegistry accepts deterministic and llm-strict anonymization modes", async () => {
  const filePath = writeTempTargetsFile({
    targets: [
      {
        target_id: "prod-det",
        display_name: "Prod Deterministic",
        environment: "prod",
        db_kind: "sqlserver",
        status: "active",
        connection_env_var: "DB_PROD_DET_CONNECTION_STRING",
        read_enabled: true,
        write_enabled: false,
        anonymization_enabled: true,
        anonymization_mode: "deterministic",
        llm_provider: "lmstudio",
        llm_model: "gemma",
        max_rows: 100,
        max_result_bytes: 1024,
        allowed_tools: ["db_target_info", "db_policy_info", "db_read"]
      },
      {
        target_id: "prod-strict",
        display_name: "Prod Strict",
        environment: "prod",
        db_kind: "sqlserver",
        status: "active",
        connection_env_var: "DB_PROD_STRICT_CONNECTION_STRING",
        read_enabled: true,
        write_enabled: false,
        anonymization_enabled: true,
        anonymization_mode: "llm-strict",
        llm_provider: "ollama",
        llm_model: "gemma3:4b",
        max_rows: 100,
        max_result_bytes: 1024,
        allowed_tools: ["db_target_info", "db_policy_info", "db_read"]
      }
    ]
  });

  const registry = await loadTargetRegistry(filePath);
  assert.equal(registry.get("prod-det").anonymization_mode, "deterministic");
  assert.equal(registry.get("prod-strict").anonymization_mode, "llm-strict");
});

test("loadTargetRegistry applies per-target env overrides", async () => {
  const filePath = writeTempTargetsFile({
    targets: [
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
        llm_model: "google/gemma-3-4b",
        max_rows: 100,
        max_result_bytes: 1024,
        allowed_tools: ["db_target_info", "db_policy_info", "db_read"]
      }
    ]
  });

  const registry = await loadTargetRegistry(filePath, {
    env: {
      TARGET_PROD_MAIN_WRITE_ENABLED: "true",
      TARGET_PROD_MAIN_ANONYMIZATION_ENABLED: "false",
      TARGET_PROD_MAIN_LLM_PROVIDER: "ollama",
      TARGET_PROD_MAIN_LLM_MODEL: "gemma3:4b"
    }
  });

  const target = registry.get("prod-main");
  assert.equal(target.write_enabled, true);
  assert.equal(target.anonymization_enabled, false);
  assert.equal(target.anonymization_mode, "off");
  assert.equal(target.llm_provider, "none");
  assert.equal(target.llm_model, "");
});

test("loadTargetRegistry accepts dashboard runtime export aliases for llm provider and model", async () => {
  const filePath = writeTempTargetsFile({
    version: 1,
    publisher: "mcp-dashboard",
    service_id: "llm-sql-db-mcp",
    apply_strategy: "restart_or_start",
    generated_at: "2026-04-10T09:00:00+02:00",
    target_count: 1,
    active_target_count: 1,
    targets: [
      {
        target_id: "prod-main",
        display_name: "Prod Main",
        environment: "prod",
        db_kind: "sqlserver",
        status: "active",
        connection_env_var: "DB_PROD_MAIN_CONNECTION_STRING",
        connection_vault_ref: "vault://db.prod.main",
        read_enabled: true,
        write_enabled: false,
        write_policy: "deny",
        anonymization_enabled: true,
        anonymization_mode: "hybrid",
        anonymization_provider: "lmstudio",
        anonymization_model: "google/gemma-3-4b",
        max_rows: 100,
        max_result_bytes: 1024,
        allowed_tools: ["db_target_info", "db_policy_info", "db_read"],
        state: {
          runtime_status: "ready",
          last_synced_at: "2026-04-10T09:00:00+02:00",
          last_error: null
        }
      }
    ]
  });

  const registry = await loadTargetRegistry(filePath);
  const target = registry.get("prod-main");
  assert.equal(target.llm_provider, "lmstudio");
  assert.equal(target.llm_model, "google/gemma-3-4b");
  assert.equal(target.anonymization_mode, "hybrid");
  assert.equal(target.state.runtime_status, "ready");
});

test("loadTargetRegistry preserves optional runtime state exported by the dashboard", async () => {
  const filePath = writeTempTargetsFile({
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
  });

  const registry = await loadTargetRegistry(filePath);
  const target = registry.get("dev-main");
  assert.equal(target.state.runtime_status, "vault_locked");
  assert.equal(target.state.last_error, "Vault bloccato");
});

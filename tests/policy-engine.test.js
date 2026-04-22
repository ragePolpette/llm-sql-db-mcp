import test from "node:test";
import assert from "node:assert/strict";
import { buildPolicyInfo, evaluateToolPolicy, toSafeTargetInfo, toSafeTargetSummary } from "../src/lib/policy-engine.js";

const activeProdTarget = {
  target_id: "prod-main",
  status: "active",
  read_enabled: true,
  write_enabled: false,
  anonymization_enabled: true,
  allowed_tools: ["db_target_info", "db_policy_info", "db_read", "db_write"]
};

test("evaluateToolPolicy enables db_read and requires anonymization for anonymized targets", () => {
  const policy = evaluateToolPolicy({
    target: activeProdTarget,
    toolName: "db_read"
  });

  assert.equal(policy.allowed, true);
  assert.equal(policy.anonymization_required, true);
  assert.equal(policy.denial_reason, null);
});

test("evaluateToolPolicy denies disabled targets", () => {
  const policy = evaluateToolPolicy({
    target: {
      ...activeProdTarget,
      status: "disabled"
    },
    toolName: "db_read"
  });

  assert.equal(policy.allowed, false);
  assert.match(policy.denial_reason, /disabled/i);
});

test("buildPolicyInfo returns all target-scoped policies when tool_name is omitted", () => {
  const info = buildPolicyInfo(activeProdTarget);
  assert.equal(info.tool_name, null);
  assert.equal(info.available_policies.length, 4);
  assert.equal(info.available_policies.find(item => item.tool_name === "db_read").anonymization_required, true);
});

test("evaluateToolPolicy denies db_write when write is disabled", () => {
  const policy = evaluateToolPolicy({
    target: activeProdTarget,
    toolName: "db_write"
  });

  assert.equal(policy.allowed, false);
  assert.match(policy.denial_reason, /Write access is disabled/i);
});

test("safe target views expose runtime_status when present", () => {
  const target = {
    ...activeProdTarget,
    display_name: "Prod Main",
    environment: "prod",
    db_kind: "sqlserver",
    llm_provider: "lmstudio",
    llm_model: "gemma",
    anonymization_mode: "hybrid",
    max_rows: 100,
    max_result_bytes: 1024,
    state: {
      runtime_status: "vault_locked",
      last_error: "Vault bloccato"
    }
  };

  assert.equal(toSafeTargetSummary(target).runtime_status, "vault_locked");
  assert.equal(toSafeTargetInfo(target).runtime_status, "vault_locked");
});

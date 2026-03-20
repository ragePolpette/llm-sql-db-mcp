import test from "node:test";
import assert from "node:assert/strict";
import { buildPolicyInfo, evaluateToolPolicy } from "../src/lib/policy-engine.js";

const activeProdTarget = {
  target_id: "prod-main",
  status: "active",
  read_enabled: true,
  anonymization_enabled: true,
  allowed_tools: ["db_target_info", "db_policy_info", "db_read"]
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
  assert.equal(info.available_policies.length, 3);
  assert.equal(info.available_policies.find(item => item.tool_name === "db_read").anonymization_required, true);
});

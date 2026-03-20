const TARGET_SCOPED_TOOLS = ["db_target_info", "db_policy_info", "db_read", "db_write"];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function toSafeTargetSummary(target) {
  return {
    target_id: target.target_id,
    display_name: target.display_name,
    environment: target.environment,
    db_kind: target.db_kind,
    status: target.status,
    read_enabled: target.read_enabled,
    write_enabled: target.write_enabled,
    anonymization_enabled: target.anonymization_enabled,
    llm_provider: target.llm_provider,
    llm_model: target.llm_model
  };
}

export function toSafeTargetInfo(target) {
  return {
    ...toSafeTargetSummary(target),
    allowed_tools: clone(target.allowed_tools),
    anonymization_mode: target.anonymization_mode,
    effective_limits: {
      max_rows: target.max_rows,
      max_result_bytes: target.max_result_bytes
    }
  };
}

export function getTargetScopedTools() {
  return [...TARGET_SCOPED_TOOLS];
}

export function evaluateToolPolicy({ target, toolName }) {
  const normalizedToolName = toolName ?? null;

  if (!target) {
    return {
      tool_name: normalizedToolName,
      allowed: false,
      anonymization_required: false,
      denial_reason: "Unknown target_id."
    };
  }

  if (!normalizedToolName) {
    return {
      tool_name: null,
      allowed: null,
      anonymization_required: null,
      denial_reason: null
    };
  }

  if (!TARGET_SCOPED_TOOLS.includes(normalizedToolName)) {
    return {
      tool_name: normalizedToolName,
      allowed: false,
      anonymization_required: false,
      denial_reason: `Unknown tool_name: ${normalizedToolName}`
    };
  }

  if (target.status !== "active") {
    return {
      tool_name: normalizedToolName,
      allowed: false,
      anonymization_required: false,
      denial_reason: `Target "${target.target_id}" is disabled.`
    };
  }

  if (!target.allowed_tools.includes(normalizedToolName)) {
    return {
      tool_name: normalizedToolName,
      allowed: false,
      anonymization_required: false,
      denial_reason: `Tool "${normalizedToolName}" is not allowed for target "${target.target_id}".`
    };
  }

  if (normalizedToolName === "db_read" && !target.read_enabled) {
    return {
      tool_name: normalizedToolName,
      allowed: false,
      anonymization_required: false,
      denial_reason: `Read access is disabled for target "${target.target_id}".`
    };
  }

  if (normalizedToolName === "db_write" && !target.write_enabled) {
    return {
      tool_name: normalizedToolName,
      allowed: false,
      anonymization_required: false,
      denial_reason: `Write access is disabled for target "${target.target_id}".`
    };
  }

  return {
    tool_name: normalizedToolName,
    allowed: true,
    anonymization_required: normalizedToolName === "db_read" && target.anonymization_enabled,
    denial_reason: null
  };
}

export function buildPolicyInfo(target, toolName) {
  const basePolicy = evaluateToolPolicy({ target, toolName });

  if (!target) {
    return {
      target_id: null,
      available_policies: [],
      ...basePolicy
    };
  }

  if (toolName) {
    return {
      target_id: target.target_id,
      available_policies: [],
      ...basePolicy
    };
  }

  return {
    target_id: target.target_id,
    tool_name: null,
    allowed: null,
    anonymization_required: null,
    denial_reason: null,
    available_policies: TARGET_SCOPED_TOOLS.map(name => ({
      ...evaluateToolPolicy({ target, toolName: name })
    }))
  };
}

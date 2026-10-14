import fs from "node:fs/promises";
import * as z from "zod";

const allowedProviders = ["none", "lmstudio", "ollama"];
const allowedStatuses = ["active", "disabled"];
const allowedAnonymizationTrust = ["corroborated", "strict"];
const allowedAnonymizationModes = ["off", "direct", "deterministic", "hybrid", "llm-strict"];
export const TARGET_ENVIRONMENTS = ["dev", "test", "qa", "uat", "staging", "prod"];
export const PRODUCTION_ENVIRONMENT = "prod";
const ENVIRONMENT_ALIASES = new Map([
  ["development", "dev"],
  ["production", "prod"]
]);
const targetStateSchema = z.object({
  runtime_status: z.string().min(1).optional(),
  last_synced_at: z.string().nullable().optional(),
  last_error: z.string().nullable().optional()
}).optional();

const targetSchema = z
  .object({
    target_id: z.string().min(1),
    display_name: z.string().min(1),
    environment: z.enum(TARGET_ENVIRONMENTS),
    db_kind: z.literal("sqlserver"),
    status: z.enum(allowedStatuses),
    connection_env_var: z.string().min(1).regex(/^[A-Z0-9_]+$/),
    read_enabled: z.boolean(),
    write_enabled: z.boolean(),
    anonymization_enabled: z.boolean(),
    anonymization_mode: z.enum(allowedAnonymizationModes),
    anonymization_trust: z.enum(allowedAnonymizationTrust).default("corroborated"),
    llm_provider: z.enum(allowedProviders),
    llm_model: z.string(),
    max_rows: z.number().int().positive(),
    max_result_bytes: z.number().int().positive().nullable(),
    allowed_tools: z.array(z.string().min(1)).default([]),
    state: targetStateSchema
  })
  .superRefine((target, ctx) => {
    if (!target.anonymization_enabled) {
      if (target.anonymization_mode !== "off") {
        ctx.addIssue({
          code: "custom",
          message: "anonymization_mode must be \"off\" when anonymization is disabled.",
          path: ["anonymization_mode"]
        });
      }

      if (target.llm_provider !== "none") {
        ctx.addIssue({
          code: "custom",
          message: "llm_provider must be \"none\" when anonymization is disabled.",
          path: ["llm_provider"]
        });
      }

      if (target.llm_model !== "") {
        ctx.addIssue({
          code: "custom",
          message: "llm_model must be empty when anonymization is disabled.",
          path: ["llm_model"]
        });
      }
    }

    if (target.anonymization_enabled && target.llm_provider === "none") {
      ctx.addIssue({
        code: "custom",
        message: "llm_provider cannot be \"none\" when anonymization is enabled.",
        path: ["llm_provider"]
      });
    }
  });

const targetsFileSchema = z.object({
  targets: z.array(targetSchema)
});

function ensureUniqueTargetIds(targets) {
  const seen = new Set();

  for (const target of targets) {
    if (seen.has(target.target_id)) {
      throw new Error(`Duplicate target_id detected: ${target.target_id}`);
    }

    seen.add(target.target_id);
  }
}

function normalizeTargetEnvPrefix(targetId) {
  return `TARGET_${String(targetId || "")
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()}`;
}

function parseBooleanOverride(value, label) {
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${label} must be a boolean value.`);
}

function normalizeEnvironment(environment) {
  if (typeof environment !== "string") {
    return environment;
  }

  const normalized = environment.trim().toLowerCase();
  return ENVIRONMENT_ALIASES.get(normalized) ?? normalized;
}

export function isProductionTarget(target) {
  return normalizeEnvironment(target?.environment) === PRODUCTION_ENVIRONMENT;
}

function normalizeRuntimeTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return target;
  }

  const nextTarget = { ...target };
  nextTarget.environment = normalizeEnvironment(nextTarget.environment);

  if (nextTarget.llm_provider === undefined && nextTarget.anonymization_provider !== undefined) {
    nextTarget.llm_provider = nextTarget.anonymization_provider;
  }

  if (nextTarget.llm_model === undefined && nextTarget.anonymization_model !== undefined) {
    nextTarget.llm_model = nextTarget.anonymization_model;
  }

  return nextTarget;
}

function applyTargetEnvOverrides(target, env, warn) {
  const prefix = normalizeTargetEnvPrefix(target.target_id);
  const nextTarget = { ...target };
  const production = isProductionTarget(target);

  const readEnabled = env[`${prefix}_READ_ENABLED`];
  if (readEnabled !== undefined && readEnabled !== "") {
    nextTarget.read_enabled = parseBooleanOverride(readEnabled, `${prefix}_READ_ENABLED`);
  }

  const writeEnabled = env[`${prefix}_WRITE_ENABLED`];
  if (writeEnabled !== undefined && writeEnabled !== "") {
    const parsed = parseBooleanOverride(writeEnabled, `${prefix}_WRITE_ENABLED`);
    if (production && parsed) {
      warn("target.prod_override_ignored", {
        target_id: target.target_id,
        env_var: `${prefix}_WRITE_ENABLED`,
        reason: "Write access is always disabled for prod targets."
      });
    } else {
      nextTarget.write_enabled = parsed;
    }
  }

  const anonymizationEnabled = env[`${prefix}_ANONYMIZATION_ENABLED`];
  if (anonymizationEnabled !== undefined && anonymizationEnabled !== "") {
    const parsed = parseBooleanOverride(anonymizationEnabled, `${prefix}_ANONYMIZATION_ENABLED`);
    if (production && !parsed && nextTarget.anonymization_enabled) {
      warn("target.prod_override_ignored", {
        target_id: target.target_id,
        env_var: `${prefix}_ANONYMIZATION_ENABLED`,
        reason: "Anonymization on a prod target can only be disabled in the targets file."
      });
    } else {
      nextTarget.anonymization_enabled = parsed;
    }
    if (!nextTarget.anonymization_enabled) {
      nextTarget.anonymization_mode = "off";
      nextTarget.llm_provider = "none";
      nextTarget.llm_model = "";
    }
  }

  const anonymizationMode = env[`${prefix}_ANONYMIZATION_MODE`];
  if (anonymizationMode !== undefined && anonymizationMode !== "") {
    nextTarget.anonymization_mode = String(anonymizationMode).trim().toLowerCase();
  }

  const trust = env[`${prefix}_ANONYMIZATION_TRUST`];
  if (trust !== undefined && trust !== "") {
    nextTarget.anonymization_trust = String(trust).trim().toLowerCase();
  }

  const provider = env[`${prefix}_LLM_PROVIDER`];
  if (provider !== undefined && provider !== "") {
    nextTarget.llm_provider = String(provider).trim().toLowerCase();
  }

  const model = env[`${prefix}_LLM_MODEL`];
  if (model !== undefined) {
    nextTarget.llm_model = String(model).trim();
  }

  if (!nextTarget.anonymization_enabled) {
    nextTarget.anonymization_mode = "off";
    nextTarget.llm_provider = "none";
    nextTarget.llm_model = "";
  }

  return nextTarget;
}

// Production targets are read-only regardless of what the targets file or the environment say.
export function applyProductionFence(target, warn = () => {}) {
  if (!isProductionTarget(target)) {
    return target;
  }

  const nextTarget = { ...target };
  if (nextTarget.write_enabled) {
    warn("target.prod_write_disabled", {
      target_id: target.target_id,
      reason: "write_enabled forced to false for a prod target."
    });
    nextTarget.write_enabled = false;
  }

  if (Array.isArray(nextTarget.allowed_tools) && nextTarget.allowed_tools.includes("db_write")) {
    warn("target.prod_write_tool_removed", {
      target_id: target.target_id,
      reason: "db_write removed from allowed_tools for a prod target."
    });
    nextTarget.allowed_tools = nextTarget.allowed_tools.filter(tool => tool !== "db_write");
  }

  return nextTarget;
}

function warnAboutUnmaskedProductionTargets(targets, warn) {
  for (const target of targets) {
    if (isProductionTarget(target) && target.status === "active" && !target.anonymization_enabled) {
      warn("target.prod_anonymization_disabled", {
        target_id: target.target_id,
        reason: "Anonymization is disabled for an active prod target: query results are returned unmasked."
      });
    }
  }
}

export class TargetRegistry {
  #targets;
  #targetMap;

  constructor(targets) {
    ensureUniqueTargetIds(targets);
    this.#targets = structuredClone(targets).map(target => applyProductionFence(target));
    this.#targetMap = new Map(this.#targets.map(target => [target.target_id, target]));
  }

  list() {
    return structuredClone(this.#targets);
  }

  get(targetId) {
    const target = this.#targetMap.get(targetId);
    return target ? structuredClone(target) : undefined;
  }

  require(targetId) {
    const target = this.get(targetId);
    if (!target) {
      throw new Error(`Unknown target_id: ${targetId}`);
    }

    return target;
  }

  get size() {
    return this.#targets.length;
  }
}

export async function loadTargetRegistry(targetsFilePath, { env = process.env, logger = null } = {}) {
  const warn = (event, payload) => logger?.warn?.(event, payload);
  let rawFile;
  try {
    rawFile = await fs.readFile(targetsFilePath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read targets file at ${targetsFilePath}: ${error.message}`, { cause: error });
  }

  let parsedJson;
  try {
    parsedJson = JSON.parse(rawFile);
  } catch (error) {
    throw new Error(`targets.json is not valid JSON: ${error.message}`, { cause: error });
  }

  // Legacy environment override names collapse punctuation/case. Reject an
  // ambiguous override instead of silently applying it to multiple targets.
  const prefixes = new Set();
  for (const target of Array.isArray(parsedJson?.targets) ? parsedJson.targets : []) {
    const prefix = normalizeTargetEnvPrefix(target.target_id);
    if (prefixes.has(prefix) && Object.keys(env).some(key => key.startsWith(`${prefix}_`) && env[key] !== "" && env[key] !== undefined)) {
      throw new Error(`Ambiguous target environment override prefix: ${prefix}`);
    }
    prefixes.add(prefix);
  }
  const rawTargets = Array.isArray(parsedJson?.targets)
    ? parsedJson.targets.map(target => applyTargetEnvOverrides(normalizeRuntimeTarget(target), env, warn))
    : parsedJson?.targets;

  const parsed = targetsFileSchema.safeParse({
    ...parsedJson,
    targets: rawTargets
  });
  if (!parsed.success) {
    throw new Error(`Invalid targets configuration: ${parsed.error.message}`);
  }

  const targets = parsed.data.targets.map(target => applyProductionFence(target, warn));
  warnAboutUnmaskedProductionTargets(targets, warn);
  return new TargetRegistry(targets);
}

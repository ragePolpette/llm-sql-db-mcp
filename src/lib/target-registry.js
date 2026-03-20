import fs from "node:fs/promises";
import { z } from "zod";

const allowedProviders = ["none", "lmstudio", "ollama"];
const allowedStatuses = ["active", "disabled"];
const allowedAnonymizationModes = ["off", "direct", "hybrid"];

const targetSchema = z
  .object({
    target_id: z.string().min(1),
    display_name: z.string().min(1),
    environment: z.string().min(1),
    db_kind: z.literal("sqlserver"),
    status: z.enum(allowedStatuses),
    connection_env_var: z.string().min(1).regex(/^[A-Z0-9_]+$/),
    read_enabled: z.boolean(),
    write_enabled: z.literal(false),
    anonymization_enabled: z.boolean(),
    anonymization_mode: z.enum(allowedAnonymizationModes),
    llm_provider: z.enum(allowedProviders),
    llm_model: z.string(),
    max_rows: z.number().int().positive(),
    max_result_bytes: z.number().int().positive(),
    allowed_tools: z.array(z.string().min(1)).default([])
  })
  .superRefine((target, ctx) => {
    if (!target.anonymization_enabled) {
      if (target.anonymization_mode !== "off") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "anonymization_mode must be \"off\" when anonymization is disabled.",
          path: ["anonymization_mode"]
        });
      }

      if (target.llm_provider !== "none") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "llm_provider must be \"none\" when anonymization is disabled.",
          path: ["llm_provider"]
        });
      }

      if (target.llm_model !== "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "llm_model must be empty when anonymization is disabled.",
          path: ["llm_model"]
        });
      }
    }

    if (target.anonymization_enabled && target.llm_provider === "none") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
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

export class TargetRegistry {
  #targets;
  #targetMap;

  constructor(targets) {
    ensureUniqueTargetIds(targets);
    this.#targets = targets.map(target => ({ ...target }));
    this.#targetMap = new Map(this.#targets.map(target => [target.target_id, target]));
  }

  list() {
    return this.#targets.map(target => ({ ...target }));
  }

  get(targetId) {
    const target = this.#targetMap.get(targetId);
    return target ? { ...target } : undefined;
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

export async function loadTargetRegistry(targetsFilePath) {
  let rawFile;
  try {
    rawFile = await fs.readFile(targetsFilePath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read targets file at ${targetsFilePath}: ${error.message}`);
  }

  let parsedJson;
  try {
    parsedJson = JSON.parse(rawFile);
  } catch (error) {
    throw new Error(`targets.json is not valid JSON: ${error.message}`);
  }

  const parsed = targetsFileSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(`Invalid targets configuration: ${parsed.error.message}`);
  }

  return new TargetRegistry(parsed.data.targets);
}

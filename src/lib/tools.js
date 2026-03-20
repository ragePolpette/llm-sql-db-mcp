import * as z from "zod/v4";
import { getTargetScopedTools } from "./policy-engine.js";

const targetSummarySchema = z.object({
  target_id: z.string(),
  display_name: z.string(),
  environment: z.string(),
  db_kind: z.literal("sqlserver"),
  status: z.string(),
  read_enabled: z.boolean(),
  write_enabled: z.boolean(),
  anonymization_enabled: z.boolean(),
  llm_provider: z.string(),
  llm_model: z.string()
});

const targetInfoSchema = targetSummarySchema.extend({
  allowed_tools: z.array(z.string()),
  anonymization_mode: z.string(),
  effective_limits: z.object({
    max_rows: z.number().int().positive(),
    max_result_bytes: z.number().int().positive()
  })
});

const policyRowSchema = z.object({
  tool_name: z.string(),
  allowed: z.boolean(),
  anonymization_required: z.boolean(),
  denial_reason: z.string().nullable()
});

export function registerFixedTools(server, handlers) {
  server.registerTool(
    "db_target_list",
    {
      title: "List Database Targets",
      description: "Return configured database targets with safe metadata only. No connection details or runtime secrets are exposed.",
      inputSchema: {},
      outputSchema: {
        targets: z.array(targetSummarySchema)
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    handlers.dbTargetList
  );

  server.registerTool(
    "db_target_info",
    {
      title: "Get Database Target Info",
      description: "Return the safe metadata, effective limits, allowed tools, and anonymization mode for a specific target_id.",
      inputSchema: {
        target_id: z.string().min(1).describe("Target identifier from db_target_list. No implicit default target is used.")
      },
      outputSchema: {
        target_id: z.string(),
        display_name: z.string(),
        environment: z.string(),
        db_kind: z.literal("sqlserver"),
        status: z.string(),
        read_enabled: z.boolean(),
        write_enabled: z.boolean(),
        anonymization_enabled: z.boolean(),
        llm_provider: z.string(),
        llm_model: z.string(),
        allowed_tools: z.array(z.string()),
        anonymization_mode: z.string(),
        effective_limits: z.object({
          max_rows: z.number().int().positive(),
          max_result_bytes: z.number().int().positive()
        })
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    handlers.dbTargetInfo
  );

  server.registerTool(
    "db_policy_info",
    {
      title: "Get Database Policy Info",
      description: "Explain whether a tool is allowed for a target_id, whether anonymization would be required, and why access would be denied.",
      inputSchema: {
        target_id: z.string().min(1).describe("Target identifier to evaluate."),
        tool_name: z
          .enum(getTargetScopedTools())
          .optional()
          .describe("Optional tool name to evaluate. Omit it to return the policy view for all target-scoped tools.")
      },
      outputSchema: {
        target_id: z.string().nullable(),
        tool_name: z.string().nullable(),
        allowed: z.boolean().nullable(),
        anonymization_required: z.boolean().nullable(),
        denial_reason: z.string().nullable(),
        available_policies: z.array(policyRowSchema)
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    handlers.dbPolicyInfo
  );
}

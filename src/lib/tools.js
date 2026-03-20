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

  server.registerTool(
    "db_read",
    {
      title: "Execute Read-Only SQL",
      description: "Execute a read-only SQL Server query for a specific target_id. Only SELECT statements and read-safe CTEs are allowed.",
      inputSchema: {
        target_id: z.string().min(1).describe("Target identifier to query."),
        sql: z.string().min(1).describe("Read-only SQL text. Write, DDL, and multi-statement input is rejected."),
        parameters: z
          .record(
            z.string(),
            z.union([z.string(), z.number(), z.boolean(), z.null()])
          )
          .optional()
          .describe("Optional named SQL parameters."),
        max_rows: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optional row cap. The server clamps it to the target limit.")
      },
      outputSchema: {
        target_id: z.string(),
        sql: z.string(),
        anonymization_applied: z.boolean(),
        anonymization_provider: z.string(),
        anonymization_mode: z.string(),
        columns: z.array(
          z.object({
            name: z.string(),
            nullable: z.boolean(),
            type: z.string()
          })
        ),
        rows: z.array(z.record(z.string(), z.unknown())),
        row_count: z.number().int().nonnegative(),
        total_rows_before_limits: z.number().int().nonnegative(),
        max_rows_applied: z.number().int().positive(),
        max_result_bytes_applied: z.number().int().positive(),
        result_bytes: z.number().int().nonnegative(),
        truncated: z.boolean(),
        duration_ms: z.number().int().nonnegative()
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    },
    handlers.dbRead
  );

  server.registerTool(
    "db_write",
    {
      title: "Execute Write SQL",
      description: "Execute a write SQL Server statement for a specific target_id when the target policy enables write access. Supports INSERT, UPDATE, DELETE, MERGE, and write CTE statements only.",
      inputSchema: {
        target_id: z.string().min(1).describe("Target identifier to query."),
        sql: z.string().min(1).describe("Write SQL text. DDL, EXEC, SELECT INTO, and multi-statement input is rejected."),
        parameters: z
          .record(
            z.string(),
            z.union([z.string(), z.number(), z.boolean(), z.null()])
          )
          .optional()
          .describe("Optional named SQL parameters.")
      },
      outputSchema: {
        target_id: z.string(),
        sql: z.string(),
        columns: z.array(
          z.object({
            name: z.string(),
            nullable: z.boolean(),
            type: z.string()
          })
        ),
        rows: z.array(z.record(z.string(), z.unknown())),
        row_count: z.number().int().nonnegative(),
        rows_affected: z.number().int().nonnegative(),
        max_result_bytes_applied: z.number().int().positive(),
        result_bytes: z.number().int().nonnegative(),
        truncated: z.boolean(),
        duration_ms: z.number().int().nonnegative()
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false
      }
    },
    handlers.dbWrite
  );
}

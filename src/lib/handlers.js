import {
  buildPolicyInfo,
  evaluateToolPolicy,
  toSafeTargetInfo,
  toSafeTargetSummary
} from "./policy-engine.js";
import { assertReadSafeSql } from "./sql-guard.js";

function createJsonResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ],
    structuredContent: payload
  };
}

function createErrorResult(message, details = {}) {
  const detailEntries = Object.entries(details);
  const detailSuffix =
    detailEntries.length === 0
      ? ""
      : `\n${JSON.stringify(details, null, 2)}`;

  return {
    content: [
      {
        type: "text",
        text: `${message}${detailSuffix}`
      }
    ],
    isError: true
  };
}

function resolveEffectiveMaxRows(requestedMaxRows, targetMaxRows) {
  if (!requestedMaxRows) {
    return targetMaxRows;
  }

  return Math.min(requestedMaxRows, targetMaxRows);
}

function getConnectionString(target, env) {
  const connectionString = env[target.connection_env_var];
  if (!connectionString) {
    throw new Error(
      `Missing runtime environment variable "${target.connection_env_var}" for target "${target.target_id}".`
    );
  }

  return connectionString;
}

export function createHandlers({
  targetRegistry,
  env = process.env,
  executeSqlRead,
  anonymizeQueryResult,
  providerConfig,
  fetchImpl = globalThis.fetch,
  logDbEvent = null
}) {
  return {
    async dbTargetList() {
      return createJsonResult({
        targets: targetRegistry.list().map(toSafeTargetSummary)
      });
    },

    async dbTargetInfo({ target_id: targetId }) {
      const target = targetRegistry.get(targetId);
      if (!target) {
        return createErrorResult(`Unknown target_id: ${targetId}`, {
          target_id: targetId
        });
      }

      if (target.status !== "active") {
        return createErrorResult(`Target "${targetId}" is disabled.`, {
          target_id: targetId,
          status: target.status
        });
      }

      return createJsonResult(toSafeTargetInfo(target));
    },

    async dbPolicyInfo({ target_id: targetId, tool_name: toolName }) {
      const target = targetRegistry.get(targetId);
      if (!target) {
        return createErrorResult(`Unknown target_id: ${targetId}`, {
          target_id: targetId
        });
      }

      return createJsonResult(buildPolicyInfo(target, toolName));
    },

    async dbRead({ target_id: targetId, sql, parameters = {}, max_rows: requestedMaxRows }) {
      const target = targetRegistry.get(targetId);
      if (!target) {
        return createErrorResult(`Unknown target_id: ${targetId}`, {
          target_id: targetId
        });
      }

      const policy = evaluateToolPolicy({
        target,
        toolName: "db_read"
      });

      if (!policy.allowed) {
        return createErrorResult(policy.denial_reason, {
          target_id: targetId,
          tool_name: "db_read"
        });
      }

      let normalizedSql;
      try {
        normalizedSql = assertReadSafeSql(sql);
      } catch (error) {
        return createErrorResult(error.message, {
          target_id: targetId,
          tool_name: "db_read"
        });
      }

      try {
        const connectionString = getConnectionString(target, env);
        const effectiveMaxRows = resolveEffectiveMaxRows(requestedMaxRows, target.max_rows);
        logDbEvent?.("query_in", {
          tool: "db_read",
          target_id: target.target_id,
          sql: normalizedSql,
          parameters,
          maxRows: effectiveMaxRows
        });
        const result = await executeSqlRead({
          connectionString,
          sqlText: normalizedSql,
          parameters,
          maxRows: effectiveMaxRows,
          maxResultBytes: target.max_result_bytes
        });

        const finalResult = policy.anonymization_required
          ? await anonymizeQueryResult({
              target,
              queryResult: {
                ...result,
                sql_text: normalizedSql
              },
              providerConfig,
              fetchImpl
            })
          : {
              ...result,
              sql_text: normalizedSql,
              anonymization_applied: false,
              anonymization_provider: "none",
              anonymization_mode: target.anonymization_mode
            };

        logDbEvent?.("query_out", {
          tool: "db_read",
          target_id: target.target_id,
          rowCount: finalResult.row_count,
          truncated: finalResult.truncated,
          anonymizationApplied: finalResult.anonymization_applied,
          anonymizationProvider: finalResult.anonymization_provider,
          anonymizationMode: finalResult.anonymization_mode,
          response: {
            success: true,
            rowCount: finalResult.row_count,
            truncated: finalResult.truncated,
            anonymizationApplied: finalResult.anonymization_applied,
            anonymizationProvider: finalResult.anonymization_provider,
            anonymizationMode: finalResult.anonymization_mode,
            rows: finalResult.rows
          }
        });

        return createJsonResult({
          target_id: target.target_id,
          sql: normalizedSql,
          ...finalResult
        });
      } catch (error) {
        return createErrorResult(error.message, {
          target_id: targetId,
          tool_name: "db_read"
        });
      }
    }
  };
}

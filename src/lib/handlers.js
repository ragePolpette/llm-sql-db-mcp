import {
  buildPolicyInfo,
  evaluateToolPolicy,
  toSafeTargetInfo,
  toSafeTargetSummary
} from "./policy-engine.js";
import { assertReadSafeSql, assertWriteSafeSql } from "./sql-guard.js";

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

function createErrorResult(message, { code = "tool_error", ...details } = {}) {
  const detailEntries = Object.entries(details);
  const detailSuffix =
    detailEntries.length === 0
      ? ""
      : `\n${JSON.stringify(details, null, 2)}`;
  const errorEnvelope = {
    error: {
      code,
      message,
      details
    }
  };

  return {
    content: [
      {
        type: "text",
        text: `${message}${detailSuffix}`
      },
      {
        type: "text",
        text: JSON.stringify(errorEnvelope)
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
function resolveDiagnosticTarget(targetRegistry, databaseTarget, explicitTargetId = null) {
  if (explicitTargetId) {
    const explicitTarget = targetRegistry.get(explicitTargetId);

    if (!explicitTarget) {
      return {
        target: null,
        blockers: [`Unknown target_id "${explicitTargetId}" for diagnostic query.`]
      };
    }

    if (explicitTarget.status !== "active") {
      return {
        target: null,
        blockers: [`Target "${explicitTargetId}" is not active and cannot be used for diagnostic query.`]
      };
    }

    if (explicitTarget.environment !== databaseTarget) {
      return {
        target: null,
        blockers: [
          `Target "${explicitTargetId}" belongs to environment "${explicitTarget.environment}", not "${databaseTarget}".`
        ]
      };
    }

    return {
      target: explicitTarget,
      blockers: []
    };
  }

  const matches = targetRegistry.list().filter(target => target.environment === databaseTarget);
  const activeMatches = matches.filter(target => target.status === "active");

  if (activeMatches.length === 0) {
    return {
      target: null,
      blockers: [`No active target found for database_target "${databaseTarget}".`]
    };
  }

  if (activeMatches.length > 1) {
    const matchedTargetIds = [...activeMatches]
      .map(target => target.target_id)
      .sort((left, right) => left.localeCompare(right));
    return {
      target: null,
      blockers: [
        `Multiple active targets matched database_target "${databaseTarget}": ${matchedTargetIds.join(", ")}. Use db_target_list and call db_read with an explicit target_id.`
      ]
    };
  }

  return {
    target: activeMatches[0],
    blockers: []
  };
}

function normalizeDiagnosticMetadataValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function createDiagnosticSummary({ target, databaseTarget, ticketKey, result }) {
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const columns = Array.isArray(result?.columns) ? result.columns : [];

  return {
    target_id: target?.target_id ?? null,
    database_target: databaseTarget,
    ticket_key: normalizeDiagnosticMetadataValue(ticketKey),
    row_count: result?.row_count ?? 0,
    total_rows_before_limits: result?.total_rows_before_limits ?? 0,
    truncated: result?.truncated ?? false,
    anonymization_applied: result?.anonymization_applied ?? false,
    anonymization_provider: result?.anonymization_provider ?? 'none',
    column_names: columns.map(column => column.name),
    sample_rows: rows.slice(0, 3),
    duration_ms: result?.duration_ms ?? 0
  };
}

function extractBlockerText(result) {
  const text = result?.content?.[0]?.text;
  return typeof text === 'string' && text.trim() ? text.trim() : 'Diagnostic query failed.';
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

function getTargetRuntimeStatus(target) {
  return String(target?.state?.runtime_status || "").trim().toLowerCase();
}

function getTargetRuntimeBlocker(target) {
  const runtimeStatus = getTargetRuntimeStatus(target);
  if (!runtimeStatus || runtimeStatus === "ready") {
    return null;
  }

  const lastError = typeof target?.state?.last_error === "string" && target.state.last_error.trim()
    ? target.state.last_error.trim()
    : null;
  const statusDetail = lastError ? `${runtimeStatus}: ${lastError}` : runtimeStatus;
  return `Target "${target.target_id}" is not runtime-ready (${statusDetail}). Sync the dashboard runtime and restart/start the service before querying this target.`;
}

export function createHandlers({
  targetRegistry,
  env = process.env,
  executeSqlRead,
  executeSqlWrite,
  sqlDriverConfig = {},
  anonymizeQueryResult,
  providerConfig,
  fetchImpl = globalThis.fetch,
  logDbEvent = null
}) {
  const handlers = {
    async dbToolInfo() {
      return createJsonResult({
        server: "llm-sql-db-mcp",
        purpose: "Gateway target-based verso SQL Server con policy, anonimizzazione e diagnostica uniforme.",
        tool_map: {
          discovery: ["db_tool_info", "db_target_list", "db_target_info", "db_policy_info"],
          read: ["db_read", "run_diagnostic_query"],
          write: ["db_write"]
        },
        usage_notes: {
          db_target_list: "Punto di ingresso per vedere i target configurati senza esporre secret.",
          db_target_info: "Mostra limiti, anonimizzazione e tool consentiti per un target_id.",
          db_policy_info: "Spiega se un tool e' permesso e se richiede anonimizzazione.",
          db_read: "Usa target_id esplicito e solo SQL read-safe.",
          db_write: "Usa target_id esplicito; disponibile solo se il target abilita la write policy.",
          run_diagnostic_query:
            "Wrapper harness-friendly: risolve dev/prod su un target reale oppure usa target_id esplicito coerente con l'environment e normalizza l'output diagnostico."
        },
        target_selection_flow: [
          "Chiama db_target_list",
          "Scegli il target_id esplicito oppure usa run_diagnostic_query con database_target=dev|prod e target_id opzionale",
          "Verifica policy e limiti con db_target_info/db_policy_info prima di query sensibili"
        ],
        boundaries: [
          "Non espone connection string o altri secret runtime.",
          "Non usa target impliciti per db_read/db_write.",
          "I repo legacy llm-db-dev-mcp e llm-db-prod-mcp non fanno parte di questo contract."
        ]
      });
    },

    async dbTargetList() {
      return createJsonResult({
        targets: targetRegistry.list().map(toSafeTargetSummary)
      });
    },

    async dbTargetInfo({ target_id: targetId }) {
      const target = targetRegistry.get(targetId);
      if (!target) {
        return createErrorResult(`Unknown target_id: ${targetId}`, {
          code: "target_not_found",
          target_id: targetId
        });
      }

      if (target.status !== "active") {
        return createErrorResult(`Target "${targetId}" is disabled.`, {
          code: "target_disabled",
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
          code: "target_not_found",
          target_id: targetId
        });
      }

      return createJsonResult(buildPolicyInfo(target, toolName));
    },

    async dbRead({ target_id: targetId, sql, parameters = {}, max_rows: requestedMaxRows }) {
      const target = targetRegistry.get(targetId);
      if (!target) {
        return createErrorResult(`Unknown target_id: ${targetId}`, {
          code: "target_not_found",
          target_id: targetId
        });
      }

      const policy = evaluateToolPolicy({
        target,
        toolName: "db_read"
      });

      if (!policy.allowed) {
        return createErrorResult(policy.denial_reason, {
          code: "policy_denied",
          target_id: targetId,
          tool_name: "db_read"
        });
      }

      let normalizedSql;
      try {
        normalizedSql = assertReadSafeSql(sql);
      } catch (error) {
        return createErrorResult(error.message, {
          code: "invalid_sql",
          target_id: targetId,
          tool_name: "db_read"
        });
      }

      try {
        const runtimeBlocker = getTargetRuntimeBlocker(target);
        if (runtimeBlocker) {
          throw new Error(runtimeBlocker);
        }

        const connectionString = getConnectionString(target, env);
        const effectiveMaxRows = resolveEffectiveMaxRows(requestedMaxRows, target.max_rows);
        logDbEvent?.("query_in", {
          tool: "db_read",
          target_id: target.target_id,
          sql: normalizedSql,
          parameters,
          maxRows: effectiveMaxRows
        });
        logDbEvent?.("db_driver_start", {
          tool: "db_read",
          target_id: target.target_id,
          runtime_status: getTargetRuntimeStatus(target) || null
        });
        const result = await executeSqlRead({
          connectionString,
          sqlText: normalizedSql,
          parameters,
          maxRows: effectiveMaxRows,
          maxResultBytes: target.max_result_bytes,
          driverConfig: sqlDriverConfig
        });
        logDbEvent?.("db_driver_done", {
          tool: "db_read",
          target_id: target.target_id,
          rowCount: result.row_count,
          truncated: result.truncated,
          durationMs: result.duration_ms
        });

        const finalResult = policy.anonymization_required
          ? await (async () => {
              logDbEvent?.("anonymizer_start", {
                tool: "db_read",
                target_id: target.target_id,
                provider: target.llm_provider,
                mode: target.anonymization_mode
              });
              const anonymized = await anonymizeQueryResult({
                target,
                queryResult: {
                  ...result,
                  sql_text: normalizedSql
                },
                providerConfig,
                fetchImpl
              });
              logDbEvent?.("anonymizer_done", {
                tool: "db_read",
                target_id: target.target_id,
                provider: anonymized.anonymization_provider,
                mode: anonymized.anonymization_mode,
                rowCount: anonymized.row_count,
                truncated: anonymized.truncated
              });
              return anonymized;
            })()
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
        logDbEvent?.("query_failed", {
          tool: "db_read",
          target_id: target.target_id,
          error: error.message
        });
        return createErrorResult(error.message, {
          code: "db_read_failed",
          target_id: targetId,
          tool_name: "db_read"
        });
      }
    },

    async dbWrite({ target_id: targetId, sql, parameters = {} }) {
      const target = targetRegistry.get(targetId);
      if (!target) {
        return createErrorResult(`Unknown target_id: ${targetId}`, {
          code: "target_not_found",
          target_id: targetId
        });
      }

      const policy = evaluateToolPolicy({
        target,
        toolName: "db_write"
      });

      if (!policy.allowed) {
        return createErrorResult(policy.denial_reason, {
          code: "policy_denied",
          target_id: targetId,
          tool_name: "db_write"
        });
      }

      let normalizedSql;
      try {
        normalizedSql = assertWriteSafeSql(sql);
      } catch (error) {
        return createErrorResult(error.message, {
          code: "invalid_sql",
          target_id: targetId,
          tool_name: "db_write"
        });
      }

      try {
        const runtimeBlocker = getTargetRuntimeBlocker(target);
        if (runtimeBlocker) {
          throw new Error(runtimeBlocker);
        }

        const connectionString = getConnectionString(target, env);
        logDbEvent?.("query_in", {
          tool: "db_write",
          target_id: target.target_id,
          sql: normalizedSql,
          parameters
        });
        logDbEvent?.("db_driver_start", {
          tool: "db_write",
          target_id: target.target_id,
          runtime_status: getTargetRuntimeStatus(target) || null
        });

        const result = await executeSqlWrite({
          connectionString,
          sqlText: normalizedSql,
          parameters,
          maxResultBytes: target.max_result_bytes,
          driverConfig: sqlDriverConfig
        });
        logDbEvent?.("db_driver_done", {
          tool: "db_write",
          target_id: target.target_id,
          rowCount: result.row_count,
          rowsAffected: result.rows_affected,
          truncated: result.truncated,
          durationMs: result.duration_ms
        });

        logDbEvent?.("query_out", {
          tool: "db_write",
          target_id: target.target_id,
          rowCount: result.row_count,
          rowsAffected: result.rows_affected,
          truncated: result.truncated,
          response: {
            success: true,
            rowCount: result.row_count,
            rowsAffected: result.rows_affected,
            truncated: result.truncated,
            rows: result.rows
          }
        });

        return createJsonResult({
          target_id: target.target_id,
          sql: normalizedSql,
          ...result
        });
      } catch (error) {
        logDbEvent?.("query_failed", {
          tool: "db_write",
          target_id: target.target_id,
          error: error.message
        });
        return createErrorResult(error.message, {
          code: "db_write_failed",
          target_id: targetId,
          tool_name: "db_write"
        });
      }
    },

    async runDiagnosticQuery({
      database_target: databaseTarget,
      target_id: explicitTargetId = null,
      ticket_key: ticketKey,
      query,
      parameters = {}
    }) {
      const normalizedTicketKey = normalizeDiagnosticMetadataValue(ticketKey);
      const resolved = resolveDiagnosticTarget(targetRegistry, databaseTarget, explicitTargetId);
      const blockers = [...resolved.blockers];

      if (!resolved.target) {
        return createJsonResult({
          used: {
            database_target: databaseTarget,
            target_id: explicitTargetId,
            ticket_key: normalizedTicketKey,
            tool_name: 'db_read'
          },
          rows: [],
          summary: createDiagnosticSummary({
            target: null,
            databaseTarget,
            ticketKey: normalizedTicketKey,
            result: { rows: [] }
          }),
          blockers
        });
      }

      const readResult = await handlers.dbRead({
        target_id: resolved.target.target_id,
        sql: query,
        parameters
      });

      if (readResult.isError) {
        blockers.push(extractBlockerText(readResult));
        return createJsonResult({
          used: {
            database_target: databaseTarget,
            target_id: resolved.target.target_id,
            ticket_key: normalizedTicketKey,
            tool_name: 'db_read'
          },
          rows: [],
          summary: createDiagnosticSummary({
            target: resolved.target,
            databaseTarget,
            ticketKey: normalizedTicketKey,
            result: {}
          }),
          blockers
        });
      }

      const structured = readResult.structuredContent ?? {};
      return createJsonResult({
        used: {
          database_target: databaseTarget,
          target_id: resolved.target.target_id,
          ticket_key: normalizedTicketKey,
          tool_name: 'db_read'
        },
        rows: Array.isArray(structured.rows) ? structured.rows : [],
        summary: createDiagnosticSummary({
          target: resolved.target,
          databaseTarget,
          ticketKey: normalizedTicketKey,
          result: structured
        }),
        blockers
      });
    }

  };

  return handlers;
}

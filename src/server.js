import { randomUUID } from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { anonymizeQueryResult } from "./lib/anonymizer.js";
import { isOriginAllowed, loadRuntimeConfig } from "./lib/config.js";
import { closeSqlServerPools, executeSqlServerRead, executeSqlServerWrite } from "./lib/drivers/sqlserver.js";
import { createHandlers } from "./lib/handlers.js";
import { createLogger } from "./lib/logger.js";
import { runWithRequestContext } from "./lib/request-context.js";
import { registerFixedTools } from "./lib/tools.js";
import { SessionStore } from "./lib/session-store.js";
import { loadTargetRegistry } from "./lib/target-registry.js";

function createProtocolErrorResponse(
  res,
  { status, jsonRpcCode = -32000, message, errorCode = "internal_error", details = {} }
) {
  const requestIdHeader = res.getHeader("x-request-id");
  const requestId = typeof requestIdHeader === "string" && requestIdHeader.trim() ? requestIdHeader : null;
  const errorData = {
    error_code: errorCode,
    request_id: requestId
  };

  if (Object.keys(details).length > 0) {
    errorData.details = details;
  }

  res.status(status).json({
    jsonrpc: "2.0",
    error: {
      code: jsonRpcCode,
      message,
      data: errorData
    },
    id: null
  });
}

function resolveRequestId(req) {
  const headerValue = req.headers["x-request-id"];
  if (typeof headerValue === "string" && headerValue.trim()) {
    return headerValue.trim();
  }

  return randomUUID();
}

function buildMcpServer(config, dependencies) {
  const server = new McpServer({
    name: config.serverName,
    version: config.serverVersion
  });

  registerFixedTools(server, createHandlers(dependencies));
  return server;
}

async function safeCloseTransport(transport, sessionId) {
  try {
    await transport.close();
  } catch (error) {
    // Fallback logger is used only when a scoped runtime logger is not available yet.
    fallbackLogger.error("session.close_failed", {
      session_id: sessionId,
      error: error.message
    });
  }
}

const fallbackLogger = createLogger();

function getActiveTargetsMissingConnectionEnv(targetRegistry, env) {
  return targetRegistry
    .list()
    .filter(target => target.status === "active")
    .filter(target => !env[target.connection_env_var])
    .map(target => ({
      target_id: target.target_id,
      environment: target.environment,
      connection_env_var: target.connection_env_var
    }));
}

function buildReadinessPayload({ config, targetRegistry, env, startedAt }) {
  const targets = targetRegistry.list();
  const activeTargets = targets.filter(target => target.status === "active");
  const missingConnectionEnv = getActiveTargetsMissingConnectionEnv(targetRegistry, env);
  const ready = activeTargets.length > 0 && missingConnectionEnv.length === 0;

  return {
    status: ready ? "ready" : "not_ready",
    service: config.serverName,
    version: config.serverVersion,
    uptime_seconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
    checks: {
      config_loaded: true,
      registry_loaded: true,
      target_count: targets.length,
      active_target_count: activeTargets.length,
      active_targets_missing_connection_env: missingConnectionEnv
    }
  };
}

export async function createApp({ cwd = process.cwd(), closeSqlPools = closeSqlServerPools } = {}) {
  const config = loadRuntimeConfig({ cwd });
  const logger = createLogger({
    level: config.logLevel
  });
  const targetRegistry = await loadTargetRegistry(config.targetsFile, { env: process.env });
  const app = createMcpExpressApp();
  const sessionStore = new SessionStore({
    defaultTtlMs: config.sessionTtlMs
  });
  const startedAt = new Date();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    const requestId = resolveRequestId(req);
    const sessionId = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : null;
    res.setHeader("x-request-id", requestId);
    runWithRequestContext(
      {
        request_id: requestId,
        session_id: sessionId
      },
      next
    );
  });
  app.use((req, res, next) => {
    if (isOriginAllowed(req.headers.origin, config)) {
      next();
      return;
    }

    res.status(403).json({
      error: {
        code: "origin_not_allowed",
        message: "Origin not allowed.",
        request_id: res.getHeader("x-request-id") ?? null
      }
    });
  });

  app.get(config.healthPath, (_req, res) => {
    res.json({
      status: "ok",
      service: config.serverName,
      version: config.serverVersion,
      uptime_seconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
      target_count: targetRegistry.size
    });
  });

  app.get(config.readinessPath, (_req, res) => {
    const payload = buildReadinessPayload({
      config,
      targetRegistry,
      env: process.env,
      startedAt
    });

    res.status(payload.status === "ready" ? 200 : 503).json(payload);
  });

  const sweepTimer = setInterval(() => {
    const expiredSessions = sessionStore.pruneExpired();
    for (const expired of expiredSessions) {
      void safeCloseTransport(expired.value.transport, expired.sessionId);
    }
  }, config.sessionSweepIntervalMs);
  sweepTimer.unref();

  async function resolveSession(sessionId) {
    const session = sessionStore.get(sessionId);
    if (!session) {
      return undefined;
    }

    sessionStore.touch(sessionId);
    return session;
  }

  async function createTransportForInitialization() {
    const server = buildMcpServer(config, {
      targetRegistry,
      env: process.env,
      executeSqlRead: executeSqlServerRead,
      executeSqlWrite: executeSqlServerWrite,
      sqlDriverConfig: config.sqlServer,
      anonymizeQueryResult,
      providerConfig: config.providers,
      logDbEvent: logger.dbEvent
    });
    let transport;

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: sessionId => {
        sessionStore.set(sessionId, {
          transport,
          server
        });
      }
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        sessionStore.delete(transport.sessionId);
      }
    };

    await server.connect(transport);
    return transport;
  }

  app.post(config.mcpPath, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];

    try {
      if (typeof sessionId === "string") {
        const existingSession = await resolveSession(sessionId);
        if (!existingSession) {
          createProtocolErrorResponse(res, {
            status: 404,
            jsonRpcCode: -32001,
            message: "Unknown or expired session.",
            errorCode: "unknown_session"
          });
          return;
        }

        await existingSession.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        createProtocolErrorResponse(res, {
          status: 400,
          jsonRpcCode: -32600,
          message: "Initialization request required when no session is provided.",
          errorCode: "initialization_required"
        });
        return;
      }

      const transport = await createTransportForInitialization();
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error("http.mcp_post_failed", {
        error: error.message
      });
      if (!res.headersSent) {
        createProtocolErrorResponse(res, {
          status: 500,
          jsonRpcCode: -32603,
          message: "Internal server error.",
          errorCode: "internal_error"
        });
      }
    }
  });

  app.get(config.mcpPath, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];

    if (typeof sessionId !== "string") {
      createProtocolErrorResponse(res, {
        status: 400,
        jsonRpcCode: -32600,
        message: "Session ID header is required.",
        errorCode: "session_id_required"
      });
      return;
    }

    const session = await resolveSession(sessionId);
    if (!session) {
      createProtocolErrorResponse(res, {
        status: 404,
        jsonRpcCode: -32001,
        message: "Unknown or expired session.",
        errorCode: "unknown_session"
      });
      return;
    }

    try {
      await session.transport.handleRequest(req, res);
    } catch (error) {
      logger.error("http.mcp_get_failed", {
        error: error.message
      });
      if (!res.headersSent) {
        createProtocolErrorResponse(res, {
          status: 500,
          jsonRpcCode: -32603,
          message: "Internal server error.",
          errorCode: "internal_error"
        });
      }
    }
  });

  app.delete(config.mcpPath, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];

    if (typeof sessionId !== "string") {
      createProtocolErrorResponse(res, {
        status: 400,
        jsonRpcCode: -32600,
        message: "Session ID header is required.",
        errorCode: "session_id_required"
      });
      return;
    }

    const session = await resolveSession(sessionId);
    if (!session) {
      createProtocolErrorResponse(res, {
        status: 404,
        jsonRpcCode: -32001,
        message: "Unknown or expired session.",
        errorCode: "unknown_session"
      });
      return;
    }

    try {
      await session.transport.handleRequest(req, res);
    } catch (error) {
      logger.error("http.mcp_delete_failed", {
        error: error.message
      });
      if (!res.headersSent) {
        createProtocolErrorResponse(res, {
          status: 500,
          jsonRpcCode: -32603,
          message: "Internal server error.",
          errorCode: "internal_error"
        });
      }
    }
  });

  return {
    app,
    config,
    logger,
    targetRegistry,
    async stop() {
      clearInterval(sweepTimer);
      const activeSessions = sessionStore.drain();
      for (const session of activeSessions) {
        try {
          await session.value.transport.close();
        } catch (error) {
          logger.error("session.close_failed", {
            session_id: session.sessionId,
            error: error.message
          });
        }
      }

      try {
        await closeSqlPools();
      } catch (error) {
        logger.error("db.pool_close_failed", {
          error: error.message
        });
      }
    }
  };
}

export async function startServer({ cwd = process.cwd() } = {}) {
  const runtimeApp = await createApp({ cwd });
  const { app, config, logger, targetRegistry } = runtimeApp;
  const server = http.createServer(app);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });

  logger.info("server.started", {
    service: config.serverName,
    host: config.host,
    port: config.port,
    mcp_path: config.mcpPath,
    target_count: targetRegistry.size
  });

  return {
    server,
    config,
    logger,
    targetRegistry,
    async close() {
      await runtimeApp.stop();
      await new Promise((resolve, reject) => {
        server.close(error => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const runtime = await startServer();

    const shutdown = async signal => {
      runtime.logger.info("server.shutdown_requested", {
        signal
      });
      await runtime.close();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    fallbackLogger.error("server.start_failed", {
      error: error.message
    });
    process.exit(1);
  }
}

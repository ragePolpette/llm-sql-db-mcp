import { randomUUID } from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { isOriginAllowed, loadRuntimeConfig } from "./lib/config.js";
import { SessionStore } from "./lib/session-store.js";
import { loadTargetRegistry } from "./lib/target-registry.js";

function createProtocolErrorResponse(res, status, message) {
  res.status(status).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message
    },
    id: null
  });
}

function buildMcpServer(config) {
  return new McpServer({
    name: config.serverName,
    version: config.serverVersion
  });
}

async function safeCloseTransport(transport, sessionId) {
  try {
    await transport.close();
  } catch (error) {
    console.error(`Failed to close session ${sessionId}:`, error);
  }
}

export async function createApp({ cwd = process.cwd() } = {}) {
  const config = loadRuntimeConfig({ cwd });
  const targetRegistry = await loadTargetRegistry(config.targetsFile);
  const app = createMcpExpressApp();
  const sessionStore = new SessionStore({
    defaultTtlMs: config.sessionTtlMs
  });
  const startedAt = new Date();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    if (isOriginAllowed(req.headers.origin, config)) {
      next();
      return;
    }

    res.status(403).json({
      error: "Origin not allowed."
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
    const server = buildMcpServer(config);
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
          createProtocolErrorResponse(res, 404, "Unknown or expired session.");
          return;
        }

        await existingSession.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        createProtocolErrorResponse(res, 400, "Initialization request required when no session is provided.");
        return;
      }

      const transport = await createTransportForInitialization();
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP POST handling failed:", error);
      if (!res.headersSent) {
        createProtocolErrorResponse(res, 500, "Internal server error.");
      }
    }
  });

  app.get(config.mcpPath, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];

    if (typeof sessionId !== "string") {
      createProtocolErrorResponse(res, 400, "Session ID header is required.");
      return;
    }

    const session = await resolveSession(sessionId);
    if (!session) {
      createProtocolErrorResponse(res, 404, "Unknown or expired session.");
      return;
    }

    try {
      await session.transport.handleRequest(req, res);
    } catch (error) {
      console.error("MCP GET handling failed:", error);
      if (!res.headersSent) {
        createProtocolErrorResponse(res, 500, "Internal server error.");
      }
    }
  });

  app.delete(config.mcpPath, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];

    if (typeof sessionId !== "string") {
      createProtocolErrorResponse(res, 400, "Session ID header is required.");
      return;
    }

    const session = await resolveSession(sessionId);
    if (!session) {
      createProtocolErrorResponse(res, 404, "Unknown or expired session.");
      return;
    }

    try {
      await session.transport.handleRequest(req, res);
    } catch (error) {
      console.error("MCP DELETE handling failed:", error);
      if (!res.headersSent) {
        createProtocolErrorResponse(res, 500, "Internal server error.");
      }
    }
  });

  return {
    app,
    config,
    targetRegistry,
    async stop() {
      clearInterval(sweepTimer);
      const activeSessions = sessionStore.drain();
      for (const session of activeSessions) {
        await safeCloseTransport(session.value.transport, session.sessionId);
      }
    }
  };
}

export async function startServer({ cwd = process.cwd() } = {}) {
  const runtimeApp = await createApp({ cwd });
  const { app, config, targetRegistry } = runtimeApp;
  const server = http.createServer(app);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });

  console.log(
    `${config.serverName} listening on http://${config.host}:${config.port}${config.mcpPath} with ${targetRegistry.size} configured targets.`
  );

  return {
    server,
    config,
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
      console.log(`Received ${signal}, shutting down.`);
      await runtime.close();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    console.error("Unable to start llm-sql-db-mcp:", error);
    process.exit(1);
  }
}

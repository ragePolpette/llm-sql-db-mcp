import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const DEFAULT_MCP_PATH = "/mcp";
const DEFAULT_HEALTH_PATH = "/health";
const DEFAULT_TARGETS_FILE = "targets.json";
const DEFAULT_SESSION_TTL_MS = 1_800_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_DB_CONNECTION_TIMEOUT_MS = 15_000;
const DEFAULT_DB_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_DB_POOL_MAX = 10;
const DEFAULT_DB_POOL_MIN = 0;
const DEFAULT_DB_POOL_IDLE_TIMEOUT_MS = 30_000;
const FORBIDDEN_ENV_KEY_PATTERNS = [
  /CONNECTION_STRING$/i,
  /(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD)$/i
];

function parseInteger(value, fallback, label) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`${label} must be an integer.`);
  }

  return parsed;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(`Boolean value expected, received "${value}".`);
}

function parseOrigins(value) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean);
}

function parseEnum(value, allowed, fallback, label) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (allowed.includes(normalized)) {
    return normalized;
  }

  throw new Error(`${label} must be one of: ${allowed.join(", ")}.`);
}

function assertNoForbiddenSecretsInDotEnv(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const parsed = dotenv.parse(fs.readFileSync(envPath, "utf8"));
  const forbiddenKeys = Object.keys(parsed).filter(key =>
    FORBIDDEN_ENV_KEY_PATTERNS.some(pattern => pattern.test(key))
  );

  if (forbiddenKeys.length > 0) {
    throw new Error(
      `Forbidden secret keys found in ${path.basename(envPath)}: ${forbiddenKeys.join(", ")}. Use runtime environment variables instead.`
    );
  }
}

export function loadRuntimeConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const envPath = path.resolve(cwd, ".env");
  assertNoForbiddenSecretsInDotEnv(envPath);

  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }

  const host = env.HOST ?? DEFAULT_HOST;
  const port = parseInteger(env.PORT, DEFAULT_PORT, "PORT");
  const mcpPath = env.MCP_PATH ?? DEFAULT_MCP_PATH;
  const healthPath = env.HEALTH_PATH ?? DEFAULT_HEALTH_PATH;
  const targetsFile = path.resolve(cwd, env.TARGETS_FILE ?? DEFAULT_TARGETS_FILE);
  const sessionTtlMs = parseInteger(env.SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS, "SESSION_TTL_MS");
  const sessionSweepIntervalMs = parseInteger(
    env.SESSION_SWEEP_INTERVAL_MS,
    DEFAULT_SWEEP_INTERVAL_MS,
    "SESSION_SWEEP_INTERVAL_MS"
  );
  const allowLoopbackOrigins = parseBoolean(env.ALLOW_LOOPBACK_ORIGINS, true);
  const allowedOrigins = parseOrigins(env.ALLOWED_ORIGINS);

  if (port <= 0) {
    throw new Error("PORT must be greater than zero.");
  }

  if (sessionTtlMs < 0) {
    throw new Error("SESSION_TTL_MS must be zero or greater.");
  }

  if (sessionSweepIntervalMs <= 0) {
    throw new Error("SESSION_SWEEP_INTERVAL_MS must be greater than zero.");
  }

  const anonymizerTimeoutMs = parseInteger(env.ANON_TIMEOUT_MS, 5000, "ANON_TIMEOUT_MS");
  if (anonymizerTimeoutMs <= 0) {
    throw new Error("ANON_TIMEOUT_MS must be greater than zero.");
  }

  const dbConnectionTimeoutMs = parseInteger(
    env.DB_CONNECTION_TIMEOUT_MS,
    DEFAULT_DB_CONNECTION_TIMEOUT_MS,
    "DB_CONNECTION_TIMEOUT_MS"
  );
  const dbRequestTimeoutMs = parseInteger(
    env.DB_REQUEST_TIMEOUT_MS,
    DEFAULT_DB_REQUEST_TIMEOUT_MS,
    "DB_REQUEST_TIMEOUT_MS"
  );
  const dbPoolMax = parseInteger(env.DB_POOL_MAX, DEFAULT_DB_POOL_MAX, "DB_POOL_MAX");
  const dbPoolMin = parseInteger(env.DB_POOL_MIN, DEFAULT_DB_POOL_MIN, "DB_POOL_MIN");
  const dbPoolIdleTimeoutMs = parseInteger(
    env.DB_POOL_IDLE_TIMEOUT_MS,
    DEFAULT_DB_POOL_IDLE_TIMEOUT_MS,
    "DB_POOL_IDLE_TIMEOUT_MS"
  );

  if (dbConnectionTimeoutMs <= 0) {
    throw new Error("DB_CONNECTION_TIMEOUT_MS must be greater than zero.");
  }

  if (dbRequestTimeoutMs <= 0) {
    throw new Error("DB_REQUEST_TIMEOUT_MS must be greater than zero.");
  }

  if (dbPoolMin < 0) {
    throw new Error("DB_POOL_MIN must be zero or greater.");
  }

  if (dbPoolMax <= 0) {
    throw new Error("DB_POOL_MAX must be greater than zero.");
  }

  if (dbPoolMax < dbPoolMin) {
    throw new Error("DB_POOL_MAX must be greater than or equal to DB_POOL_MIN.");
  }

  if (dbPoolIdleTimeoutMs <= 0) {
    throw new Error("DB_POOL_IDLE_TIMEOUT_MS must be greater than zero.");
  }

  return {
    serverName: "llm-sql-db-mcp",
    serverVersion: "0.1.0",
    host,
    port,
    mcpPath,
    healthPath,
    targetsFile,
    sessionTtlMs,
    sessionSweepIntervalMs,
    allowLoopbackOrigins,
    allowedOrigins,
    logLevel: parseEnum(env.LOG_LEVEL, ["error", "info", "debug"], "info", "LOG_LEVEL"),
    sqlServer: {
      connectionTimeoutMs: dbConnectionTimeoutMs,
      requestTimeoutMs: dbRequestTimeoutMs,
      pool: {
        max: dbPoolMax,
        min: dbPoolMin,
        idleTimeoutMs: dbPoolIdleTimeoutMs
      }
    },
    providers: {
      lmstudioBaseUrl: env.LMSTUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1",
      ollamaBaseUrl: env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
      fieldIdentification: parseEnum(
        env.ANON_FIELD_IDENTIFICATION,
        ["hybrid", "heuristic", "llm"],
        "hybrid",
        "ANON_FIELD_IDENTIFICATION"
      ),
      hashSalt: env.ANON_HASH_SALT ?? "",
      failOpen: parseBoolean(env.ANON_FAIL_OPEN, false),
      timeoutMs: anonymizerTimeoutMs
    }
  };
}

export function isOriginAllowed(origin, config) {
  if (!origin) {
    return true;
  }

  if (config.allowedOrigins.includes(origin)) {
    return true;
  }

  if (!config.allowLoopbackOrigins) {
    return false;
  }

  try {
    const parsed = new URL(origin);
    return ["127.0.0.1", "::1", "localhost"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

import sql from "mssql";

const poolCache = new Map();
const PARAM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normalizeCellValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map(normalizeCellValue);
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, normalizeCellValue(entryValue)])
    );
  }

  return value;
}

function normalizeRows(rows) {
  return rows.map(row =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeCellValue(value)]))
  );
}

function normalizeColumns(recordset) {
  if (!recordset?.columns) {
    return [];
  }

  return Object.entries(recordset.columns).map(([name, meta]) => ({
    name,
    nullable: Boolean(meta.nullable),
    type: meta.type?.name ?? "unknown"
  }));
}

function buildBoundedRows(rows, maxResultBytes) {
  const acceptedRows = [];
  let resultBytes = 2;

  for (const row of rows) {
    const rowJson = JSON.stringify(row);
    const rowBytes = Buffer.byteLength(rowJson, "utf8");
    const separatorBytes = acceptedRows.length === 0 ? 0 : 1;

    if (acceptedRows.length > 0 && resultBytes + separatorBytes + rowBytes > maxResultBytes) {
      break;
    }

    if (acceptedRows.length === 0 && rowBytes > maxResultBytes) {
      break;
    }

    resultBytes += separatorBytes + rowBytes;
    acceptedRows.push(row);
  }

  return {
    rows: acceptedRows,
    resultBytes
  };
}

export function buildSqlServerConnectionConfig(connectionString, driverConfig = {}) {
  const pool = driverConfig.pool ?? {};
  return {
    connectionString,
    connectionTimeout: driverConfig.connectionTimeoutMs,
    requestTimeout: driverConfig.requestTimeoutMs,
    pool: {
      max: pool.max,
      min: pool.min,
      idleTimeoutMillis: pool.idleTimeoutMs
    }
  };
}

async function getPool(connectionString, driverConfig = {}) {
  const cachedPool = poolCache.get(connectionString);
  if (cachedPool) {
    return cachedPool;
  }

  const pool = new sql.ConnectionPool(buildSqlServerConnectionConfig(connectionString, driverConfig));
  const connectedPool = await pool.connect();
  poolCache.set(connectionString, connectedPool);
  return connectedPool;
}

export async function executeSqlServerRead({
  connectionString,
  sqlText,
  parameters = {},
  maxRows,
  maxResultBytes,
  driverConfig = {}
}) {
  const pool = await getPool(connectionString, driverConfig);
  const request = pool.request();

  for (const [name, value] of Object.entries(parameters)) {
    if (!PARAM_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid SQL parameter name: ${name}`);
    }

    request.input(name, value);
  }

  const startedAt = Date.now();
  const queryResult = await request.query(sqlText);
  const recordset = queryResult.recordset ?? [];
  const normalizedRows = normalizeRows(recordset);
  const limitedRows = normalizedRows.slice(0, maxRows);
  const boundedRows = buildBoundedRows(limitedRows, maxResultBytes);
  const truncated = boundedRows.rows.length < normalizedRows.length;

  return {
    columns: normalizeColumns(recordset),
    rows: boundedRows.rows,
    row_count: boundedRows.rows.length,
    total_rows_before_limits: normalizedRows.length,
    max_rows_applied: maxRows,
    max_result_bytes_applied: maxResultBytes,
    result_bytes: boundedRows.resultBytes,
    truncated,
    duration_ms: Date.now() - startedAt
  };
}

export async function executeSqlServerWrite({
  connectionString,
  sqlText,
  parameters = {},
  maxResultBytes,
  driverConfig = {}
}) {
  const pool = await getPool(connectionString, driverConfig);
  const request = pool.request();

  for (const [name, value] of Object.entries(parameters)) {
    if (!PARAM_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid SQL parameter name: ${name}`);
    }

    request.input(name, value);
  }

  const startedAt = Date.now();
  const queryResult = await request.query(sqlText);
  const recordset = queryResult.recordset ?? [];
  const normalizedRows = normalizeRows(recordset);
  const boundedRows = buildBoundedRows(normalizedRows, maxResultBytes);

  return {
    columns: normalizeColumns(recordset),
    rows: boundedRows.rows,
    row_count: boundedRows.rows.length,
    rows_affected: Array.isArray(queryResult.rowsAffected)
      ? queryResult.rowsAffected.reduce((sum, value) => sum + (Number(value) || 0), 0)
      : 0,
    max_result_bytes_applied: maxResultBytes,
    result_bytes: boundedRows.resultBytes,
    truncated: boundedRows.rows.length < normalizedRows.length,
    duration_ms: Date.now() - startedAt
  };
}

export async function closeSqlServerPools() {
  const pools = [...poolCache.values()];
  poolCache.clear();

  await Promise.allSettled(
    pools.map(pool => pool.close())
  );
}

export const __sqlServerTestUtils = {
  buildSqlServerConnectionConfig,
  getPoolCacheSize() {
    return poolCache.size;
  },
  setCachedPool(connectionString, pool) {
    poolCache.set(connectionString, pool);
  },
  resetPoolCache() {
    poolCache.clear();
  }
};

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

    if (maxResultBytes !== null && resultBytes + separatorBytes + rowBytes > maxResultBytes) {
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
  // `mssql` accepts a SqlClient connection string only when it is passed to
  // ConnectionPool directly. Supplying it as `connectionString` in a config
  // object leaves the required `server` setting unset.
  const parsedConnection = new sql.ConnectionPool(connectionString).config;
  const pool = driverConfig.pool ?? {};
  return {
    ...parsedConnection,
    connectionTimeout: driverConfig.connectionTimeoutMs,
    requestTimeout: driverConfig.requestTimeoutMs,
    pool: {
      ...parsedConnection.pool,
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

function describeParameterType(value) {
  // Only the type is needed to compile the query; a null value still needs a declaration.
  if (value === null || value === undefined || typeof value === "string") return "nvarchar(max)";
  if (typeof value === "boolean") return "bit";
  if (typeof value === "bigint") return "bigint";
  if (typeof value === "number") return Number.isInteger(value) ? "bigint" : "float";
  if (value instanceof Date) return "datetime2";
  return null;
}

// Resolves each output column to its source table/column (SQL Server browse metadata), so that
// anonymization classifies the real column rather than the caller-chosen alias. Computed columns map
// to null. When the metadata cannot be obtained (unsupported parameter types, temp objects,
// permissions, describe errors) `origins` is null and the anonymizer treats every column as computed.
// `reason` is a short code safe to return to the caller; `detail` is the raw error, for debug logs only.
async function describeColumnOrigins(pool, sqlText, parameters) {
  const declarations = [];
  for (const [name, value] of Object.entries(parameters)) {
    const type = describeParameterType(value);
    if (!type) {
      return { origins: null, status: "unavailable", reason: `unsupported_param_type:${name}`, detail: null };
    }
    declarations.push(`@${name} ${type}`);
  }

  let described;
  try {
    const request = pool.request();
    request.input("tsql", sql.NVarChar(sql.MAX), sqlText);
    request.input("params", sql.NVarChar(sql.MAX), declarations.length > 0 ? declarations.join(", ") : null);
    described = await request.query(
      "SELECT name, source_schema, source_table, source_column, is_hidden, error_number, error_message, error_type_desc " +
        "FROM sys.dm_exec_describe_first_result_set(@tsql, @params, 1)"
    );
  } catch (error) {
    return { origins: null, status: "unavailable", reason: "describe_failed", detail: error?.message ?? null };
  }

  const rows = described?.recordset ?? [];
  // The DMV reports describe errors as a row carrying error_* columns instead of raising.
  const errorRow = rows.find(row => row.error_number !== null && row.error_number !== undefined);
  if (errorRow) {
    const type = String(errorRow.error_type_desc || "error").toLowerCase();
    return { origins: null, status: "unavailable", reason: `describe_error:${type}`, detail: errorRow.error_message ?? null };
  }

  const origins = {};
  for (const row of rows) {
    if (row.is_hidden || !row.name) continue;
    // A repeated output name is ambiguous: treat it as computed.
    origins[row.name] =
      Object.prototype.hasOwnProperty.call(origins, row.name) || !row.source_column
        ? null
        : { schema: row.source_schema ?? null, table: row.source_table ?? null, column: row.source_column };
  }
  if (Object.keys(origins).length === 0) {
    return { origins: null, status: "unavailable", reason: "describe_empty", detail: null };
  }
  return { origins, status: "resolved", reason: null, detail: null };
}

export async function executeSqlServerRead({
  connectionString,
  sqlText,
  parameters = {},
  maxRows,
  maxResultBytes,
  describeOrigins = false,
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

  const originResolution = describeOrigins ? await describeColumnOrigins(pool, sqlText, parameters) : null;

  const startedAt = Date.now();
  const queryResult = await request.query(sqlText);
  const recordset = queryResult.recordset ?? [];
  const normalizedRows = normalizeRows(recordset);
  const limitedRows = normalizedRows.slice(0, maxRows);
  const boundedRows = buildBoundedRows(limitedRows, maxResultBytes);
  const truncated = boundedRows.rows.length < normalizedRows.length;

  return {
    columns: normalizeColumns(recordset),
    ...(originResolution
      ? {
          column_origins: originResolution.origins,
          column_origins_status: originResolution.status,
          column_origins_reason: originResolution.reason,
          column_origins_detail: originResolution.detail
        }
      : {}),
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
  buildBoundedRows,
  buildSqlServerConnectionConfig,
  describeParameterType,
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

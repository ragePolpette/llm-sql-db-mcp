import sql from "mssql";

const poolCache = new Map();
const PARAM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const READ_ISOLATION_LEVEL = sql.ISOLATION_LEVEL.READ_COMMITTED;
const defaultPoolFactory = config => new sql.ConnectionPool(config).connect();
let poolFactory = defaultPoolFactory;

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

function normalizeRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeCellValue(value)]));
}

function normalizeRows(rows) {
  return rows.map(normalizeRow);
}

function normalizeColumns(columns) {
  if (!columns) {
    return [];
  }

  return Object.entries(columns).map(([name, meta]) => ({
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

// The in-flight promise is cached so that concurrent first requests share one pool instead of
// each opening its own and leaking all but the last.
function getPool(connectionString, driverConfig = {}) {
  const cachedPool = poolCache.get(connectionString);
  if (cachedPool) {
    return cachedPool;
  }

  const pending = Promise.resolve()
    .then(() => poolFactory(buildSqlServerConnectionConfig(connectionString, driverConfig)))
    .catch(error => {
      if (poolCache.get(connectionString) === pending) {
        poolCache.delete(connectionString);
      }
      throw error;
    });
  poolCache.set(connectionString, pending);
  return pending;
}

function bindParameters(request, parameters) {
  for (const [name, value] of Object.entries(parameters)) {
    if (!PARAM_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid SQL parameter name: ${name}`);
    }

    request.input(name, value);
  }
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

// Streams the first result set and stops reading as soon as the row or byte cap is exceeded, so
// at most maxRows + 1 rows are ever materialized. Streaming is used instead of rewriting the query
// with TOP because it works for every statement the read guard accepts (CTEs, UNION, ORDER BY,
// OFFSET/FETCH, existing TOP) without parsing or altering the caller's SQL.
function streamBoundedRows(request, sqlText, { maxRows, maxResultBytes }) {
  return new Promise((resolve, reject) => {
    const rows = [];
    let columns = null;
    let recordsetCount = 0;
    let rowsSeen = 0;
    let resultBytes = 2;
    let truncated = false;
    let stopped = false;
    let streamError = null;

    function stop() {
      if (stopped) return;
      stopped = true;
      request.cancel();
    }

    request.stream = true;
    request.on("recordset", recordsetColumns => {
      recordsetCount += 1;
      if (recordsetCount === 1) {
        columns = recordsetColumns;
      }
    });
    request.on("row", row => {
      if (stopped || recordsetCount > 1) return;
      rowsSeen += 1;
      if (rowsSeen > maxRows) {
        truncated = true;
        stop();
        return;
      }

      const normalized = normalizeRow(row);
      const rowBytes = Buffer.byteLength(JSON.stringify(normalized), "utf8");
      const separatorBytes = rows.length === 0 ? 0 : 1;
      if (maxResultBytes !== null && maxResultBytes !== undefined && resultBytes + separatorBytes + rowBytes > maxResultBytes) {
        truncated = true;
        stop();
        return;
      }

      resultBytes += separatorBytes + rowBytes;
      rows.push(normalized);
    });
    request.on("error", error => {
      if (stopped && error?.code === "ECANCEL") return;
      streamError ??= error;
    });

    Promise.resolve(request.query(sqlText)).then(
      () => {
        if (streamError) {
          reject(streamError);
          return;
        }
        resolve({ columns, rows, rowsSeen, resultBytes, truncated });
      },
      error => reject(streamError ?? error)
    );
  });
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
  for (const name of Object.keys(parameters)) {
    if (!PARAM_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid SQL parameter name: ${name}`);
    }
  }

  const pool = await getPool(connectionString, driverConfig);
  const originResolution = describeOrigins ? await describeColumnOrigins(pool, sqlText, parameters) : null;

  const startedAt = Date.now();
  const transaction = pool.transaction();
  await transaction.begin(READ_ISOLATION_LEVEL);
  let streamed;
  try {
    const request = transaction.request();
    bindParameters(request, parameters);
    streamed = await streamBoundedRows(request, sqlText, { maxRows, maxResultBytes });
  } finally {
    // db_read never commits: anything the statement might have changed is discarded.
    await transaction.rollback().catch(() => {});
  }

  return {
    columns: normalizeColumns(streamed.columns),
    ...(originResolution
      ? {
          column_origins: originResolution.origins,
          column_origins_status: originResolution.status,
          column_origins_reason: originResolution.reason,
          column_origins_detail: originResolution.detail
        }
      : {}),
    rows: streamed.rows,
    row_count: streamed.rows.length,
    total_rows_before_limits: streamed.rowsSeen,
    max_rows_applied: maxRows,
    max_result_bytes_applied: maxResultBytes,
    result_bytes: streamed.resultBytes,
    truncated: streamed.truncated,
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
  bindParameters(request, parameters);

  const startedAt = Date.now();
  const queryResult = await request.query(sqlText);
  const recordset = queryResult.recordset ?? [];
  const normalizedRows = normalizeRows(recordset);
  const boundedRows = buildBoundedRows(normalizedRows, maxResultBytes);

  return {
    columns: normalizeColumns(recordset.columns),
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
  const pendingPools = [...poolCache.values()];
  poolCache.clear();

  await Promise.allSettled(
    pendingPools.map(async pendingPool => {
      const pool = await pendingPool;
      await pool.close();
    })
  );
}

export const __sqlServerTestUtils = {
  buildBoundedRows,
  buildSqlServerConnectionConfig,
  describeParameterType,
  getPoolCacheSize() {
    return poolCache.size;
  },
  getPool,
  setCachedPool(connectionString, pool) {
    poolCache.set(connectionString, Promise.resolve(pool));
  },
  setPoolFactory(factory) {
    poolFactory = factory ?? defaultPoolFactory;
  },
  resetPoolCache() {
    poolCache.clear();
  }
};

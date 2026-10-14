import { EventEmitter } from "node:events";

function columnsFromRows(rows) {
  const first = rows.find(row => row && typeof row === "object") ?? {};
  return Object.fromEntries(
    Object.keys(first).map((name, index) => [name, { index, name, nullable: true, type: { name: "NVarChar" } }])
  );
}

// Mimics an mssql Request in stream mode: emits recordset/row/error events, honours cancel(),
// and resolves query() once the request is done.
export function createStreamingRequest({ rows = [], columns = columnsFromRows(rows), error = null, stats = {} } = {}) {
  const request = new EventEmitter();
  request.inputs = {};
  request.stream = null;
  request.canceled = false;
  stats.rowsEmitted = 0;
  request.input = (name, typeOrValue, value) => {
    request.inputs[name] = value === undefined ? typeOrValue : value;
  };
  request.cancel = () => {
    request.canceled = true;
    return true;
  };
  request.query = async sqlText => {
    stats.sqlText = sqlText;
    stats.streamMode = request.stream;
    await new Promise(resolve => setImmediate(resolve));
    request.emit("recordset", columns);
    for (const row of rows) {
      if (request.canceled) break;
      stats.rowsEmitted += 1;
      request.emit("row", row);
    }
    if (error) {
      request.emit("error", error);
    } else if (request.canceled) {
      request.emit("error", Object.assign(new Error("Canceled."), { code: "ECANCEL" }));
    }
    request.emit("done", { rowsAffected: [] });
    return { recordset: undefined, rowsAffected: [] };
  };
  return request;
}

export function createFakeTransaction({ rows = [], error = null, stats = {} } = {}) {
  stats.begun = null;
  stats.rolledBack = false;
  stats.committed = false;
  return {
    async begin(isolationLevel) {
      stats.begun = isolationLevel;
    },
    request() {
      return createStreamingRequest({ rows, error, stats });
    },
    async rollback() {
      stats.rolledBack = true;
    },
    async commit() {
      stats.committed = true;
    }
  };
}

export function createFakePool({ dataRows = [], describeRows = [], describeError = null, error = null, stats = {} } = {}) {
  const describeCalls = [];
  return {
    describeCalls,
    stats,
    request() {
      const inputs = {};
      return {
        input(name, typeOrValue, value) {
          inputs[name] = value === undefined ? typeOrValue : value;
        },
        async query(sqlText) {
          if (sqlText.includes("dm_exec_describe_first_result_set")) {
            describeCalls.push({ ...inputs });
            if (describeError) throw describeError;
            return { recordset: describeRows };
          }
          return { recordset: dataRows, rowsAffected: [dataRows.length] };
        }
      };
    },
    transaction() {
      return createFakeTransaction({ rows: dataRows, error, stats });
    }
  };
}

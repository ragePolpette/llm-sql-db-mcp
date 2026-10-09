import test from "node:test";
import assert from "node:assert/strict";
import {
  __sqlServerTestUtils,
  buildSqlServerConnectionConfig,
  closeSqlServerPools,
  executeSqlServerRead
} from "../src/lib/drivers/sqlserver.js";
import { anonymizeQueryResult } from "../src/lib/anonymizer.js";

test("buildSqlServerConnectionConfig maps runtime config to mssql pool settings", () => {
  const config = buildSqlServerConnectionConfig("Server=.;Database=App;", {
    connectionTimeoutMs: 12000,
    requestTimeoutMs: 24000,
    pool: {
      max: 12,
      min: 1,
      idleTimeoutMs: 45000
    }
  });

  assert.equal(config.server, "localhost");
  assert.equal(config.database, "App");
  assert.equal(config.connectionTimeout, 12000);
  assert.equal(config.requestTimeout, 24000);
  assert.deepEqual(config.pool, {
    max: 12,
    min: 1,
    idleTimeoutMillis: 45000
  });
});

test("closeSqlServerPools closes cached pools and clears the cache", async () => {
  const closeOrder = [];
  __sqlServerTestUtils.resetPoolCache();
  __sqlServerTestUtils.setCachedPool("db-1", {
    async close() {
      closeOrder.push("db-1");
    }
  });
  __sqlServerTestUtils.setCachedPool("db-2", {
    async close() {
      closeOrder.push("db-2");
    }
  });

  await closeSqlServerPools();

  assert.equal(__sqlServerTestUtils.getPoolCacheSize(), 0);
  assert.deepEqual(closeOrder.sort(), ["db-1", "db-2"]);
});

test("closeSqlServerPools tolerates pool close failures and still clears the cache", async () => {
  __sqlServerTestUtils.resetPoolCache();
  __sqlServerTestUtils.setCachedPool("db-ok", {
    async close() {}
  });
  __sqlServerTestUtils.setCachedPool("db-fail", {
    async close() {
      throw new Error("pool close failed");
    }
  });

  await closeSqlServerPools();

  assert.equal(__sqlServerTestUtils.getPoolCacheSize(), 0);
});

test("describeParameterType maps JS values to T-SQL types and rejects unsupported ones", () => {
  assert.equal(__sqlServerTestUtils.describeParameterType("a"), "nvarchar(max)");
  assert.equal(__sqlServerTestUtils.describeParameterType(3), "bigint");
  assert.equal(__sqlServerTestUtils.describeParameterType(3.5), "float");
  assert.equal(__sqlServerTestUtils.describeParameterType(true), "bit");
  assert.equal(__sqlServerTestUtils.describeParameterType(new Date()), "datetime2");
  assert.equal(__sqlServerTestUtils.describeParameterType(null), "nvarchar(max)");
  assert.equal(__sqlServerTestUtils.describeParameterType(undefined), "nvarchar(max)");
  assert.equal(__sqlServerTestUtils.describeParameterType({}), null);
});

function createFakePool({ describeRows, describeError = null, dataRows }) {
  const describeCalls = [];
  return {
    describeCalls,
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
          return { recordset: dataRows };
        }
      };
    }
  };
}

const ALIAS_SQL = "SELECT cognome AS tipo, nome AS stato FROM dbo.u WHERE codice = @p";
const ALIAS_ROWS = [{ tipo: "Rossi", stato: "Mario" }];
const PROD_TARGET = {
  target_id: "prod-main",
  environment: "prod",
  anonymization_enabled: true,
  anonymization_mode: "deterministic",
  llm_provider: "none"
};
const PROVIDER_CONFIG = { hashSalt: "salt-salt-salt", fieldIdentification: "heuristic", timeoutMs: 1000 };

async function readAndAnonymize(pool, parameters) {
  __sqlServerTestUtils.resetPoolCache();
  __sqlServerTestUtils.setCachedPool("fake-db", pool);
  const queryResult = await executeSqlServerRead({
    connectionString: "fake-db",
    sqlText: ALIAS_SQL,
    parameters,
    maxRows: 10,
    maxResultBytes: null,
    describeOrigins: true
  });
  __sqlServerTestUtils.resetPoolCache();
  return anonymizeQueryResult({
    target: PROD_TARGET,
    queryResult: { ...queryResult, sql_text: ALIAS_SQL },
    providerConfig: PROVIDER_CONFIG
  });
}

test("a null SQL parameter is declared as nvarchar(max) and aliases are still resolved", async () => {
  const pool = createFakePool({
    describeRows: [
      { name: "tipo", source_schema: "dbo", source_table: "u", source_column: "cognome" },
      { name: "stato", source_schema: "dbo", source_table: "u", source_column: "nome" }
    ],
    dataRows: ALIAS_ROWS
  });
  const result = await readAndAnonymize(pool, { p: null });

  assert.equal(pool.describeCalls[0].params, "@p nvarchar(max)");
  assert.match(result.rows[0].tipo, /^NAME_/);
  assert.match(result.rows[0].stato, /^NAME_/);
  assert.equal("column_origins" in result, false);
});

test("when column metadata cannot be obtained, aliased values are masked anyway", async () => {
  const pool = createFakePool({
    describeError: new Error("Invalid object name '#tmp'."),
    dataRows: ALIAS_ROWS
  });
  const result = await readAndAnonymize(pool, { p: "x" });

  assert.equal(pool.describeCalls.length, 1);
  assert.notEqual(result.rows[0].tipo, "Rossi");
  assert.notEqual(result.rows[0].stato, "Mario");
});

test("an unsupported parameter type skips metadata and still masks aliased values", async () => {
  const pool = createFakePool({ describeRows: [], dataRows: ALIAS_ROWS });
  const result = await readAndAnonymize(pool, { p: { nested: true } });

  assert.equal(pool.describeCalls.length, 0);
  assert.notEqual(result.rows[0].tipo, "Rossi");
  assert.notEqual(result.rows[0].stato, "Mario");
});

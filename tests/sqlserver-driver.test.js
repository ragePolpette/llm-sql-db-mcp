import test from "node:test";
import assert from "node:assert/strict";
import { __sqlServerTestUtils, buildSqlServerConnectionConfig, closeSqlServerPools } from "../src/lib/drivers/sqlserver.js";

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
  assert.equal(__sqlServerTestUtils.describeParameterType({}), null);
});

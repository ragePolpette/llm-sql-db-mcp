import test from "node:test";
import assert from "node:assert/strict";
import { __sqlServerTestUtils, closeSqlServerPools } from "../src/lib/drivers/sqlserver.js";

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

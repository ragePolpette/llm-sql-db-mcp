import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {loadTargetRegistry} from "../src/lib/target-registry.js";
import {__sqlServerTestUtils, executeSqlServerRead} from "../src/lib/drivers/sqlserver.js";
import {__anonymizerTestUtils} from "../src/lib/anonymizer.js";

test("Any keeps large multibyte rows before and after anonymization; numeric caps still apply", () => {
  const rows = [{value: "è".repeat(150000)}, {value: "second"}];
  const result = __sqlServerTestUtils.buildBoundedRows(rows, null);
  assert.deepEqual(result.rows, rows);
  assert.equal(result.resultBytes, Buffer.byteLength(JSON.stringify(rows)));
  assert.deepEqual(__anonymizerTestUtils.clampRowsToByteLimit(rows, null), rows);
  assert.deepEqual(__sqlServerTestUtils.buildBoundedRows(rows, 20).rows, []);
  assert.deepEqual(__anonymizerTestUtils.clampRowsToByteLimit(rows, 20), []);
  const exact = Buffer.byteLength(JSON.stringify([rows[1]]));
  assert.equal(__sqlServerTestUtils.buildBoundedRows([rows[1]], exact).rows.length, 1);
  assert.equal(__sqlServerTestUtils.buildBoundedRows([rows[1]], exact - 1).rows.length, 0);
});

test("Any still applies the independent row cap in the actual SQL driver", async () => {
  const connectionString = "synthetic-only";
  __sqlServerTestUtils.setCachedPool(connectionString, {
    request: () => ({query: async () => ({recordset:[{id:1, value:"x".repeat(200000)}, {id:2}]})})
  });
  try {
    const result = await executeSqlServerRead({connectionString, sqlText:"synthetic", maxRows:1, maxResultBytes:null});
    assert.equal(result.row_count, 1);
    assert.equal(result.max_result_bytes_applied, null);
    assert.equal(result.max_rows_applied, 1);
    assert.equal(result.truncated, true);
    assert.ok(result.result_bytes > 131072);
  } finally { __sqlServerTestUtils.resetPoolCache(); }
});

test("103 independently named targets load, preserve Any and cannot leak mutable settings", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "multi-target-test-"));
  try {
    const ids = ["client-a", "client_a", "CLIENT-A", ...Array.from({length:100}, (_, i) => `client-${i}`)];
    const targets = ids.map((id, i) => ({target_id:id, display_name:`Cliente è ${i}`, environment:"qa",
      db_kind:"sqlserver", status:"active", connection_env_var:`DB_${i}`, read_enabled:true,
      write_enabled:false, anonymization_enabled:false, anonymization_mode:"off", llm_provider:"none",
      llm_model:"", max_rows:i+1, max_result_bytes:i === 0 ? null : 1000+i, allowed_tools:["db_read"]}));
    const file = path.join(dir, "targets.json");
    await fs.writeFile(file, JSON.stringify({targets}));
    const registry = await loadTargetRegistry(file, {env:{}});
    assert.equal(registry.size, 103);
    assert.equal(registry.get(ids[0]).max_result_bytes, null);
    for (let i=0; i<ids.length; i++) assert.equal(registry.get(ids[i]).max_rows, i+1);
    registry.get(ids[0]).allowed_tools.push("db_write");
    assert.deepEqual(registry.get(ids[0]).allowed_tools, ["db_read"]);
    await assert.rejects(loadTargetRegistry(file, {env:{TARGET_CLIENT_A_READ_ENABLED:"false"}}), /Ambiguous/);
  } finally { await fs.rm(dir, {recursive:true, force:true}); }
});

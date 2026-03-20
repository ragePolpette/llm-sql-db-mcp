import test from "node:test";
import assert from "node:assert/strict";
import { anonymizeRows, __anonymizationCoreTestUtils } from "../src/lib/anonymizer.js";

test("anonymizeRows deterministically masks obvious sensitive keys without provider calls", async () => {
  const rows = await anonymizeRows(
    [
      {
        Id: 1,
        Email: "mario.rossi@example.com",
        PartitaIva: "12345678901",
        Telefono: "+39 333 1234567"
      }
    ],
    {
      provider: "none",
      mode: "deterministic",
      fieldIdentification: "heuristic",
      hashSalt: "Super-Secret-Hash-Salt-123!",
      failOpen: false,
      timeoutMs: 5000,
      model: "",
      baseUrl: ""
    }
  );

  assert.equal(rows[0].Id, 1);
  assert.match(rows[0].Email, /^user_[a-f0-9]{10}@example\.invalid$/);
  assert.match(rows[0].PartitaIva, /^VAT_[A-F0-9]{12}$/);
  assert.match(rows[0].Telefono, /^\+39\d{10}$/);
});

test("anonymizeRows uses LM classification and keeps deterministic output", async () => {
  const rows = await anonymizeRows(
    [
      {
        Conto: "1213628",
        Descrizione: "Cliente principale"
      }
    ],
    {
      provider: "lmstudio",
      mode: "hybrid",
      fieldIdentification: "hybrid",
      hashSalt: "Super-Secret-Hash-Salt-123!",
      failOpen: false,
      timeoutMs: 5000,
      model: "google/gemma-3-4b",
      baseUrl: "http://127.0.0.1:1234/v1"
    },
    {
      sqlText: "SELECT Conto, Descrizione FROM dbo.DocPdc",
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: "{\"fields\":{\"Conto\":\"none\",\"Descrizione\":\"none\"}}"
                }
              }
            ]
          };
        }
      })
    }
  );

  assert.equal(rows[0].Conto, "1213628");
  assert.equal(rows[0].Descrizione, "Cliente principale");
});

test("anonymizeRows fails closed in llm-strict when field identification fails", async () => {
  await assert.rejects(
    () =>
      anonymizeRows(
        [{ Nome: "Mario" }],
        {
          provider: "ollama",
          mode: "llm-strict",
          fieldIdentification: "llm",
          hashSalt: "Super-Secret-Hash-Salt-123!",
          failOpen: false,
          timeoutMs: 5000,
          model: "gemma3:4b",
          baseUrl: "http://127.0.0.1:11434"
        },
        {
          fetchImpl: async () => {
            throw new Error("provider down");
          }
        }
      ),
    /Field identification LLM failed/
  );
});

test("anonymizeRows caches field decisions per SQL source scope", async () => {
  __anonymizationCoreTestUtils.resetKindCache();

  await anonymizeRows(
    [{ RiferimentoAmministrazione: "Ufficio Appalti" }],
    {
      provider: "lmstudio",
      mode: "hybrid",
      fieldIdentification: "hybrid",
      hashSalt: "Super-Secret-Hash-Salt-123!",
      failOpen: false,
      timeoutMs: 5000,
      model: "google/gemma-3-4b",
      baseUrl: "http://127.0.0.1:1234/v1"
    },
    {
      sqlText: "SELECT RiferimentoAmministrazione FROM dbo.Fat_Clienti_dettaglio",
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: "{\"fields\":{\"RiferimentoAmministrazione\":\"none\"}}"
                }
              }
            ]
          };
        }
      })
    }
  );

  const cacheKeys = __anonymizationCoreTestUtils.getKindCacheKeys();
  assert.equal(cacheKeys.length, 1);
  assert.match(cacheKeys[0], /dbo\.fat_clienti_dettaglio\|riferimento_amministrazione/);
});

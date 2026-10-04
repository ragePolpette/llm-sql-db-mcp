import test from "node:test";
import assert from "node:assert/strict";
import { anonymizeRows, __anonymizationCoreTestUtils } from "../src/lib/anonymizer.js";

test("anonymizeRows preserves cf and partita iva while still masking real sensitive keys", async () => {
  const rows = await anonymizeRows(
    [
      {
        Id: 1,
        Email: "mario.rossi@example.com",
        PartitaIva: "12345678901",
        CodiceFiscale: "RSSMRA80A01H501U",
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
  assert.equal(rows[0].PartitaIva, "12345678901");
  assert.equal(rows[0].CodiceFiscale, "RSSMRA80A01H501U");
  assert.match(rows[0].Telefono, /^\+39\d{10}$/);
});

test("anonymizeRows preserves technical flags and generated references", async () => {
  const rows = await anonymizeRows(
    [
      {
        Estero: "0",
        numrif: "OQ00000009"
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

  assert.equal(rows[0].Estero, "0");
  assert.equal(rows[0].numrif, "OQ00000009");
});

test("anonymizeRows preserves structured operational codes", async () => {
  const rows = await anonymizeRows(
    [
      {
        codice_ordine: "OQ00000010"
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

  assert.equal(rows[0].codice_ordine, "OQ00000010");
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

const BASE_CFG = {
  provider: "none",
  mode: "deterministic",
  fieldIdentification: "heuristic",
  hashSalt: "Super-Secret-Hash-Salt-123!",
  failOpen: false,
  timeoutMs: 5000,
  model: "",
  baseUrl: ""
};

function llmCfg() {
  return { ...BASE_CFG, provider: "ollama", mode: "hybrid", fieldIdentification: "hybrid", model: "m", baseUrl: "http://127.0.0.1:11434" };
}

function llmFetch(fields) {
  return async () => ({
    ok: true,
    async json() {
      return { message: { content: JSON.stringify({ fields }) } };
    }
  });
}

test("a provider none verdict cannot downgrade a strong heuristic hit", async () => {
  __anonymizationCoreTestUtils.resetKindCache();
  const [row] = await anonymizeRows(
    [{ email: "mario@x.it", cognome: "Rossi" }],
    llmCfg(),
    { sqlText: "SELECT email, cognome FROM dbo.u", fetchImpl: llmFetch({ email: "none", cognome: "none" }) }
  );
  assert.match(row.email, /@example\.invalid$/);
  assert.match(row.cognome, /^NAME_/);
});

test("a low-confidence none is ignored, a high-confidence none is honoured", async () => {
  __anonymizationCoreTestUtils.resetKindCache();
  const [row] = await anonymizeRows(
    [{ Sicuro: "abc", Dubbio: "Mario Rossi" }],
    llmCfg(),
    {
      sqlText: "SELECT Sicuro, Dubbio FROM dbo.t",
      fetchImpl: llmFetch({
        Sicuro: { kind: "none", confidence: 0.99 },
        Dubbio: { kind: "none", confidence: 0.3 }
      })
    }
  );
  assert.equal(row.Sicuro, "abc");
  assert.match(row.Dubbio, /^TEXT_/);
});

test("aliasing a sensitive column to a technical name does not bypass masking", async () => {
  const sqlText = "SELECT cognome AS tipo, nome AS stato, email AS id, COUNT(*) AS total FROM dbo.u";
  const rows = [{ tipo: "Rossi", stato: "Mario", id: "mario@x.it", total: 7 }];

  const [legacy] = await anonymizeRows(rows, BASE_CFG, { sqlText });
  assert.equal(legacy.tipo, "Rossi", "without origins the legacy name-based exemption still applies");

  const [row] = await anonymizeRows(rows, BASE_CFG, {
    sqlText,
    columnOrigins: {
      tipo: { table: "u", column: "cognome" },
      stato: { table: "u", column: "nome" },
      id: { table: "u", column: "email" },
      total: null
    }
  });
  assert.match(row.tipo, /^NAME_/);
  assert.match(row.stato, /^NAME_/);
  assert.match(row.id, /@example\.invalid$/);
  assert.equal(row.total, 7);
});

test("computed string columns lose the technical-name exemption", async () => {
  const [row] = await anonymizeRows(
    [{ tipo: "Rossi", id: 5 }],
    BASE_CFG,
    { sqlText: "SELECT LEFT(cognome, 5) AS tipo, id FROM dbo.u", columnOrigins: { tipo: null, id: { table: "u", column: "id" } } }
  );
  assert.match(row.tipo, /^TEXT_/);
  assert.equal(row.id, 5);
});

test("UNION queries treat every column as computed", async () => {
  const [row] = await anonymizeRows(
    [{ tipo: "Rossi" }],
    BASE_CFG,
    { sqlText: "SELECT tipo FROM a UNION SELECT cognome FROM b", columnOrigins: { tipo: { table: "a", column: "tipo" } } }
  );
  assert.match(row.tipo, /^TEXT_/);
});

test("a provider none verdict is ignored for computed columns", async () => {
  __anonymizationCoreTestUtils.resetKindCache();
  const [row] = await anonymizeRows(
    [{ tipo: "Rossi" }],
    llmCfg(),
    {
      sqlText: "SELECT cognome AS tipo FROM dbo.u",
      columnOrigins: { tipo: null },
      fetchImpl: llmFetch({ tipo: "none" })
    }
  );
  assert.match(row.tipo, /^TEXT_/);
});

test("emails and valid IBANs are masked even in technical columns", async () => {
  const [row] = await anonymizeRows(
    [{ id: "mario@x.it", stato: "IT60X0542811101000000123456", tipo: "IT60X0542811101000000123457" }],
    BASE_CFG
  );
  assert.match(row.id, /@example\.invalid$/);
  assert.match(row.stato, /^IBAN_/);
  assert.equal(row.tipo, "IT60X0542811101000000123457", "invalid checksum is not an IBAN");
});

test("birth dates and IBAN columns are masked by name", async () => {
  const [row] = await anonymizeRows(
    [{ data_nascita: "1980-01-01T00:00:00.000Z", Iban: "x" }],
    BASE_CFG
  );
  assert.match(row.data_nascita, /^DATE_/);
  assert.match(row.Iban, /^IBAN_/);
});

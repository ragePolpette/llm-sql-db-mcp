import test from "node:test";
import assert from "node:assert/strict";
import { anonymizeRows, __anonymizationCoreTestUtils } from "../src/lib/anonymizer.js";

// Column origins as the SQL Server driver reports them for plain, non-aliased columns. Name-based
// exemptions only apply when origins are known; without them every column is treated as computed.
function resolvedOrigins(...columns) {
  return Object.fromEntries(columns.map(column => [column, { schema: "dbo", table: "t", column }]));
}

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
    },
    { columnOrigins: resolvedOrigins("Id", "Email", "PartitaIva", "CodiceFiscale", "Telefono") }
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
    },
    { columnOrigins: resolvedOrigins("Estero", "numrif") }
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
    },
    { columnOrigins: resolvedOrigins("codice_ordine") }
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
      columnOrigins: resolvedOrigins("Conto", "Descrizione"),
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
      columnOrigins: resolvedOrigins("Sicuro", "Dubbio"),
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

  const [unresolved] = await anonymizeRows(rows, BASE_CFG, { sqlText });
  assert.match(unresolved.tipo, /^TEXT_/, "without origins an alias is never trusted");
  assert.match(unresolved.stato, /^TEXT_/);
  assert.match(unresolved.id, /^TEXT_/);
  assert.equal(unresolved.total, 7);

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
    BASE_CFG,
    { columnOrigins: resolvedOrigins("id", "stato", "tipo") }
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

test("onReport explains every decision per column and never contains values", async () => {
  __anonymizationCoreTestUtils.resetKindCache();
  let report;
  await anonymizeRows(
    [{ email: "mario@x.it", Estero: "0", tipo: "Rossi", ignoto: "abc", importo: 12.5 }],
    BASE_CFG,
    { sqlText: "SELECT * FROM dbo.t", columnOrigins: resolvedOrigins("email", "Estero", "tipo", "ignoto", "importo"), onReport: r => { report = r; } }
  );
  const reasons = Object.fromEntries(report.columns.map(c => [c.column, Object.keys(c.reasons)[0]]));
  assert.equal(reasons.email, "heuristic:email");
  assert.equal(reasons.Estero, "safe:technical");
  assert.equal(reasons.ignoto, "fallback:unknown-text");
  assert.equal(reasons.importo, "kept:non-string");
  assert.ok(report.by_reason["heuristic:email"] >= 1);
  assert.equal(JSON.stringify(report).includes("mario@x.it"), false);
  assert.equal(JSON.stringify(report).includes("Rossi"), false);
});

test("a throwing onReport callback does not break anonymization", async () => {
  const [row] = await anonymizeRows([{ email: "a@b.it" }], BASE_CFG, { onReport() { throw new Error("boom"); } });
  assert.match(row.email, /@example\.invalid$/);
});

test("trust=strict ignores a provider none verdict on unknown columns", async () => {
  __anonymizationCoreTestUtils.resetKindCache();
  const [row] = await anonymizeRows(
    [{ Descrizione: "Cliente principale" }],
    { ...llmCfg(), trust: "strict" },
    { sqlText: "SELECT Descrizione FROM dbo.t", fetchImpl: llmFetch({ Descrizione: "none" }) }
  );
  assert.match(row.Descrizione, /^TEXT_/);
});

test("trust=corroborated rejects a provider none verdict when the column contains phone numbers", async () => {
  __anonymizationCoreTestUtils.resetKindCache();
  let report;
  const [clean, dirty] = await anonymizeRows(
    [{ Contatto: "ufficio acquisti" }, { Contatto: "chiamare +39 333 1234567" }],
    llmCfg(),
    {
      sqlText: "SELECT Contatto FROM dbo.t",
      columnOrigins: resolvedOrigins("Contatto"),
      fetchImpl: llmFetch({ Contatto: "none" }),
      onReport: r => { report = r; }
    }
  );
  assert.match(clean.Contatto, /^TEXT_/);
  assert.match(dirty.Contatto, /^TEXT_/);
  assert.ok(report.by_reason["provider-none-rejected:pii-pattern>fallback:text"] >= 1);
});

test("trust=corroborated still honours a clean confident none and says so in the report", async () => {
  __anonymizationCoreTestUtils.resetKindCache();
  let report;
  const [row] = await anonymizeRows(
    [{ Causale: "Fattura gennaio" }],
    llmCfg(),
    { sqlText: "SELECT Causale FROM dbo.t", columnOrigins: resolvedOrigins("Causale"), fetchImpl: llmFetch({ Causale: "none" }), onReport: r => { report = r; } }
  );
  assert.equal(row.Causale, "Fattura gennaio");
  assert.equal(report.by_reason["provider-none"], 1);
});

test("without column origins nothing is exempted by name and provider none is ignored", async () => {
  __anonymizationCoreTestUtils.resetKindCache();
  let report;
  const [row] = await anonymizeRows(
    [{ tipo: "Rossi", stato: "Mario", Causale: "Fattura gennaio", id: 42, Telefono: "+39 333 1234567" }],
    llmCfg(),
    {
      sqlText: "SELECT cognome AS tipo, nome AS stato, Causale, id, Telefono FROM dbo.t WHERE x = @p",
      fetchImpl: llmFetch({ tipo: "none", stato: "none", Causale: "none" }),
      onReport: r => { report = r; }
    }
  );
  assert.match(row.tipo, /^TEXT_/);
  assert.match(row.stato, /^TEXT_/);
  assert.match(row.Causale, /^TEXT_/, "a provider none is not trusted when the alias cannot be verified");
  assert.equal(row.id, 42, "non-string values are left as they are");
  assert.match(row.Telefono, /^\+39\d{10}$/, "name heuristics still add masking");
  assert.ok(report.columns.every(column => column.derived), "the report marks every column as unverified");
});

test("computed 0/1/true/false columns pass, computed letters and alias heuristics do not", async () => {
  let report;
  const [first, second] = await anonymizeRows(
    [
      { is_cliente: "1", iniziale: "S", flag_nome: "1" },
      { is_cliente: "0", iniziale: "N", flag_nome: "0" }
    ],
    BASE_CFG,
    {
      sqlText: "SELECT CASE WHEN x THEN '1' ELSE '0' END AS is_cliente, LEFT(cognome, 1) AS iniziale, ... AS flag_nome FROM dbo.t",
      columnOrigins: { is_cliente: null, iniziale: null, flag_nome: null },
      onReport: r => { report = r; }
    }
  );
  assert.equal(first.is_cliente, "1");
  assert.equal(second.is_cliente, "0");
  assert.match(first.iniziale, /^TEXT_/, "single letters are not treated as flags");
  assert.match(first.flag_nome, /^NAME_/, "a name heuristic on the alias still wins");
  assert.equal(report.by_reason["safe:binary-flag"], 2);
});

test("KNOWN LIMITATION: non-string values derived from sensitive columns are returned in clear", async () => {
  // Output anonymization cannot stop inference by a hostile caller: ASCII(SUBSTRING(cognome, n, 1)) or
  // YEAR(data_nascita) are numbers, and numbers are never masked, so repeating the query rebuilds the
  // value. The same holds for WHERE <sensitive column> ... with COUNT(*). See SECURITY.md (threat model):
  // the mitigation is a DB login that can only read views without the sensitive columns.
  // If this test starts failing because these values get masked, update SECURITY.md and README too.
  const [row] = await anonymizeRows(
    [{ x: 82, anno: 1980, n: 3 }],
    BASE_CFG,
    {
      sqlText: "SELECT ASCII(SUBSTRING(cognome, 1, 1)) AS x, YEAR(data_nascita) AS anno, COUNT(*) AS n FROM dbo.u WHERE cognome LIKE 'R%'",
      columnOrigins: { x: null, anno: null, n: null }
    }
  );
  assert.equal(row.x, 82, "ASCII('R') leaks the first letter of the surname");
  assert.equal(row.anno, 1980, "the birth year leaks");
  assert.equal(row.n, 3, "COUNT(*) over a sensitive predicate leaks");
});

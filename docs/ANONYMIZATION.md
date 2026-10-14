# Anonymization

## Column catalog

With `ANON_CATALOG_PATH` set, the server learns which columns are safe or sensitive per target. The result is reviewed periodically with the CLI:

```bash
npm run anon:catalog -- list                      # pending columns, most used first
npm run anon:catalog -- list --status auto-safe   # columns that were auto-promoted
npm run anon:catalog -- set dbo.Clienti.Note sensitive --kind text
npm run anon:catalog -- set dbo.Ordini.Stato safe
```

- The catalog needs SQL Server column origins (`sys.dm_exec_describe_first_result_set`). Results without origins do not touch the catalog.
- `auto-safe` is granted only to repeated, short, non-name-like, PII-free value sets. Free text and Title Case values stay masked until a human decides.
- Machine evidence is kept per `target_id`, so dev data never vouches for prod. Human verdicts apply to all targets.
- Verdicts can only be edited with the CLI, never through MCP tools.
- Keep the catalog file outside the repository: it contains schema names.

## Threat model

Output anonymization protects against accidental exposure of personal data to a client acting in good faith, for example an LLM reading production data. It does not protect against a hostile caller crafting queries to infer values. Numbers derived from sensitive columns (`ASCII(SUBSTRING(cognome, 1, 1))`, `YEAR(data_nascita)`) are returned in clear, and predicates on sensitive columns (`COUNT(*) ... WHERE cognome LIKE 'R%'`) answer yes/no questions. Filtering output cannot close these channels.

If the client may be hostile, give the target a dedicated SQL login that can only read views without the sensitive columns, or with them already pseudonymized, and treat anonymization as a second line of defense. See [SECURITY.md](../SECURITY.md).

On anonymized targets, SQL Server error messages are scrubbed of data values (for example `CAST(cognome AS int)` would otherwise echo the surname). Compile-time errors, which happen before any row is read, are kept verbatim so the query can still be fixed.

When the server cannot verify column origins, the `db_read` result carries `anonymization_notes` explaining why more columns were masked and how to rewrite the query. Rows returned by `db_write` through an `OUTPUT` clause have no column origins, so on targets that require anonymization every text column in them is treated as computed and masked unless a deterministic rule recognizes it.

## Provider classification

Unless `ANON_FIELD_IDENTIFICATION=heuristic` (and the mode is not `llm-strict`), the server asks the target's provider (LM Studio or Ollama) to classify unknown columns. The request contains column names, the query sources, and up to five raw distinct sample values per column. Run the provider locally or on a host you trust with that data. Verdicts are cached in memory per `target_id` and per query source set, so a verdict obtained on one target is never reused on another.

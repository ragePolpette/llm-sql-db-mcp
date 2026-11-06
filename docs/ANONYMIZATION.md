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
- File-name columns and plain date/time columns (see [SECURITY.md](../SECURITY.md#file-names-and-dates)) stay in clear even when the catalog holds an older `auto-sensitive` verdict for them; only a human verdict masks them.

## System metadata and numeric columns

- `kept:numeric-type`: the SQL type of the column is numeric (`int`, `bigint`, `decimal`, `numeric`, `money`, `float`, `real`, `bit`, ...), whatever the JSON value looks like.
- `safe:system-object`: the column origin is in `sys`, `INFORMATION_SCHEMA` or `msdb`.
- `safe:system-query`: every object the query reads is system metadata, so computed columns of system views (most of `INFORMATION_SCHEMA`) stay readable too.
- Never metadata: `dm_exec_sql_text`, `dm_exec_input_buffer`, query plans, Query Store text and plans, `msdb` Database Mail, `sysjobhistory`, `sysjobsteps`, `sysjobstepslogs`, audit and Extended Events files.

## Value floor

Every value that is not otherwise masked goes through a deterministic floor: e-mail addresses, checksum-valid IBANs and checksum-valid personal fiscal codes (16 characters, omocodia included) are always replaced, even in columns judged technical. VAT numbers and 11-digit company fiscal codes are not touched.

## Schema classification (on demand)

`npm run anon:catalog -- classify --target <id>` proposes verdicts for columns that have none. It never runs on the query path and never reads values: only metadata (schema, table, column, SQL type, sibling column names) reaches the model.

1. Rules first: dates (birth dates excepted), file names, system objects and recognized column names are decided without a model.
2. The remaining text columns are sent per table to a local model (`ANON_CLASSIFIER_PROVIDER` = `ollama` or `lmstudio`, `ANON_CLASSIFIER_MODEL`), with independent questions: person names, contact info, personal free text, credential, technical code, and a kind from a closed list.
3. The answer is validated (only requested columns, known kinds, probabilities in 0-1); invalid or missing answers become `review`.
4. The policy in code is asymmetric: any personal signal at 0.5 or more gives `proposed-sensitive`; `proposed-safe` needs kind `technical`, technical signal at 0.9 or more and every personal signal at 0.1 or less; everything else is `review`.
5. Proposals go to `<catalog>.proposals.json` (model, prompt version, input hash). They change nothing until accepted: `proposals`, `accept <key>` (or `accept --status proposed-safe`), `accept <key> --as safe|sensitive --kind <kind>` for review items, `reject <key>`. A rejected proposal is not proposed again until its input changes.

`classify --eval <n>` runs the same pipeline on n columns that already have a human verdict and reports `safe_precision` (the share of `proposed-safe` that a human also marked safe), `sensitive_recall`, `review_rate` and the columns that would have leaked. Run it before trusting a new model or prompt.

## Threat model

Output anonymization protects against accidental exposure of personal data to a client acting in good faith, for example an LLM reading production data. It does not protect against a hostile caller crafting queries to infer values. Numbers derived from sensitive columns (`ASCII(SUBSTRING(cognome, 1, 1))`, `YEAR(data_nascita)`) are returned in clear, and predicates on sensitive columns (`COUNT(*) ... WHERE cognome LIKE 'R%'`) answer yes/no questions. Filtering output cannot close these channels.

If the client may be hostile, give the target a dedicated SQL login that can only read views without the sensitive columns, or with them already pseudonymized, and treat anonymization as a second line of defense. See [SECURITY.md](../SECURITY.md).

On anonymized targets, SQL Server error messages are scrubbed of data values (for example `CAST(cognome AS int)` would otherwise echo the surname). Compile-time errors, which happen before any row is read, are kept verbatim so the query can still be fixed.

When the server cannot verify column origins, the `db_read` result carries `anonymization_notes` explaining why more columns were masked and how to rewrite the query. Rows returned by `db_write` through an `OUTPUT` clause have no column origins, so on targets that require anonymization every text column in them is treated as computed and masked unless a deterministic rule recognizes it.

## Provider classification

Unless `ANON_FIELD_IDENTIFICATION=heuristic` (and the mode is not `llm-strict`), the server asks the target's provider (LM Studio or Ollama) to classify unknown columns. The request contains column names, the query sources, and up to five raw distinct sample values per column. Each column also carries its source table (`schema.table`, from SQL Server column origins) and whether it is computed, so the model can read the column name in context. Run the provider locally or on a host you trust with that data.

If the provider does not answer within `ANON_TIMEOUT_MS` (5 s by default), classification is skipped and unknown text columns fall back to `TEXT_`. The `db.anonymizer_decisions` log event reports the outcome in `provider.status` (`ok`, `failed:timeout`, `failed:invalid-json`, `failed:error`, `skipped:*`) with `duration_ms`; a small model on CPU typically needs 10-20 s, so check this field before tuning prompts. Verdicts are cached in memory per `target_id` and per query source set, so a verdict obtained on one target is never reused on another.

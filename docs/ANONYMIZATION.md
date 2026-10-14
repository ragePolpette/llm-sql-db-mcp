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

When the server cannot verify column origins, the `db_read` result carries `anonymization_notes` explaining why more columns were masked and how to rewrite the query.

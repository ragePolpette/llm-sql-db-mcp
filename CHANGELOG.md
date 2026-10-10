# Changelog

Tutte le modifiche rilevanti a questo progetto saranno documentate qui.

Il formato segue in modo leggero [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) e la policy di versioning del repo e' descritta in [docs/VERSIONING_POLICY.md](./docs/VERSIONING_POLICY.md).

## [Unreleased]

### Added
- Anonymization catalog (phase B): when `ANON_CATALOG_PATH` is set, every anonymized `db_read` records, per `target_id` and per source column (`schema.table.column`), which verdict was applied plus hashed evidence (no raw values; file mode 0600). Unknown columns start `pending`; a column is auto-promoted to `auto-safe` only after >=3 uses / >=30 cells of a closed, repeated, short, non-Title-Case, PII-free value set, and is re-checked on every result. Machine `auto-safe` evidence is never shared across targets.
- `npm run anon:catalog` CLI to review (`list`, `human`) and decide (`set <col> safe|sensitive --kind`, `unset`). Human verdicts are shared by all targets and override heuristics; they are deliberately not exposed through MCP tools. The running server reloads them without restart.
- Driver reports `source_schema` for column origins (catalog keys are `schema.table.column`).

### Security
- Documented the anonymization threat model (README, SECURITY.md): output anonymization covers accidental exposure, not inference by a hostile caller (`ASCII(SUBSTRING(...))`, `YEAR(...)`, `COUNT(*)` with predicates on sensitive columns). Recommended mitigation: a DB login restricted to views without sensitive columns. A `KNOWN LIMITATION` test pins the current behaviour.
- Column-origin resolution now reads describe errors reported as rows by `sys.dm_exec_describe_first_result_set` (it usually reports errors that way rather than raising).

### Added
- `db.anonymizer_decisions` reports `origins_status` / `origins_reason` (raw SQL Server message only at `debug`).
- `db_read` (and the `run_diagnostic_query` summary) returns `anonymization_notes` when column origins are unavailable, with the reason and how to rewrite the query.
- Computed columns whose values are only `0`/`1`/`true`/`false` are returned in clear (`safe:binary-flag`); single letters are still masked.
- Anonymization: when column origins cannot be resolved (a `null` SQL parameter, temp tables, unsupported parameter types, permission or SQL Server errors) every column is now treated as computed: nothing is exempted by name and provider "none" verdicts are ignored. Previously the anonymizer fell back to trusting output names, so `SELECT cognome AS tipo ... WHERE x = @p` with `p = null` returned names in clear. `null` parameters are also declared as `nvarchar(max)` so they no longer prevent metadata resolution.
- Anonymization (phase A): per-column decision reasons are logged as `db.anonymizer_decisions` (aggregate counts at `info`, per-column detail at `debug`, never values).
- Anonymization: new per-target `anonymization_trust` (`corroborated` default, `strict`; env override `TARGET_<ID>_ANONYMIZATION_TRUST`). `strict` never accepts a provider `none` verdict on unknown columns; `corroborated` also rejects it when the column visibly contains e-mails, IBANs or phone numbers.
- Anonymization: `ANON_FAIL_OPEN` now applies only to explicitly non-production environments (`dev`, `test`, `staging`); a missing or unknown `environment` is treated as production. Targets with anonymization disabled are unchanged (results pass through).
- Anonymization: a provider `none` verdict can no longer downgrade a strong heuristic hit (email, phone, name, iban, date) and is ignored for computed columns.
- Anonymization: on SQL Server the driver resolves each output column to its source column (`sys.dm_exec_describe_first_result_set`), so aliasing (`SELECT cognome AS tipo`) no longer bypasses masking. Computed columns and UNION queries lose the technical-name exemption.
- Anonymization: e-mail addresses and checksum-valid IBANs are masked in every string value, even in columns judged technical; birth-date and IBAN columns are masked by name.
- Anonymization: the provider is asked for a confidence; a `none` verdict below `ANON_MIN_CONFIDENCE` (default 0.8) is ignored and the column stays masked. Prompt now flags sample values as untrusted.

### Added
- `run_diagnostic_query` now accepts an optional explicit `target_id` override, allowing deterministic diagnostic reads even when multiple active targets share the same environment.

## [0.1.0] - 2026-03-27

### Added
- target registry dinamico con source of truth file-based e policy target-aware
- guard rail rigidi per target `environment=prod`
- supporto a anonimizzazione configurabile per target
- documentazione pubblica minima di prodotto: `README`, `SECURITY`, `CONTRIBUTING`, roadmap e note operative

### Changed
- logging runtime ridotto a metadati sicuri con livelli espliciti, `request_id` e formato configurabile
- lifecycle del server con shutdown pool SQL, timeout DB, readiness separata e diagnostica non ambigua
- suite di test ampliata su guard rail SQL, registry dinamico e invarianti di sicurezza ragionevoli

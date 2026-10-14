# Changelog

All notable changes to this project are documented in this file.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The versioning policy is described in [docs/VERSIONING_POLICY.md](./docs/VERSIONING_POLICY.md).

## [Unreleased]

### Security
- SQL guard rewritten as a single-pass T-SQL tokenizer. The previous regex chain stripped comments before string literals, so `SELECT '--'; DROP TABLE t` and `SELECT 1 AS [a']; DROP TABLE t; SELECT ']'` passed the read guard. Multi-statement batches (any `;` followed by more code, or a second top-level statement without `;`), `GO`, unterminated literals or comments, unbalanced parentheses, transaction control, `DECLARE`, `SET` in reads, `WAITFOR`, `OPENROWSET`/`OPENQUERY`/`OPENDATASOURCE` and other non-DML statements are now rejected. Queries that used one of these keywords as a bare identifier must quote it (`[name]`).
- Production fence is enforced in code: `environment` must be one of `dev`, `test`, `qa`, `uat`, `staging`, `prod` (case-insensitive, aliases `development` and `production`); other values now fail at startup. On `prod` targets `write_enabled` is forced to `false`, `db_write` is removed from `allowed_tools`, the policy engine always denies `db_write`, and `TARGET_<ID>_WRITE_ENABLED=true` / `TARGET_<ID>_ANONYMIZATION_ENABLED=false` are ignored with a warning. A prod target with `anonymization_enabled=false` in the registry is still accepted, with a startup warning. `db_write` was removed from the prod target in `targets.json`.
- Rows returned by `db_write` (an `OUTPUT` clause) are now anonymized when the target requires anonymization; `db_write` responses include the `anonymization_*` fields.
- The in-memory cache of provider field verdicts is keyed by `target_id` as well as by query sources, so a verdict obtained on one target is never reused on another.
- Optional static token at the HTTP edge: when `DB_MCP_API_KEY` is set, every request needs `Authorization: Bearer <token>` or `x-api-key: <token>` (timing-safe comparison). Starting with a non-loopback `HOST` and no `DB_MCP_API_KEY` is now refused. The Express app now receives the configured host, so the SDK localhost Host-header check applies only to loopback binds.
- `ANON_HASH_SALT` is validated at startup when any active target has anonymization enabled; previously the server started and failed on the first masked value.
- Documented that raw sample values are sent to the local LLM provider during classification and that fiscal codes and VAT numbers are treated as safe identifiers by design (SECURITY.md).

### Changed
- `db_read` streams the first result set and stops at `max_rows + 1` rows or at `max_result_bytes`, instead of loading the whole result in memory. `total_rows_before_limits` now counts rows read (at most `max_rows + 1`), not the full result size.
- `db_read` runs in an explicit `READ COMMITTED` transaction that is always rolled back.
- Concurrent first requests to a target share a single connection pool; a failed connection attempt is no longer cached.
- LM Studio and Ollama share one HTTP client with per-provider adapters. Timeouts now abort with a recognizable `AbortError` and also cover reading the response body.
- Shutdown forces a flush of the anonymization catalog and logs `anon.catalog_flush_failed` with the catalog error.
- Output byte clamping after anonymization is linear instead of quadratic.
- A single `zod` import style is used across the code base.
- The logger gained a `warn` level.

### Added
- ESLint (flat config, `@eslint/js` recommended) with `npm run lint`, included in `npm run check` and therefore in CI.

### Added
- Anonymization catalog (phase B): when `ANON_CATALOG_PATH` is set, every anonymized `db_read` records, per `target_id` and per source column (`schema.table.column`), which verdict was applied plus hashed evidence (no raw values; file mode 0600). Unknown columns start `pending`; a column is auto-promoted to `auto-safe` only after >=3 uses / >=30 cells of a closed, repeated, short, non-Title-Case, PII-free value set, and is re-checked on every result. Machine `auto-safe` evidence is never shared across targets.
- `npm run anon:catalog` CLI to review (`list`, `human`) and decide (`set <col> safe|sensitive --kind`, `unset`). Human verdicts are shared by all targets and override heuristics; they are deliberately not exposed through MCP tools. The running server reloads them without restart.
- Driver reports `source_schema` for column origins (catalog keys are `schema.table.column`).

### Security
- `db_read` on anonymized targets redacts data values echoed by SQL Server error messages (conversion, JSON, overflow, duplicate-key, driver JSON errors) in both the response and `db.query_failed` logs. Compile-time errors (invalid column, syntax, ...) are kept verbatim because they occur before any row is read; unknown error numbers are redacted. Targets without anonymization are unchanged.
- SECURITY.md: login hardening checklist for anonymized targets (views in a separate schema, no base-table SELECT, no server/database state, no SHOWPLAN, `public`/`guest` review) with a T-SQL example and verification steps.
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
- dynamic target registry as a file-based source of truth with target-aware policy
- strict guard rails for `environment=prod` targets
- configurable per-target anonymization
- minimal public product documentation: `README`, `SECURITY`, `CONTRIBUTING`, roadmap, and operational notes

### Changed
- runtime logging reduced to safe metadata with explicit levels, `request_id`, and a configurable format
- server lifecycle with SQL pool shutdown, DB timeouts, separate readiness, and unambiguous diagnostics
- test suite extended to cover SQL guard rails, the dynamic registry, and reasonable security invariants

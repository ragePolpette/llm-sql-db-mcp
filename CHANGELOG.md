# Changelog

Tutte le modifiche rilevanti a questo progetto saranno documentate qui.

Il formato segue in modo leggero [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) e la policy di versioning del repo e' descritta in [docs/VERSIONING_POLICY.md](./docs/VERSIONING_POLICY.md).

## [Unreleased]

### Security
- Anonymization: a provider `none` verdict can no longer downgrade a strong heuristic hit (email, phone, name, iban, date) and is ignored for computed columns.
- Anonymization: on SQL Server the driver resolves each output column to its source column (`sys.dm_exec_describe_first_result_set`), so aliasing (`SELECT cognome AS tipo`) no longer bypasses masking. Computed columns and UNION queries lose the technical-name exemption; if origins cannot be resolved the previous name-based behaviour applies.
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

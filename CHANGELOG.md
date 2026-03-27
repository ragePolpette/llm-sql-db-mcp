# Changelog

Tutte le modifiche rilevanti a questo progetto saranno documentate qui.

Il formato segue in modo leggero [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) e la policy di versioning del repo e' descritta in [docs/VERSIONING_POLICY.md](./docs/VERSIONING_POLICY.md).

## [Unreleased]

### Changed
- Nessuna voce ancora registrata. Aggiornare questa sezione quando una branch modifica contract MCP, schema registry, comportamento runtime o posture documentata del prodotto.

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

# Versioning Policy

Questa policy definisce come versionare in modo semplice e credibile:
- il contract MCP esposto dal server
- il target registry caricato da file
- la release pubblica del repository

Obiettivo:
- evitare drift tra runtime, docs e release
- chiarire cosa e' breaking e cosa no
- mantenere il repo leggibile come prodotto serio anche se resta locale

## Source Of Truth

La release pubblica del repo usa la versione in `package.json`.

Il runtime deve esporre la stessa versione tramite `config.serverVersion`, non una stringa hardcoded separata.

Questo implica:
- una release cambia `package.json`
- il server espone la stessa versione in health/readiness e metadata MCP
- docs e changelog si allineano a quella versione

## Semver Scope

Il progetto segue SemVer in modo pragmatico:
- `MAJOR`: breaking change al contract MCP o al registry schema
- `MINOR`: aggiunte backward-compatible a tool, metadati o configurazione
- `PATCH`: fix, hardening, miglioramenti docs o chiarimenti senza rotture di contract

## MCP Contract Rules

Per questo repo il contract MCP include:
- nomi dei tool
- input attesi
- shape di output rilevante per i client
- codici errore machine-readable quando gia' documentati

Regole:
- aggiungere un nuovo tool opzionale e' `MINOR`
- aggiungere un nuovo campo opzionale in output e' `MINOR`
- cambiare nome di un tool o rimuoverlo e' `MAJOR`
- rendere obbligatorio un campo prima opzionale e' `MAJOR`
- cambiare semantica di un errore in modo incompatibile e' almeno `MINOR`, spesso `MAJOR`

## Target Registry Rules

Lo schema attuale del registry e' implicitamente `v1`:
- top-level con `targets`
- ogni target con metadata, binding di connessione e policy target-aware

Regole:
- aggiungere campi opzionali backward-compatible e' `MINOR`
- cambiare significato di campi esistenti o rimuoverli e' `MAJOR`
- se in futuro serve una rottura di schema, introdurre un campo top-level esplicito come `registry_schema_version`

Finche' il registry resta backward-compatible, non serve forzare un campo versione nel file.

## Change Discipline

Quando una modifica tocca contract MCP o registry:
1. aggiornare questa policy o il doc pertinente se cambia la regola
2. aggiornare `README.md` se cambia il comportamento utente
3. aggiornare `targets.example.json` se cambia la configurazione raccomandata
4. aggiungere test o fixture che coprano il nuovo contract
5. annotare il change nel changelog o nella release note minima

## Deliberately Not Covered

Questa policy non introduce:
- version negotiation runtime
- multi-schema registry loader
- compatibility matrix complessa tra client e server

Per il target del repo sarebbe overbuild. Basta avere una disciplina chiara e una singola source of truth per la versione pubblica.

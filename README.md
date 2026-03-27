# llm-sql-db-mcp

MCP server HTTP stateful per SQL Server con surface fissa, target registry dinamico e policy target-aware. Il progetto e' pensato per uso locale o team limitato: mette guard rail pratici attorno a query SQL lette o scritte via MCP, senza trasformarsi in un control plane complesso.

## Cosa Fa

Il server espone una surface MCP piccola e stabile per:
- elencare i target DB configurati
- ispezionare metadati e policy effettive di un target
- eseguire query read-safe su target consentiti
- eseguire write controllate solo sui target che lo permettono
- applicare anonimizzazione target-aware dove richiesta

L'obiettivo non e' "fare da ORM" o da query engine generico. L'obiettivo e' ridurre il rischio operativo quando un client MCP deve interrogare database SQL Server con policy note e verificabili.

## Target User

Il progetto e' adatto a:
- uso personale avanzato
- team ristretto o business unit limitata
- demo e portfolio pubblico di un MCP serio ma non internet-facing

Non e' progettato oggi per multi-tenancy, esposizione pubblica o deployment enterprise aperto.

## Non-Goals

Fuori scope attuale:
- supporto database diversi da SQL Server
- provisioning UI incorporato
- orchestrazione cloud o deployment internet-facing
- auth enterprise completa o IAM centralizzato
- riscrittura del query engine oltre i guard rail necessari

## Architettura

Componenti principali:
- `src/server.js`: transport HTTP MCP, lifecycle del processo e wiring dei tool
- `src/lib/config.js`: parsing e validazione della configurazione runtime
- `src/lib/target-registry.js`: source of truth dei target DB caricati da file
- `src/lib/policy-engine.js`: decisioni target-aware su read, write e anonimizzazione
- `src/lib/sql-guard.js`: blocchi lessicali e invarianti per query consentite
- `src/lib/drivers/sqlserver.js`: integrazione runtime con SQL Server tramite `mssql`
- `src/lib/anonymization/*`: masking deterministico e classificazione field-aware

La surface MCP resta intenzionalmente piccola:
- `db_target_list`
- `db_target_info`
- `db_policy_info`
- `db_read`
- `db_write`
- `run_diagnostic_query` opzionale

## Data Flow

Flusso essenziale di una richiesta:
1. il client MCP chiama un tool via HTTP
2. il server valida sessione, input e target richiesto
3. il target registry risolve il target e il relativo binding di connessione
4. il policy engine decide se il tool e' consentito e se serve anonimizzazione
5. il guard SQL verifica che la query rientri nelle forme ammesse
6. il driver SQL Server esegue la query con timeout e limiti runtime
7. se richiesto, la pipeline di anonimizzazione trasforma i valori del result set
8. il server restituisce un payload MCP coerente e logga solo metadati sicuri

## Security Model Locale

Questo progetto assume un modello di sicurezza pragmatico:
- il server gira su macchina locale o rete fidata limitata
- le connection string restano fuori dal repo e fuori dal `.env`
- i target `environment=prod` devono avere fence non aggirabili
- i log di default non devono esporre SQL completo, parametri raw o row payload
- le policy stanno nel registry target, non nella logica del client

In pratica il boundary di sicurezza non e' "esporre il server a internet", ma "ridurre errori e abusi in un contesto locale controllato".

Policy operativa e note di disclosure sono descritte in [SECURITY.md](./SECURITY.md).
La direzione futura per un boundary di autenticazione opzionale e' documentata in [docs/AUTH_FUTURE_INTEGRATION.md](./docs/AUTH_FUTURE_INTEGRATION.md).

## Limiti Noti

Limiti intenzionali o attuali:
- solo SQL Server
- nessuna UI incorporata in questo repo
- le protezioni SQL restano guard rail applicativi, non sostituiscono permessi DB minimi lato credenziali
- `/ready` esiste per segnalare config e registry minimi, ma non sostituisce dependency checks profondi
- l'autenticazione forte non e' implementata perche' il target operativo non e' pubblico
- esiste un punto di integrazione documentato per auth futura, ma oggi non e' parte del runtime attivo

## Operational Notes

- Avvio rapido: `npm install` poi `npm start`
- Smoke test minimo: `npm run check` e `npm test`
- Rotazione secret runtime: aggiornare solo le env var di connessione o il binding esterno del target, mai committare secret nel repo
- Disabilitazione target: impostare `status=disabled` nel target registry e riavviare il processo che carica il file
- Roadmap operativa: vedi [docs/PRODUCT_ROADMAP_CHECKLIST.md](./docs/PRODUCT_ROADMAP_CHECKLIST.md)
- Docs index: vedi [docs/README.md](./docs/README.md)
- Contributi: vedi [CONTRIBUTING.md](./CONTRIBUTING.md)
- Security posture: vedi [SECURITY.md](./SECURITY.md)
- Licenza: vedi [LICENSE](./LICENSE)

## Requisiti

- Node.js 22+
- runtime env vars per le connection string dei target
- opzionale: LM Studio o Ollama locali per i target che richiedono anonimizzazione

## Avvio rapido

1. Installa le dipendenze:

```bash
npm install
```

2. Verifica o adatta [targets.example.json](./targets.example.json) e [.env.example](./.env.example).

3. Esporta a runtime le connection string richieste dai target, per esempio:

```powershell
$env:DB_DEV_MAIN_CONNECTION_STRING="Server=.;Database=DevDb;Trusted_Connection=True;Encrypt=False"
$env:DB_PROD_MAIN_CONNECTION_STRING="Server=.;Database=ProdDb;Trusted_Connection=True;Encrypt=False"
$env:DB_OPS_ARCHIVE_CONNECTION_STRING="Server=.;Database=OpsArchive;Trusted_Connection=True;Encrypt=False"
```

4. Avvia il server:

```bash
npm start
```

Health:
- `GET /health`
- `GET /ready`

Endpoint MCP:
- `POST /mcp`
- `GET /mcp`
- `DELETE /mcp`

## Configurazione

Variabili principali:
- `HOST`: default `127.0.0.1`
- `PORT`: default `3000`
- `MCP_PATH`: default `/mcp`
- `HEALTH_PATH`: default `/health`
- `READINESS_PATH`: default `/ready`
- `TARGETS_FILE`: default `targets.json`
- `SESSION_TTL_MS`: default `1800000` (30 minuti). `0` significa no expiry ed e' consigliato solo per debugging locale controllato
- `SESSION_SWEEP_INTERVAL_MS`: sweep interval delle sessioni scadute
- `ALLOW_LOOPBACK_ORIGINS`: consente origin loopback
- `ALLOWED_ORIGINS`: lista CSV di origin consentiti
- `LOG_LEVEL`: `error`, `info`, `debug`
- `LOG_FORMAT`: `json` di default; `plain` opzionale per output piu' leggibile in locale
- `LMSTUDIO_BASE_URL`: default `http://127.0.0.1:1234/v1`
- `OLLAMA_BASE_URL`: default `http://127.0.0.1:11434`
- `ANON_FIELD_IDENTIFICATION`: `hybrid`, `heuristic`, `llm`
- `ANON_HASH_SALT`: secret stabile usato per il masking deterministico
- `ANON_FAIL_OPEN`: se `true`, puo' aprire solo su target non-`prod`; per `environment=prod` `llm-strict` resta fail-closed
- `ANON_TIMEOUT_MS`: timeout delle chiamate provider per identificazione campi

Override runtime per target:
- prefisso: `TARGET_<TARGET_ID_NORMALIZZATO>_...`
- esempio per `prod-main`: `TARGET_PROD_MAIN_...`
- campi supportati:
  - `READ_ENABLED`
  - `WRITE_ENABLED`
  - `ANONYMIZATION_ENABLED`
  - `ANONYMIZATION_MODE`
  - `LLM_PROVIDER`
  - `LLM_MODEL`

Regola importante:
- non mettere connection string, API key, password o secret nel file `.env` del progetto; il loader le rifiuta esplicitamente
- per uso normale il server applica un TTL sessione di default; usare `SESSION_TTL_MS=0` solo se vuoi deliberatamente sessioni MCP persistenti senza scadenza

## Target Registry

Il server legge i target da [`targets.json`](./targets.json). Ogni target definisce:
- `target_id`
- `display_name`
- `environment`
- `status`
- metadati sicuri
- env var della connection string
- limiti read-only
- allowed tools
- configurazione anonimizzazione

Esempi tipici:
- target dev read/write per workflow locale controllato
- target prod read-only con anonimizzazione obbligatoria
- target disabled mantenuto nel registry ma non interrogabile

Il file [targets.example.json](./targets.example.json) mostra esplicitamente tutti e tre i profili:
- `dev-main`: target dev read/write senza anonimizzazione
- `prod-main`: target prod read-only con anonimizzazione attiva
- `ops-archive`: target disabled utile come esempio di spegnimento operativo senza cancellare il binding

Mode supportati:
- `off`
- `deterministic`
- `hybrid`
- `llm-strict`

Nota:
- `direct` resta accettato come alias legacy ma viene trattato come `llm-strict`

## Tool MCP

Nota harness: `run_diagnostic_query` vive in questo repo perché orchestra i tool target-based esistenti (`db_read`, policy e registry) e mantiene un contract unico. I repo legacy `llm-db-dev-mcp` e `llm-db-prod-mcp` restano invariati.

### `db_target_list`

Ritorna solo metadati sicuri dei target.

### `db_target_info`

Input:
- `target_id`

Ritorna:
- metadati sicuri del target
- limiti effettivi
- tool consentiti
- mode/provider/model di anonimizzazione

### `db_policy_info`

Input:
- `target_id`
- `tool_name` opzionale

Ritorna:
- se il tool e consentito
- se l'anonimizzazione sarebbe richiesta
- motivo del deny

### `db_read`

Input:
- `target_id`
- `sql`
- `parameters` opzionale
- `max_rows` opzionale

Regole:
- accetta solo SQL read-safe
- rifiuta keyword write/DDL e multi-statement
- usa solo SQL Server
- applica `max_rows` e `max_result_bytes`
- se il target richiede anonimizzazione, applica masking deterministico sui valori
- il provider configurato non riscrive il result set: viene usato per classificare i campi quando la strategia lo richiede
- se la query e il target lo consentono, la forma del result set viene preservata

### `db_write`

Input:
- `target_id`
- `sql`
- `parameters` opzionale

Regole:
- il tool esiste sempre nella surface MCP, ma viene permesso solo se `write_enabled=true` per il target
- supporta solo statement di write controllati:
  - `INSERT`
  - `UPDATE`
  - `DELETE`
  - `MERGE`
  - write CTE che terminano in una di queste operazioni
- continua a bloccare anche in modalita write:
  - `DROP`
  - `ALTER`
  - `CREATE`
  - `TRUNCATE`
  - `EXEC`
  - `EXECUTE`
  - multi-statement
  - `SELECT INTO`
- non applica anonimizzazione all'output

## Test

Check sintattico:

```bash
npm run check
```

Suite completa:

```bash
npm test
```

La suite copre:
- config loading
- target registry
- policy engine
- sql guard
- anonymization core deterministico + classificazione field-aware
- handler `db_read`
- parsing provider
- integration test MCP HTTP per health/tool surface/tool call

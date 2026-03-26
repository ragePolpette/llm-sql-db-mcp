# llm-sql-db-mcp

MCP server HTTP stateful che espone una surface SQL fissa e policy-driven su piu target SQL Server configurati staticamente.

## Stato v1

Supportato:
- SQL Server soltanto
- target multipli via `targets.json`
- tool MCP fissi: `db_target_list`, `db_target_info`, `db_policy_info`, `db_read`, `db_write`
- tool diagnostico opzionale: `run_diagnostic_query`
- policy target-aware
- anonimizzazione target-aware con pipeline deterministica riusabile
- provider `lmstudio` e `ollama` usati per identificazione campi sensibili dove richiesto

Non supportato:
- MySQL
- provisioning UI

## Requisiti

- Node.js 22+
- runtime env vars per le connection string dei target
- opzionale: LM Studio o Ollama locali per i target che richiedono anonimizzazione

## Avvio rapido

1. Installa le dipendenze:

```bash
npm install
```

2. Verifica o adatta [targets.example.json](/C:/Users/Gianmarco/Urgewalt/Yetzirah/llm-sql-db-mcp/targets.example.json) e [\.env.example](/C:/Users/Gianmarco/Urgewalt/Yetzirah/llm-sql-db-mcp/.env.example).

3. Esporta a runtime le connection string richieste dai target, per esempio:

```powershell
$env:DB_DEV_MAIN_CONNECTION_STRING="Server=.;Database=DevDb;Trusted_Connection=True;Encrypt=False"
$env:DB_PROD_MAIN_CONNECTION_STRING="Server=.;Database=ProdDb;Trusted_Connection=True;Encrypt=False"
```

4. Avvia il server:

```bash
npm start
```

Health:
- `GET /health`

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
- `TARGETS_FILE`: default `targets.json`
- `SESSION_TTL_MS`: default `1800000` (30 minuti). `0` significa no expiry ed e' consigliato solo per debugging locale controllato
- `SESSION_SWEEP_INTERVAL_MS`: sweep interval delle sessioni scadute
- `ALLOW_LOOPBACK_ORIGINS`: consente origin loopback
- `ALLOWED_ORIGINS`: lista CSV di origin consentiti
- `LMSTUDIO_BASE_URL`: default `http://127.0.0.1:1234/v1`
- `OLLAMA_BASE_URL`: default `http://127.0.0.1:11434`
- `ANON_FIELD_IDENTIFICATION`: `hybrid`, `heuristic`, `llm`
- `ANON_HASH_SALT`: secret stabile usato per il masking deterministico
- `ANON_FAIL_OPEN`: se `true`, in `llm-strict` non blocca la query quando l'identificazione LLM fallisce
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

Il server legge i target da [targets.json](/C:/Users/Gianmarco/Urgewalt/Yetzirah/llm-sql-db-mcp/targets.json). Ogni target definisce:
- `target_id`
- metadati sicuri
- env var della connection string
- limiti read-only
- allowed tools
- configurazione anonimizzazione

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

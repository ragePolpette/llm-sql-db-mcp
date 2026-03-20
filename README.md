# llm-sql-db-mcp

MCP server HTTP stateful che espone una surface SQL fissa e policy-driven su piu target SQL Server configurati staticamente.

## Stato v1

Supportato:
- SQL Server soltanto
- target multipli via `targets.json`
- tool MCP fissi: `db_target_list`, `db_target_info`, `db_policy_info`, `db_read`
- policy target-aware
- anonimizzazione target-aware con pipeline deterministica riusabile
- provider `lmstudio` e `ollama` usati per identificazione campi sensibili dove richiesto

Non supportato:
- write tools
- MySQL
- dashboard integration
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
- `SESSION_TTL_MS`: `0` significa no expiry
- `SESSION_SWEEP_INTERVAL_MS`: sweep interval delle sessioni scadute
- `ALLOW_LOOPBACK_ORIGINS`: consente origin loopback
- `ALLOWED_ORIGINS`: lista CSV di origin consentiti
- `LMSTUDIO_BASE_URL`: default `http://127.0.0.1:1234/v1`
- `OLLAMA_BASE_URL`: default `http://127.0.0.1:11434`
- `ANON_FIELD_IDENTIFICATION`: `hybrid`, `heuristic`, `llm`
- `ANON_HASH_SALT`: secret stabile usato per il masking deterministico
- `ANON_FAIL_OPEN`: se `true`, in `llm-strict` non blocca la query quando l'identificazione LLM fallisce
- `ANON_TIMEOUT_MS`: timeout delle chiamate provider per identificazione campi

Regola importante:
- non mettere connection string, API key, password o secret nel file `.env` del progetto; il loader le rifiuta esplicitamente

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

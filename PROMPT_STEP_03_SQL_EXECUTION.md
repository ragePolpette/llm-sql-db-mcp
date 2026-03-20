Step 3: SQL Execution

Leggi prima [IMPLEMENTATION_PLAN.md](C:/Users/Gianmarco/Urgewalt/Yetzirah/llm-sql-db-mcp/IMPLEMENTATION_PLAN.md).

Prerequisito:
- step 1 e 2 già completati e committati

Obiettivo:
- aggiungere esecuzione query read-only per SQL Server

Implementa:
- `src/lib/sql-guard.js`
- `src/lib/drivers/sqlserver.js`
- estensione di `src/lib/handlers.js`
- tool `db_read`

Requisiti:
- solo SQL Server
- `db_read` richiede `target_id`
- query non read-safe rifiutate
- output normalizzato
- rispetto dei limiti `max_rows` e `max_result_bytes`
- errori chiari quando manca la env connection string del target

Non implementare ancora:
- write tools
- MySQL
- anonimizzazione provider-based

A fine step:
- aggiungi test mirati
- fai commit con messaggio tipo `Add read-only SQL Server execution`
- fermati

Step 2: Fixed Tool Surface

Leggi prima [IMPLEMENTATION_PLAN.md](C:/Users/Gianmarco/Urgewalt/Yetzirah/llm-sql-db-mcp/IMPLEMENTATION_PLAN.md).

Prerequisito:
- lo step 1 deve essere già completato e committato

Obiettivo:
- aggiungere la surface MCP fissa senza query execution

Implementa:
- `src/lib/tools.js`
- `src/lib/handlers.js`
- `src/lib/policy-engine.js`

Tool da aggiungere:
- `db_target_list`
- `db_target_info`
- `db_policy_info`

Requisiti:
- `target_id` obbligatorio dove serve
- errori chiari per target sconosciuto o disabilitato
- nessun target implicito
- output coerente con il piano
- descrizioni tool e campi schema curate

Non implementare ancora:
- `db_read`
- SQL guard
- driver SQL
- anonymization provider calls

A fine step:
- verifica avvio server e `tools/list`
- fai commit con messaggio tipo `Add llm-sql-db-mcp target and policy tools`
- fermati

Step 1: Foundation

Leggi prima [IMPLEMENTATION_PLAN.md](C:/Users/Gianmarco/Urgewalt/Yetzirah/llm-sql-db-mcp/IMPLEMENTATION_PLAN.md).

Obiettivo:
- creare lo skeleton del progetto
- predisporre il server MCP HTTP
- aggiungere config, session store, target registry e health

Implementa:
- `package.json`
- `src/server.js`
- `src/lib/config.js`
- `src/lib/session-store.js`
- `src/lib/target-registry.js`
- `targets.json`
- `.gitignore`
- eventuale `.env.example`

Requisiti:
- server HTTP MCP con `/health`
- transport streamable HTTP
- session store con supporto TTL `0 = no expiry`
- origin validation
- config runtime chiara
- niente write
- niente dashboard
- niente query execution ancora

Output atteso:
- server avviabile
- `/health` risponde
- target registry caricato e validato a startup

A fine step:
- esegui i check minimi
- fai commit con messaggio tipo `Add llm-sql-db-mcp foundation`
- fermati

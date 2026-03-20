Step 4: Anonymization Providers

Leggi prima [IMPLEMENTATION_PLAN.md](C:/Users/Gianmarco/Urgewalt/Yetzirah/llm-sql-db-mcp/IMPLEMENTATION_PLAN.md).

Prerequisito:
- step 1, 2 e 3 già completati e committati

Obiettivo:
- aggiungere anonimizzazione output target-aware

Implementa:
- `src/lib/anonymizer.js`
- `src/lib/providers/ollama.js`
- `src/lib/providers/lmstudio.js`
- integrazione nel flow di `db_read`

Requisiti:
- provider supportati:
  - `none`
  - `ollama`
  - `lmstudio`
- niente fallback automatico tra provider
- parser robusto per JSON puro o fenced JSON
- se il target richiede anonymization ma il provider non è disponibile, errore chiaro
- se il target non richiede anonymization, output raw

Non implementare ancora:
- dashboard integration
- target provisioning UI
- write tools

A fine step:
- aggiungi test provider/parsing
- fai commit con messaggio tipo `Add target-aware anonymization providers`
- fermati

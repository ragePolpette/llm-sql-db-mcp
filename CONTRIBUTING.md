# Contributing

Grazie per voler contribuire a `llm-sql-db-mcp`.

Il progetto ha un target intenzionale preciso:
- tool locale o team limitato
- non internet-facing
- hardening pragmatico
- surface MCP piccola e prevedibile

Le contributioni migliori rafforzano questi obiettivi invece di allargare il perimetro in modo casuale.

## Workflow

Workflow richiesto per ogni modifica:
1. creare un branch feature dedicato da `main`
2. implementare il cambiamento in modo mirato
3. eseguire i check e i test pertinenti
4. push del branch
5. aprire una PR
6. fare merge solo dopo verifica del diff
7. aggiornare [docs/PRODUCT_ROADMAP_CHECKLIST.md](./docs/PRODUCT_ROADMAP_CHECKLIST.md) se il lavoro tocca item tracciati

Pattern consigliati per il naming dei branch:
- `feature/p0-redacted-logging`
- `feature/p1-security-docs`
- `feature/p1-contributing-license`
- `fix/sql-guard-cte-parse`

## Change Scope

Preferire PR piccole e leggibili:
- una responsabilita' chiara per PR
- niente refactor larghi senza necessita' reale
- niente riscritture del query engine salvo bug o incoerenze concrete
- niente cambi di comportamento impliciti sui target `prod`

## Safety Rules

Regole da non violare:
- non committare secret, connection string, token o password
- non usare `.env` del repo per secret runtime
- non indebolire i fence dei target `environment=prod`
- non trasformare il server in un servizio internet-facing "per comodita'"
- non introdurre logging di SQL raw, parametri raw o row payload di default

Se una modifica tocca policy, anonimizzazione, registry target o target `prod`, la PR deve spiegarlo in modo esplicito.

## Testing Expectations

Prima di aprire una PR:
- eseguire `npm run check`
- eseguire `npm test` se la modifica tocca runtime, handler, policy, registry, driver o guard rail
- per modifiche solo documentali, dichiarare esplicitamente che non sono stati eseguiti test

Se aggiungi o cambi comportamento:
- aggiornare i test esistenti quando possibile
- evitare fix senza copertura minima sui casi critici

## Documentation Expectations

Aggiornare la documentazione quando cambia uno di questi aspetti:
- scope del prodotto
- configurazione runtime
- contract dei tool MCP
- target registry
- policy o limiti di sicurezza

I file principali da tenere coerenti sono:
- [README.md](./README.md)
- [SECURITY.md](./SECURITY.md)
- [docs/PRODUCT_ROADMAP_CHECKLIST.md](./docs/PRODUCT_ROADMAP_CHECKLIST.md)

## Pull Request Notes

Una buona PR dovrebbe includere:
- summary breve del cambiamento
- motivazione tecnica
- testing eseguito oppure nota `documentation-only`
- eventuali rischi residui

Evitare PR che mischiano:
- hardening
- nuove feature
- refactor strutturali
- pulizia cosmetica non correlata

## Out Of Scope Contributions

Contributi che oggi non sono prioritari:
- supporto cloud-first
- multi-tenancy
- autenticazione enterprise completa
- supporto generico a molti database senza un piano chiaro
- UI o control plane incorporati in questo repo

Se vuoi proporre qualcosa di grosso o fuori scope, apri prima una issue o una PR di design minima.

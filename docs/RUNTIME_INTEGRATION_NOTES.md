# Runtime Integration Notes

Questa nota chiude due decisioni pragmatiche del repo:
- per ora non introdurre un `Dockerfile`
- lasciare un boundary chiaro per un futuro control plane esterno

L'obiettivo non e' aumentare la complessita', ma evitare decisioni incoerenti col target attuale del progetto.

## Dockerfile Decision

Decisione corrente:
- nessun `Dockerfile` nel repo per ora

Motivo:
- il server e' pensato per uso locale o team-limitato, spesso con SQL Server raggiungibile in rete interna o locale
- alcuni target usano provider LLM locali come LM Studio o Ollama, che in demo native restano piu' semplici da collegare
- la gestione dei secret avviene via env var runtime, non via file versionati o immagini container
- un container adesso rischierebbe di sembrare "deployment-ready" quando il progetto non vuole comunicare quello

In pratica, per il target attuale il run nativo e' piu' onesto e meno fragile di un packaging container improvvisato.

## Quando Un Dockerfile Avrebbe Senso

Un `Dockerfile` diventerebbe utile solo se serve uno di questi casi:
- demo ripetibile su piu' macchine con stesso Node runtime
- smoke environment locale uniforme per review o portfolio
- packaging esplicito per testare startup, health e config senza dipendere dall'host

Se introdotto in futuro, dovrebbe essere:
- chiaramente marcato come demo/local packaging
- senza secret embedded
- con `targets.json` montato dall'esterno
- con env var passate a runtime
- senza far sembrare il repo pronto per esposizione pubblica

## Future Control Plane Boundary

Il query engine non deve diventare il punto di orchestrazione.

La divisione corretta dei ruoli e':
- questo repo resta data plane MCP
- un eventuale dashboard o control plane esterno resta owner di registry, metadata operativi e riferimenti ai secret

## Existing Hooks

Il boundary esiste gia' in forma semplice:
- `TARGETS_FILE` definisce la source of truth file-based del registry
- le connection string restano in env var runtime
- gli override `TARGET_<TARGET_ID>_...` consentono variazioni operative senza cambiare il codice

Questo significa che un control plane esterno puo':
1. generare o aggiornare il file registry
2. gestire i binding secret fuori dal repo
3. riavviare o orchestrare il reload del processo MCP

Il server continua a fare solo:
- validation
- policy enforcement
- query execution
- anonymization

## Deliberately Deferred

Non introdurre ora:
- API admin nel server per mutare il registry
- scrittura diretta dei secret da parte del server
- coupling forte con dashboard o vault specifici
- reload hot del registry se complica le invarianti dei target `prod`

Se servira' un control plane piu' ricco, l'integrazione corretta e' al bordo del runtime, non dentro `handlers` o `sql-guard`.

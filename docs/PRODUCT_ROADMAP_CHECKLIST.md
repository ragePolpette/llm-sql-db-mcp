# Product Roadmap Checklist

Roadmap pragmatica per portare `llm-sql-db-mcp` da buon tool locale a prodotto serio, sicuro e presentabile come portfolio pubblico.

Scope intenzionale:
- tool locale o business-unit limited
- non internet-facing
- non multi-tenant
- design pulito, sicurezza ragionevole, operativita' solida

Non-goal attuali:
- deployment pubblico
- orchestrazione cloud
- auth enterprise completa
- supporto multi-database immediato

## Workflow Di Esecuzione

Per ogni item implementato:
1. creare branch feature dedicato
2. implementare + testare localmente
3. push del branch
4. aprire PR
5. review / merge
6. aggiornare questo file spuntando il punto completato e aggiungendo riferimenti alla PR

Convenzione suggerita per i branch:
- `feature/p0-redacted-logging`
- `feature/p0-db-timeouts`
- `feature/p1-security-docs`

## Definition Of Done Del Repo

Il repo e' considerato "degno" per il target attuale quando:
- i log non espongono SQL sensibile, parametri o row payload di default
- i pool DB e le sessioni hanno lifecycle chiaro
- il tool diagnostico non ha ambiguita' deboli
- il README spiega chiaramente scope, limiti e modello di sicurezza
- esistono documenti minimi da repo serio (`SECURITY.md`, `LICENSE`, `CONTRIBUTING.md`)
- la suite test copre i percorsi critici e i guard rail principali
- il progetto comunica una direzione credibile verso un uso piu' strutturato

## P0 - Safety E Solidita' Minima

Obiettivo: eliminare i punti che oggi fanno sembrare il tool rischioso o incompleto.

- [x] Ridurre i log runtime ai soli metadati sicuri.
  Note:
  - niente row payload nei log
  - niente parametri raw nei log di default
  - niente dump completo del SQL in produzione locale "normale"
- [x] Introdurre livelli di logging espliciti (`error`, `info`, `debug`) con redaction coerente.
- [x] Chiudere esplicitamente i pool SQL Server nello shutdown del server.
- [x] Introdurre timeout DB espliciti per query e connessioni.
- [x] Introdurre configurazione minima del pool DB (`max`, `min`, `idleTimeoutMillis` o equivalente `mssql`).
- [x] Rendere `run_diagnostic_query` non ambiguo con registry dinamico.
  Opzioni accettabili:
  - richiedere `target_id` esplicito nel path diagnostico
  - oppure fallire se piu' target attivi matchano lo stesso environment
- [ ] Impostare un default piu' sano per `SESSION_TTL_MS` oppure documentare in modo molto chiaro il default infinito.
- [ ] Aggiungere test sui nuovi comportamenti di logging, shutdown, timeout e diagnostica non ambigua.

## P1 - Repo Serio E Portfolio Ready

Obiettivo: far percepire il progetto come prodotto curato, non come harness interno.

- [ ] Rafforzare il `README.md` con:
  - architettura del sistema
  - data flow essenziale
  - target user
  - non-goals
  - limiti noti
  - modello di sicurezza locale
- [ ] Aggiungere `SECURITY.md`.
  Contenuti minimi:
  - threat model leggero
  - cosa e' protetto
  - cosa non va fatto
  - come gestire secret e target prod
- [ ] Aggiungere `CONTRIBUTING.md` con workflow branch -> push -> PR -> merge.
- [ ] Aggiungere una `LICENSE` adatta alla pubblicazione del portfolio.
- [ ] Aggiungere una sezione "Operational Notes" con:
  - come avviare il tool
  - come fare smoke test
  - come ruotare i secret runtime
  - come disabilitare un target
- [ ] Aggiungere esempi migliori di configurazione target:
  - dev read/write
  - prod read-only + anonymization
  - target disabled
- [ ] Ripulire o contestualizzare i documenti legacy/prompt-oriented dentro `docs/`.
- [ ] Aggiungere una mini roadmap pubblica nel `README` che punti a questo file.

## P1.5 - Hardening Tecnico Ragionevole

Obiettivo: aumentare la credibilita' tecnica senza sovraingegnerizzare.

- [ ] Introdurre `request_id` o `correlation_id` nei log runtime.
- [ ] Distinguere meglio health, readiness e stato dipendenze.
  Minimo accettabile:
  - `/health` base
  - readiness check che segnali config/registry validi
- [ ] Rendere gli errori piu' consistenti e machine-readable.
- [ ] Rendere esplicita la strategia per `ANON_FAIL_OPEN` e limitarla ai casi veramente tollerabili.
- [ ] Aggiungere test adversarial su `sql-guard` per query borderline e bypass lessicali.
- [ ] Aggiungere test di integrazione sul nuovo registry dinamico con target multipli nello stesso environment.

## P2 - Direzione Verso Enterprise, Senza Overbuild

Obiettivo: lasciare nel repo una direzione credibile, senza implementare tutto subito.

- [ ] Preparare structured logging JSON opzionale.
- [ ] Disegnare un modello di auth opzionale per uso futuro.
  Nota:
  - non implementarlo ora se il tool resta locale
  - basta documentare il punto di integrazione
- [ ] Definire una policy di versioning del contract MCP e della config target registry.
- [ ] Preparare un file `CHANGELOG.md` o una policy release minimale.
- [ ] Valutare un `Dockerfile` solo se utile per demo ripetibili locali.
- [ ] Aggiungere note su come collegare in futuro il tool a un control plane esterno senza cambiare il query engine.

## Sequenza Consigliata

Ordine consigliato di sviluppo:

1. P0 logging
2. P0 shutdown + pool lifecycle
3. P0 timeout e pool config
4. P0 diagnostica non ambigua
5. P0 session TTL
6. P1 README
7. P1 `SECURITY.md`
8. P1 `CONTRIBUTING.md` + `LICENSE`
9. P1.5 request id + error model
10. P1.5 test hardening

## Tracking

Usare questa sezione durante il lavoro per collegare gli item alle PR.

| Item | Branch | PR | Stato | Note |
|---|---|---|---|---|
| P0 logging redaction | feature/p0-redacted-logging |  | Ready for PR | logging redatto + log levels espliciti + check/test ok |
| P0 DB shutdown + pool close | feature/p0-db-shutdown-pool-close |  | Ready for PR | runtime.stop chiude le pool SQL + test lifecycle + check/test ok |
| P0 DB timeout + pool config | feature/p0-db-timeout-pool-config |  | Ready for PR | config runtime SQL esplicita + mapping driver + test + check/test ok |
| P0 diagnostic target resolution | feature/p0-diagnostic-target-resolution |  | Ready for PR | il tool diagnostico fallisce su target multipli attivi invece di sceglierne uno + check/test ok |
| P0 session TTL policy |  |  | Todo |  |
| P1 README hardening |  |  | Todo |  |
| P1 SECURITY.md |  |  | Todo |  |
| P1 CONTRIBUTING.md + LICENSE |  |  | Todo |  |
| P1.5 request id + error model |  |  | Todo |  |
| P1.5 guard/test hardening |  |  | Todo |  |

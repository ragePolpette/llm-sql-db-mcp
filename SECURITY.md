# Security Policy

## Scope

`llm-sql-db-mcp` e' progettato per:
- uso locale
- rete fidata limitata
- team ristretto o business unit limitata

Non e' progettato per:
- esposizione pubblica su internet
- multi-tenancy
- deployment aperto senza hardening aggiuntivo

Questo file descrive il modello di sicurezza attuale del progetto, non una promessa di copertura totale.

## Security Goals

Gli obiettivi pratici del progetto sono:
- ridurre il rischio di query dannose o incoerenti tramite tool surface fissa e policy target-aware
- evitare esposizione accidentale di secret o payload sensibili nei log
- mantenere fence rigide sui target `environment=prod`
- separare la configurazione dei target dalla logica del client MCP

## Threat Model Light

Assunzioni:
- il processo gira su una macchina controllata oppure su una rete interna fidata
- l'operatore del server controlla runtime env, file di registry e credenziali DB
- il database resta il boundary finale di autorizzazione attraverso permessi minimi lato credenziali

Rischi che il progetto prova a mitigare:
- query write o DDL non consentite inviate per errore o tramite client MCP mal configurato
- accesso a target non permessi dal registry
- uso improprio di target `prod`
- esposizione di dati sensibili in result set dove il target richiede anonimizzazione
- leak accidentali nei log applicativi

Rischi non coperti completamente:
- host compromesso
- credenziali DB troppo permissive
- esposizione del server su internet senza autenticazione o proxy adeguato
- bypass completi del motore SQL tramite capability esterne al processo

## Protected Assets

Asset principali da proteggere:
- connection string e altri secret runtime
- dati letti dai target database
- policy per target
- distinzione fra target `dev`, `test`, `prod`
- integrita' del target registry

## Required Operational Rules

Regole operative minime:
- non committare mai connection string, token o password nel repo
- non usare il file `.env` del progetto per secret runtime
- non esporre il server direttamente su internet
- usare credenziali DB a privilegi minimi e separate per target quando possibile
- trattare `environment=prod` come boundary con guard rail non aggirabili
- usare `status=disabled` per target temporaneamente fuori uso invece di lasciarli attivi e inutilizzati

## Production Targets

Per tutti i target `environment=prod`:
- niente scorciatoie che riabilitano write in modo implicito
- niente bypass delle policy via naming legacy o fallback deboli
- anonimizzazione obbligatoria se il target lo richiede nel registry
- i log non devono contenere row payload, parametri raw o SQL completo di default
- ogni variazione al target registry va trattata come change operativo sensibile

Se hai dubbi su un target `prod`, il comportamento corretto e' bloccare o disabilitare il target finche' la configurazione non e' chiara.

## Secrets Handling

Linee guida:
- tenere i secret fuori da Git e fuori da file di configurazione versionati
- usare env var runtime o un secret store esterno
- ruotare i secret cambiando il binding runtime, non patchando il codice
- non includere secret in issue, PR, log o transcript di test

Il progetto rifiuta intenzionalmente secret nel `.env` locale per evitare leakage accidentale.

## Safe Usage Guidance

Uso considerato ragionevole:
- sviluppo locale
- analisi guidata su target dev o test
- letture controllate su target prod con policy forti e anonimizzazione dove richiesta

Uso sconsigliato o fuori scope:
- dare accesso indiscriminato a client o agenti non affidabili
- usare credenziali sysadmin o equivalenti
- considerare i guard rail applicativi come sostituti dei permessi SQL
- usare `ANON_FAIL_OPEN=true` come scorciatoia per target `prod`: su `environment=prod` il progetto deve restare fail-closed

## Vulnerability Reporting

Se trovi una vulnerabilita' o un comportamento insicuro:
- non pubblicare subito exploit, secret o dettagli riproducibili in un issue pubblico
- preferire GitHub Security Advisories o private reporting, se abilitati
- se non e' disponibile un canale privato, aprire un issue minimale senza dettagli sensibili e chiedere un contatto riservato

Per problemi non sensibili o miglioramenti di hardening, una normale issue o PR va bene.

## Security Posture Today

Il progetto punta a essere:
- sicuro in modo pragmatico per uso locale o team limitato
- leggibile e verificabile come portfolio pubblico
- orientato verso standard piu' alti, senza fingersi un servizio enterprise gia' pronto per esposizione pubblica

Non va presentato come soluzione sicura "by default" per ambienti internet-facing senza ulteriori controlli architetturali.

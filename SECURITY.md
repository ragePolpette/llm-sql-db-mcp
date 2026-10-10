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
- esposizione accidentale di dati sensibili in result set dove il target richiede anonimizzazione (non l'inferenza deliberata: vedi sotto)
- leak accidentali nei log applicativi

Rischi non coperti completamente:
- host compromesso
- credenziali DB troppo permissive
- esposizione del server su internet senza autenticazione o proxy adeguato
- bypass completi del motore SQL tramite capability esterne al processo

## Anonimizzazione: cosa protegge e cosa no

L'anonimizzazione agisce sull'**output** di `db_read`: maschera i valori che il server riconosce come dati personali prima di restituirli al client.

Protegge da:
- **esposizione accidentale** di dati personali verso un client (tipicamente un LLM) che legge dati di produzione in buona fede: una `SELECT *`, una colonna di note, un alias che rinomina una colonna sensibile;
- alias e colonne calcolate: l'origine delle colonne viene risolta tramite SQL Server e, se non si ottiene, nulla viene esentato in base al nome.

**Non protegge da un chiamante ostile** che costruisce query per inferire i valori. Esempi che oggi funzionano e restituiscono dati in chiaro:
- `SELECT ASCII(SUBSTRING(cognome, 1, 1)) AS x ...`, ripetuta per ogni posizione: i numeri non vengono mai mascherati, quindi si ricostruisce il cognome;
- `SELECT YEAR(data_nascita) ...`, `DATEDIFF(...)`, `LEN(email)`: qualsiasi valore numerico derivato da una colonna sensibile;
- `SELECT COUNT(*) ... WHERE cognome LIKE 'R%'`: un predicato su una colonna sensibile risponde sì/no, e con abbastanza query ricostruisce il valore.

Filtrare l'output non può chiudere questi canali: l'inferenza va bloccata a monte, nei permessi del database. Un test (`KNOWN LIMITATION` in `tests/anonymization-core.test.js`) documenta il comportamento attuale.

Se il client può essere ostile, o se un'esfiltrazione deliberata è un rischio da coprire (dettagli nella sezione successiva):
- usare per il target un **login SQL dedicato con permessi solo su viste** che non contengono le colonne sensibili (o le espongono già pseudonimizzate), senza `SELECT` sulle tabelle base;
- in alternativa usare le funzionalità del database pensate per questo (ad esempio permessi a livello di colonna con `DENY SELECT` sulle colonne sensibili, Row-Level Security); il Dynamic Data Masking di SQL Server da solo non basta, perché è aggirabile con predicati e funzioni allo stesso modo;
- considerare l'anonimizzazione del server come una seconda linea, non come il confine di sicurezza.

## Hardening del login per i target anonimizzati

Se il client puo' essere ostile, il confine vero e' il login SQL del target, non l'anonimizzazione. Checklist minima per il login referenziato da `connection_env_var` di un target anonimizzato:

1. **Un login dedicato per target**, usato solo da questo server.
2. **Solo viste, in uno schema separato.** Le viste espongono solo colonne non sensibili (o surrogate key per i join). Lo schema separato serve perche' un `DENY` sullo schema `dbo` blocca anche le viste che stanno in `dbo`. Se gli schemi hanno lo stesso owner (tipicamente `dbo`), l'ownership chaining fa funzionare le viste senza permessi sulle tabelle base.
3. **Nessun `SELECT` sulle tabelle base**: mai il ruolo `db_datareader` (da' `SELECT` su tutto) e `DENY` esplicito sullo schema delle tabelle.
4. **Niente pseudonimi "fatti in casa" nelle viste**: un `HASHBYTES` senza segreto su email, telefono o codice fiscale si inverte per dizionario. Meglio omettere la colonna o esporre una chiave surrogata.
5. **Niente stato di server e database**: non concedere `VIEW SERVER STATE` / `VIEW DATABASE STATE` (ne' le varianti `... PERFORMANCE STATE` di SQL Server 2022). Le DMV come `sys.dm_exec_sql_text` mostrano le query di altre sessioni con i loro letterali.
6. **Niente `SHOWPLAN`**: non serve al server e il piano contiene i valori dei parametri compilati.
7. **Niente `EXECUTE` su funzioni** che leggono colonne sensibili.
8. **Controllare il ruolo `public` e l'utente `guest`**: nessun permesso su tabelle con dati personali, `guest` disabilitato nei database del server.
9. **Nessun utente del login in altri database** dello stesso server.

Esempio (da adattare):

```sql
-- server
CREATE LOGIN mcp_prod_reader WITH PASSWORD = '<secret>', CHECK_POLICY = ON;

-- database
CREATE USER mcp_prod_reader FOR LOGIN mcp_prod_reader;
GO
CREATE SCHEMA mcp AUTHORIZATION dbo;
GO
CREATE VIEW mcp.Clienti AS
  SELECT Id, Stato, Provincia, DataCreazione   -- niente Nome, Cognome, Email, Telefono, Note
  FROM dbo.Clienti;
GO
GRANT SELECT ON SCHEMA::mcp TO mcp_prod_reader;
DENY SELECT ON SCHEMA::dbo TO mcp_prod_reader;
DENY VIEW DATABASE STATE TO mcp_prod_reader;
DENY SHOWPLAN TO mcp_prod_reader;
```

Verifica, eseguita da un amministratore:

```sql
EXECUTE AS USER = 'mcp_prod_reader';
SELECT TOP (1) Cognome FROM dbo.Clienti;                -- deve fallire
SELECT TOP (1) * FROM mcp.Clienti;                      -- deve funzionare
SELECT * FROM fn_my_permissions(NULL, 'DATABASE');      -- nessun SELECT/VIEW STATE inatteso
REVERT;
```

Con questo login l'anonimizzazione del server resta attiva come seconda linea: copre gli errori di configurazione delle viste e l'esposizione accidentale. In piu', sui target anonimizzati i messaggi d'errore di SQL Server vengono ripuliti dai valori che possono contenere (es. `Conversion failed when converting the nvarchar value '...'`); gli errori di compilazione, che avvengono prima di leggere qualsiasi riga, restano integri per poter correggere la query.

## Future Authentication Boundary

Il runtime attuale non implementa auth forte perche' il target operativo resta locale o team-limitato.

La direzione prevista, se il repo dovesse salire di livello, e' aggiungere auth al bordo HTTP:
- prima della risoluzione sessione MCP
- prima dell'esecuzione dei tool
- senza riscrivere query engine, registry o surface MCP

Il design di riferimento e' documentato in [docs/AUTH_FUTURE_INTEGRATION.md](./docs/AUTH_FUTURE_INTEGRATION.md).

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
- considerare l'anonimizzazione dell'output una difesa contro un client ostile: non lo e'
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

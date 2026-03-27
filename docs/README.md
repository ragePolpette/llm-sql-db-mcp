# Docs Index

Questa cartella contiene solo documentazione pubblica e mantenuta.

Obiettivo:
- tenere nel repo documenti utili a uso, review e manutenzione del progetto
- evitare handoff operativi temporanei, prompt interni o note effimere che invecchiano male

## Documenti Correnti

- [PRODUCT_ROADMAP_CHECKLIST.md](./PRODUCT_ROADMAP_CHECKLIST.md): roadmap pragmatica del repo, checklist di hardening e tracking degli step completati
- [AUTH_FUTURE_INTEGRATION.md](./AUTH_FUTURE_INTEGRATION.md): punto di integrazione per auth opzionale futura senza cambiare query engine o surface MCP
- [VERSIONING_POLICY.md](./VERSIONING_POLICY.md): regole semplici per versionare release pubblica, contract MCP e schema del target registry
- [../CHANGELOG.md](../CHANGELOG.md): changelog minimale del prodotto con sezione `Unreleased` e baseline `0.1.0`

## Criterio Di Inclusione

Un documento entra in `docs/` se:
- serve a utenti o contributori del repo
- descrive roadmap, architettura, sicurezza o operativita' reale
- resta utile anche dopo il singolo ciclo di lavoro

Un documento non dovrebbe stare qui se:
- e' un prompt di lavoro temporaneo
- e' un handoff tra agenti o sessioni
- contiene dettagli operativi usa-e-getta
- duplica contenuti che stanno meglio in `README.md`, `SECURITY.md` o `CONTRIBUTING.md`

## Nota Sul Repo Pubblico

Questo repository punta a essere leggibile come portfolio pubblico. Per questo i documenti in `docs/` devono essere pochi, chiari e mantenuti, non un dump di materiale interno.

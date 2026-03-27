# Future Auth Integration

Questa nota descrive come introdurre autenticazione opzionale in `llm-sql-db-mcp` senza rifare il query engine e senza cambiare la surface MCP.

Obiettivo:
- chiarire dove si aggancia l'auth
- evitare che il repo sembri ingenuo sul boundary di sicurezza
- mantenere il target attuale locale o team-limitato

Non-obiettivo:
- implementare auth nel runtime attuale
- trasformare il progetto in servizio pubblico o multi-tenant

## Current Posture

Oggi il server assume:
- macchina locale o rete interna fidata
- operatori noti
- credenziali DB e target registry gestiti dallo stesso owner operativo

Questo significa che l'assenza di auth forte e' una scelta di scope, non una dimenticanza architetturale.

## Future Modes

Se il progetto dovesse salire di livello, i mode ragionevoli sono:
- `off`: default attuale per uso locale controllato
- `static-bearer`: token condiviso semplice per reti interne limitate
- `jwt`: bearer firmato con issuer/audience verificati dietro reverse proxy o IdP interno
- `proxy-auth`: trust esplicito di header identitari iniettati da reverse proxy autenticato

Per il target del repo, il primo step realistico sarebbe `static-bearer` o `proxy-auth`, non RBAC enterprise completo.

## Integration Point

L'integrazione corretta e' nel transport HTTP, prima della risoluzione sessione MCP e prima dell'esecuzione dei tool.

Punto di aggancio previsto:
- middleware Express in `src/server.js`
- estrazione principal da header o token
- validazione del mode configurato
- arricchimento del request context con `principal_id`, `auth_mode`, `auth_scope`

Questo consente di mantenere invariati:
- `target-registry`
- `policy-engine`
- `handlers`
- query engine

## Minimal Principal Model

Se l'auth viene introdotta, il principal minimo dovrebbe includere:
- `principal_id`
- `auth_mode`
- `scopes` o `allowed_targets`
- opzionale `display_name`

Il principal non deve essere usato per sostituire le policy target-aware esistenti. Deve solo aggiungere un boundary ulteriore.

## Policy Mapping

L'evoluzione piu' pulita e':
1. il middleware autentica il chiamante
2. il request context porta il principal fino agli handler
3. il policy engine valuta sia il target sia il principal
4. i log registrano `request_id` e `principal_id` senza esporre payload sensibili

Questo evita di spargere logica auth dentro i tool.

## Safe Default

Quando l'auth verra' introdotta, il default ragionevole resta:
- `AUTH_MODE=off` per sviluppo locale puro
- fail-closed se `AUTH_MODE` e' diverso da `off` ma mancano i prerequisiti minimi
- nessun bypass implicito per target `environment=prod`

## Deliberately Deferred

Fuori scope per il prossimo futuro:
- multi-tenant RBAC
- per-target ACL complesse lato principal
- refresh token, session provider o OIDC completo
- gestione utenti dentro questo repo

La direzione corretta, se servira', e' integrazione semplice al bordo HTTP e policy enforcement riusando il modello target-aware gia' esistente.

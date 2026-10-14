# Future Auth Integration

This note describes how optional authentication could be added to `llm-sql-db-mcp` without reworking the query engine or changing the MCP surface. Nothing described here is implemented in the current runtime.

Goals:

- clarify where authentication attaches
- make the security boundary explicit
- keep the current target of local or small-team use

Non-goals:

- implementing authentication in the current runtime
- turning the project into a public or multi-tenant service

## Current posture

The server currently assumes:

- a local machine or trusted internal network
- known operators
- DB credentials and the target registry managed by the same operational owner

The absence of strong authentication is a scope decision, not an architectural omission.

## Possible modes

If the project moves beyond local use, reasonable modes are:

- `off`: the current default for controlled local use
- `static-bearer`: a simple shared token for limited internal networks
- `jwt`: a signed bearer with issuer and audience verified behind a reverse proxy or internal IdP
- `proxy-auth`: explicit trust of identity headers injected by an authenticated reverse proxy

The first realistic step would be `static-bearer` or `proxy-auth`, not full enterprise RBAC.

## Integration point

Authentication belongs in the HTTP transport, before MCP session resolution and before tool execution.

Planned attachment point:

- an Express middleware in `src/server.js`
- principal extraction from a header or token
- validation of the configured mode
- enrichment of the request context with `principal_id`, `auth_mode`, and `auth_scope`

This keeps the following unchanged:

- `target-registry`
- `policy-engine`
- `handlers`
- the query engine

## Minimal principal model

If authentication is introduced, the minimal principal should include:

- `principal_id`
- `auth_mode`
- `scopes` or `allowed_targets`
- optionally `display_name`

The principal must not replace the existing target-aware policies. It only adds a further boundary.

## Policy mapping

The cleanest evolution is:

1. the middleware authenticates the caller
2. the request context carries the principal to the handlers
3. the policy engine evaluates both the target and the principal
4. logs record `request_id` and `principal_id` without exposing sensitive payloads

This avoids spreading authentication logic across the tools.

## Safe default

When authentication is introduced, the default should remain:

- `AUTH_MODE=off` for purely local development
- fail-closed if `AUTH_MODE` is not `off` but the minimum prerequisites are missing
- no implicit bypass for `environment=prod` targets

## Deliberately deferred

Out of scope for the foreseeable future:

- multi-tenant RBAC
- complex per-target ACLs on the principal
- refresh tokens, session providers, or full OIDC
- user management inside this repository

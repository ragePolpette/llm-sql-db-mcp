# Security Policy

## Scope

`llm-sql-db-mcp` is designed for:

- local use
- a limited trusted network
- a small team or a limited business unit

It is not designed for:

- public exposure on the internet
- multi-tenancy
- open deployment without additional hardening

This file describes the current security model of the project. It is not a promise of complete coverage.

## Security goals

- reduce the risk of harmful or inconsistent queries through a fixed tool surface and target-aware policy
- avoid accidental exposure of secrets or sensitive payloads in logs
- keep strict fences on `environment=prod` targets
- separate target configuration from the MCP client logic

## Threat model

Assumptions:

- the process runs on a controlled machine or a trusted internal network
- the server operator controls the runtime environment, the registry file, and the DB credentials
- the database remains the final authorization boundary through least-privilege credentials

Risks the project tries to mitigate:

- write or DDL queries that are not allowed, sent by mistake or by a misconfigured MCP client
- access to targets not permitted by the registry
- improper use of `prod` targets
- accidental exposure of sensitive data in result sets where the target requires anonymization (not deliberate inference, see below)
- accidental leaks in application logs

Risks not fully covered:

- a compromised host
- overly permissive DB credentials
- exposure of the server on the internet without authentication or a suitable proxy
- complete bypasses of the SQL engine through capabilities outside the process

## Anonymization: what it protects and what it does not

Anonymization acts on the output of `db_read`: it masks values the server recognizes as personal data before returning them to the client.

It protects against:

- accidental exposure of personal data to a client (typically an LLM) reading production data in good faith: a `SELECT *`, a notes column, an alias that renames a sensitive column
- aliases and computed columns: column origins are resolved through SQL Server and, if that fails, nothing is exempted based on its name

It does not protect against a hostile caller crafting queries to infer values. Examples that currently work and return data in clear:

- `SELECT ASCII(SUBSTRING(cognome, 1, 1)) AS x ...`, repeated for each position: numbers are never masked, so the surname can be reconstructed
- `SELECT YEAR(data_nascita) ...`, `DATEDIFF(...)`, `LEN(email)`: any numeric value derived from a sensitive column
- `SELECT COUNT(*) ... WHERE cognome LIKE 'R%'`: a predicate on a sensitive column answers yes/no, and with enough queries the value can be reconstructed

Filtering output cannot close these channels. Inference must be blocked upstream, in database permissions. A test (`KNOWN LIMITATION` in `tests/anonymization-core.test.js`) documents the current behavior.

If the client may be hostile, or deliberate exfiltration is a risk to cover:

- use a dedicated SQL login for the target with permissions only on views that do not contain the sensitive columns (or expose them already pseudonymized), with no `SELECT` on the base tables
- alternatively use database features designed for this, such as column-level permissions with `DENY SELECT` on sensitive columns, or Row-Level Security; SQL Server Dynamic Data Masking alone is not enough, because it can be bypassed with predicates and functions in the same way
- treat server-side anonymization as a second line of defense, not as the security boundary

More detail: [docs/ANONYMIZATION.md](./docs/ANONYMIZATION.md).

## Future authentication boundary

The current runtime does not implement strong authentication because the intended deployment is local or limited to a team.

If the project moves up a level, authentication would be added at the HTTP edge:

- before MCP session resolution
- before tool execution
- without rewriting the query engine, the registry, or the MCP surface

The reference design is in [docs/AUTH_FUTURE_INTEGRATION.md](./docs/AUTH_FUTURE_INTEGRATION.md).

## Protected assets

- connection strings and other runtime secrets
- data read from the target databases
- per-target policy
- the distinction between `dev`, `test`, and `prod` targets
- integrity of the target registry

## Required operational rules

- never commit connection strings, tokens, or passwords to the repository
- do not use the project `.env` file for runtime secrets
- do not expose the server directly on the internet
- use least-privilege DB credentials, separate per target where possible
- treat `environment=prod` as a boundary with guard rails that cannot be bypassed
- use `status=disabled` for targets that are temporarily out of use instead of leaving them active and unused

## Production targets

For all `environment=prod` targets:

- no shortcuts that implicitly re-enable writes
- no policy bypass through legacy naming or weak fallbacks
- anonymization is mandatory if the target requires it in the registry
- logs must not contain row payloads, raw parameters, or full SQL by default
- every change to the target registry is a sensitive operational change

If in doubt about a `prod` target, the correct behavior is to block or disable the target until the configuration is clear.

## Secrets handling

- keep secrets out of Git and out of versioned configuration files
- use runtime environment variables or an external secret store
- rotate secrets by changing the runtime binding, not by patching code
- do not include secrets in issues, PRs, logs, or test transcripts

The project intentionally rejects secrets in the local `.env` to avoid accidental leakage.

## Safe usage guidance

Reasonable use:

- local development
- guided analysis on dev or test targets
- controlled reads on prod targets with strong policy and anonymization where required

Discouraged or out of scope:

- giving indiscriminate access to untrusted clients or agents
- using sysadmin or equivalent credentials
- treating application guard rails as a substitute for SQL permissions
- treating output anonymization as a defense against a hostile client
- using `ANON_FAIL_OPEN=true` as a shortcut for `prod` targets: on `environment=prod` the project must stay fail-closed

## Reporting a vulnerability

If you find a vulnerability or unsafe behavior:

- do not immediately publish exploits, secrets, or reproducible details in a public issue
- prefer GitHub Security Advisories (private vulnerability reporting) on https://github.com/ragePolpette/llm-sql-db-mcp, if enabled
- if no private channel is available, open a minimal issue without sensitive details and ask for a private contact

For non-sensitive problems or hardening improvements, a normal issue or PR is fine.

## What is not covered

- deployments exposed to the internet or to untrusted networks
- compromised hosts or operator accounts
- databases accessed with overly permissive credentials
- deliberate inference by a hostile query author (see the anonymization section)
- vulnerabilities in third-party dependencies, which should be reported upstream

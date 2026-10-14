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

Anonymization acts on the output of `db_read` and on rows returned by `db_write` through an `OUTPUT` clause: it masks values the server recognizes as personal data before returning them to the client.

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

### Data sent to the LLM provider

For targets with an LLM provider (`llm_provider` set to `lmstudio` or `ollama`), column classification is delegated to that provider. The classification request contains the column names, the query sources, and up to five raw distinct sample values per column, taken from the actual result set before masking. These values leave the server process in clear. The provider is expected to run locally or on a host trusted with the same data; do not point `LMSTUDIO_BASE_URL` or `OLLAMA_BASE_URL` at a shared or remote service unless that is acceptable for the data in the target. With `ANON_FIELD_IDENTIFICATION=heuristic`, and an `anonymization_mode` other than `llm-strict`, no values are sent.

### Fiscal codes and VAT numbers

Columns named like an Italian fiscal code (`cf`, `codice_fiscale`, `codfiscale`, ...) or VAT number (`partita_iva`, `piva`, `vat`, ...) are treated as safe identifiers and returned in clear, and the provider prompt tells the model to classify them as not sensitive. This is a deliberate choice for the databases this server was built for: there these values are the business keys that operators use to correlate records across queries and with external systems, and masking them would make diagnostics impossible. VAT numbers identify businesses and are public. A natural person's fiscal code, however, is personal data and encodes name, birth date, sex, and place of birth. If that is not acceptable for a target, mark the columns as sensitive with the catalog CLI (`npm run anon:catalog -- set dbo.Clienti.CodiceFiscale sensitive --kind text`), which overrides the safe rule, or exclude them at the database level.

More detail: [docs/ANONYMIZATION.md](./docs/ANONYMIZATION.md).

## Login hardening for anonymized targets

If the client may be hostile, the real boundary is the SQL login of the target, not the anonymization layer. Minimum checklist for the login referenced by `connection_env_var` of an anonymized target:

1. **One dedicated login per target**, used only by this server.
2. **Views only, in a separate schema.** Views expose only non-sensitive columns (or surrogate keys for joins). The separate schema matters because a `DENY` on the `dbo` schema also blocks views that live in `dbo`. When both schemas have the same owner (typically `dbo`), ownership chaining lets the views work without permissions on the base tables.
3. **No `SELECT` on base tables**: never the `db_datareader` role (it grants `SELECT` on everything) and an explicit `DENY` on the schema that holds the tables.
4. **No home-made pseudonyms in views**: an unsalted `HASHBYTES` over email, phone or tax code is reversible by dictionary. Omit the column or expose a surrogate key instead.
5. **No server or database state**: do not grant `VIEW SERVER STATE` / `VIEW DATABASE STATE` (nor the `... PERFORMANCE STATE` variants of SQL Server 2022). DMVs such as `sys.dm_exec_sql_text` show the queries of other sessions together with their literals.
6. **No `SHOWPLAN`**: the server does not need it and the plan contains compiled parameter values.
7. **No `EXECUTE` on functions** that read sensitive columns.
8. **Review the `public` role and the `guest` user**: no permissions on tables with personal data, `guest` disabled in the databases of the server.
9. **No user for this login in other databases** on the same server.

Example (adapt to your schema):

```sql
-- server
CREATE LOGIN mcp_prod_reader WITH PASSWORD = '<secret>', CHECK_POLICY = ON;

-- database
CREATE USER mcp_prod_reader FOR LOGIN mcp_prod_reader;
GO
CREATE SCHEMA mcp AUTHORIZATION dbo;
GO
CREATE VIEW mcp.Clienti AS
  SELECT Id, Stato, Provincia, DataCreazione   -- no Nome, Cognome, Email, Telefono, Note
  FROM dbo.Clienti;
GO
GRANT SELECT ON SCHEMA::mcp TO mcp_prod_reader;
DENY SELECT ON SCHEMA::dbo TO mcp_prod_reader;
DENY VIEW DATABASE STATE TO mcp_prod_reader;
DENY SHOWPLAN TO mcp_prod_reader;
```

Verification, run by an administrator:

```sql
EXECUTE AS USER = 'mcp_prod_reader';
SELECT TOP (1) Cognome FROM dbo.Clienti;                -- must fail
SELECT TOP (1) * FROM mcp.Clienti;                      -- must work
SELECT * FROM fn_my_permissions(NULL, 'DATABASE');      -- no unexpected SELECT / VIEW STATE
REVERT;
```

With such a login, server-side anonymization stays active as a second line: it covers view misconfigurations and accidental exposure. In addition, on anonymized targets SQL Server error messages are scrubbed of the values they may contain (for example `Conversion failed when converting the nvarchar value '...'`); compile-time errors, which happen before any row is read, are kept intact so the query can be corrected.

## Authentication boundary

The runtime does not implement identity-aware authentication because the intended deployment is local or limited to a team. It offers an optional static shared token at the HTTP edge:

- with `DB_MCP_API_KEY` set, every request must carry `Authorization: Bearer <token>` or `x-api-key: <token>`, checked in constant time before MCP session resolution and tool execution
- binding `HOST` to a non-loopback address without `DB_MCP_API_KEY` is refused at startup
- `DB_MCP_API_KEY` must come from the runtime environment; it is rejected in the repository `.env`

Further modes (JWT, authenticating proxy) are described in [docs/AUTH_FUTURE_INTEGRATION.md](./docs/AUTH_FUTURE_INTEGRATION.md).

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

For all `environment=prod` targets the runtime enforces:

- `write_enabled` is forced to `false` and `db_write` is removed from `allowed_tools` when the registry is loaded, with a warning
- the policy engine denies `db_write` on any prod target, independently of the target fields
- `TARGET_<ID>_WRITE_ENABLED=true` and `TARGET_<ID>_ANONYMIZATION_ENABLED=false` are ignored with a warning
- `anonymization_enabled=false` set in the registry is honored as an explicit operator choice, and logged as a warning at every startup
- `environment` is validated against `dev`, `test`, `qa`, `uat`, `staging`, `prod` (aliases `development`, `production`), so a misspelled production label fails at startup instead of escaping the fence

Operational rules:

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

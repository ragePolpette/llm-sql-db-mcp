# llm-sql-db-mcp

Policy-driven MCP server that gives clients controlled access to multiple SQL Server targets through a fixed tool surface.

[![CI](https://github.com/ragePolpette/llm-sql-db-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ragePolpette/llm-sql-db-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

## Overview

The project is designed for local or small-team environments where an MCP client needs database access with explicit guard rails. It is not a general ORM, query engine, or internet-facing database control plane.

MCP clients that can query databases directly need stronger operational boundaries than running arbitrary SQL. This server keeps those boundaries explicit:

- the target registry is the source of truth
- policy decisions are made per target
- SQL guard rails run before execution
- production targets are treated with non-bypassable fences
- optional field-aware anonymization is applied before results leave the server

Scope:

- SQL Server access through a constrained MCP tool surface
- local or trusted-network deployment
- explicit target policies for read, write, and anonymization
- runtime observability and readiness checks

Non-goals:

- databases other than SQL Server
- built-in admin UI
- public multi-tenant deployment
- enterprise IAM or internet-facing authentication
- replacing database-side permissions with application policy alone

## Capabilities

The server exposes a small, stable MCP surface for:

- listing configured database targets
- inspecting target metadata and effective policies
- executing read-safe queries on allowed targets
- executing controlled writes only where the target policy permits them
- running diagnostic reads with environment resolution or explicit target pinning
- applying deterministic or provider-assisted anonymization when required

MCP tools:

- `db_target_list`
- `db_target_info`
- `db_policy_info`
- `db_read`
- `db_write`
- `run_diagnostic_query` (when enabled by the shipped runtime surface)

## Architecture

Main runtime components:

- `src/server.js`: MCP HTTP transport and process lifecycle
- `src/lib/config.js`: runtime configuration parsing and validation
- `src/lib/target-registry.js`: target loading and normalization
- `src/lib/policy-engine.js`: target-aware read, write, and anonymization decisions
- `src/lib/sql-guard.js`: single-pass T-SQL tokenizer and structural SQL guard rails
- `src/lib/drivers/sqlserver.js`: SQL Server execution through `mssql`
- `src/lib/anonymization/`: deterministic masking and field classification

Request flow:

```text
MCP request
   |
   v
session + input validation
   |
   v
target registry resolution
   |
   v
policy engine decision
   |
   v
SQL guard
   |
   v
SQL Server driver
   |
   v
optional anonymization
   |
   v
MCP response + sanitized logs
```

## Quick start

Requirements:

- Node.js 22 or later
- a SQL Server connection string for each active target, provided as a runtime environment variable
- optional: a local LM Studio or Ollama instance when a target uses provider-assisted anonymization

```bash
npm install
cp .env.example .env
npm start
```

If any active target has anonymization enabled (the shipped `targets.json` does), set `ANON_HASH_SALT` first: the server refuses to start without it.

The server reads `targets.json` by default. See [targets.example.json](targets.example.json) for a sample registry. Each target names the environment variable that holds its connection string (`connection_env_var`); set that variable in the shell that starts the server, not in `.env`.

HTTP endpoints:

- `GET /health`
- `GET /ready`
- `POST /mcp`, `GET /mcp`, `DELETE /mcp`

## Configuration

Runtime settings are read from environment variables. [.env.example](.env.example) lists the supported ones with defaults. Key settings:

- `HOST`, `PORT`
- `DB_MCP_API_KEY` (optional, runtime environment only): see [Authentication](#authentication)
- `TARGETS_FILE`
- `SESSION_TTL_MS`
- `ALLOWED_ORIGINS`
- `LOG_LEVEL`, `LOG_FORMAT`
- `ANON_HASH_SALT`: required at startup when any active target has anonymization enabled
- `ANON_FIELD_IDENTIFICATION`
- `ANON_FAIL_OPEN`
- `ANON_TIMEOUT_MS`
- `ANON_MIN_CONFIDENCE` (0-1, default 0.8): a provider `none` verdict below this confidence is ignored and the column is masked
- `ANON_CATALOG_PATH` (optional): enables the self-populating column catalog; keep it outside the repository because it contains schema names

Per-target overrides can be supplied through `TARGET_<TARGET_ID>_...` environment variables for read, write, and anonymization behavior. On `prod` targets, overrides that would enable writes (`TARGET_<ID>_WRITE_ENABLED=true`) or disable anonymization (`TARGET_<ID>_ANONYMIZATION_ENABLED=false`) are ignored and a `target.prod_override_ignored` warning is logged.

Targets with anonymization enabled also accept `anonymization_trust` (`corroborated` by default, or `strict`). `strict` ignores any provider "not sensitive" verdict on columns that are not recognized deterministically, so those string columns are masked. Anonymization decisions are logged per reason (`db.anonymizer_decisions`) without values.

Connection strings, API keys, passwords, and other secrets must not live in the repository `.env`.

### Authentication

By default the server accepts unauthenticated requests and binds to `127.0.0.1`. Setting `DB_MCP_API_KEY` in the runtime environment enables a static shared token at the HTTP edge: every request except the liveness probe `GET /health` (which only reports that the process is up) must then send either `Authorization: Bearer <token>` or `x-api-key: <token>`, otherwise it gets `401` with error code `unauthorized`. The comparison is timing-safe.

Binding `HOST` to anything other than a loopback address (`127.0.0.0/8`, `::1`, `localhost`) requires `DB_MCP_API_KEY`; without it the server refuses to start. `DB_MCP_API_KEY` is a secret, so it is rejected if placed in the repository `.env`.

This is a single shared token, not per-user identity. See [docs/AUTH_FUTURE_INTEGRATION.md](docs/AUTH_FUTURE_INTEGRATION.md) for the possible next steps.

### Target registry

The runtime reads targets from `targets.json`. Each target defines:

- `target_id`, `display_name`, `environment`, `status`; `environment` must be one of `dev`, `test`, `qa`, `uat`, `staging`, `prod` (case-insensitive; `development` and `production` are accepted as aliases)
- safe metadata
- the environment variable that holds its connection string
- read and write permissions
- anonymization configuration

The example registry in [targets.example.json](targets.example.json) contains a dev read/write target, a prod read-only target with anonymization, and a disabled target.

### Production fence

Targets with `environment=prod` are always read-only, whatever the registry or the environment says:

- `write_enabled` is forced to `false` and `db_write` is removed from `allowed_tools`, with a warning logged at startup
- the policy engine denies `db_write` on prod targets even if a target object reaches it unfenced
- env overrides that would re-enable writes or disable anonymization are ignored
- `anonymization_enabled=false` in the registry is still honored, because it is an explicit operator choice, but a `target.prod_anonymization_disabled` warning is logged at startup

### SQL guard and result limits

`db_read` accepts exactly one `SELECT` statement (optionally behind a CTE); `db_write` accepts exactly one `INSERT`, `UPDATE`, `DELETE`, or `MERGE`. The guard tokenizes the SQL in a single pass (string literals with `''` escapes, `N'...'`, `[...]` and `"..."` identifiers, `--` and nested `/* */` comments), so quoting and comments cannot hide a second statement. Batches with more than one statement, a `;` followed by more code, the `GO` separator, DDL, `EXEC`, `SELECT ... INTO`, transaction control, `OPENROWSET`/`OPENQUERY`/`OPENDATASOURCE`, and other non-DML statements are rejected. Unterminated literals or comments and unbalanced parentheses are rejected as well.

`db_read` streams the first result set and stops reading as soon as `max_rows` or `max_result_bytes` is exceeded, so at most `max_rows + 1` rows are ever held in memory. Streaming was chosen over rewriting the query with `TOP (n)` because it works for every statement the guard accepts (CTEs, `UNION`, `ORDER BY ... OFFSET/FETCH`, an existing `TOP`) without altering the caller's SQL. `total_rows_before_limits` therefore counts the rows read, at most `max_rows + 1`, not the full size of the result. Each read runs in an explicit `READ COMMITTED` transaction that is always rolled back.

When a target requires anonymization, rows returned by `db_write` (an `OUTPUT` clause) are anonymized the same way as `db_read` results.


## Usage

Point an MCP client at the HTTP endpoint, for example `http://127.0.0.1:3000/mcp` with the default `HOST`, `PORT`, and `MCP_PATH`. A typical session lists targets with `db_target_list`, inspects a target with `db_target_info` and `db_policy_info`, and then reads with `db_read`.

### Anonymization catalog

With `ANON_CATALOG_PATH` set, column verdicts are reviewed with:

```bash
npm run anon:catalog -- list
npm run anon:catalog -- set dbo.Clienti.Note sensitive --kind text
```

Details and the anonymization threat model are in [docs/ANONYMIZATION.md](docs/ANONYMIZATION.md).

## Security

The project assumes a pragmatic local or internal security model:

- the server runs on a workstation or a limited trusted network
- connection strings stay outside repository files and outside `.env`
- production targets keep non-bypassable fences
- logs should not expose raw SQL payloads, raw parameters, or row contents
- client code does not define policy; the target registry does

Output anonymization protects against accidental exposure to a client acting in good faith. It does not protect against a hostile caller inferring values through crafted queries. For that case, restrict the database login at the database level.

The goal is to reduce operational mistakes and unsafe MCP usage inside a controlled environment. It is not a public-cloud data access platform.

When anonymization uses an LLM provider, raw sample values from the result columns are sent to the configured local provider (LM Studio or Ollama) during classification. Italian fiscal codes and VAT numbers are treated as safe identifiers by design. Both points are explained in [SECURITY.md](SECURITY.md).

See [SECURITY.md](SECURITY.md) for the threat model and reporting instructions, and [docs/AUTH_FUTURE_INTEGRATION.md](docs/AUTH_FUTURE_INTEGRATION.md) for the authentication boundary.

## Development

```bash
npm ci
npm run check
npm test
```

`npm run check` runs `node --check` on the source files and then ESLint (`npm run lint`, flat config with `@eslint/js` recommended rules). `npm test` runs the Node.js test runner. Tests use synthetic data and do not need a SQL Server instance. See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow.

Further documentation:

- [docs/README.md](docs/README.md)
- [docs/VERSIONING_POLICY.md](docs/VERSIONING_POLICY.md)
- [CHANGELOG.md](CHANGELOG.md)

## Project status

Active development. The version in `package.json` is 0.1.0 and the package is marked private. This repository is the current canonical SQL MCP server in this stack.

Built with AI-assisted workflows, while architecture, tradeoffs, integration, review, and validation were directed by the author.

## Related projects

This repository supersedes `llm-db-dev-mcp` and `llm-db-prod-mcp`. Those split repositories are kept only as historical predecessors and are deprecated in favor of this target-based runtime.

## License

MIT. See [LICENSE](LICENSE).

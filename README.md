# llm-sql-db-mcp

`llm-sql-db-mcp` is a policy-driven MCP server for SQL Server targets with a fixed tool surface, dynamic target registry, and target-aware anonymization rules.

The project is designed for local or small-team environments where an MCP client needs controlled database access with explicit guard rails. It is not a general ORM, query engine, or internet-facing database control plane.

## What It Does

The server exposes a small stable MCP surface for:

- listing configured database targets
- inspecting target metadata and effective policies
- executing read-safe queries on allowed targets
- executing controlled writes only where the target policy permits them
- running diagnostic reads with environment resolution or explicit target pinning
- applying deterministic or provider-assisted anonymization when required

## Why It Exists

MCP clients that can query databases directly need stronger operational boundaries than “just run SQL”.

`llm-sql-db-mcp` is built to keep those boundaries explicit:

- target registry as the source of truth
- policy decisions per target
- SQL guard rails before execution
- environment-aware treatment of production targets
- optional field-aware anonymization before results leave the server

## Supersedes

This repository is the unifying successor to:

- `llm-db-dev-mcp`
- `llm-db-prod-mcp`

The older split repositories are kept only as historical predecessors and should be treated as deprecated in favor of this target-based runtime.

## Scope And Non-Goals

In scope:

- SQL Server access through a constrained MCP tool surface
- local or trusted-network deployment
- explicit target policies for read, write, and anonymization
- runtime observability and readiness checks

Out of scope:

- databases other than SQL Server
- built-in admin UI
- public multi-tenant deployment
- enterprise IAM or internet-facing auth
- replacing database-side permissions with application policy alone

## Architecture

Main runtime components:

- `src/server.js`: MCP HTTP transport and process lifecycle
- `src/lib/config.js`: runtime configuration parsing and validation
- `src/lib/target-registry.js`: target loading and normalization
- `src/lib/policy-engine.js`: target-aware read/write/anonymization decisions
- `src/lib/sql-guard.js`: lexical and structural SQL guard rails
- `src/lib/drivers/sqlserver.js`: SQL Server execution through `mssql`
- `src/lib/anonymization/`: deterministic masking and field classification

Main MCP tools:

- `db_target_list`
- `db_target_info`
- `db_policy_info`
- `db_read`
- `db_write`
- `run_diagnostic_query` when enabled by the shipped runtime surface

## Data Flow

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
safe MCP response + sanitized logs
```

## Security Model

This project assumes a pragmatic local/internal security model:

- the server runs on a workstation or a limited trusted network
- connection strings stay outside repo files and outside `.env`
- production targets must keep non-bypassable fences
- logs should not expose raw SQL payloads, raw parameters, or row contents
- client code does not define policy; the target registry does

The goal is to reduce operational mistakes and unsafe MCP usage inside a controlled environment, not to pretend this is a full public-cloud data access platform.

See also:

- [SECURITY.md](SECURITY.md)
- [docs/AUTH_FUTURE_INTEGRATION.md](docs/AUTH_FUTURE_INTEGRATION.md)

## Local Run

Requirements:

- Node.js 22+
- runtime environment variables for target connection strings
- optional local LM Studio or Ollama when a target requires provider-assisted anonymization

Install:

```bash
npm install
```

Run:

```bash
npm start
```

Health and readiness:

- `GET /health`
- `GET /ready`

MCP endpoints:

- `POST /mcp`
- `GET /mcp`
- `DELETE /mcp`

## Configuration

Key runtime settings include:

- `HOST`
- `PORT`
- `TARGETS_FILE`
- `SESSION_TTL_MS`
- `ALLOWED_ORIGINS`
- `LOG_LEVEL`
- `LOG_FORMAT`
- `ANON_HASH_SALT`
- `ANON_FIELD_IDENTIFICATION`
- `ANON_FAIL_OPEN`
- `ANON_TIMEOUT_MS`

Target overrides can be supplied through `TARGET_<TARGET_ID>_...` environment variables for per-target read/write/anonymization behavior.

Important rule:

- connection strings, API keys, passwords, and secrets must not live in the repository `.env`

## Target Registry

The runtime reads targets from `targets.json`.

Each target defines:

- `target_id`
- `display_name`
- `environment`
- `status`
- safe metadata
- connection string environment binding
- read/write permissions
- anonymization configuration

The example registry in [targets.example.json](targets.example.json) demonstrates:

- a dev read/write target
- a prod read-only target with anonymization
- a disabled target kept only for controlled runtime configuration

## Quality Gates

Available checks:

```bash
npm run check
npm test
```

## Project Status

This repository is in active development and should be treated as the current canonical SQL MCP server in this stack.

## Documentation

- [docs/README.md](docs/README.md)
- [docs/PRODUCT_ROADMAP_CHECKLIST.md](docs/PRODUCT_ROADMAP_CHECKLIST.md)
- [docs/RUNTIME_INTEGRATION_NOTES.md](docs/RUNTIME_INTEGRATION_NOTES.md)
- [docs/VERSIONING_POLICY.md](docs/VERSIONING_POLICY.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [CHANGELOG.md](CHANGELOG.md)
- [LICENSE](LICENSE)

## Development Process

Built with AI-assisted workflows, while architecture, tradeoffs, integration, review, and validation were directed by the author.

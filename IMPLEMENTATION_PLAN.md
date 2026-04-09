# llm-sql-db-mcp Implementation Plan

## Goal
Build a new MCP server that provides a fixed, policy-driven SQL tool surface over multiple configurable database targets.

The first version must:
- support only SQL Server
- support multiple targets via static configuration
- expose a fixed MCP tool surface
- make permissions and anonymization depend on `target_id`
- support anonymization providers `lmstudio`, `ollama`, or `none`
- keep runtime secrets out of project `.env` files by default

The first version must **not**:
- implement writes
- support MySQL or other engines yet
- integrate with the dashboard yet
- replace the existing `llm-db-dev-mcp` / `llm-db-prod-mcp` services yet

## Project Path
- repository root (`./`)

## Recommended Stack
- Node.js
- `@modelcontextprotocol/sdk`
- SQL Server driver already proven in the current DB MCP projects
- ESM modules

## Architecture

### Core modules
- `src/server.js`
  - HTTP MCP bootstrap
  - session handling
  - origin validation
  - streamable HTTP transport
  - `/health`

- `src/lib/config.js`
  - server config
  - runtime env loading
  - forbidden secret keys in `.env`
  - provider config

- `src/lib/target-registry.js`
  - load target definitions from `targets.json`
  - validate schema
  - expose lookup/list helpers

- `src/lib/policy-engine.js`
  - evaluate effective policy for a request
  - allow/deny by target and tool
  - decide whether anonymization is required

- `src/lib/sql-guard.js`
  - allow only read-safe SQL in v1
  - reject obvious write/DDL statements

- `src/lib/drivers/sqlserver.js`
  - SQL Server execution adapter
  - parameter handling
  - result normalization

- `src/lib/anonymizer.js`
  - output anonymization pipeline
  - route to provider adapters
  - no-op when provider is `none`

- `src/lib/providers/ollama.js`
  - provider adapter for Ollama

- `src/lib/providers/lmstudio.js`
  - provider adapter for LM Studio

- `src/lib/tools.js`
  - MCP tool schema definitions

- `src/lib/handlers.js`
  - MCP tool dispatch

- `src/lib/logger.js`
  - structured runtime logs

- `src/lib/session-store.js`
  - session TTL / no-expiry support

## Fixed MCP Tool Surface

### `db_target_list`
Return the configured targets with safe metadata only.

Expected output fields:
- `target_id`
- `display_name`
- `environment`
- `db_kind`
- `status`
- `read_enabled`
- `write_enabled`
- `anonymization_enabled`
- `llm_provider`
- `llm_model`

### `db_target_info`
Input:
- `target_id`

Return:
- full safe target metadata
- effective limits
- allowed tools
- anonymization mode
- provider/model

### `db_policy_info`
Input:
- `target_id`
- optional `tool_name`

Return:
- whether the tool is allowed
- whether anonymization is required
- why a request would be denied

### `db_read`
Input:
- `target_id`
- `sql`
- optional `parameters`
- optional `max_rows`

Behavior:
1. resolve target
2. load effective policy
3. reject if target disabled or read not allowed
4. reject if SQL is not read-safe
5. execute via SQL Server driver
6. anonymize output if required by target policy
7. return normalized payload

## Target Registry

Store target configuration in `targets.json`.

### Suggested shape
```json
{
  "targets": [
    {
      "target_id": "dev-main",
      "display_name": "Dev Main",
      "environment": "dev",
      "db_kind": "sqlserver",
      "status": "active",
      "connection_env_var": "DB_DEV_MAIN_CONNECTION_STRING",
      "read_enabled": true,
      "write_enabled": false,
      "anonymization_enabled": false,
      "anonymization_mode": "off",
      "llm_provider": "none",
      "llm_model": "",
      "max_rows": 200,
      "max_result_bytes": 262144,
      "allowed_tools": ["db_target_info", "db_policy_info", "db_read"]
    },
    {
      "target_id": "prod-main",
      "display_name": "Prod Main",
      "environment": "prod",
      "db_kind": "sqlserver",
      "status": "active",
      "connection_env_var": "DB_PROD_MAIN_CONNECTION_STRING",
      "read_enabled": true,
      "write_enabled": false,
      "anonymization_enabled": true,
      "anonymization_mode": "hybrid",
      "llm_provider": "lmstudio",
      "llm_model": "google/gemma-3-4b",
      "max_rows": 100,
      "max_result_bytes": 131072,
      "allowed_tools": ["db_target_info", "db_policy_info", "db_read"]
    }
  ]
}
```

## Policy Rules

### General
- every operational tool must require `target_id`
- unknown target => explicit user-facing error
- disabled target => explicit user-facing error
- no implicit default target in v1

### Read policy
- target must have `read_enabled=true`
- SQL must pass `sql-guard`

### Write policy
- not implemented in v1
- return clear error if future write tool is invoked accidentally

### Anonymization policy
- if `anonymization_enabled=false`, return raw rows
- if `anonymization_enabled=true`, anonymize after query execution
- provider must be one of:
  - `lmstudio`
  - `ollama`
  - `none`
- `none` is only valid if anonymization is disabled

## SQL Guard v1

Only support read-safe SQL.

Reject at minimum:
- `INSERT`
- `UPDATE`
- `DELETE`
- `MERGE`
- `DROP`
- `ALTER`
- `TRUNCATE`
- `CREATE`
- `EXEC`
- `EXECUTE`

Allow:
- `SELECT`
- read-only CTEs that resolve to `SELECT`

Be conservative. False positives are acceptable in v1 if they reduce risk.

## Provider Support

### LM Studio
- OpenAI-compatible local API
- configurable base URL
- parse JSON response robustly
- tolerate JSON wrapped in markdown fences

### Ollama
- keep support compatible with current DB anonymization flow
- configurable base URL
- parse JSON response robustly

### Shared provider contract
Both adapters should expose the same classification function signature.

## Secrets

### Required rule
Do not allow DB connection strings or provider API secrets to be stored in the project `.env` by default.

### Runtime model
- connection strings come from runtime env vars
- sensitive targets should be startable only when env is present
- config loading should throw clear errors when required runtime env vars are missing

## Logging

Emit structured logs for:
- `target_query_in`
- `target_query_out`
- `policy_deny`
- `anonymization_applied`
- `provider_error`

Suggested fields:
- `target_id`
- `tool`
- `provider`
- `mode`
- `row_count`
- `sql_preview`
- `duration_ms`
- `timestamp`

## Tests

### Unit tests
- config loading
- registry validation
- policy evaluation
- sql guard
- provider response parsing

### Integration tests
- target listing
- target info lookup
- unknown target failure
- denied read
- allowed read
- anonymized read for prod target
- raw read for dev target

## Commit Plan

### Commit 1
Foundation:
- project scaffold
- HTTP MCP server
- `/health`
- config
- session store
- target registry

### Commit 2
Tool surface:
- `db_target_list`
- `db_target_info`
- `db_policy_info`
- policy engine

### Commit 3
Query execution:
- SQL Server driver
- SQL guard
- `db_read`

### Commit 4
Anonymization:
- provider adapters
- provider selection
- output masking pipeline

### Commit 5
Tests and docs:
- unit + integration tests
- README
- sample `targets.json`

## Explicit Non-Goals For v1
- dashboard integration
- write tools
- MySQL support
- parked mode
- automatic target provisioning from UI
- migration/replacement of current DB MCPs

## Recommended Delivery Sequence
Implement in strictly separate steps and verify each one before moving to the next.

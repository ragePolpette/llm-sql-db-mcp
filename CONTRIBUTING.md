# Contributing

Thank you for contributing to `llm-sql-db-mcp`.

The project has a deliberate target:

- local or small-team tool
- not internet-facing
- pragmatic hardening
- a small, predictable MCP surface

The best contributions strengthen these goals instead of widening the perimeter at random.

## Workflow

Required for every change:

1. create a dedicated branch from `main`
2. implement the change in a focused way
3. run the relevant checks and tests
4. push the branch
5. open a pull request
6. merge only after the diff has been reviewed

Suggested branch naming patterns:

- `feature/redacted-logging`
- `feature/security-docs`
- `fix/sql-guard-cte-parse`

## Development

Requires Node.js 22 or later.

```bash
npm ci
npm run check
npm test
```

Tests use synthetic data and do not need a SQL Server instance. `npm run check` includes ESLint (`npm run lint`). CI runs `npm run check` and `npm test` on pushes to `main` and on pull requests.

## Change scope

Prefer small, readable pull requests:

- one clear responsibility per PR
- no broad refactors without real need
- no rewrites of the query engine except for concrete bugs or inconsistencies
- no implicit behavior changes on `prod` targets

## Safety rules

Rules not to be violated:

- do not commit secrets, connection strings, tokens, or passwords
- do not use the repository `.env` for runtime secrets
- do not weaken the fences on `environment=prod` targets
- do not turn the server into an internet-facing service for convenience
- do not introduce logging of raw SQL, raw parameters, or row payloads by default

If a change touches policy, anonymization, the target registry, or `prod` targets, the PR must say so explicitly.

## Testing expectations

Before opening a PR:

- run `npm run check`
- run `npm test` if the change touches runtime, handlers, policy, registry, driver, or guard rails
- for documentation-only changes, state explicitly that tests were not run

When adding or changing behavior:

- update existing tests where possible
- avoid fixes without minimal coverage of the critical cases

## Documentation expectations

Update the documentation when any of these change:

- product scope
- runtime configuration
- the MCP tool contract
- the target registry
- policy or security limits

Main files to keep consistent:

- [README.md](./README.md)
- [SECURITY.md](./SECURITY.md)

## Pull request notes

A good PR includes:

- a short summary of the change
- the technical motivation
- the testing performed, or a `documentation-only` note
- any residual risks

Avoid PRs that mix:

- hardening
- new features
- structural refactors
- unrelated cosmetic cleanup

## Out-of-scope contributions

Not currently a priority:

- cloud-first support
- multi-tenancy
- full enterprise authentication
- generic support for many databases without a clear plan
- an embedded UI or control plane in this repository

For anything large or out of scope, open an issue or a minimal design PR first.

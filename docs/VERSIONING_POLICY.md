# Versioning Policy

This policy defines how to version:

- the MCP contract exposed by the server
- the file-based target registry
- the public release of the repository

Goals:

- avoid drift between runtime, docs, and release
- clarify what is breaking and what is not

## Source of truth

The public release uses the version in `package.json`.

The runtime exposes the same version through `config.serverVersion`, not a separate hardcoded string. This implies:

- a release changes `package.json`
- the server reports the same version in health and readiness output and in MCP metadata
- docs and changelog align to that version

## Semver scope

The project follows SemVer pragmatically:

- `MAJOR`: breaking change to the MCP contract or the registry schema
- `MINOR`: backward-compatible additions to tools, metadata, or configuration
- `PATCH`: fixes, hardening, and documentation improvements that do not break the contract

## MCP contract rules

The MCP contract includes:

- tool names
- expected inputs
- the shape of output that clients rely on
- machine-readable error codes, where already documented

Rules:

- adding a new optional tool is `MINOR`
- adding a new optional output field is `MINOR`
- renaming or removing a tool is `MAJOR`
- making a previously optional field required is `MAJOR`
- changing the semantics of an error in an incompatible way is at least `MINOR`, often `MAJOR`

## Target registry rules

The current registry schema is implicitly `v1`:

- a top-level `targets` array
- each target with metadata, a connection binding, and target-aware policy

Rules:

- adding backward-compatible optional fields is `MINOR`
- changing the meaning of existing fields or removing them is `MAJOR`
- if a schema break is ever needed, introduce an explicit top-level field such as `registry_schema_version`

While the registry stays backward-compatible, a version field is not required in the file.

## Change discipline

When a change touches the MCP contract or the registry:

1. update this policy or the relevant document if the rule changes
2. update `README.md` if user-visible behavior changes
3. update `targets.example.json` if the recommended configuration changes
4. add tests or fixtures covering the new contract
5. record the change in the changelog

## Deliberately not covered

This policy does not introduce:

- runtime version negotiation
- a multi-schema registry loader
- a compatibility matrix between clients and servers

# AGENTS.md

## Scope

Valido dentro:
- `llm-sql-db-mcp/`
- il worktree operativo unico usato per sviluppare questo repo

## Workflow Minimo

- Leggi prima [README.md](./README.md) e i file sotto `src/` rilevanti al task.
- Tratta questo repo come MCP SQL server operativo, non come sandbox usa-e-getta.
- Mantieni il workflow: branch dedicata, commit, push, PR, merge.

## Dependency Policy

- Se modifichi `package.json` o `package-lock.json`, esegui:

```powershell
node C:\Users\Gianmarco\Urgewalt\dependency-policy\dependency-policy-check.mjs --repo . --mode auto
```

- Se il check fallisce, il task non va considerato concluso senza eccezione approvata in:

```text
C:\Users\Gianmarco\Urgewalt\SECURITY_EXCEPTIONS.md
```

- Se non tocchi manifest o lockfile dipendenze, questo check non e' obbligatorio.

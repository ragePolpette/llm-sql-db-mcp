Leggi prima [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) e trattalo come source of truth.

Regole di esecuzione:
- lavora solo nella root di questo repository
- non implementare tutto in un colpo solo
- esegui uno step alla volta
- a fine di ogni step:
  - verifica il codice
  - fai commit
  - fermati e riassumi
- non introdurre MySQL
- non introdurre write tools
- non integrare la dashboard
- non toccare i repo esistenti `llm-db-dev-mcp` e `llm-db-prod-mcp`

Ordine obbligatorio:
1. esegui [PROMPT_STEP_01_FOUNDATION.md](PROMPT_STEP_01_FOUNDATION.md)
2. poi [PROMPT_STEP_02_TOOL_SURFACE.md](PROMPT_STEP_02_TOOL_SURFACE.md)
3. poi [PROMPT_STEP_03_SQL_EXECUTION.md](PROMPT_STEP_03_SQL_EXECUTION.md)
4. poi [PROMPT_STEP_04_ANONYMIZATION.md](PROMPT_STEP_04_ANONYMIZATION.md)
5. poi [PROMPT_STEP_05_TESTS_AND_DOCS.md](PROMPT_STEP_05_TESTS_AND_DOCS.md)

Non saltare step. Non anticipare lavoro di step futuri se non serve al wiring minimo.

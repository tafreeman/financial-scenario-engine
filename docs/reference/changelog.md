# Changelog

## v0.1.0

Initial release of the Financial Scenario Engine.

### Features

- **Calculation Engine** — Pure TypeScript engine with labor, margin, budget, EVM, utilization, and scenario modules
- **Scenario Analysis** — V2 (deterministic) and V3 (agentic) AI-assisted analysis pipelines
- **React Frontend** — Dashboard, AI Analyst, Staffing CRUD, and Settings tabs
- **Dual LLM Support** — GitHub Models API (cloud) and Ollama (local)
- **Privacy** — Anonymized context snapshot for cloud LLM calls
- **Excel Import** — Preview-only workbook upload (Phase 1)
- **SQLite Storage** — Single-file portable database
- **Unit Tests** — Full engine coverage via Vitest
- **E2E Tests** — Playwright tests for UI workflows and Excel import
- **Windows Launcher** — `start.bat` for one-click startup

## Roadmap

Forward-looking work that is **not** in the current release:

- **Full Excel-to-SQLite import.** Today's `/api/import/excel*` endpoints only return a preview (sheet names + first 20 rows for up to 10 sheets) and do not persist any data. Mapping previewed sheets onto the projects / staffing / labor schemas — including conflict resolution and column-mapping UI — is planned but not yet implemented.

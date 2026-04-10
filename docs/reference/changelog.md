# Changelog

## v1.0.0

Initial release of the Financial Impact Analyzer.

### Features

- **Calculation Engine** — Pure TypeScript engine with labor, margin, budget, EVM, utilization, and scenario modules
- **Scenario Analysis** — V2 (deterministic) and V3 (agentic) AI-assisted analysis pipelines
- **React Frontend** — Dashboard, AI Analyst, Staffing CRUD, and Settings tabs
- **Dual LLM Support** — GitHub Models API (cloud) and Ollama (local)
- **Privacy** — Anonymized context snapshot for cloud LLM calls
- **Excel Import** — Preview-only workbook upload (Phase 1)
- **SQLite Storage** — Single-file portable database
- **98 Unit Tests** — Full engine coverage via Vitest
- **E2E Tests** — Playwright tests for UI workflows and Excel import
- **Windows Launcher** — `start.bat` for one-click startup

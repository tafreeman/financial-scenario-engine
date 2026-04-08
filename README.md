# Financial Impact Analyzer

Portable, browser-based tool for AI-powered project financial scenario analysis.
Runs locally on Windows — no cloud hosting, no deployment, no accounts.

## What It Does

PMs type a natural-language question and get a structured financial impact analysis:

- **Staffing swap analysis** — "What if we replace the Senior Dev with two Mid-level Devs?"
- **Burn rate monitoring** — "Flag projects that will exhaust budget within 3 months"
- **Pre/post bid comparison** — "Compare original bid against current actuals"
- **Margin analysis** — "Which labor categories are dragging margin down?"

The AI sees live project data (staffing, rates, budgets) from the local SQLite
database and produces structured analysis with numbers, tables, and recommendations.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Browser (localhost:3000)                       │
│  React + Vite + Tailwind                        │
│  Dashboard │ AI Chat │ Staffing │ Settings      │
└──────────────────┬──────────────────────────────┘
                   │ REST API
┌──────────────────┴──────────────────────────────┐
│  Express Server (Node.js)                       │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐ │
│  │ Routes   │  │ AI Client│  │ DB Layer      │ │
│  │ REST API │  │ System   │  │ SQLite via    │ │
│  │ CRUD     │  │ Prompt + │  │ better-sqlite3│ │
│  │          │  │ Context  │  │               │ │
│  └──────────┘  └─────┬────┘  └───────┬───────┘ │
│                      │               │          │
└──────────────────────┼───────────────┼──────────┘
                       │               │
          HTTPS POST   │               │  Local file
          Bearer PAT   │               │
                       ▼               ▼
              models.github.ai    data/finimpact.db
              /inference/chat
              /completions
```

## Quick Start (Windows)

### Prerequisites
- **Node.js 18+** — [download](https://nodejs.org/)
- **GitHub PAT** with `models:read` scope — [create one](https://github.com/settings/tokens?type=beta)

### Option A: Double-click (easiest)
1. Double-click `start.bat`
2. First run installs dependencies and builds (~2 min)
3. Browser opens to `http://localhost:3000`
4. Go to Settings tab → paste your GitHub PAT → Save

### Option B: Manual
```bash
npm install
cd client && npm install && npm run build && cd ..
npx tsx server/index.ts
```

### Option C: Development (hot reload)
```bash
npm install && cd client && npm install && cd ..
npm run dev
# Server: http://localhost:3000
# Client dev: http://localhost:5173 (proxies /api to :3000)
```

## Project Structure

```
fin-impact-tool/
├── server/                     # Express + TypeScript backend
│   ├── index.ts                # Entry point, static file serving
│   ├── db.ts                   # SQLite schema, seed data, queries
│   ├── ai.ts                   # LLM client (GitHub Models + Ollama) + prompts
│   ├── routes.ts               # REST API endpoints
│   ├── engine/                 # Financial calculation engine (pure functions)
│   │   ├── types.ts            # Shared types and constants
│   │   ├── labor.ts            # Labor cost/revenue metrics
│   │   ├── margin.ts           # Margin and profitability calculations
│   │   ├── budget.ts           # Burn rate and budget exhaustion
│   │   ├── evm.ts              # Earned Value Management (CPI, SPI, EAC, …)
│   │   ├── utilization.ts      # Utilization rate metrics
│   │   ├── scenarios.ts        # Staffing mutation functions (swap/add/remove)
│   │   ├── portfolio.ts        # Portfolio-level aggregation
│   │   ├── matching.ts         # Fuzzy role-name matching
│   │   ├── narrative.ts        # Template-based markdown narrative renderer
│   │   ├── executor.ts         # Scenario orchestration (load → calc → impact)
│   │   ├── index.ts            # Barrel export
│   │   └── __tests__/          # Vitest unit tests (98 tests, 7 files)
│   └── import/
│       └── excel/              # Excel workbook import module
│           ├── v1/             # V1 handler
│           ├── shared/         # Shared parser + types
│           └── index.ts        # Barrel export
├── client/                     # React + Vite + Tailwind frontend
│   └── src/
│       ├── App.tsx             # Shell with tab navigation
│       ├── api.ts              # Typed fetch client
│       ├── format.ts           # Number/currency formatting helpers
│       └── components/
│           ├── Dashboard.tsx   # Budget overview + stat cards
│           ├── Chat.tsx        # AI scenario query + history
│           ├── ScenarioCards.tsx # Structured scenario result display
│           ├── StaffingView.tsx # Staffing CRUD + rate card
│           └── SettingsPanel.tsx # PAT, model config, provider selection
├── tests/
│   └── e2e/                    # Playwright E2E tests
│       ├── ui/                 # UI workflow tests
│       └── excel/              # Excel import endpoint tests
├── data/                       # SQLite database (auto-created)
│   └── finimpact.db
├── start.bat                   # Windows one-click launcher
├── package.json                # Root deps (server + tooling)
├── vitest.config.ts            # Unit test config
├── playwright.config.ts        # E2E test config
└── README.md
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/dashboard` | Summary stats + project list |
| GET | `/api/projects` | Projects with burn rate calc |
| POST | `/api/projects` | Add project |
| PATCH | `/api/projects/:id` | Update project |
| GET | `/api/staffing` | Staffing (optional `?project_id=`) |
| POST | `/api/staffing` | Add staffing assignment |
| DELETE | `/api/staffing/:id` | Deactivate staffing |
| GET | `/api/rates` | Labor category rate card |
| POST | `/api/scenario/v2` | Run scenario: LLM intent → engine → narrative |
| POST | `/api/scenario/v2/parse-only` | Parse query to structured operation (no compute) |
| POST | `/api/scenario/v3` | Agentic scenario (tool-calling loop) |
| GET | `/api/scenarios` | Query history |
| GET | `/api/config` | Get config (PAT masked) |
| PUT | `/api/config` | Update config |
| POST | `/api/import/excel` | Upload Excel workbook for sheet preview (v1) |
| POST | `/api/import/excel/v2` | Upload Excel workbook for sheet preview (v2) |

## AI System Prompt

The AI receives a structured system prompt that includes:
1. Role definition (financial scenario parser / financial impact analyst)
2. Required response format (Summary → Delta → Assumptions → Risks → Recommendation)
3. Live database snapshot (projects, staffing, rates, budget, burn rates — anonymized: person names replaced with `Staff-N`)

Every query automatically injects the current workbook state so the AI
reasons about actual numbers, not hypotheticals.

### Scenario Pipeline (V2)

```
User query
   │
   ▼  (LLM — anonymized context)
parseIntent()  →  ScenarioOperation (structured JSON)
   │
   ▼  (deterministic, no LLM)
executeScenario()  →  ScenarioResult (numbers + deltas)
   │
   ▼  (template-based by default; LLM optional)
generateNarrative()  →  Markdown prose
```

### LLM Providers

| Provider | Config key `llm_provider` | Notes |
|----------|--------------------------|-------|
| GitHub Models API | `github` (default) | Requires PAT with `models:read` scope |
| Ollama (local) | `ollama` | No PAT needed; requires a running Ollama server |

Switch providers via the Settings tab or by editing `llm_provider` in the config table.

## Data

### Storage
All data lives in `data/finimpact.db` — a single SQLite file. Back up by copying this file.
Delete it to reset to sample data (auto-recreated on next startup).

### Sample Data (seeded on first run)
- 3 projects: Alpha ($1.25M), Beta ($2.1M), Gamma ($680K)
- 8 labor categories with bill/cost rates
- 8 staffing assignments across projects

### Importing from Excel
POST a `.xlsx` file to `/api/import/excel` for sheet preview.
Full import mapping is a Phase 2 feature — currently returns sheet names
and first 20 rows for inspection.

## Security

- PAT stored in local SQLite only — never logged, never cached externally
- PAT transmitted exclusively to `models.github.ai` over HTTPS with TLS
- No telemetry, no analytics, no external calls beyond the AI endpoint
- Server binds to `localhost` only — not accessible from other machines
- For federal environments: verify GitHub Models API data classification approval

## Customization

### Adding Labor Categories
Insert directly into SQLite:
```sql
INSERT INTO labor_categories (name, bill_rate, cost_rate)
VALUES ('Data Engineer', 205, 155);
```

### Changing the AI Behavior
Edit `server/ai.ts` → `SYSTEM_PROMPT` constant. The prompt controls
response format, analytical focus, and tone.

### Connecting to Real Data
Replace the seed data in `server/db.ts` → `seedSampleData()` with actual
project/staffing data, or build an import pipeline from your GPS Pricing workbook.

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Runtime | Node.js 18+ | Portable, no compilation step |
| Server | Express + TypeScript | Minimal, well-known |
| Database | SQLite (better-sqlite3) | Zero-config, single file, portable |
| AI (cloud) | GitHub Models API | Approved toolchain, PAT auth, multi-model |
| AI (local) | Ollama | Fully offline alternative; no PAT required |
| Calc Engine | Pure TypeScript (`server/engine/`) | Deterministic, fully tested, no LLM dependency |
| Frontend | React 19 + Vite + Tailwind | Fast dev, small bundle |
| Markdown | react-markdown | Renders AI response tables and formatting |
| Excel | SheetJS (xlsx) | Parse uploaded workbooks |

## Testing

### Unit Tests (Vitest)

Tests cover the financial calculation engine (`server/engine/`).

```bash
npm install
npx vitest run          # run once
npx vitest              # watch mode
```

98 tests across 7 files: `labor`, `budget`, `margin`, `evm`, `scenarios`, `goal-seeking`, `narrative`.

### E2E Tests (Playwright)

```bash
npm run test:e2e        # run Playwright tests (requires running server)
```

Tests live in `tests/e2e/ui/` (UI workflows) and `tests/e2e/excel/` (import endpoint).

---

## Further Reading

| Document | Description |
|----------|-------------|
| [`server/engine/README.md`](server/engine/README.md) | Calculation engine architecture, modules, and public API |
| [`client/README.md`](client/README.md) | React frontend setup, components, and build |
| [`server/import/excel/README.md`](server/import/excel/README.md) | Excel import module and response shapes |
| [`AGENTS.md`](AGENTS.md) | Guide for AI coding assistants working in this repo |
| [`playwright-tester-training-prompt.md`](playwright-tester-training-prompt.md) | Playwright test authoring guide |

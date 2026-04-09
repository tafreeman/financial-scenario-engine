# Financial Impact Analyzer

Portable, browser-based project financial analysis tool with a deterministic TypeScript engine and an optional LLM layer.
Runs locally on Node.js, ships with a Windows launcher, and keeps data in a local SQLite file.

## What It Does

PMs can ask natural-language questions and get structured financial analysis backed by live project data:

- **Staffing swap analysis** — "What if we replace the Senior Dev with two Mid-level Devs?"
- **Burn rate monitoring** — "Flag projects that will exhaust budget within 3 months"
- **Pre/post bid comparison** — "Compare original bid against current actuals"
- **Margin analysis** — "Which labor categories are dragging margin down?"

The app uses the local SQLite database for project, staffing, rate-card, and history data.
The LLM helps parse intent and optionally narrate results, but the calculation engine produces the financial numbers.

## Architecture

```
┌─────────────────────────────────────────────────┐
│ Browser UI                                      │
│ React 19 + Vite + Tailwind                      │
│ Dashboard │ AI Analyst │ Staffing │ Settings    │
└──────────────────┬──────────────────────────────┘
                   │ REST API
┌──────────────────┴──────────────────────────────┐
│ Express Server                                  │
│  routes.ts   db.ts   ai.ts   import/excel/      │
│                      │                           │
│                      ▼                           │
│             server/engine/                      │
│     deterministic financial calculations        │
└───────────────┬───────────────────────┬─────────┘
                │                       │
                ▼                       ▼
      Local SQLite data           Optional LLM provider
        data/finimpact.db         GitHub Models or Ollama
```

## Quick Start

### Prerequisites
- **Node.js 18+** — [download](https://nodejs.org/)
- **Optional:** GitHub PAT with `models:read` scope for the GitHub Models provider — [create one](https://github.com/settings/tokens?type=beta)
- **Optional:** Ollama for fully local inference

### Option A: Double-click (easiest)
1. Double-click `start.bat`
2. First run installs dependencies and builds (~2 min)
3. Browser opens to `http://localhost:3000`
4. Go to Settings → choose GitHub Models or Ollama
5. If using GitHub Models, paste your PAT and save

### Option B: Manual
```bash
npm run install:all
npm run build
npm start
```

### Option C: Development (hot reload)
```bash
npm run install:all
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

## AI Workflows

The app supports two AI-assisted flows:

1. **V2** — LLM parses intent, the deterministic engine computes results, and the app returns template or LLM narration
2. **V3** — agentic analysis uses the `run_scenario` tool loop to explore one or more scenarios with exact engine outputs

Cloud LLM requests use an anonymized context snapshot where person names are replaced with `Staff-N`.

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
POST a `.xlsx` file to `/api/import/excel` or `/api/import/excel/v2` for workbook preview.
The current implementation returns sheet names plus up to the first 20 rows for up to 10 previewed sheets.
Full import mapping into SQLite is still a future phase.

## Security

- PAT stored in local SQLite only — never logged, never cached externally
- PAT transmitted exclusively to `models.github.ai` over HTTPS with TLS when the GitHub provider is selected
- Ollama mode keeps inference local to the machine
- No telemetry, no analytics, and no external cloud dependency outside the selected LLM provider
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
Edit the prompt constants in `server/ai.ts`:
- `PARSE_INTENT_PROMPT`
- `NARRATE_PROMPT`
- `AGENTIC_SYSTEM_PROMPT`

These control parsing, narrative output, and agentic scenario behavior.

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
npm test                # same as vitest run
npx vitest run          # run once
npx vitest              # watch mode
```

98 tests across 7 files: `labor`, `budget`, `margin`, `evm`, `scenarios`, `goal-seeking`, `narrative`.

### E2E Tests (Playwright)

```bash
npm run test:e2e
```

Playwright auto-builds the client and starts the app server on port `3100`.
On a fresh machine, install browser dependencies first:

```bash
npx playwright install --with-deps chromium
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

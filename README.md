# Financial Scenario Engine

[![CI / Deploy](https://github.com/tafreeman/financial-scenario-engine/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/tafreeman/financial-scenario-engine/actions/workflows/deploy-pages.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**📖 Docs:** [tafreeman.github.io/financial-scenario-engine](https://tafreeman.github.io/financial-scenario-engine/) · **Static overview (not a live app — see below):** [/overview/](https://tafreeman.github.io/financial-scenario-engine/overview/)

**A local what-if simulator for project budgets: an AI reads your question, and tested code does all the math.**

Every number comes from the calculation engine in `server/engine/`. The large language model (LLM) does exactly two jobs — turning your plain-English question into a structured request, and optionally writing the prose summary at the end. It never computes a figure; whatever structured data it hands back is re-checked against a strict schema before the engine acts on it. All project data lives in a local SQLite file, and the LLM step talks to GitHub Models, OpenRouter, or a local Ollama instance — so the app can run with no external cloud dependency at all.

> **Development note:** Built with AI-assisted development; see [`CONTRIBUTORS.md`](CONTRIBUTORS.md) for tooling and attribution details.

## What It Does

PMs can ask natural-language questions and get structured financial analysis backed by live project data:

- **Staffing swap analysis** — "What if we replace the Senior Dev with two Mid-level Devs?"
- **Burn rate monitoring** — "Flag projects that will exhaust budget within 3 months"
- **Pre/post bid comparison** — "Compare original bid against current actuals"
- **Margin analysis** — "Which labor categories are dragging margin down?"

### AI Analyst Tab

![AI Analyst tab — natural-language scenario query interface](docs/assets/ai-analyst-tab.png)

## See It Work: A Real Scenario, Real Output

No mocked numbers here — this is the actual production engine, run once with no LLM call involved, so the output below is reproducible and genuine.

**Query:** *"What if we replace the Senior Developer on Project Alpha with two Mid-level Developers?"*

The intent parser (when a model is configured) turns that into a structured operation. This exact one is case `swap-001`, committed in [`server/evals/intent-corpus.json`](server/evals/intent-corpus.json):

```json
{
  "action": "swap",
  "project": "Project Alpha",
  "remove": [{ "role": "Senior Developer", "count": 1 }],
  "add": [{ "role": "Mid-level Developer", "count": 2, "hours_per_week": 40 }]
}
```

Feeding that operation to the real `executeScenario()` and `generateNarrative()` (`server/engine/executor.ts`, `server/engine/narrative.ts`) against the app's actual seeded data for Project Alpha (`server/db.ts` → `seedSampleData()`) produces this, verbatim:

````markdown
## Impact Summary
This **Staffing Swap** on **Project Alpha** would result in a monthly cost increase of **$14,733**. Margin would improve by **1.0%** percentage points. Net headcount change: **+1**. Budget runway would reduce by **1.8 months**.

## Financial Delta
| Metric | Before | After | Change |
|--------|--------|-------|--------|
| Monthly Cost | $71,717 | $86,450 | +$14,733 |
| Monthly Revenue | $97,283 | $118,950 | +$21,667 |
| Margin % | 26.3% | 27.3% | +1.0% |
| Burn Rate / Mo | $71,717 | $86,450 | +$14,733 |
| Months Remaining | 10.7 | 8.8 | -1.8 |
| Headcount | 3 | 4 | +1 |
| FTE | 2.8 | 3.8 | +1.0 |

## Key Observations
- Cost increases but margin improves — the additional revenue outpaces the cost.
- Burn rate changes significantly (+20.5%) — monitor budget runway closely.
- Current margin of 26.3% is below typical target of 30%.

## Recommendation
Review the numbers above and assess alignment with project goals before making changes.
````

**Provenance:** produced by importing and calling the real, unmodified `executeScenario()` / `generateNarrative()` functions directly (via `tsx`, no server, no network) against the real seed data and a pinned reference date (`2026-04-15`, for reproducibility), with the operation JSON above copied verbatim from the committed intent-eval corpus. Nothing here was hand-written or fabricated — you can reproduce it yourself from those three inputs.

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
        data/finimpact.db         GitHub Models, OpenRouter, or Ollama
```

The calculation engine **never calls the LLM** — it only takes a structured operation in and returns numbers. The model sits at the boundary on both sides: parsing your question into that structured operation beforehand, and optionally narrating the result afterward. That boundary is hardened with retries and backoff, strict schema re-validation, SSRF guards on the configurable endpoint, and audit logging that never captures prompts or financial content — see [Reliability at the LLM Boundary](https://tafreeman.github.io/financial-scenario-engine/guide/ai-workflows#reliability-at-the-llm-boundary) for the full detail.

Full project structure, data-flow diagrams, and database schema: [Architecture →](https://tafreeman.github.io/financial-scenario-engine/guide/architecture).

## Quick Start

### Prerequisites
- **Node.js 18+** — [download](https://nodejs.org/)
- **Optional:** GitHub PAT with `models:read` scope for AI-powered scenario analysis — [create one](https://github.com/settings/tokens?type=beta)
- **Optional:** an OpenRouter API key ([openrouter.ai](https://openrouter.ai/)) — free-tier (`:free` model-id suffix) or paid models
- **Optional:** Ollama for fully local inference

### Option A: Double-click (easiest)
1. Double-click `start.bat`
2. First run installs dependencies and builds (~2 min)
3. Browser opens to `http://127.0.0.1:3000`
4. Go to Settings → choose GitHub Models or Ollama
5. If using GitHub Models, paste your PAT and save

> OpenRouter is supported by the server (`llm_provider: "openrouter"` via `PUT /api/config`), but the Settings UI does not yet have a picker for it — configure it via the config API directly, see [Configuration](https://tafreeman.github.io/financial-scenario-engine/reference/configuration).

### Option B: Manual
```bash
npm run setup   # installs root + client deps, then builds the client
npm start
```
`npm run setup` is exactly `npm run install:all && npm run build` — there's no need to run those separately.

### Option C: Development (hot reload)
```bash
npm run install:all
npm run dev
# Server: http://127.0.0.1:3000
# Client dev: http://localhost:5173 (proxies /api to 127.0.0.1:3000)
```

On first run the app seeds `data/finimpact.db` with sample data (3 projects, 8 labor categories, 8 staffing assignments) — the same data behind the scenario above. Delete the file to reset it; it's auto-recreated on next startup.

## Learn More

Everything below used to live inline in this README. It's all still here, in more detail than before, at these pages:

| Topic | Where |
|-------|-------|
| Full architecture, data flow, DB schema, project structure | [Architecture](https://tafreeman.github.io/financial-scenario-engine/guide/architecture) |
| V2/V3 AI pipelines, LLM providers, anonymization, LLM-boundary reliability | [AI Workflows](https://tafreeman.github.io/financial-scenario-engine/guide/ai-workflows) |
| Full REST API reference (every endpoint, request/response shapes) | [API Reference](https://tafreeman.github.io/financial-scenario-engine/api/) |
| Unit/E2E test suites, coverage scope, intent-parsing evals, the advisory faithfulness judge | [Testing](https://tafreeman.github.io/financial-scenario-engine/reference/testing) |
| Data privacy, LLM network access, CORS, reverse-proxy (`TRUST_PROXY_HOPS`) | [Security](https://tafreeman.github.io/financial-scenario-engine/reference/security) |
| LLM provider setup, environment variables, customizing labor categories/prompts/seed data | [Configuration](https://tafreeman.github.io/financial-scenario-engine/reference/configuration) |
| Excel workbook import (preview-only today) | [Excel Import](https://tafreeman.github.io/financial-scenario-engine/excel/) |
| React frontend structure and components | [Client](https://tafreeman.github.io/financial-scenario-engine/client/) |
| Calculation engine module-by-module reference | [Engine](https://tafreeman.github.io/financial-scenario-engine/engine/) |
| What shipped, and what's planned but not yet built | [Changelog & Roadmap](https://tafreeman.github.io/financial-scenario-engine/reference/changelog) |
| Authorship, AI tooling acknowledgement, how to contribute | [`CONTRIBUTORS.md`](CONTRIBUTORS.md) |

## GitHub Pages Site

**Both paths below are a static, pre-rendered site — neither is a running instance of the app.** There is no backend behind either one: nothing to query, no scenario to run, no data to mutate. To use the real app, run it locally (see Quick Start above).

The published site is **one artifact composed from two separate static builds**, so a deploy of either surface can never overwrite the other:

| Path | Source | Built with |
|------|--------|------------|
| `/` (plus `/guide/`, `/api/`, `/engine/`, `/client/`, `/excel/`, `/reference/`) | `docs/` | VitePress (static site generator) |
| `/overview/` | `client/pages/` + `client/src/site/` | The same React + Vite + Tailwind stack as the app UI, statically exported — a pre-rendered snapshot, not the live app |

Deployment is automated in [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml), the only workflow that writes to the `github-pages` environment. On every push to `main` (and on manual dispatch), after lint, typecheck, unit tests, and E2E pass, it builds both surfaces, composes them into one `site/` tree, and performs one upload and one deploy under the `pages` concurrency group.

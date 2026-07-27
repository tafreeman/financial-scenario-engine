# Financial Scenario Engine

[![CI / Deploy](https://github.com/tafreeman/financial-scenario-engine/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/tafreeman/financial-scenario-engine/actions/workflows/deploy-pages.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**📖 Live docs:** [https://tafreeman.github.io/financial-scenario-engine/](https://tafreeman.github.io/financial-scenario-engine/) · **Project overview:** [/overview/](https://tafreeman.github.io/financial-scenario-engine/overview/)

**A local what-if simulator for project budgets: an AI reads your question, and tested code does all the math.**

Every number comes from the calculation engine in `server/engine/`. The large language model (LLM) does exactly two jobs — it turns your plain-English question into a structured request, and it optionally writes the prose summary at the end. It never computes a figure. (When you opt into model-written narration, the prose *around* those numbers is the model's own work, which is what the advisory faithfulness judge described below exists to check.) Whatever structured data it hands back is re-checked against a strict schema before the engine acts on it (see [Reliability at the LLM boundary](#reliability-at-the-llm-boundary)).

All project data lives in a local SQLite file. For the language-model step, the app talks to GitHub Models, OpenRouter, or an Ollama instance running on your own machine — so it can run with no external cloud dependency at all.

> **Development note:** Built with AI-assisted development; see [`CONTRIBUTORS.md`](CONTRIBUTORS.md) for tooling and attribution details.

## What It Does

PMs can ask natural-language questions and get structured financial analysis backed by live project data:

- **Staffing swap analysis** — "What if we replace the Senior Dev with two Mid-level Devs?"
- **Burn rate monitoring** — "Flag projects that will exhaust budget within 3 months"
- **Pre/post bid comparison** — "Compare original bid against current actuals"
- **Margin analysis** — "Which labor categories are dragging margin down?"

### AI Analyst Tab

![AI Analyst tab — natural-language scenario query interface](docs/assets/ai-analyst-tab.png)

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

### Reliability at the LLM boundary

The model sits at the edge of the system, not in the critical path. Every call across that edge is hardened:

- **Retries on transient failures.** Up to `LLM_MAX_RETRY_ATTEMPTS = 3` attempts, with exponential backoff plus jitter — a small random delay so simultaneous retries don't all fire at the same instant. If the provider sends a `Retry-After` header the app honors it, but caps it at 60s, so a hostile or buggy header can't stall a request for minutes. See `chatRequest()` in `server/ai.ts`.
- **Re-validating the model's structured output.** The model returns JSON that becomes a `ScenarioOperation` — the typed instruction the engine executes. Before the engine runs, that JSON is checked against a strict schema (`scenarioOperationSchema`, written with Zod, a TypeScript schema-validation library). Malformed or invented fields are rejected outright, never coerced into something plausible. This applies on both the V2 parse path and the V3 tool-call path. See `server/engine/validation.ts` and `server/ai.ts`.
- **No silent no-ops.** An operation that would run but change nothing is refused or flagged, never reported as an answer. The schema rejects an action carrying none of the payload its handler reads, so `{"action":"add","project":"X"}` no longer parses; and a payload naming a role or person the roster does not carry comes back with a warning saying so, rather than an all-zero result that reads exactly like "this change is free" (`server/engine/validation.ts`, `server/engine/scenarios.ts`).
- **Guards against redirected and internal-host requests.** The app lets you configure the LLM endpoint URL, which would otherwise be a server-side request forgery (SSRF) risk — a way to make the server issue requests to hosts it shouldn't reach. So a configured URL is rejected if it resolves to a loopback or private-range address, including the IPv4-mapped and IPv4-compatible IPv6 spellings that a naive check misses (`server/ssrf.ts`). Outbound LLM requests also set `redirect: "error"`, so even an allowed endpoint can't 3xx-redirect the request — which carries your PAT and financial context — onward to an attacker's host (`chatRequest()`, `server/ai.ts`).
- **Observability at the boundary.** Every LLM call writes one structured JSON log line: request id, latency, retry count, token counts for the prompt and the response, and a typed failure code. It never logs prompts, queries, or financial content (`server/logger.ts`, `server/ai.ts`). The same call updates a running tally kept in memory, exposed read-only at `GET /api/telemetry/llm` (`server/llm-telemetry.ts`). None of it is transmitted anywhere — see Security below.

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

> OpenRouter is supported by the server (`llm_provider: "openrouter"` via `PUT /api/config` — see "LLM Providers" below), but the Settings UI does not yet have a picker for it; configure it via the config API directly until that UI support lands.

### Option B: Manual
```bash
npm run setup
npm run install:all
npm run build
npm start
```

### Option C: Development (hot reload)
```bash
npm run install:all
npm run dev
# Server: http://127.0.0.1:3000
# Client dev: http://localhost:5173 (proxies /api to 127.0.0.1:3000)
```

## AI Workflows

The app has two AI-assisted flows:

1. **V2 — one pass.** The model reads your question and returns a structured operation. The engine computes the result. The app then renders a summary, either from a fixed template (the default) or from the model.
2. **V3 — an agent loop.** `agenticScenario()` (`server/ai.ts`) lets the model call the engine repeatedly through a `run_scenario` tool, so it can explore several scenarios before answering. Each turn it decides what to compute next, gets exact engine numbers back, and reasons from those. The loop is capped at `MAX_ITERATIONS = 8`; if it hits the cap, the app asks for a final summary rather than returning nothing.

Before any request goes to a cloud provider, the app builds a reduced snapshot of your data (`buildAnonymizedContextSnapshot()`, `server/db.ts`) and strips personal information from it. Person names become `Staff-1`, `Staff-2`, and so on, so no name is read out of the database and sent onward. A name you type into your own question is a different matter — the query goes to the provider as you wrote it (see [ADR 003](docs/decisions/003-pii-anonymization.md)).

### Scenario Pipeline (V2)

```
User query
   │
   ▼  (LLM — anonymized context)
parseIntent()  →  ScenarioOperation (structured JSON, revalidated against
                   scenarioOperationSchema before anything downstream trusts it)
   │
   ▼  (deterministic, no LLM)
executeScenario()  →  ScenarioResult (numbers + deltas)
   │
   ▼  (template-based by default; LLM optional)
generateNarrative()  →  Markdown prose
```

### LLM Providers

One function — `getAiConfig()` in `server/ai.ts` — reads the model, endpoint, and credentials out of the SQLite config table. Everything else asks it for those values rather than checking which provider is selected: intent parsing, narration, the V3 agent loop, and the eval runner all stay provider-agnostic.

| Provider | Config key `llm_provider` | Notes |
|----------|--------------------------|-------|
| GitHub Models API | `github` (default) | Requires PAT with `models:read` scope. Fully retired 2026-07-30 — see the callout below. |
| OpenRouter | `openrouter` | Requires an API key (`openrouter_api_key` config key, or `OPENROUTER_API_KEY` env var). Default model is a `:free` (no-charge) model — the current free catalog is enumerable via `GET https://openrouter.ai/api/v1/models`. Configurable today via `PUT /api/config`; no Settings-tab picker yet (see Quick Start). |
| Ollama (local) | `ollama` | No PAT needed; requires a running Ollama server |

Switch providers via the Settings tab (GitHub Models / Ollama today) or by editing `llm_provider` directly in the config table / via `PUT /api/config` (all three providers, including OpenRouter).

> **GitHub Models retirement (2026-07-30):** the app's own default provider is still `github`. Changing that default is a separate, owner-gated product decision — the CI eval migration described below did not touch it. The CI intent-eval workflow (`.github/workflows/real-model-eval.yml`) has already moved off GitHub Models and now runs against Ollama Cloud by default. That is a CI-only change; see "Intent-parsing evals" below.

## Data

### Storage
All data lives in `data/finimpact.db` — a single SQLite file. Back up by copying this file.
Delete it to reset to sample data (auto-recreated on next startup).

### Sample Data (seeded on first run)
- 3 projects: Alpha ($1.25M), Beta ($2.1M), Gamma ($680K)
- 8 labor categories with bill/cost rates
- 8 staffing assignments across projects

### Excel workbook preview (read-only)
POST a `.xlsx` file to `/api/import/excel` or `/api/import/excel/v2`. The endpoints return sheet names plus the first 20 rows for up to 10 sheets — purely a preview surface. **No data is written to the database.** Full workbook-to-SQLite mapping is on the [roadmap](#roadmap), not in the current release.

## Security

- PAT/API key stored in local SQLite only — never logged, never cached externally; `GET /api/config` masks both `github_pat` and `openrouter_api_key` the same way (first 4 / last 4 characters only)
- Credentials go only to the provider you selected, always over HTTPS: the PAT to `models.github.ai`, the OpenRouter API key to `openrouter.ai`
- **OpenRouter data policy caveat:** OpenRouter's account privacy settings treat paid and free models differently. Check your account's training and logging opt-outs before relying on a `:free` model for anything past development. What gets sent is not raw PII — person names are redacted, see `buildAnonymizedContextSnapshot()` below — but it does include real project names, rate cards, and financial figures. See [OpenRouter's privacy & logging docs](https://openrouter.ai/docs/features/privacy-and-logging).
- Ollama mode keeps inference local to the machine
- No external telemetry, no analytics, and no external cloud dependency outside the selected LLM provider — the in-process LLM call metrics at `GET /api/telemetry/llm` (counts, latency, typed failure codes; never prompts or financial content) are served locally and transmitted nowhere
- Server binds to `127.0.0.1` by default — not accessible from other machines
- Every mutating route — config writes, Excel import, staffing and project CRUD — sits behind a shared-secret check (`requireAppToken`, `server/auth.ts`) requiring an `x-app-token` header. The comparison uses `crypto.timingSafeEqual`, so how long a rejection takes doesn't reveal how much of the token was correct. The point: another process on the same machine, without the secret, can't repoint the LLM endpoint or write data
- For regulated environments: verify GitHub Models API data classification approval

### CORS configuration

The server defaults to allowing requests only from the Vite dev-client origins `http://localhost:5173` and `http://127.0.0.1:5173`. When deploying behind a reverse proxy or to a hosted environment, set the `CORS_ORIGIN` environment variable to your application's actual origin:

```bash
CORS_ORIGIN=https://your-app.example.com npm start
```

Leaving `CORS_ORIGIN` unset in production causes browsers to reject cross-origin requests from the production domain. The explicit origin requirement stops arbitrary pages in a user's browser from reading API data (including `/api/config`).

### Reverse-proxy mode: `TRUST_PROXY_HOPS`

Behind a reverse proxy, the socket-level source of every request is the proxy's own address, not the client's. Unless you tell Express to trust that proxy, `req.ip` resolves to the proxy address on every request. Every per-IP rate limiter in `server/routes.ts` — the 300/min ceiling on read routes, the 10/min ceiling on scenario routes — then shares a single bucket across every client behind the proxy, and one abusive client can exhaust the budget for everyone else.

Set `TRUST_PROXY_HOPS` to the number of reverse proxies actually in front of this process (typically `1`):

```bash
TRUST_PROXY_HOPS=1 CORS_ORIGIN=https://your-app.example.com npm start
```

`TRUST_PROXY_HOPS` defaults to `0`: no proxy is trusted, and Express reads the real socket address. That matches this app's out-of-the-box direct-bind deployment.

**Never** set it to a value meaning "trust everything." Express's `trust proxy: true` trusts the whole `X-Forwarded-For` chain, and the left-most entry in that header is fully client-spoofable — any caller can send `X-Forwarded-For: 1.2.3.4` and walk past the per-IP ceiling. Giving a specific hop count instead makes Express read the Nth-from-the-right entry: the one your own trusted proxy actually appended. See `server/trust-proxy.ts` for the full rationale.

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Runtime | Node.js 18+ | Portable, no compilation step |
| Server | Express + TypeScript | Minimal, well-known |
| Database | SQLite (better-sqlite3) | Zero-config, single file, portable |
| AI (cloud) | GitHub Models API | Approved toolchain, PAT auth, multi-model |
| AI (cloud) | OpenRouter | Cloud replacement as GitHub Models retires; free and paid models |
| AI (local) | Ollama | Fully offline alternative; no PAT required |
| Calc Engine | Pure TypeScript (`server/engine/`) | Deterministic, fully tested, no LLM dependency |
| Frontend | React 19 + Vite + Tailwind | Fast dev, small bundle |
| Markdown | react-markdown | Renders AI response tables and formatting |
| Excel | ExcelJS | Parse uploaded workbooks |

## Testing

### Unit Tests (Vitest)

Tests cover the financial calculation engine (`server/engine/`).

```bash
npm test                # same as vitest run
npx vitest run          # run once
npx vitest              # watch mode
```

The core calculation modules — `labor`, `budget`, `margin`, `evm`, `utilization`, `scenarios`, and `narrative` — each have their own unit-test file. Together these cover the full calculation surface, including Earned Value Management metrics (CPI, SPI, EAC and friends), utilization, and what-if scenarios. None of them need a network connection or an API key.

Two modules have no test file of their own. `matching.ts` (fuzzy project/role resolution) and `portfolio.ts` (portfolio aggregation) are covered indirectly, wherever `executor.ts` resolves a project or role or aggregates a multi-project result — see `executor-guards.test.ts`, `deterministic-asofdate.test.ts`, `evm-proxy.test.ts`, and `scenarios.test.ts`. The schema in `validation.ts` is covered directly by `validation.test.ts`.

`goal-seeking.test.ts` is not a module's test file; there is no `goal-seeking.ts`. It checks that the `labor`, `margin`, `budget`, and `scenarios` primitives compose the way the V3 agent loop chains them to answer goal-seeking questions — for example, "how do I extend the timeline and stay in budget?" A separate AI-layer integration test covers the boundary where a parsed intent becomes tool arguments.

**Coverage scope.** The enforced coverage thresholds ([`vitest.config.ts`](vitest.config.ts)) apply to `server/engine/**` — the deterministic financial core — and deliberately exclude `executor.ts`, `portfolio.ts`, and the barrel `index.ts`.

Excluded is not the same as untested. `executor.ts` is exercised directly by `executor-guards.test.ts`, `evm-proxy.test.ts`, and `deterministic-asofdate.test.ts`, which call `executeScenario()` the same way production does; that also reaches `portfolio.ts`'s `calcPortfolioMetrics()` on portfolio-wide actions. The thresholds are scoped to the pure-calculation core on purpose: a numeric floor stays meaningful there, and diluting it with orchestration code — which unit tests cover better anyway — would only make the gate easier to pass.

**The Playwright E2E suite does not add coverage of this path.** The only E2E spec that reaches the AI-scenario endpoints, `ai-workflow.spec.ts`, intercepts the request in the browser (`page.route("**/api/scenario/v3", ...)`) and answers it with a scripted response. `executeScenario()` and `calcPortfolioMetrics()` never run during that test. A live call isn't an alternative either, since the E2E environment has no LLM provider configured.

In fact the E2E suite does not exercise `server/engine/` at all. The Dashboard tests in `app.spec.ts` do hit the live `/api/dashboard` handler, but that handler builds its summary from `server/db.ts` queries and its own arithmetic in `server/routes.ts` — `server/db.ts` imports nothing from the engine. Vitest is the only thing covering the engine.

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

`app.spec.ts` and `tests/e2e/excel/*.spec.ts` hit the real server and a real, freshly-seeded SQLite database, with no mocking.

`ai-workflow.spec.ts` (the AI Analyst query/response flow) works differently. It uses Playwright's `page.route()` to intercept `/api/scenario/v3` in the browser and return a scripted JSON response. So it verifies the *frontend's* handling of a given API shape — loading state, rendering, error states — and does not exercise the real intent-parsing, engine, or narration code on the server. That is deliberate: the E2E environment runs with no LLM provider configured (see `FSE_DISABLE_GH_TOKEN` in `playwright.config.ts`), so there is no live model to call. Server-side behavior at the AI boundary is covered instead by the Vitest suite above (`ai.test.ts`, `executor-guards.test.ts`, and others) and by the intent-parsing eval below.

### Intent-parsing evals

The unit tests can't check whether the model actually understood the question. Turning "swap the Senior Dev for two Mid-levels on Alpha" into the correct `ScenarioOperation` takes a live model call, so it can't run in the ordinary CI suite.

That job belongs to an **eval**: a fixed set of example inputs, each labeled with the output it should produce, run against a real model and scored. Think of it as a test suite for the model — except that models aren't deterministic, so the result is an accuracy percentage measured across the whole set rather than a pass/fail per case.

**Corpus:** `server/evals/intent-corpus.json` holds the labeled cases. They cover every operation type (`swap`, `add`, `remove`, `rate_change`, `hours_change`, `timeline_extension`, `unexpected_cost`, `reallocation`, `burn_rate_check`, `margin_analysis`, `evm_analysis`, `what_if_composite`). It also includes ambiguous and out-of-scope queries paired with the fallback behavior they should trigger, plus an `adversarial` category: prompt-injection attempts (input written to talk the model out of following its instructions), contradictory queries, and trick questions. The case count isn't repeated here — the corpus-integrity tests below enforce both a size floor and category coverage.

Some queries have more than one defensible reading under the prompt's rules. Those entries carry an `expectedAlternatives` array, and the scorer takes the best match among the primary expected value and its alternatives.

**Runner (local, GitHub Models — the DB's seeded default):**

```bash
GITHUB_TOKEN=<pat-with-models:read> npm run eval:intent
```

**Runner (local, OpenRouter):**

```bash
OPENROUTER_API_KEY=<key> npm run eval:configure-openrouter && npm run eval:intent
```

The runner sends each query through the same `PARSE_INTENT_PROMPT` production uses. It imports that prompt directly from `server/ai.ts`, so editing the prompt automatically changes what the eval measures. It calls production's `parseIntent()` directly rather than reimplementing it, so output it cannot parse comes back as the same typed failure production returns — `invalid_json` or `invalid_operation` — and scores 0, exactly as production surfaces a 422. There is no fallback that turns a failed parse into a plausible-looking success.

Scoring has two parts: whether the action type matched exactly, and how many individual fields matched the labeled values. The runner prints a per-case result table and an aggregate summary. Both aggregate figures — action accuracy and mean field score — divide by the full corpus size, and a transport error scores 0 rather than dropping out of the denominator.

Notes on the runner's environment:
- Model, provider, and endpoint are resolved via the same `getAiConfig()` production uses (`server/ai.ts`), which reads the app's SQLite config table — a custom model/provider configured in Settings (or the seeded default, `openai/gpt-4.1` on the GitHub Models endpoint) is reflected in eval results, not hardcoded here.
- The upfront skip/gate check is provider-aware: it calls the SAME `isProviderConfigured()` production uses (`server/ai.ts`), so it correctly recognizes whichever provider is actually configured (github/ollama/openrouter) rather than keying on one provider's credential env var alone.
- If the resolved provider is unconfigured: an ungated local run (plain `npm run eval:intent`) exits cleanly without failing; a gated run (`EVAL_INTENT_GATED=1`, as set by `.github/workflows/real-model-eval.yml`) fails instead, so CI can't silently skip the accuracy gate.
- When the resolved provider is `openrouter`, requests are paced (`OPENROUTER_EVAL_PACING_MS` in `run-intent-eval.ts`) to stay under OpenRouter's free-tier rate limit of 20 requests/minute — see the CI section below. Pacing keys off the provider name, not the host, so it also applies to the CI runs that use the `openrouter` provider against Ollama Cloud. It has no effect on `github` or `ollama` runs.

**CI (`.github/workflows/real-model-eval.yml`) — off GitHub Models, now Ollama Cloud by default.** GitHub Models is fully retired 2026-07-30, and this scheduled/PR-triggered eval had failed 19 consecutive runs against it with `failureCode: "http_error"`. The workflow moved to OpenRouter first, then changed its default host to Ollama Cloud, because OpenRouter's free Nemotron pool turned out to be too unreliable to gate on: it does not consistently honor the `response_format` request field, so runs failed on malformed JSON rather than on genuine accuracy regressions, and same-day re-runs exhausted OpenRouter's shared free-tier daily cap.

Every run executes `npm run eval:configure-openrouter` before `npm run eval:intent`. One naming quirk to know before reading that workflow: **`openrouter` is this codebase's name for a generic OpenAI-compatible provider, not specifically OpenRouter the company.** The config script always writes `llm_provider: "openrouter"`, and `server/ai.ts` always reads the credential from an environment variable named `OPENROUTER_API_KEY`. The endpoint URL and the repository secret supplying that variable are what actually change per host:

| How the workflow runs | Endpoint | Repository secret | Default model |
|-----------------------|----------|-------------------|---------------|
| Nightly `schedule`, labeled PR, or a manual run that leaves `endpoint` alone | `https://ollama.com/v1/chat/completions` | `OLLAMA_CLOUD_API_KEY` | `nemotron-3-ultra` |
| Manual run, `endpoint: openrouter` | `https://openrouter.ai/api/v1/chat/completions` | `OPENROUTER_API_KEY` | `nvidia/nemotron-3-ultra-550b-a55b:free` |
| Manual run, `endpoint: nvidia-nim` | `https://integrate.api.nvidia.com/v1/chat/completions` | `NVIDIA_API_KEY` | `nvidia/nemotron-3-ultra-550b-a55b` |

All three hosts serve the same underlying model family, but each names the model differently — so if you override `endpoint`, set `openrouter_model` to match. The three endpoint URLs are fixed constants owned by the workflow, never free text, so selecting one does not widen the SSRF surface that `server/ssrf.ts` guards on `PUT /api/config`.

To swap models without a code change, use the `openrouter_model` `workflow_dispatch` input for manual runs, or set an `OPENROUTER_MODEL` repository/environment variable for scheduled and labeled-PR runs. The app's own default provider (`server/db.ts`, still `github`) is untouched by any of this — see the callout in "LLM Providers" above.

Free-tier rate limits are worth understanding if you point a run back at OpenRouter (https://openrouter.ai/docs/api-reference/limits): 20 requests/minute always, and 50 requests/day unless the OpenRouter account has purchased $10+ in credits all-time, which raises the cap to 1,000/day. One full eval run issues one LLM call per corpus entry (`server/__tests__/intent-corpus.test.ts` holds the enforced size floor — not repeated here as a number that could drift). That sits comfortably inside the per-minute cap once paced, but a single run comes close enough to the 50/day cap — on an account with no purchased credits — to leave little headroom for a same-day schedule plus a labeled-PR run plus a manual dispatch. Purchasing credits, or accepting a tighter cadence, is an account-level decision for the repo owner; the workflow's code cannot change it. NVIDIA NIM and Ollama Cloud draw on separate quotas, which is why they remain available for same-day manual re-runs after OpenRouter's daily budget is spent.

**Results artifact:** `server/evals/results/latest.json`, written on each run and excluded from git. Accuracy comes from the runner output and this artifact; it is deliberately not hard-coded in this README.

When a case fails on a non-2xx response, it records the numeric `httpStatus` alongside the existing `parseFailureCode`. Previously a failed run showed only the generic code, which left a 429 (rate limited) and a 401 (bad credentials) indistinguishable without re-running against a live model.

**Corpus integrity (CI):** `server/__tests__/intent-corpus.test.ts` runs in the normal `npm test` suite — no network needed. It validates that every corpus entry is a structurally valid `ScenarioOperation`, every action type is covered, ids are unique, the adversarial category is non-empty, and the corpus meets the size floor asserted there (the test is the authoritative number, not this README).

### Narration faithfulness (advisory judge)

The intent eval checks what goes *into* the engine. This second eval checks what comes back *out*: when the app writes a prose summary of a scenario, does that prose match the numbers the engine actually computed? It looks for invented or mismatched figures, direction flips (reporting that costs fell when they rose), and claims the result doesn't support. The property has a standard name — **faithfulness**: the summary asserts nothing its source data doesn't support.

Grading prose against a data structure is awkward to do with string matching, so this eval uses a second model as the grader. That pattern is called **LLM-as-judge**. The judge is shown the `ScenarioResult` and the narrative, and returns a verdict.

- **Judge:** `server/evals/faithfulness-judge.ts`. Its verdict is validated against a strict Zod schema, and it returns typed failure codes. The model call is injectable, so the judge's own unit tests never touch the network. This file is eval-side only and is never imported by production request-handling code.
- **Runner:** `GITHUB_TOKEN=<pat> npm run eval:faithfulness`. It runs representative operations through the real `executeScenario()` → `generateNarrative()` path at a fixed reference date, then judges each narrative. Results land in `server/evals/results/faithfulness-latest.json` (gitignored).
- **ADVISORY ONLY — this judge gates nothing.** It has not been calibrated against human-labeled data, so how often its verdicts are correct is simply unmeasured — its precision and recall are unknown. Treat its output as a hint, not as evidence. The runner exits 0 regardless of the verdicts. A missing `GITHUB_TOKEN` skips cleanly, or fails under `EVAL_FAITHFULNESS_GATED=1`, mirroring the intent eval. A pass/fail threshold may only be introduced by a deliberate calibration PR that follows the procedure documented in `server/evals/eval-config.ts`.

---

## Project Structure

```
financial-scenario-engine/
├── server/                     # Express + TypeScript backend
│   ├── index.ts                # Entry point, static file serving
│   ├── db.ts                   # SQLite schema, seed data, queries
│   ├── loaders.ts              # DB rows → PortfolioSnapshot for the engine
│   ├── ai.ts                   # LLM client (GitHub Models + OpenRouter + Ollama) + prompts
│   ├── routes.ts               # REST API endpoints
│   ├── auth.ts                 # App-token auth (requireAppToken / APP_SECRET) for mutating routes
│   ├── ssrf.ts                 # SSRF guard helpers for config-endpoint URL refinements
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
│   │   ├── validation.ts       # scenarioOperationSchema — Zod revalidation at the LLM trust boundary
│   │   ├── executor.ts         # Scenario orchestration (calc → impact; snapshot passed in)
│   │   ├── index.ts            # Barrel export
│   │   └── __tests__/          # Vitest engine unit tests (one file per module)
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
| GET | `/api/telemetry/llm` | In-process LLM call metrics (counts, latency, typed failure codes — no content) |
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
| POST | `/api/import/excel` | Upload Excel workbook — sheet preview only, no data written (v1) |
| POST | `/api/import/excel/v2` | Upload Excel workbook — sheet preview only, no data written (v2) |

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
Replace the seed data in `server/db.ts` → `seedSampleData()` with actual project/staffing data, or build an import pipeline from your pricing reference workbook.

---

## GitHub Pages Site

The published site is **one artifact composed from two builds**, so a deploy of either surface can never overwrite the other:

| Path | Source | Built with |
|------|--------|------------|
| `/` (plus `/guide/`, `/api/`, `/engine/`, `/client/`, `/excel/`, `/reference/`) | `docs/` | VitePress |
| `/overview/` | `client/pages/` + `client/src/site/` | React + Vite + Tailwind, same stack as the application UI |

### Pages Commands

```bash
# Overview site
npm run build:pages
cd client && npm run preview:pages

# Docs
cd docs && npm ci && npm run build
```

Built separately, each surface serves from `/` locally; only the deployed artifact nests the overview site under `/overview/`.

### Deployment

GitHub Pages deployment is automated in `.github/workflows/deploy-pages.yml`, which is the **only** workflow that writes to the `github-pages` environment.
On pushes to `main` (and on manual dispatch), after lint, typecheck, unit tests, and E2E pass, it builds both surfaces, composes them into a single `site/` tree, and performs one upload and one deploy under the `pages` concurrency group.

---

## Roadmap

Forward-looking work that is **not** in the current release:

- **Full Excel-to-SQLite import.** Today's `/api/import/excel*` endpoints only return a preview (sheet names + first 20 rows for up to 10 sheets) and do not persist any data. Mapping previewed sheets onto the projects / staffing / labor schemas — including conflict resolution and column-mapping UI — is planned but not yet implemented.

## Further Reading

| Document | Description |
|----------|-------------|
| [`CONTRIBUTORS.md`](CONTRIBUTORS.md) | Authorship, AI tooling acknowledgement, and how to contribute |
| [`server/engine/README.md`](server/engine/README.md) | Calculation engine architecture, modules, and public API |
| [`client/README.md`](client/README.md) | React frontend setup, components, and build |
| [`server/import/excel/README.md`](server/import/excel/README.md) | Excel preview module — endpoint contracts and response shapes (preview only) |

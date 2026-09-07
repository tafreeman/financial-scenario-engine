# Testing

The Financial Scenario Engine has two testing layers: unit tests (Vitest) for the calculation engine and end-to-end tests (Playwright) for the full application.

## Unit Tests (Vitest)

Tests cover the financial calculation engine in `server/engine/`.

::: code-group

```bash [Run once]
npm test
# or
npx vitest run
```

```bash [Watch mode]
npx vitest
```

:::

### Test Coverage

Test file count and pass/fail totals are whatever `npx vitest run` reports for the current tree — not maintained as a static number here.

| Test file | Module covered |
|-----------|---------------|
| `labor.test.ts` | `labor.ts` — cost/revenue calculations |
| `budget.test.ts` | `budget.ts` — burn rate, exhaustion date |
| `margin.test.ts` | `margin.ts` — margin percentage, contribution |
| `evm.test.ts` | `evm.ts` — CPI, SPI, EAC, ETC, VAC, TCPI |
| `utilization.test.ts` | `utilization.ts` — utilization rate, effective bill rate |
| `scenarios.test.ts` | `scenarios.ts` — mutations + impact deltas |
| `narrative.test.ts` | `narrative.ts` — template output |
| `validation.test.ts` | `validation.ts` — `scenarioOperationSchema` |
| `executor-guards.test.ts` | `executor.ts` guard paths — transitively covers `matching.ts` and `portfolio.ts` |
| `evm-proxy.test.ts` | `executor.ts` — EVM proxy/spend-ratio wiring |
| `deterministic-asofdate.test.ts` | `executor.ts` — deterministic date handling |
| `goal-seeking.test.ts` | Not a per-module file — checks that `labor`/`margin`/`budget`/`scenarios` combine correctly for goal-seeking-style what-if questions |

All tests are **deterministic** — no randomness, no time-dependent logic.

### Coverage Scope

The enforced coverage thresholds ([`vitest.config.ts`](../../vitest.config.ts)) apply to `server/engine/**` — the deterministic financial core — and deliberately exclude `executor.ts`, `portfolio.ts`, and the barrel `index.ts`.

Excluded is not the same as untested. `executor.ts` is exercised directly by `executor-guards.test.ts`, `evm-proxy.test.ts`, and `deterministic-asofdate.test.ts`, which call `executeScenario()` the same way production does; that also reaches `portfolio.ts`'s `calcPortfolioMetrics()` on portfolio-wide actions. The thresholds are scoped to the pure-calculation core on purpose: a numeric floor stays meaningful there, and diluting it with orchestration code — which unit tests cover better anyway — would only make the gate easier to pass.

## E2E Tests (Playwright)

End-to-end tests cover UI workflows and API endpoints.

```bash
npm run test:e2e
```

Most specs — `app.spec.ts` and the `tests/e2e/excel/` specs — run against the real server and a freshly-seeded SQLite DB.

The AI Analyst query flow (`ai-workflow.spec.ts`) is the exception. It uses Playwright's `page.route()` to intercept `/api/scenario/v3` in the browser and return a scripted response, so it checks the frontend's handling of a given response shape rather than the real intent-parsing, engine, or narration path on the server. There is no live model to call instead: the E2E environment has no LLM provider configured. For how the AI boundary is covered instead, see [Coverage Scope](#coverage-scope) above and [Intent-Parsing Evals](#intent-parsing-evals) below.

In fact the E2E suite does not exercise `server/engine/` at all. The Dashboard tests in `app.spec.ts` do hit the live `/api/dashboard` handler, but that handler builds its summary from `server/db.ts` queries and its own arithmetic in `server/routes.ts` — `server/db.ts` imports nothing from the engine. Vitest is the only thing covering the engine.

Playwright auto-builds the client and starts the app server on port `3100` via the `webServer` config.

### First Run Setup

```bash
npx playwright install --with-deps chromium
```

### Test Locations

| Directory | Coverage |
|-----------|----------|
| `tests/e2e/ui/` | UI workflow tests |
| `tests/e2e/excel/` | Excel import endpoint tests |

### Conventions

- Follow **AAA pattern** (Arrange → Act → Assert)
- No `page.waitForTimeout()` (hardcoded sleeps)
- No `{ force: true }` on click actions
- Tests run against a fresh database (seeded on startup)

## Running Specific Tests

::: code-group

```bash [All unit tests]
npx vitest run
```

```bash [Single unit test file]
npx vitest run server/engine/__tests__/evm.test.ts
```

```bash [All E2E tests]
npm run test:e2e
```

```bash [Excel E2E only]
npx playwright test tests/e2e/excel/
```

```bash [UI E2E only]
npx playwright test tests/e2e/ui/
```

:::

## Intent-Parsing Evals

The unit tests can't check whether the model actually understood the question. Turning "swap the Senior Dev for two Mid-levels on Alpha" into the correct `ScenarioOperation` takes a live model call, so it can't run in the ordinary CI suite.

That job belongs to an **eval**: a fixed set of example inputs, each labeled with the output it should produce, run against a real model and scored. Think of it as a test suite for the model — except that models aren't deterministic, so the result is an accuracy percentage measured across the whole set rather than a pass/fail per case.

**Corpus:** `server/evals/intent-corpus.json` holds the labeled cases. They cover every operation type (`swap`, `add`, `remove`, `rate_change`, `hours_change`, `timeline_extension`, `unexpected_cost`, `reallocation`, `burn_rate_check`, `margin_analysis`, `evm_analysis`, `what_if_composite`). It also includes ambiguous and out-of-scope queries paired with the fallback behavior they should trigger, plus an `adversarial` category: prompt-injection attempts (input written to talk the model out of following its instructions), contradictory queries, and trick questions. The case count isn't repeated here — the corpus-integrity tests below enforce both a size floor and category coverage.

Some queries have more than one defensible reading under the prompt's rules. Those entries carry an `expectedAlternatives` array, and the scorer takes the best match among the primary expected value and its alternatives.

**Runner (local, Ollama — the DB's seeded default):**

```bash
npm run eval:intent
```

Requires a running local Ollama server (`ollama serve`); no token needed.

**Runner (local, GitHub Models):**

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
- Model, provider, and endpoint are resolved via the same `getAiConfig()` production uses (`server/ai.ts`), which reads the app's SQLite config table — a custom model/provider configured in Settings (or the seeded default, `llama3.2` on the local Ollama endpoint) is reflected in eval results, not hardcoded here.
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

To swap models without a code change, use the `openrouter_model` `workflow_dispatch` input for manual runs, or set an `OPENROUTER_MODEL` repository/environment variable for scheduled and labeled-PR runs. The app's own default provider (`server/db.ts`, now `ollama` — see the callout in [AI Workflows → LLM Providers](../guide/ai-workflows.md#llm-providers)) is untouched by any of this; it was migrated separately, in PR #60.

Free-tier rate limits are worth understanding if you point a run back at OpenRouter (https://openrouter.ai/docs/api-reference/limits): 20 requests/minute always, and 50 requests/day unless the OpenRouter account has purchased $10+ in credits all-time, which raises the cap to 1,000/day. One full eval run issues one LLM call per corpus entry (`server/__tests__/intent-corpus.test.ts` holds the enforced size floor — not repeated here as a number that could drift). That sits comfortably inside the per-minute cap once paced, but a single run comes close enough to the 50/day cap — on an account with no purchased credits — to leave little headroom for a same-day schedule plus a labeled-PR run plus a manual dispatch. Purchasing credits, or accepting a tighter cadence, is an account-level decision for the repo owner; the workflow's code cannot change it. NVIDIA NIM and Ollama Cloud draw on separate quotas, which is why they remain available for same-day manual re-runs after OpenRouter's daily budget is spent.

**Results artifact:** `server/evals/results/latest.json`, written on each run and excluded from git. Accuracy comes from the runner output and this artifact; it is deliberately not hard-coded here.

When a case fails on a non-2xx response, it records the numeric `httpStatus` alongside the existing `parseFailureCode`. Previously a failed run showed only the generic code, which left a 429 (rate limited) and a 401 (bad credentials) indistinguishable without re-running against a live model.

**Corpus integrity (CI):** `server/__tests__/intent-corpus.test.ts` runs in the normal `npm test` suite — no network needed. It validates that every corpus entry is a structurally valid `ScenarioOperation`, every action type is covered, ids are unique, the adversarial category is non-empty, and the corpus meets the size floor asserted there (the test is the authoritative number, not this page).

## Narration Faithfulness (Advisory Judge)

The intent eval checks what goes *into* the engine. This second eval checks what comes back *out*: when the app writes a prose summary of a scenario, does that prose match the numbers the engine actually computed? It looks for invented or mismatched figures, direction flips (reporting that costs fell when they rose), and claims the result doesn't support. The property has a standard name — **faithfulness**: the summary asserts nothing its source data doesn't support.

Grading prose against a data structure is awkward to do with string matching, so this eval uses a second model as the grader. That pattern is called **LLM-as-judge**. The judge is shown the `ScenarioResult` and the narrative, and returns a verdict.

- **Judge:** `server/evals/faithfulness-judge.ts`. Its verdict is validated against a strict Zod schema, and it returns typed failure codes. The model call is injectable, so the judge's own unit tests never touch the network. This file is eval-side only and is never imported by production request-handling code.
- **Runner:** `GITHUB_TOKEN=<pat> npm run eval:faithfulness`. It runs representative operations through the real `executeScenario()` → `generateNarrative()` path at a fixed reference date, then judges each narrative. Results land in `server/evals/results/faithfulness-latest.json` (gitignored).
- **ADVISORY ONLY — this judge gates nothing.** It has not been calibrated against human-labeled data, so how often its verdicts are correct is simply unmeasured — its precision and recall are unknown. Treat its output as a hint, not as evidence. The runner exits 0 regardless of the verdicts. A missing `GITHUB_TOKEN` skips cleanly, or fails under `EVAL_FAITHFULNESS_GATED=1`, mirroring the intent eval. A pass/fail threshold may only be introduced by a deliberate calibration PR that follows the procedure documented in `server/evals/eval-config.ts`.

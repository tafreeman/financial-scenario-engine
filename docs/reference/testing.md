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
| `goal-seeking.test.ts` | Not a per-module file — composes `labor`/`margin`/`budget`/`scenarios` to check goal-seeking-style what-if composability |

All tests are **deterministic** — no randomness, no time-dependent logic.

## E2E Tests (Playwright)

End-to-end tests cover UI workflows and API endpoints.

```bash
npm run test:e2e
```

Most specs (`app.spec.ts`, the `tests/e2e/excel/` specs) run against the real server and a freshly-seeded SQLite DB. The exception is the AI Analyst query flow (`ai-workflow.spec.ts`): it uses Playwright's `page.route()` to intercept `/api/scenario/v3` in the browser and return a scripted response, so it checks the frontend's handling of a given response shape rather than the real intent-parsing/engine/narration path on the server — the e2e environment has no LLM provider configured, so there's no live model to call instead. The root README's "Coverage scope" note (under Unit Tests) has the full picture of how the AI boundary is covered instead (Vitest + the separate intent-parsing eval below).

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

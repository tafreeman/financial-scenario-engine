# Testing

The Financial Impact Analyzer has two testing layers: unit tests (Vitest) for the calculation engine and end-to-end tests (Playwright) for the full application.

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

98 tests across 7 test files:

| Test file | Module covered |
|-----------|---------------|
| `labor.test.ts` | `labor.ts` — cost/revenue calculations |
| `budget.test.ts` | `budget.ts` — burn rate, exhaustion date |
| `margin.test.ts` | `margin.ts` — margin percentage, contribution |
| `evm.test.ts` | `evm.ts` — CPI, SPI, EAC, ETC, VAC, TCPI |
| `scenarios.test.ts` | `scenarios.ts` — mutations + impact deltas |
| `goal-seeking.test.ts` | Goal-seeking / what-if analysis |
| `narrative.test.ts` | `narrative.ts` — template output |

All tests are **deterministic** — no randomness, no time-dependent logic.

## E2E Tests (Playwright)

End-to-end tests cover UI workflows and API endpoints.

```bash
npm run test:e2e
```

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

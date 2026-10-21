<!--
REVIEW.md: rules for the advisory AI pull-request reviewer.
Read from the base branch only, so a PR cannot change the rules it is reviewed under.
Byte-stable: no dates, no counters. Keep under ~1,500 tokens.
Owner: @tafreeman. Any change to this file routes to the high_risk tier.
-->

# Review guide: financial-scenario-engine

## What this repo is

A local-first TypeScript "what-if" simulator for project financials: Express + SQLite in `server/`, React in `client/`, VitePress in `docs/`. An LLM turns a question into a `ScenarioOperation` or writes prose; a pure engine in `server/engine/` computes every figure in a scenario result.

## Invariants a change must not break

- **The engine is pure, synchronous and DB-free.** `server/engine/` imports only itself and `zod`: no `async`, I/O or `server/db.ts`. The one DB crossing is `loadPortfolioSnapshot()` in `server/loaders.ts`. Checked: not checked by CI.
- **Every figure in a scenario result comes from the engine** (`executeScenario()`, `server/engine/executor.ts`); no model computes or edits one. Checked: `ci` job, `server/engine/__tests__/*.test.ts`.
- **The LLM may only parse intent and write prose.** In `server/ai.ts`: `parseIntent()`, `narrateResult()`, and `agenticScenario()`, which reaches the engine only via the `run_scenario` tool. Checked: not checked by CI.
- **Model JSON is re-validated before execution.** `parseIntent()` and `processToolCalls()` both run `scenarioOperationSchema.safeParse()` (`server/engine/validation.ts`, all objects `.strict()`) first; invented fields and payload-less actions are rejected. Checked: `ci` job, `server/engine/__tests__/validation.test.ts`, `server/__tests__/ai.test.ts`, `server/__tests__/scenario-parse-failure.integration.test.ts`.
- **Mutating and scenario routes require `x-app-token`.** Every POST/PATCH/PUT/DELETE and all scenario routes in `server/routes.ts` use `requireAppToken` (`server/auth.ts`, `timingSafeEqual`). Checked: `ci` job, `server/__tests__/routes-auth.integration.test.ts`, `server/__tests__/config-auth-ssrf.test.ts`; scenario-route 401s not checked by CI.

## High-risk areas and what to look for there

| Path | Look for |
| --- | --- |
| `server/engine/**` | Float money math; rounding before aggregation (round only at the API layer); hours/week vs FTE mixups (`fte()` = hours / 40, monthly = `WEEKS_PER_MONTH` = 52 / 12); divide-by-zero at EV = 0, where `safeDivide()` yields a `0` CPI or EAC that reads as real; mutating inputs; a match that changes nothing without a warning; loosening `.strict()` in `validation.ts`. |
| `server/loaders.ts` | Dropping the `is_active` filter; `null` vs `undefined` for `percent_complete`; engine logic leaking in. |
| `server/db.ts` | SQL `52.0 / 12` must match `WEEKS_PER_MONTH`; `buildAnonymizedContextSnapshot()` must replace every `person_name`. |
| `server/auth.ts` | Non-constant-time compare; logging the token after startup; a mutating route without the guard, or the guard after `uploadSingle`. |
| `server/ai.ts` | Model output reaching `executeScenario()` unvalidated; stored names or engine output added to a prompt (an engine warning once leaked a name, see `docs/decisions/004-lean-egress-kernel.md`); dropping `redirect: "error"` in `chatRequest()`. |
| `server/evals/**` | Reimplementing the prompt or parser instead of importing `parseIntent()`; lowering the `eval-config.ts` threshold; trimming `intent-corpus.json` below `server/__tests__/intent-corpus.test.ts`. |
| `tests/e2e/reset-e2e-db.ts` | Deleting anything but the e2e DB: relaxing the `DB_PATH` check or the `data/` refusal. |
| `playwright.config.ts` | Removing `DB_PATH: E2E_DB_PATH` from `webServer.env`; reordering `webServer.command`; `e2e-app-token` drifting from `tests/e2e/auth-state.json`. |
| `.github/**` | `uses:` refs not SHA-pinned; `pull_request_target`; secrets reachable by PR code; dropping an `npm audit` leg; renaming the required `ci`, `e2e` or `npm audit` jobs. |

## Conventions the reviewer should assume

- The blocking gate is job `ci` in `.github/workflows/deploy-pages.yml`; there is no `ci.yml`.
- Coverage thresholds cover only `server/engine/**`, minus `executor.ts`, `portfolio.ts`, `index.ts`.
- Vitest runs only `server/**/__tests__/**/*.test.ts` and `client/src/**/__tests__/**/*.test.ts`.
- `vitest.config.ts` sets `APP_API_TOKEN` and `DB_PATH=":memory:"` because `server/auth.ts` reads the token at load.
- Provider `"openrouter"` means any OpenAI-compatible endpoint; its key is always `OPENROUTER_API_KEY`.

## Do not flag (repo-specific)

- `handleExcelImportV2` aliases V1 (`server/import/excel/index.ts`); both are preview-only.
- GET routes in `server/routes.ts` are unguarded by design.
- `server/evals/run-faithfulness-eval.ts` always exits 0; it is advisory until calibrated.
- The client `npm audit` leg in `.github/workflows/security.yml` uses `--omit=dev` for an unpatched build-only advisory.
- The seeded default provider in `server/db.ts` is an owner decision.
- `docs/decisions/004-lean-egress-kernel.md` is not yet implemented (no `egress/`); review against the code.

## Severity calibration for this repo

- **Critical:** any wrong dollar figure, percentage or date; model output reaching the engine unvalidated; an unguarded mutating route; a stored name or real figure newly sent to a model; anything that can delete `data/finimpact.db`.
- **High:** a silent no-op scenario; engine I/O or a `server/db.ts` import; unpinned or over-permissioned workflows; dropping a required job or audit leg.
- **Medium:** untested engine branches; weakened eval gates; docs contradicting code.
- **Low:** style and naming.

## Out of scope for AI review

- `package-lock.json`, `client/package-lock.json`, `docs/package-lock.json`
- `client/public/**`, `docs/public/**`, `docs/assets/**`
- `data/`, `coverage/`, `test-results/`, `server/evals/results/`, `client/dist-pages/`, `docs/.vitepress/cache/`, `docs/.vitepress/dist/`

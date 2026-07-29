> Moved here from the workspace-root `CLAUDE.md` §5 on 2026-07-28 so it loads only
> when working in this repo. Cross-repo coupling and `_audit/` conventions stay in the
> workspace-root file.

# financial-scenario-engine (FSE)

**No AGENTS.md or `.cursorrules`** — and `.claude/` is gitignored here, so agent config must go at the repo root (this file) to be tracked. The closest house rules are `CONTRIBUTING.md`, `server/engine/README.md` (five design principles), and three ADRs in `docs/decisions/`.

Local-first TypeScript "what-if" simulator for project financials. Defining constraint: an LLM may only parse intent and write prose — every dollar figure comes from a pure, DB-free engine in `server/engine/`, and the model's structured output is re-validated against a Zod schema before the engine executes it.

```bash
npm run install:all      # root + client (does NOT install docs/)
npm run dev              # server 127.0.0.1:3000 + Vite 5173 proxying /api
npm run lint             # npx eslint .
npm run typecheck        # typecheck:server (tsc -p tsconfig.json) && typecheck:client
npm run test:coverage    # vitest run --coverage — the blocking gate
npx vitest run server/engine/__tests__/labor.test.ts     # single test file
npx vitest run server/__tests__/intent-corpus.test.ts -t "<name>"   # single test case
npx playwright test tests/e2e/ui/app.spec.ts             # WARNING: deletes data/finimpact.db
npm run build            # client ONLY (cd client && tsc -b && vite build)
npm start                # tsx server/index.ts
cd docs && npm ci && npm run build                       # VitePress site
```

**Architecture:** `server/engine/` is synchronous, pure, and forbidden from importing `server/db.ts`; the single sanctioned crossing is `loadPortfolioSnapshot()` in `server/loaders.ts`. Two AI control flows share one trust boundary — V2 single-pass (`parseIntent → ScenarioOperation → executeScenario → generateNarrative`) and V3 agent loop (`agenticScenario()` exposes the engine as a `run_scenario` tool, `MAX_ITERATIONS = 8`) — and **both** re-validate model JSON against `scenarioOperationSchema` before execution; invented fields are rejected, not coerced, and an action carrying none of its handler's payload is refused so it cannot execute as a silent no-op. Provider selection is one runtime seam, `getAiConfig()` in `server/ai.ts`, reading the SQLite `config` table; `"openrouter"` is this codebase's name for a **generic OpenAI-compatible provider with a config-writable endpoint** — CI drives NVIDIA NIM and Ollama Cloud through it by changing only the URL and the secret behind `OPENROUTER_API_KEY`. `requireAppToken` (`server/auth.ts`, `x-app-token`, `timingSafeEqual`) guards every mutating route and all three scenario routes. Three frontends build from one checkout and the Pages site is composed from two of them (VitePress at root, Vite overview under `/overview/`) by the workflow, not by any npm script. `server/evals/` runs a labeled corpus through production's **own** prompt and `parseIntent()` — imported, not reimplemented.

**Gotchas:**

- **There is no `ci.yml`.** The blocking gate is a job literally named `ci` inside `.github/workflows/deploy-pages.yml` ("CI and Deploy GitHub Pages"). Branch protection on `main` requires contexts `ci`, `e2e`, `npm audit` — CodeQL, secret-scan, dependency-review and real-model-eval are *not* required.
- Coverage thresholds (`vitest.config.ts`: lines/functions/statements 70, **branches 65**) apply **only to `server/engine/**`** and explicitly exclude `executor.ts`, `portfolio.ts`, `index.ts`. Uncovered code elsewhere in the engine can fail the gate; code in those three cannot.
- Vitest's include glob is `server/**/__tests__/**/*.test.ts` **only**. A test in `client/`, `tests/`, or beside its source silently never runs — and there is no client-side test runner at all.
- `vitest.config.ts` pins `APP_API_TOKEN` and `DB_PATH=":memory:"` at **config** level, not in a setup file, because `server/auth.ts` reads the token once at module load. Moving them breaks the auth test and lets tests hit the real dev DB.
- `npm run test:e2e` **deletes `data/finimpact.db`** — Playwright's `webServer.command` chains `npm run e2e:reset-db && npm run build && npm run start` with `&&` specifically because the old globalSetup ran after the server had opened the file (EBUSY/EPERM on Windows). Rationale lives in `tests/e2e/reset-e2e-db.ts:22-28`, not the README. Local Windows runs are flaky; the ubuntu `e2e` job is the real gate.
- The E2E token `"e2e-app-token"` is duplicated in three places that must stay identical: `playwright.config.ts` webServer env, its `extraHTTPHeaders`, and `tests/e2e/auth-state.json`. The same config sets `FSE_DISABLE_GH_TOKEN: "1"` so a machine with `gh` authenticated doesn't change asserted Settings copy.
- Every `package-lock.json` needs its own `npm audit` leg. `docs/` was unaudited until 2026-07-25, which is how a HIGH postcss advisory (GHSA-r28c-9q8g-f849) sat open on main while the required check stayed green.
- `server/evals/intent-corpus.json` is schema-gated by an **offline** unit test in the normal suite (valid ScenarioOperation, unique ids, all 12 action types, non-empty adversarial category, ≥40 entries) — trimming it breaks `npm test` with no network involved.
- The live-model eval needs the `run-live-eval` label; its **default host is Ollama Cloud**, not OpenRouter (the workflow emulates a ternary with `&&`/`||` and label/cron runs carry no `endpoint` input). The env var is `OPENROUTER_API_KEY` regardless of host.
- The app's seeded default provider is still `github` (GitHub Models, retired 2026-07-30). Changing `server/db.ts`'s `insertConfig.run("llm_provider", "github")` is an owner-gated product decision — do not "fix" it in passing.
- `eslint.config.js:7-16` ignores `**/*.js` and `server/engine/__tests__/**` (engine tests are unlinted); `no-explicit-any` is `error` on both halves (`:43` server, `:78` client).
- `tsconfig.playwright.json` exists but **nothing** references it — no npm script, no CI step. E2E type errors surface only when Playwright runs.
- `server/import/excel/v2/` holds no source files; `handleExcelImportV2` is an alias re-export of V1 (`server/import/excel/index.ts:3`), so both endpoints are the same preview-only path.

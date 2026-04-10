# Financial Calculation Engine

TypeScript calculation engine for project financial analysis. The calculation modules in `server/engine/` are synchronous and deterministic; the main exception is `executor.ts`, which loads data from `server/db.ts` and orchestrates those pure calculations.

## Architecture Overview

```
PortfolioSnapshot (from DB)
        │
        ▼
  executor.ts  ──────────────────────────────────────────────────────────
        │                                                                  │
        ├── calcProjectLabor()         ← labor.ts                         │
        ├── calcProjectMarginFromLabor()  ← margin.ts                     │
        ├── calcBudgetMetrics()        ← budget.ts                        │
        ├── calcEvm()                  ← evm.ts                           │
        ├── calcUtilization()          ← utilization.ts                   │
        ├── applySwap/Add/Remove/…     ← scenarios.ts  (mutates staffing) │
        ├── calcScenarioImpact()       ← scenarios.ts  (before/after diff)│
        └── calcPortfolioMetrics()     ← portfolio.ts                     │
                                                                           │
        ▼                                                                  │
  ScenarioResult ────────────────────────────────────────────────────────┘
        │
        ▼
  generateNarrative()  ← narrative.ts (template-based markdown)
```

## Module Reference

### `types.ts` — Shared types and constants

Foundation for the entire engine. No imports from other engine modules.

**Constants:**
| Name | Value | Meaning |
|------|-------|---------|
| `WEEKS_PER_MONTH` | 4.33 | 365.25 / 12 / 7 |
| `HOURS_PER_YEAR` | 2080 | 52 × 40 |
| `WORKING_DAYS_PER_MONTH` | 21.67 | 260 / 12 |
| `WEEKS_PER_YEAR` | 52 | — |
| `MONTHS_PER_YEAR` | 12 | — |

**Utility functions:** `safeDivide()`, `roundDollars()`, `roundPct()`

**Key interfaces:** `LaborCategory`, `StaffingRecord`, `Project`, `ProjectSnapshot`, `PortfolioSnapshot`, `ScenarioOperation`, `LaborMetrics`, `MarginMetrics`, `BudgetMetrics`, `EvmMetrics`, `UtilizationMetrics`, `ScenarioImpact`, `ScenarioResult`, `V2Response`

---

### `labor.ts` — Labor cost and revenue

Computes per-person and aggregate labor metrics from a staffing list.

| Function | Input | Output |
|----------|-------|--------|
| `monthlyCost(costRate, hoursPerWeek)` | rates + hours | monthly cost ($) |
| `monthlyRevenue(billRate, hoursPerWeek)` | rates + hours | monthly revenue ($) |
| `annualCost(costRate, hoursPerWeek)` | rates + hours | annual cost ($) |
| `annualRevenue(billRate, hoursPerWeek)` | rates + hours | annual revenue ($) |
| `calcProjectLabor(staffing)` | `StaffingRecord[]` | `LaborMetrics` |

---

### `margin.ts` — Profitability

Computes gross margin, contribution margin, and net direct labor multiplier.

| Function | Input | Output |
|----------|-------|--------|
| `calcProjectMargin(staffing)` | `StaffingRecord[]` | `MarginMetrics` |
| `calcProjectMarginFromLabor(labor)` | `LaborMetrics` | `MarginMetrics` |

`margin_pct` = (revenue − cost) / revenue × 100

---

### `budget.ts` — Burn rate and budget exhaustion

Computes how quickly a project burns its budget and projects exhaustion date.

| Function | Input | Output |
|----------|-------|--------|
| `calcBudgetMetrics(project, monthlyBurn)` | `Project`, burn rate | `BudgetMetrics` |
| `calcRemainingBudget(project)` | `Project` | remaining dollars |

`budget_exhaustion_date` = today + `months_remaining` months

---

### `evm.ts` — Earned Value Management

Full EVM suite: CPI, SPI, CV, SV, four EAC variants, ETC, VAC, TCPI.

| Function | Description |
|----------|-------------|
| `calcCPI(ev, ac)` | Cost Performance Index: EV / AC |
| `calcSPI(ev, pv)` | Schedule Performance Index: EV / PV |
| `calcCV(ev, ac)` | Cost Variance: EV − AC |
| `calcSV(ev, pv)` | Schedule Variance: EV − PV |
| `calcEACTypical(bac, cpi)` | EAC assuming variance continues |
| `calcEACAtypical(ac, bac, ev)` | EAC assuming one-time variance |
| `calcEACMixed(ac, bac, ev, cpi, spi)` | EAC blended |
| `calcETC(eac, ac)` | Estimate to Complete: EAC − AC |
| `calcVAC(bac, eac)` | Variance at Completion: BAC − EAC |
| `calcTCPI(bac, ev, ac)` | To-Complete Performance Index |
| `calcPlannedValue(project)` | PV from start/end dates and BAC |
| `calcEarnedValue(project)` | EV = BAC × (spent / budget) |
| `calcEvm(project)` | Full `EvmMetrics` object |

---

### `utilization.ts` — Resource utilization

| Function | Input | Output |
|----------|-------|--------|
| `calcUtilization(labor, headcount)` | `LaborMetrics`, count | `UtilizationMetrics` |

Metrics: `utilization_rate`, `effective_bill_rate`, `revenue_per_employee`, `break_even_utilization`

---

### `scenarios.ts` — Staffing mutations and impact calculation

Immutable staffing mutation functions and before/after delta calculation.

| Function | Description |
|----------|-------------|
| `applyRemove(staffing, remove[])` | Remove N people of a role |
| `applyAdd(staffing, add[], categories)` | Add N people of a role |
| `applySwap(staffing, remove[], add[], categories)` | Swap roles |
| `applyRateChange(staffing, rate_changes[])` | Change bill/cost rates |
| `applyHoursChange(staffing, hours_changes[])` | Change hours/week |
| `calcScenarioImpact(current, projected)` | `ScenarioImpact` delta |
| `calcTimelineExtensionImpact(project, months)` | Budget impact of extension |
| `calcUnexpectedCostImpact(project, costs[])` | Impact of ad-hoc cost items |

All mutation functions return **new arrays** — input is never modified.

---

### `portfolio.ts` — Portfolio aggregation

| Function | Input | Output |
|----------|-------|--------|
| `calcPortfolioMetrics(projects)` | `ProjectSnapshot[]` | portfolio totals + `ProjectSummary[]` |

---

### `matching.ts` — Fuzzy role-name matching

Resolves role names from natural-language queries to labor category names in the rate card.

| Function | Description |
|----------|-------------|
| `fuzzyMatch(input, categories)` | Returns best-matching category name |
| `fuzzyMatchWithConfidence(input, categories)` | Returns match + confidence score |

Also exports `ROLE_ABBREVIATIONS` dictionary for common aliases.

---

### `executor.ts` — Scenario orchestration

Entry point for running a complete scenario. This is the engine boundary that loads data from the database, calls the pure calculation functions, and assembles the `ScenarioResult` envelope.

| Export | Description |
|--------|-------------|
| `loadPortfolioSnapshot()` | Loads full DB state into `PortfolioSnapshot` |
| `executeScenario(operation)` | Main entrypoint: operation → `ScenarioResult` |
| `resolveProject(name, snapshot)` | Fuzzy-find project by name |
| `resolveRole(role, categories)` | Fuzzy-find labor category by role name |

---

### `narrative.ts` — Template-based narrative renderer

Generates deterministic markdown narrative from a `ScenarioResult`. No LLM call.

| Export | Description |
|--------|-------------|
| `generateNarrative(result)` | `ScenarioResult` → markdown string |

Used as the default in the V2 pipeline (`use_llm_narrative: false`).

---

### `index.ts` — Barrel export

Re-exports everything from all engine modules for convenient imports:

```typescript
import { calcProjectLabor, calcBudgetMetrics, executeScenario } from "./engine/index.js";
```

---

## Running Tests

```bash
# From repo root
npm install
npx vitest run        # run all 98 engine tests once
npx vitest            # watch mode
```

Test files:

| File | Coverage |
|------|----------|
| `__tests__/labor.test.ts` | `labor.ts` functions |
| `__tests__/budget.test.ts` | `budget.ts` functions |
| `__tests__/margin.test.ts` | `margin.ts` functions |
| `__tests__/evm.test.ts` | `evm.ts` functions |
| `__tests__/scenarios.test.ts` | `scenarios.ts` mutations + impact |
| `__tests__/goal-seeking.test.ts` | Goal-seeking / what-if scenarios |
| `__tests__/narrative.test.ts` | `narrative.ts` output |

---

## Design Principles

1. **Pure computation** — Calculation modules take explicit inputs and return explicit outputs.
2. **Immutability** — Mutation functions return new arrays; never modify inputs.
3. **Safe arithmetic** — `safeDivide()` prevents `Infinity`/`NaN` from propagating.
4. **Determinism** — Same inputs always produce the same output. The LLM provides intent; the engine provides numbers.
5. **Separation from AI** — The engine has no knowledge of LLM providers or prompts. `executor.ts` is the database-backed adapter at the edge of the engine.

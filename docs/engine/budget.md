# Budget

`server/engine/budget.ts` computes burn rate and projects budget exhaustion dates.

## Functions

### `calcBudgetMetrics(project, monthlyBurn)`

Compute budget metrics for a project given its current monthly burn rate.

**Input:** `Project` + monthly burn rate (number)
**Output:** `BudgetMetrics`

```typescript
import { calcBudgetMetrics } from "./engine/index.js";

const budget = calcBudgetMetrics(project, 62500);
// → {
//   monthly_burn_rate: 62500,
//   remaining_budget: 800000,
//   months_remaining: 12.8,
//   budget_exhaustion_date: "2026-05-01",
//   annual_run_rate: 750000
// }
```

---

### `calcRemainingBudget(project)`

Simple helper — returns `total_budget - spent_to_date`.

```typescript
import { calcRemainingBudget } from "./engine/index.js";

calcRemainingBudget({ total_budget: 1250000, spent_to_date: 450000 });
// → 800000
```

## Formulas

| Metric | Formula |
|--------|---------|
| `remaining_budget` | `total_budget − spent_to_date` |
| `months_remaining` | `remaining_budget / monthly_burn_rate` |
| `budget_exhaustion_date` | `today + months_remaining months` |
| `annual_run_rate` | `monthly_burn_rate × 12` |

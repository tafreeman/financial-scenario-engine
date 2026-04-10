# Scenarios

`server/engine/scenarios.ts` provides immutable staffing mutation functions and before/after delta calculation.

::: info Immutability
All mutation functions return **new arrays** — input is never modified.
:::

## Staffing Mutations

### `applyRemove(staffing, remove[])`

Remove N people of a specified role from a staffing list.

```typescript
import { applyRemove } from "./engine/index.js";

const updated = applyRemove(staffing, [
  { role: "Senior Developer", count: 1 }
]);
```

---

### `applyAdd(staffing, add[], categories)`

Add N people of a specified role. Requires the labor category rate card to look up rates.

```typescript
import { applyAdd } from "./engine/index.js";

const updated = applyAdd(staffing, [
  { role: "QA Engineer", count: 2, hours_per_week: 40 }
], categories);
```

---

### `applySwap(staffing, remove[], add[], categories)`

Atomic swap — remove one set of roles and add another in a single operation.

```typescript
import { applySwap } from "./engine/index.js";

const updated = applySwap(
  staffing,
  [{ role: "Senior Developer", count: 1 }],
  [{ role: "Mid-level Developer", count: 2 }],
  categories
);
```

---

### `applyRateChange(staffing, rate_changes[])`

Change bill and/or cost rates for a role.

```typescript
const updated = applyRateChange(staffing, [
  { role: "Senior Developer", new_bill_rate: 250, new_cost_rate: 180 }
]);
```

---

### `applyHoursChange(staffing, hours_changes[])`

Change weekly hours for a named person.

```typescript
const updated = applyHoursChange(staffing, [
  { person_name: "Jane Smith", new_hours_per_week: 32 }
]);
```

## Impact Calculation

### `calcScenarioImpact(current, projected)`

Compute the delta between current and projected labor/margin/budget metrics.

**Output:** `ScenarioImpact`

```typescript
const impact = calcScenarioImpact(currentMetrics, projectedMetrics);
// → {
//   cost_delta_monthly: -1950,
//   revenue_delta_monthly: -3250,
//   margin_delta_pct: -2.1,
//   headcount_delta: 1,
//   ...
// }
```

---

### `calcTimelineExtensionImpact(project, months)`

Calculate the budget impact of extending a project timeline.

---

### `calcUnexpectedCostImpact(project, costs[])`

Calculate the impact of injecting one-time or recurring cost items.

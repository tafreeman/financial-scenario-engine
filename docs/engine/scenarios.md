# Scenarios

`server/engine/scenarios.ts` provides immutable staffing mutation functions and before/after delta calculation.

::: info Immutability
All mutation functions return **new arrays** — input is never modified.
:::

::: warning Unmatched roles are reported, not silent
Roles are matched by case-insensitive substring (`add[]` additionally resolves
against the rate card), so an entry naming a role or person the roster does not
carry mutates nothing and yields an all-zero impact. Every mutation below takes
an optional trailing `warnings` array and appends a warning naming what it
failed to match; `executeScenario()` passes the result's `warnings` array into the
mutations it applies. (The one place it does not is `mergeProjectedState()`, which
replays a sub-operation whose warnings the sub-result already carries.)
:::

## Staffing Mutations

### `applyRemove(staffing, remove[], warnings?)`

Remove N people of a specified role from a staffing list.

```typescript
import { applyRemove } from "./engine/index.js";

const updated = applyRemove(staffing, [
  { role: "Senior Developer", count: 1 }
]);
```

---

### `applyAdd(staffing, categories, add[], projectId?, projectName?, warnings?)`

Add N people of a specified role. Requires the labor category rate card to look up rates.

```typescript
import { applyAdd } from "./engine/index.js";

const updated = applyAdd(staffing, categories, [
  { role: "QA Engineer", count: 2, hours_per_week: 40 }
]);
```

---

### `applySwap(staffing, categories, remove[], add[], projectId?, projectName?, warnings?)`

Atomic swap — remove one set of roles and add another in a single operation.

```typescript
import { applySwap } from "./engine/index.js";

const updated = applySwap(
  staffing,
  categories,
  [{ role: "Senior Developer", count: 1 }],
  [{ role: "Mid-level Developer", count: 2 }]
);
```

---

### `applyRateChange(staffing, rate_changes[], warnings?)`

Change bill and/or cost rates for a role. All entries matching a record are
folded in order (later entries override earlier ones per field); when more
than one entry matches a single record, a note is pushed to the optional
`warnings` array.

```typescript
const updated = applyRateChange(staffing, [
  { role: "Senior Developer", new_bill_rate: 250, new_cost_rate: 180 }
]);
```

---

### `applyHoursChange(staffing, hours_changes[], warnings?)`

Change weekly hours for a named person. Matching entries fold the same way
as `applyRateChange`, with the same optional multi-match warning.

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

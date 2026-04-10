# Margin

`server/engine/margin.ts` computes gross margin, contribution margin, and net direct labor multiplier.

## Functions

### `calcProjectMargin(staffing)`

Compute margin metrics directly from a staffing list.

**Input:** `StaffingRecord[]`
**Output:** `MarginMetrics`

```typescript
const margin = calcProjectMargin(staffing);
```

---

### `calcProjectMarginFromLabor(labor)`

Compute margin metrics from pre-calculated labor metrics (avoids recomputation).

**Input:** `LaborMetrics`
**Output:** `MarginMetrics`

```typescript
import { calcProjectLabor, calcProjectMarginFromLabor } from "./engine/index.js";

const labor = calcProjectLabor(staffing);
const margin = calcProjectMarginFromLabor(labor);
// → {
//   margin_pct: 26.7,
//   margin_dollars_monthly: 31176.00,
//   margin_dollars_annual: 374400.00,
//   gross_margin_pct: 26.7,
//   contribution_margin: 31176.00,
//   net_direct_labor_multiplier: 1.36
// }
```

## Formulas

| Metric | Formula |
|--------|---------|
| `margin_pct` | `(revenue − cost) / revenue × 100` |
| `margin_dollars_monthly` | `monthly_revenue − monthly_cost` |
| `margin_dollars_annual` | `annual_revenue − annual_cost` |
| `gross_margin_pct` | Same as `margin_pct` |
| `contribution_margin` | Same as `margin_dollars_monthly` |
| `net_direct_labor_multiplier` | `revenue / cost` |

All divisions use `safeDivide()` to prevent `NaN`/`Infinity`.

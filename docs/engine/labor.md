# Labor

`server/engine/labor.ts` computes per-person and aggregate labor cost/revenue metrics.

## Functions

### `monthlyCost(costRate, hoursPerWeek)`

Calculate monthly cost for one person.

```typescript
import { monthlyCost } from "./engine/index.js";

monthlyCost(165, 40);
// → 165 × 40 × 4.33 = $28,578.00
```

**Formula:** `costRate × hoursPerWeek × WEEKS_PER_MONTH`

---

### `monthlyRevenue(billRate, hoursPerWeek)`

Calculate monthly revenue for one person.

```typescript
monthlyRevenue(225, 40);
// → 225 × 40 × 4.33 = $38,970.00
```

**Formula:** `billRate × hoursPerWeek × WEEKS_PER_MONTH`

---

### `annualCost(costRate, hoursPerWeek)`

```typescript
annualCost(165, 40);
// → 165 × 40 × 52 = $343,200.00
```

**Formula:** `costRate × hoursPerWeek × WEEKS_PER_YEAR`

---

### `annualRevenue(billRate, hoursPerWeek)`

```typescript
annualRevenue(225, 40);
// → 225 × 40 × 52 = $468,000.00
```

**Formula:** `billRate × hoursPerWeek × WEEKS_PER_YEAR`

---

### `calcProjectLabor(staffing)`

Computes aggregate labor metrics for a project from its staffing list.

**Input:** `StaffingRecord[]`
**Output:** `LaborMetrics`

```typescript
const labor = calcProjectLabor(staffing);
// → {
//   monthly_cost: 85734.00,
//   monthly_revenue: 116910.00,
//   annual_cost: 1029600.00,
//   annual_revenue: 1404000.00,
//   blended_cost_rate: 171.60,
//   blended_bill_rate: 200.00,
//   fte_count: 3.0,
//   headcount: 3
// }
```

**Blended rates** are computed using `safeDivide()` to handle edge cases (e.g., zero staffing).

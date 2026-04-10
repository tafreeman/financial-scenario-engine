# Types & Constants

`server/engine/types.ts` is the **single source of truth** for all interfaces and constants used across the engine, routes, and client.

::: danger Do Not Modify Lightly
Changing interfaces in `types.ts` can break the engine, tests, routes, and client simultaneously.
:::

## Constants

| Name | Value | Meaning |
|------|-------|---------|
| `WEEKS_PER_MONTH` | `4.33` | 365.25 / 12 / 7 |
| `HOURS_PER_YEAR` | `2080` | 52 weeks × 40 hours |
| `WORKING_DAYS_PER_MONTH` | `21.67` | 260 / 12 |
| `WEEKS_PER_YEAR` | `52` | — |
| `MONTHS_PER_YEAR` | `12` | — |

## Utility Functions

### `safeDivide(numerator, denominator, fallback?)`

Safe division that returns a fallback (default `0`) instead of `Infinity` or `NaN` on zero denominator.

```typescript
safeDivide(100, 0);     // → 0
safeDivide(100, 0, -1); // → -1
safeDivide(100, 4);     // → 25
```

### `roundDollars(n)`

Round to 2 decimal places (for dollar amounts).

```typescript
roundDollars(1234.5678); // → 1234.57
```

### `roundPct(n)`

Round to 1 decimal place (for percentages).

```typescript
roundPct(28.456); // → 28.5
```

## Input Types

### `LaborCategory`

```typescript
interface LaborCategory {
  id: number;
  name: string;       // e.g. "Senior Developer"
  bill_rate: number;   // $/hr billed to client
  cost_rate: number;   // $/hr internal cost
}
```

### `StaffingRecord`

```typescript
interface StaffingRecord {
  id: number;
  project_id: number;
  project_name: string;
  labor_category_id: number;
  labor_category: string;
  person_name: string | null;
  hours_per_week: number;
  bill_rate: number;
  cost_rate: number;
  is_active: number; // 0 | 1
}
```

### `Project`

```typescript
interface Project {
  id: number;
  name: string;
  total_budget: number;
  spent_to_date: number;
  start_date: string;
  end_date: string;
  status: string;
}
```

### `ProjectSnapshot`

Extends `Project` with staffing data:

```typescript
interface ProjectSnapshot extends Project {
  staffing: StaffingRecord[];
}
```

### `PortfolioSnapshot`

```typescript
interface PortfolioSnapshot {
  projects: ProjectSnapshot[];
  labor_categories: LaborCategory[];
}
```

## Scenario Operation

The LLM-produced intent — a structured JSON describing what the user wants to analyze:

```typescript
interface ScenarioOperation {
  action:
    | "swap" | "add" | "remove"
    | "rate_change" | "hours_change"
    | "timeline_extension" | "unexpected_cost"
    | "reallocation"
    | "burn_rate_check" | "margin_analysis" | "evm_analysis"
    | "what_if_composite";

  project?: string;
  projects?: string[];

  remove?: { role: string; count: number; person_name?: string }[];
  add?: { role: string; count: number; hours_per_week?: number }[];
  rate_changes?: { role: string; new_bill_rate?: number; new_cost_rate?: number }[];
  hours_changes?: { person_name: string; new_hours_per_week: number }[];

  new_end_date?: string;
  extension_months?: number;

  additional_costs?: {
    description: string;
    amount: number;
    is_recurring: boolean;
    frequency_months?: number;
  }[];

  sub_operations?: ScenarioOperation[];
}
```

## Result Types

### `LaborMetrics`

```typescript
interface LaborMetrics {
  monthly_cost: number;
  monthly_revenue: number;
  annual_cost: number;
  annual_revenue: number;
  blended_cost_rate: number;
  blended_bill_rate: number;
  fte_count: number;
  headcount: number;
}
```

### `MarginMetrics`

```typescript
interface MarginMetrics {
  margin_pct: number;
  margin_dollars_monthly: number;
  margin_dollars_annual: number;
  gross_margin_pct: number;
  contribution_margin: number;
  net_direct_labor_multiplier: number;
}
```

### `BudgetMetrics`

```typescript
interface BudgetMetrics {
  monthly_burn_rate: number;
  remaining_budget: number;
  months_remaining: number;
  budget_exhaustion_date: string;
  annual_run_rate: number;
}
```

### `EvmMetrics`

```typescript
interface EvmMetrics {
  bac: number;   // Budget at Completion
  ac: number;    // Actual Cost
  pv: number;    // Planned Value
  ev: number;    // Earned Value
  cpi: number;   // Cost Performance Index
  spi: number;   // Schedule Performance Index
  cv: number;    // Cost Variance
  sv: number;    // Schedule Variance
  eac_typical: number;   // BAC / CPI
  eac_atypical: number;  // AC + (BAC - EV)
  eac_mixed: number;     // AC + (BAC - EV) / (CPI × SPI)
  etc: number;           // EAC - AC
  vac: number;           // BAC - EAC
  tcpi: number;          // (BAC - EV) / (BAC - AC)
}
```

### `ScenarioImpact`

```typescript
interface ScenarioImpact {
  cost_delta_monthly: number;
  cost_delta_annual: number;
  revenue_delta_monthly: number;
  revenue_delta_annual: number;
  margin_delta_pct: number;
  margin_delta_dollars_monthly: number;
  burn_rate_delta: number;
  burn_rate_delta_pct: number;
  months_remaining_delta: number;
  headcount_delta: number;
  fte_delta: number;
}
```

### `ScenarioResult`

The full output envelope returned by `executeScenario()`:

```typescript
interface ScenarioResult {
  operation: ScenarioOperation;
  timestamp: string;
  project_name?: string;
  projects_involved: string[];
  current: { labor: LaborMetrics; margin: MarginMetrics; budget: BudgetMetrics };
  projected?: { labor: LaborMetrics; margin: MarginMetrics; budget: BudgetMetrics };
  impact?: ScenarioImpact;
  evm?: EvmMetrics;
  utilization?: UtilizationMetrics;
  portfolio?: {
    total_burn: number;
    total_margin_pct: number;
    total_margin_dollars: number;
    project_summaries: ProjectSummary[];
  };
  warnings: string[];
  sub_results?: ScenarioResult[];
}
```

### `V2Response`

The API response shape for `/api/scenario/v2`:

```typescript
interface V2Response {
  engine: ScenarioResult;
  narrative: string;
  model: string;
  tokensUsed?: number;
  error?: string;
}
```

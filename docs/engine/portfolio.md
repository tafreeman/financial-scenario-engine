# Portfolio

`server/engine/portfolio.ts` provides portfolio-level aggregation across multiple projects.

## Functions

### `calcPortfolioMetrics(projects)`

Aggregate metrics across all projects in the portfolio.

**Input:** `ProjectSnapshot[]`
**Output:** Portfolio totals + `ProjectSummary[]`

```typescript
import { calcPortfolioMetrics } from "./engine/index.js";

const portfolio = calcPortfolioMetrics(projects);
// → {
//   total_burn: 185000,
//   total_margin_pct: 28.5,
//   total_margin_dollars: 52750,
//   project_summaries: [
//     { name: "Alpha", monthly_burn: 62500, margin_pct: 26.7, months_remaining: 12.8 },
//     { name: "Beta",  monthly_burn: 87500, margin_pct: 31.2, months_remaining: 18.3 },
//     { name: "Gamma", monthly_burn: 35000, margin_pct: 24.1, months_remaining: 8.5 }
//   ]
// }
```

## `ProjectSummary` Interface

```typescript
interface ProjectSummary {
  name: string;
  monthly_burn: number;
  margin_pct: number;
  months_remaining: number;
}
```

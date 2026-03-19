import {
  safeDivide,
  type ProjectSnapshot,
  type StaffingRecord,
  type LaborMetrics,
  type ProjectSummary,
} from "./types.js";
import { calcProjectLabor, monthlyCost, monthlyRevenue } from "./labor.js";
import { calcProjectMarginFromLabor } from "./margin.js";
import { calcRemainingBudget, calcMonthsRemaining } from "./budget.js";

// ─── Portfolio Aggregation ───────────────────────────────────────────────────

/** Compute labor once per project and return all portfolio metrics in a single pass */
export function calcPortfolioMetrics(projects: ProjectSnapshot[]): {
  total_burn: number;
  total_margin_pct: number;
  total_margin_dollars: number;
  total_revenue: number;
  total_cost: number;
  project_summaries: ProjectSummary[];
} {
  let totalRevenue = 0;
  let totalCost = 0;
  const summaries: ProjectSummary[] = [];

  for (const p of projects) {
    const labor = calcProjectLabor(p.staffing);
    const margin = calcProjectMarginFromLabor(labor);
    const remaining = calcRemainingBudget(p.total_budget, p.spent_to_date);
    const monthsLeft = calcMonthsRemaining(remaining, labor.monthly_cost);

    totalRevenue += labor.monthly_revenue;
    totalCost += labor.monthly_cost;

    summaries.push({
      name: p.name,
      monthly_burn: labor.monthly_cost,
      margin_pct: margin.margin_pct,
      months_remaining: monthsLeft,
    });
  }

  return {
    total_burn: totalCost,
    total_margin_pct: safeDivide(totalRevenue - totalCost, totalRevenue) * 100,
    total_margin_dollars: totalRevenue - totalCost,
    total_revenue: totalRevenue,
    total_cost: totalCost,
    project_summaries: summaries,
  };
}

/** Sum of monthly burn across all projects */
export function calcPortfolioBurn(projects: ProjectSnapshot[]): number {
  return calcPortfolioMetrics(projects).total_burn;
}

/** Portfolio-level margin weighted by revenue */
export function calcPortfolioMargin(projects: ProjectSnapshot[]): {
  total_margin_pct: number;
  total_margin_dollars: number;
  total_revenue: number;
  total_cost: number;
} {
  const m = calcPortfolioMetrics(projects);
  return {
    total_margin_pct: m.total_margin_pct,
    total_margin_dollars: m.total_margin_dollars,
    total_revenue: m.total_revenue,
    total_cost: m.total_cost,
  };
}

/** Summary for each project in the portfolio */
export function calcProjectSummaries(projects: ProjectSnapshot[]): ProjectSummary[] {
  return calcPortfolioMetrics(projects).project_summaries;
}

// ─── Resource Reallocation ───────────────────────────────────────────────────

/** Cost of unassigned/bench resources — pure cost, $0 revenue */
export function calcBenchCost(benchStaffing: StaffingRecord[]): {
  bench_count: number;
  bench_cost_monthly: number;
  bench_cost_annual: number;
} {
  const benchCostMonthly = benchStaffing.reduce(
    (sum, s) => sum + monthlyCost(s.cost_rate, s.hours_per_week),
    0
  );

  return {
    bench_count: benchStaffing.length,
    bench_cost_monthly: benchCostMonthly,
    bench_cost_annual: benchCostMonthly * 12,
  };
}

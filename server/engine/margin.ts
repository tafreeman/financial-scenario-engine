import {
  WEEKS_PER_MONTH,
  safeDivide,
  type StaffingRecord,
  type LaborMetrics,
  type MarginMetrics,
} from "./types.js";
import { calcProjectLabor } from "./labor.js";

// ─── Per-Person Margin ───────────────────────────────────────────────────────

/** (bill_rate - cost_rate) / bill_rate × 100 */
export function calcPersonMarginPct(billRate: number, costRate: number): number {
  return safeDivide((billRate - costRate), billRate) * 100;
}

/** (bill_rate - cost_rate) × hours_per_week × WEEKS_PER_MONTH */
export function calcPersonMarginDollars(
  billRate: number,
  costRate: number,
  hoursPerWeek: number
): number {
  return (billRate - costRate) * hoursPerWeek * WEEKS_PER_MONTH;
}

// ─── Project-Level Margin ────────────────────────────────────────────────────

/** (total_revenue - total_cost) / total_revenue × 100 */
export function calcGrossMarginPct(totalRevenue: number, totalCost: number): number {
  return safeDivide((totalRevenue - totalCost), totalRevenue) * 100;
}

/** revenue - direct_costs */
export function calcContributionMargin(revenue: number, directCosts: number): number {
  return revenue - directCosts;
}

/** revenue / total_direct_labor_cost — healthy range: 2.5x-3.5x */
export function calcLaborMultiplier(revenue: number, totalDirectLaborCost: number): number {
  return safeDivide(revenue, totalDirectLaborCost);
}

/** Full margin metrics from pre-computed labor (avoids redundant calcProjectLabor) */
export function calcProjectMarginFromLabor(labor: LaborMetrics): MarginMetrics {
  const margin_pct = calcGrossMarginPct(labor.monthly_revenue, labor.monthly_cost);
  const margin_dollars_monthly = labor.monthly_revenue - labor.monthly_cost;
  const margin_dollars_annual = labor.annual_revenue - labor.annual_cost;
  const gross_margin_pct = margin_pct; // same at direct-labor level
  const contribution_margin = calcContributionMargin(labor.monthly_revenue, labor.monthly_cost);
  const net_direct_labor_multiplier = calcLaborMultiplier(
    labor.monthly_revenue,
    labor.monthly_cost
  );

  return {
    margin_pct,
    margin_dollars_monthly,
    margin_dollars_annual,
    gross_margin_pct,
    contribution_margin,
    net_direct_labor_multiplier,
  };
}

/** Full margin metrics for a set of staffing records (convenience wrapper) */
export function calcProjectMargin(staffing: StaffingRecord[]): MarginMetrics {
  return calcProjectMarginFromLabor(calcProjectLabor(staffing));
}

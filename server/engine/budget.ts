import {
  MONTHS_PER_YEAR,
  safeDivide,
  type Project,
  type BudgetMetrics,
} from "./types.js";

// ─── Core Budget Calculations ────────────────────────────────────────────────

/** total_budget - spent_to_date */
export function calcRemainingBudget(totalBudget: number, spentToDate: number): number {
  return totalBudget - spentToDate;
}

/** remaining_budget / monthly_burn */
export function calcMonthsRemaining(remainingBudget: number, monthlyBurn: number): number {
  return safeDivide(remainingBudget, monthlyBurn);
}

/** Add months_remaining to a reference date, return ISO date string */
export function calcExhaustionDate(monthsRemaining: number, fromDate?: Date): string {
  const base = fromDate ?? new Date();
  if (monthsRemaining <= 0 || !Number.isFinite(monthsRemaining)) {
    return monthsRemaining <= 0 ? "exhausted" : "N/A";
  }
  const wholeMonths = Math.floor(monthsRemaining);
  const fractionalDays = (monthsRemaining - wholeMonths) * 30; // approximate
  const exhaustion = new Date(base);
  exhaustion.setMonth(exhaustion.getMonth() + wholeMonths);
  exhaustion.setDate(exhaustion.getDate() + Math.round(fractionalDays));
  return exhaustion.toISOString().split("T")[0];
}

// ─── Variance ────────────────────────────────────────────────────────────────

/** planned_spend - actual_spend (positive = under budget) */
export function calcBudgetVariance(plannedSpend: number, actualSpend: number): number {
  return plannedSpend - actualSpend;
}

/** (planned - actual) / planned × 100 */
export function calcBudgetVariancePct(plannedSpend: number, actualSpend: number): number {
  return safeDivide((plannedSpend - actualSpend), plannedSpend) * 100;
}

// ─── Run Rate ────────────────────────────────────────────────────────────────

/** monthly_burn × 12 */
export function calcAnnualRunRate(monthlyBurn: number): number {
  return monthlyBurn * MONTHS_PER_YEAR;
}

/** (after_burn - before_burn) */
export function calcBurnRateDelta(beforeBurn: number, afterBurn: number): number {
  return afterBurn - beforeBurn;
}

/** (after_burn - before_burn) / before_burn × 100 */
export function calcBurnRateDeltaPct(beforeBurn: number, afterBurn: number): number {
  return safeDivide((afterBurn - beforeBurn), beforeBurn) * 100;
}

// ─── Full Budget Metrics ─────────────────────────────────────────────────────

/** Assemble complete budget metrics from project data + current burn rate */
export function calcBudgetMetrics(project: Project, monthlyBurn: number): BudgetMetrics {
  const remaining = calcRemainingBudget(project.total_budget, project.spent_to_date);
  const monthsLeft = calcMonthsRemaining(remaining, monthlyBurn);

  return {
    monthly_burn_rate: monthlyBurn,
    remaining_budget: remaining,
    months_remaining: monthsLeft,
    budget_exhaustion_date: calcExhaustionDate(monthsLeft),
    annual_run_rate: calcAnnualRunRate(monthlyBurn),
  };
}

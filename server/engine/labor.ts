import {
  WEEKS_PER_MONTH,
  WEEKS_PER_YEAR,
  safeDivide,
  type StaffingRecord,
  type LaborMetrics,
} from "./types.js";

// ─── Per-Person Calculations ─────────────────────────────────────────────────

/** cost_rate × hours_per_week × WEEKS_PER_MONTH */
export function monthlyCost(costRate: number, hoursPerWeek: number): number {
  return costRate * hoursPerWeek * WEEKS_PER_MONTH;
}

/** bill_rate × hours_per_week × WEEKS_PER_MONTH */
export function monthlyRevenue(billRate: number, hoursPerWeek: number): number {
  return billRate * hoursPerWeek * WEEKS_PER_MONTH;
}

/** cost_rate × hours_per_week × 52 */
export function annualCost(costRate: number, hoursPerWeek: number): number {
  return costRate * hoursPerWeek * WEEKS_PER_YEAR;
}

/** bill_rate × hours_per_week × 52 */
export function annualRevenue(billRate: number, hoursPerWeek: number): number {
  return billRate * hoursPerWeek * WEEKS_PER_YEAR;
}

/** base_cost × overhead_multiplier */
export function loadedCost(baseCost: number, overheadMultiplier: number): number {
  return baseCost * overheadMultiplier;
}

/** hours_per_week / 40 */
export function fte(hoursPerWeek: number): number {
  return hoursPerWeek / 40;
}

// ─── Aggregate Calculations ──────────────────────────────────────────────────

/** Σ(cost_rate × hours_per_week) / Σ(hours_per_week) */
export function calcBlendedCostRate(staffing: StaffingRecord[]): number {
  const totalWeightedCost = staffing.reduce(
    (sum, s) => sum + s.cost_rate * s.hours_per_week,
    0
  );
  const totalHours = staffing.reduce((sum, s) => sum + s.hours_per_week, 0);
  return safeDivide(totalWeightedCost, totalHours);
}

/** Σ(bill_rate × hours_per_week) / Σ(hours_per_week) */
export function calcBlendedBillRate(staffing: StaffingRecord[]): number {
  const totalWeightedBill = staffing.reduce(
    (sum, s) => sum + s.bill_rate * s.hours_per_week,
    0
  );
  const totalHours = staffing.reduce((sum, s) => sum + s.hours_per_week, 0);
  return safeDivide(totalWeightedBill, totalHours);
}

/** Σ(hours_per_week) / 40 */
export function calcTotalFTE(staffing: StaffingRecord[]): number {
  return staffing.reduce((sum, s) => sum + s.hours_per_week, 0) / 40;
}

/** Full labor metrics for a set of staffing records (single-pass) */
export function calcProjectLabor(staffing: StaffingRecord[]): LaborMetrics {
  let mCost = 0, mRev = 0, aCost = 0, aRev = 0;
  let totalWeightedCost = 0, totalWeightedBill = 0, totalHours = 0;

  for (const s of staffing) {
    const h = s.hours_per_week;
    mCost += s.cost_rate * h * WEEKS_PER_MONTH;
    mRev  += s.bill_rate * h * WEEKS_PER_MONTH;
    aCost += s.cost_rate * h * WEEKS_PER_YEAR;
    aRev  += s.bill_rate * h * WEEKS_PER_YEAR;
    totalWeightedCost += s.cost_rate * h;
    totalWeightedBill += s.bill_rate * h;
    totalHours += h;
  }

  return {
    monthly_cost: mCost,
    monthly_revenue: mRev,
    annual_cost: aCost,
    annual_revenue: aRev,
    blended_cost_rate: safeDivide(totalWeightedCost, totalHours),
    blended_bill_rate: safeDivide(totalWeightedBill, totalHours),
    fte_count: totalHours / 40,
    headcount: staffing.length,
  };
}

import {
  safeDivide,
  type StaffingRecord,
  type UtilizationMetrics,
} from "./types.js";

// ─── Individual Calculations ─────────────────────────────────────────────────

/** billable_hours / available_hours × 100 — target: 75-85% for consultants */
export function calcUtilizationRate(billableHours: number, availableHours: number): number {
  return safeDivide(billableHours, availableHours) * 100;
}

/** total_revenue / total_billable_hours */
export function calcEffectiveBillRate(totalRevenue: number, totalBillableHours: number): number {
  return safeDivide(totalRevenue, totalBillableHours);
}

/** total_revenue / billable_headcount */
export function calcRevenuePerEmployee(totalRevenue: number, headcount: number): number {
  return safeDivide(totalRevenue, headcount);
}

/** cost_rate / bill_rate × 100 — if > 70%, structural cost problem */
export function calcBreakEvenUtilization(costRate: number, billRate: number): number {
  return safeDivide(costRate, billRate) * 100;
}

// ─── Aggregate Utilization ───────────────────────────────────────────────────

/**
 * Calculate utilization metrics for a set of staffing records.
 * Assumes all staffing hours are billable (since the app tracks billable assignments).
 * availableHoursPerPerson defaults to 40 hrs/week.
 */
export function calcUtilization(
  staffing: StaffingRecord[],
  availableHoursPerPerson: number = 40
): UtilizationMetrics {
  if (staffing.length === 0) {
    return {
      utilization_rate: 0,
      effective_bill_rate: 0,
      revenue_per_employee: 0,
      break_even_utilization: 0,
    };
  }

  const totalBillableHours = staffing.reduce((sum, s) => sum + s.hours_per_week, 0);
  const totalAvailableHours = staffing.length * availableHoursPerPerson;
  const totalWeeklyRevenue = staffing.reduce(
    (sum, s) => sum + s.bill_rate * s.hours_per_week,
    0
  );
  const totalWeeklyCost = staffing.reduce(
    (sum, s) => sum + s.cost_rate * s.hours_per_week,
    0
  );

  // Weighted averages for break-even calculation
  const avgCostRate = safeDivide(totalWeeklyCost, totalBillableHours);
  const avgBillRate = safeDivide(totalWeeklyRevenue, totalBillableHours);

  return {
    utilization_rate: calcUtilizationRate(totalBillableHours, totalAvailableHours),
    effective_bill_rate: calcEffectiveBillRate(totalWeeklyRevenue, totalBillableHours),
    revenue_per_employee: calcRevenuePerEmployee(totalWeeklyRevenue, staffing.length),
    break_even_utilization: calcBreakEvenUtilization(avgCostRate, avgBillRate),
  };
}

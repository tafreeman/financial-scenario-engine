import {
  WEEKS_PER_MONTH,
  safeDivide,
  type ScenarioOperation,
  type ScenarioImpact,
  type StaffingRecord,
  type LaborCategory,
  type LaborMetrics,
  type MarginMetrics,
  type BudgetMetrics,
  type ProjectSnapshot,
} from "./types.js";
import { calcProjectLabor, monthlyCost } from "./labor.js";
import { calcProjectMargin } from "./margin.js";
import { calcBudgetMetrics, calcRemainingBudget } from "./budget.js";
import { fuzzyMatch, ROLE_ABBREVIATIONS } from "./matching.js";

// ─── Staffing Mutation Functions ─────────────────────────────────────────────
// Each returns a NEW array — does not modify the input.

/** Remove staff matching role (and optionally person_name) from a staffing array */
export function applyRemove(
  staffing: StaffingRecord[],
  remove: ScenarioOperation["remove"]
): StaffingRecord[] {
  if (!remove || remove.length === 0) return [...staffing];

  const result = [...staffing];
  for (const spec of remove) {
    let remaining = spec.count;
    for (let i = result.length - 1; i >= 0 && remaining > 0; i--) {
      const s = result[i];
      const roleMatch = s.labor_category.toLowerCase().includes(spec.role.toLowerCase());
      const nameMatch = !spec.person_name ||
        (s.person_name ?? "").toLowerCase().includes(spec.person_name.toLowerCase());
      if (roleMatch && nameMatch) {
        result.splice(i, 1);
        remaining--;
      }
    }
  }
  return result;
}

/** Add synthetic staffing records for new roles */
export function applyAdd(
  staffing: StaffingRecord[],
  categories: LaborCategory[],
  add: ScenarioOperation["add"],
  projectId: number = 0,
  projectName: string = ""
): StaffingRecord[] {
  if (!add || add.length === 0) return [...staffing];

  const result = [...staffing];
  let nextId = Math.max(0, ...staffing.map(s => s.id)) + 1;

  for (const spec of add) {
    const cat = findCategory(categories, spec.role);
    if (!cat) continue;

    for (let i = 0; i < spec.count; i++) {
      result.push({
        id: nextId++,
        project_id: projectId,
        project_name: projectName,
        labor_category_id: cat.id,
        labor_category: cat.name,
        person_name: null,
        hours_per_week: spec.hours_per_week ?? 40,
        bill_rate: cat.bill_rate,
        cost_rate: cat.cost_rate,
        is_active: 1,
      });
    }
  }
  return result;
}

/** Remove then add (swap operation) */
export function applySwap(
  staffing: StaffingRecord[],
  categories: LaborCategory[],
  remove: ScenarioOperation["remove"],
  add: ScenarioOperation["add"],
  projectId: number = 0,
  projectName: string = ""
): StaffingRecord[] {
  const afterRemove = applyRemove(staffing, remove);
  return applyAdd(afterRemove, categories, add, projectId, projectName);
}

/** Apply rate changes to matching staffing records */
export function applyRateChange(
  staffing: StaffingRecord[],
  rateChanges: ScenarioOperation["rate_changes"]
): StaffingRecord[] {
  if (!rateChanges || rateChanges.length === 0) return [...staffing];

  return staffing.map(s => {
    for (const change of rateChanges) {
      if (s.labor_category.toLowerCase().includes(change.role.toLowerCase())) {
        return {
          ...s,
          bill_rate: change.new_bill_rate ?? s.bill_rate,
          cost_rate: change.new_cost_rate ?? s.cost_rate,
        };
      }
    }
    return { ...s };
  });
}

/** Apply hours changes to matching staffing records by person name */
export function applyHoursChange(
  staffing: StaffingRecord[],
  hoursChanges: ScenarioOperation["hours_changes"]
): StaffingRecord[] {
  if (!hoursChanges || hoursChanges.length === 0) return [...staffing];

  return staffing.map(s => {
    for (const change of hoursChanges) {
      if ((s.person_name ?? "").toLowerCase().includes(change.person_name.toLowerCase())) {
        return { ...s, hours_per_week: change.new_hours_per_week };
      }
    }
    return { ...s };
  });
}

// ─── Timeline & Cost Impact ──────────────────────────────────────────────────

/** Calculate impact of extending a project timeline */
export function calcTimelineExtensionImpact(
  project: ProjectSnapshot,
  monthlyBurn: number,
  extensionMonths?: number,
  newEndDate?: string
): {
  new_end_date: string;
  additional_months: number;
  additional_cost: number;
  new_total_projected: number;
  budget_gap: number;
} {
  const oldEnd = new Date(project.end_date);
  let additionalMonths: number;
  let newEnd: Date;

  if (extensionMonths !== undefined) {
    additionalMonths = extensionMonths;
    newEnd = new Date(oldEnd);
    newEnd.setMonth(newEnd.getMonth() + extensionMonths);
  } else if (newEndDate) {
    newEnd = new Date(newEndDate);
    additionalMonths = (newEnd.getTime() - oldEnd.getTime()) / (30.44 * 24 * 60 * 60 * 1000);
  } else {
    return {
      new_end_date: project.end_date,
      additional_months: 0,
      additional_cost: 0,
      new_total_projected: project.spent_to_date,
      budget_gap: 0,
    };
  }

  const additional_cost = monthlyBurn * additionalMonths;
  const remaining = calcRemainingBudget(project.total_budget, project.spent_to_date);
  // Calculate total months remaining from now to new end
  const now = new Date();
  const remainingMonthsNew = (newEnd.getTime() - now.getTime()) / (30.44 * 24 * 60 * 60 * 1000);
  const new_total_projected = project.spent_to_date + monthlyBurn * Math.max(0, remainingMonthsNew);
  const budget_gap = new_total_projected - project.total_budget;

  return {
    new_end_date: newEnd.toISOString().split("T")[0],
    additional_months: additionalMonths,
    additional_cost,
    new_total_projected,
    budget_gap,
  };
}

/** Calculate impact of unexpected/new costs */
export function calcUnexpectedCostImpact(
  project: ProjectSnapshot,
  monthlyBurn: number,
  costs: ScenarioOperation["additional_costs"]
): {
  total_one_time: number;
  total_recurring_monthly: number;
  impact_on_remaining: number;
  new_months_remaining: number;
} {
  if (!costs || costs.length === 0) {
    const remaining = calcRemainingBudget(project.total_budget, project.spent_to_date);
    return {
      total_one_time: 0,
      total_recurring_monthly: 0,
      impact_on_remaining: 0,
      new_months_remaining: safeDivide(remaining, monthlyBurn),
    };
  }

  let totalOneTime = 0;
  let totalRecurringMonthly = 0;

  for (const cost of costs) {
    if (cost.is_recurring) {
      const monthlyAmount = safeDivide(cost.amount, cost.frequency_months ?? 1);
      totalRecurringMonthly += monthlyAmount;
    } else {
      totalOneTime += cost.amount;
    }
  }

  const remaining = calcRemainingBudget(project.total_budget, project.spent_to_date) - totalOneTime;
  const newBurn = monthlyBurn + totalRecurringMonthly;
  const newMonthsRemaining = safeDivide(remaining, newBurn);

  return {
    total_one_time: totalOneTime,
    total_recurring_monthly: totalRecurringMonthly,
    impact_on_remaining: totalOneTime + totalRecurringMonthly * Math.max(0, newMonthsRemaining),
    new_months_remaining: newMonthsRemaining,
  };
}

// ─── Impact Calculation ──────────────────────────────────────────────────────

/** Compute the delta between before and after states */
export function calcScenarioImpact(
  before: { labor: LaborMetrics; margin: MarginMetrics; budget: BudgetMetrics },
  after: { labor: LaborMetrics; margin: MarginMetrics; budget: BudgetMetrics }
): ScenarioImpact {
  return {
    cost_delta_monthly: after.labor.monthly_cost - before.labor.monthly_cost,
    cost_delta_annual: after.labor.annual_cost - before.labor.annual_cost,
    revenue_delta_monthly: after.labor.monthly_revenue - before.labor.monthly_revenue,
    revenue_delta_annual: after.labor.annual_revenue - before.labor.annual_revenue,
    margin_delta_pct: after.margin.margin_pct - before.margin.margin_pct,
    margin_delta_dollars_monthly: after.margin.margin_dollars_monthly - before.margin.margin_dollars_monthly,
    burn_rate_delta: after.budget.monthly_burn_rate - before.budget.monthly_burn_rate,
    burn_rate_delta_pct: safeDivide(
      after.budget.monthly_burn_rate - before.budget.monthly_burn_rate,
      before.budget.monthly_burn_rate
    ) * 100,
    months_remaining_delta: after.budget.months_remaining - before.budget.months_remaining,
    headcount_delta: after.labor.headcount - before.labor.headcount,
    fte_delta: after.labor.fte_count - before.labor.fte_count,
  };
}

// ─── Helper ──────────────────────────────────────────────────────────────────

/** Find a labor category by fuzzy name match */
function findCategory(categories: LaborCategory[], roleName: string): LaborCategory | undefined {
  return fuzzyMatch(roleName, categories, c => c.name, ROLE_ABBREVIATIONS) ?? undefined;
}

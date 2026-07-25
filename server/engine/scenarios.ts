import {
  DAYS_PER_MONTH,
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
import { calcRemainingBudget } from "./budget.js";
import { fuzzyMatch, ROLE_ABBREVIATIONS } from "./matching.js";

// ─── Staffing Mutation Functions ─────────────────────────────────────────────
// Each returns a NEW array — does not modify the input.

/** Remove staff matching role (and optionally person_name) from a staffing array.
 *
 *  @param warnings - When supplied, a spec that matches no staffing record at all
 *  pushes a warning naming the role.  Role matching is substring-based, so a role
 *  the roster does not carry (or a mis-transcribed one) otherwise removes nobody
 *  and still reports a clean all-zero impact — indistinguishable, to the reader,
 *  from "this change genuinely costs nothing". */
export function applyRemove(
  staffing: StaffingRecord[],
  remove: ScenarioOperation["remove"],
  warnings?: string[]
): StaffingRecord[] {
  if (!remove || remove.length === 0) return [...staffing];

  const result = [...staffing];
  for (const spec of remove) {
    let remaining = spec.count;
    for (let i = result.length - 1; i >= 0 && remaining > 0; i--) {
      const s: StaffingRecord | undefined = result[i];
      if (!s) continue;
      const nameMatch = !spec.person_name || matchesPerson(s, spec.person_name);
      if (matchesRole(s, spec.role) && nameMatch) {
        result.splice(i, 1);
        remaining--;
      }
    }
    // remaining === spec.count means the inner loop never found a match.
    if (remaining === spec.count) {
      warnings?.push(`No staff matched ${describeStaffSpec(spec.role, spec.person_name)}; nothing was removed.`);
    } else if (remaining > 0) {
      // A partial match is the same defect one degree weaker: "remove 3 seniors"
      // when the roster holds 1 removes that one and reports the saving from a
      // single departure as though the whole request had been honoured.
      warnings?.push(
        `Only ${spec.count - remaining} of ${spec.count} matched ` +
        `${describeStaffSpec(spec.role, spec.person_name)}; the remaining ${remaining} were not removed.`
      );
    }
  }
  return result;
}

/** Add synthetic staffing records for new roles.
 *
 *  @param warnings - When supplied, a role that resolves to no rate-card category
 *  pushes a warning naming it.  Such an entry adds nobody, so without the warning
 *  the operation reports a zero impact as though the addition were free. */
export function applyAdd(
  staffing: StaffingRecord[],
  categories: LaborCategory[],
  add: ScenarioOperation["add"],
  projectId: number = 0,
  projectName: string = "",
  warnings?: string[]
): StaffingRecord[] {
  if (!add || add.length === 0) return [...staffing];

  const result = [...staffing];
  let nextId = Math.max(0, ...staffing.map(s => s.id)) + 1;

  for (const spec of add) {
    const cat = findCategory(categories, spec.role);
    if (!cat) {
      warnings?.push(`No rate-card role matched "${spec.role}"; no staff were added.`);
      continue;
    }

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

/** Remove then add (swap operation).
 *
 *  @param warnings - Threaded into both halves, so a swap naming an unmatched
 *  role on either side reports it rather than silently doing half (or none) of
 *  the requested change. */
export function applySwap(
  staffing: StaffingRecord[],
  categories: LaborCategory[],
  remove: ScenarioOperation["remove"],
  add: ScenarioOperation["add"],
  projectId: number = 0,
  projectName: string = "",
  warnings?: string[]
): StaffingRecord[] {
  const afterRemove = applyRemove(staffing, remove, warnings);
  return applyAdd(afterRemove, categories, add, projectId, projectName, warnings);
}

/** Apply rate changes to matching staffing records.
 *
 *  All entries whose role substring-matches a record are folded into that
 *  record in order; later entries override earlier ones for the same field
 *  (a broad "Developer" bill-rate change and a narrow "Senior Developer"
 *  cost-rate change on the same record both take effect). */
export function applyRateChange(
  staffing: StaffingRecord[],
  rateChanges: ScenarioOperation["rate_changes"],
  warnings?: string[]
): StaffingRecord[] {
  if (!rateChanges || rateChanges.length === 0) return [...staffing];

  // An entry whose role matches no record changes no rates, yet the operation
  // still returns a clean all-zero impact — report it instead.
  if (warnings) {
    for (const change of rateChanges) {
      if (!staffing.some(s => matchesRole(s, change.role))) {
        warnings.push(`No staff matched "${change.role}"; no rates were changed.`);
      }
    }
  }

  return staffing.map(s => {
    const matches = rateChanges.filter(change => matchesRole(s, change.role));
    if (matches.length > 1 && warnings) {
      warnings.push(`Multiple rate changes matched "${s.labor_category}"; applied in order (later entries override earlier ones per field).`);
    }
    return matches.reduce<StaffingRecord>(
      (acc, change) => ({
        ...acc,
        bill_rate: change.new_bill_rate ?? acc.bill_rate,
        cost_rate: change.new_cost_rate ?? acc.cost_rate,
      }),
      { ...s }
    );
  });
}

/** Apply hours changes to matching staffing records by person name.
 *
 *  All entries whose person_name substring-matches a record are folded into
 *  that record in order; the last matching entry wins. */
export function applyHoursChange(
  staffing: StaffingRecord[],
  hoursChanges: ScenarioOperation["hours_changes"],
  warnings?: string[]
): StaffingRecord[] {
  if (!hoursChanges || hoursChanges.length === 0) return [...staffing];

  // Same no-match reporting as applyRateChange: an unmatched person name leaves
  // every record's hours untouched and reports a zero impact.
  if (warnings) {
    for (const change of hoursChanges) {
      if (!staffing.some(s => matchesPerson(s, change.person_name))) {
        warnings.push(`No staff matched person "${change.person_name}"; no hours were changed.`);
      }
    }
  }

  return staffing.map(s => {
    const matches = hoursChanges.filter(change => matchesPerson(s, change.person_name));
    if (matches.length > 1 && warnings) {
      warnings.push(`Multiple hours changes matched "${s.person_name ?? ""}"; applied in order (last entry wins).`);
    }
    return matches.reduce<StaffingRecord>(
      (acc, change) => ({ ...acc, hours_per_week: change.new_hours_per_week }),
      { ...s }
    );
  });
}

// ─── Timeline & Cost Impact ──────────────────────────────────────────────────

/** Calculate impact of extending a project timeline.
 *
 *  @param asOfDate - The reference date for "now" when computing remaining months.
 *  Defaults to the current wall-clock time when omitted.  Pass an explicit date
 *  in tests and deterministic contexts to make outputs independent of wall-clock time.
 */
export function calcTimelineExtensionImpact(
  project: ProjectSnapshot,
  monthlyBurn: number,
  extensionMonths?: number,
  newEndDate?: string,
  asOfDate?: Date
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
    // Defense-in-depth: the boundary schema (validation.ts) rejects a malformed
    // new_end_date, but a direct call bypasses it. An Invalid Date would make the
    // newEnd.toISOString() below throw RangeError, so treat it as no extension.
    if (Number.isNaN(newEnd.getTime())) {
      return {
        new_end_date: project.end_date,
        additional_months: 0,
        additional_cost: 0,
        new_total_projected: project.spent_to_date,
        budget_gap: 0,
      };
    }
    additionalMonths = (newEnd.getTime() - oldEnd.getTime()) / (DAYS_PER_MONTH * 24 * 60 * 60 * 1000);
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
  const _remaining = calcRemainingBudget(project.total_budget, project.spent_to_date);
  // Calculate total months remaining from asOfDate to new end
  const now = asOfDate ?? new Date();
  const remainingMonthsNew = (newEnd.getTime() - now.getTime()) / (DAYS_PER_MONTH * 24 * 60 * 60 * 1000);
  const new_total_projected = project.spent_to_date + monthlyBurn * Math.max(0, remainingMonthsNew);
  const budget_gap = new_total_projected - project.total_budget;

  return {
    new_end_date: newEnd.toISOString().split("T")[0] ?? newEnd.toISOString().slice(0, 10),
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

// The three mutation functions above all target records the same way — a
// case-insensitive substring test against the record's labor category or person
// name.  They share these two predicates so the "did anything match?" check that
// drives the no-match warnings can never drift from the matching that actually
// decides which records are mutated.

/** Case-insensitive substring match of a spec role against a record's labor category */
function matchesRole(record: StaffingRecord, role: string): boolean {
  return record.labor_category.toLowerCase().includes(role.toLowerCase());
}

/** Case-insensitive substring match of a spec person name against a record's person */
function matchesPerson(record: StaffingRecord, personName: string): boolean {
  return (record.person_name ?? "").toLowerCase().includes(personName.toLowerCase());
}

/** Render a removal spec's role (plus person, when narrowed to one) for a warning */
function describeStaffSpec(role: string, personName?: string): string {
  return personName ? `"${role}" (person "${personName}")` : `"${role}"`;
}

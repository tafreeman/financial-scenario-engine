import { describe, it, expect } from "vitest";
import {
  applyRemove,
  applyAdd,
  applySwap,
  applyRateChange,
  applyHoursChange,
  calcScenarioImpact,
  calcTimelineExtensionImpact,
  calcUnexpectedCostImpact,
} from "../scenarios.js";
import { calcProjectLabor, monthlyCost, monthlyRevenue } from "../labor.js";
import { calcProjectMargin } from "../margin.js";
import { calcBudgetMetrics } from "../budget.js";
import type { StaffingRecord, LaborCategory, Project, ProjectSnapshot } from "../types.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const categories: LaborCategory[] = [
  { id: 1, name: "Lead Architect", bill_rate: 285, cost_rate: 210 },
  { id: 2, name: "Senior Developer", bill_rate: 245, cost_rate: 185 },
  { id: 3, name: "Mid-level Developer", bill_rate: 185, cost_rate: 135 },
  { id: 4, name: "Junior Developer", bill_rate: 135, cost_rate: 95 },
  { id: 5, name: "Business Analyst", bill_rate: 175, cost_rate: 125 },
  { id: 6, name: "QA Engineer", bill_rate: 165, cost_rate: 115 },
  { id: 7, name: "Project Manager", bill_rate: 225, cost_rate: 165 },
  { id: 8, name: "Scrum Master", bill_rate: 195, cost_rate: 145 },
];

const alphaStaffing: StaffingRecord[] = [
  { id: 1, project_id: 1, project_name: "Project Alpha", labor_category_id: 2, labor_category: "Senior Developer", person_name: "J. Smith", hours_per_week: 40, bill_rate: 245, cost_rate: 185, is_active: 1 },
  { id: 2, project_id: 1, project_name: "Project Alpha", labor_category_id: 3, labor_category: "Mid-level Developer", person_name: "K. Chen", hours_per_week: 40, bill_rate: 185, cost_rate: 135, is_active: 1 },
  { id: 3, project_id: 1, project_name: "Project Alpha", labor_category_id: 5, labor_category: "Business Analyst", person_name: "L. Park", hours_per_week: 30, bill_rate: 175, cost_rate: 125, is_active: 1 },
];

const alphaProject: Project = {
  id: 1, name: "Project Alpha", total_budget: 1250000, spent_to_date: 485000,
  start_date: "2025-10-01", end_date: "2026-09-30", status: "active",
};

// ─── Mutation Tests ──────────────────────────────────────────────────────────

describe("applyRemove", () => {
  it("removes matching staff by role", () => {
    const result = applyRemove(alphaStaffing, [{ role: "Senior Developer", count: 1 }]);
    expect(result.length).toBe(2);
    expect(result.find(s => s.labor_category === "Senior Developer")).toBeUndefined();
  });

  it("does not remove more than count", () => {
    const firstStaff = alphaStaffing[0];
    if (!firstStaff) throw new Error("fixture is empty");
    const twoDevs = [...alphaStaffing, { ...firstStaff, id: 99, person_name: "Other Dev" }];
    const result = applyRemove(twoDevs, [{ role: "Senior Developer", count: 1 }]);
    expect(result.filter(s => s.labor_category === "Senior Developer").length).toBe(1);
  });

  it("removes by person_name when specified", () => {
    const result = applyRemove(alphaStaffing, [{ role: "Senior Developer", count: 1, person_name: "J. Smith" }]);
    expect(result.length).toBe(2);
  });

  it("returns unchanged array when no match", () => {
    const result = applyRemove(alphaStaffing, [{ role: "Nonexistent Role", count: 1 }]);
    expect(result.length).toBe(3);
  });

  it("returns copy when remove is empty", () => {
    const result = applyRemove(alphaStaffing, []);
    expect(result.length).toBe(3);
    expect(result).not.toBe(alphaStaffing); // is a copy
  });

  it("warns when a role matches nobody, so the no-op is not silent", () => {
    const warnings: string[] = [];
    applyRemove(alphaStaffing, [{ role: "Nonexistent Role", count: 1 }], warnings);
    expect(warnings.some(w => w.includes("Nonexistent Role"))).toBe(true);
  });

  it("warns when person_name narrows a matching role down to nobody", () => {
    const warnings: string[] = [];
    const result = applyRemove(
      alphaStaffing,
      [{ role: "Senior Developer", count: 1, person_name: "Nobody Here" }],
      warnings
    );
    expect(result.length).toBe(3); // nothing removed
    expect(warnings.some(w => w.includes("Nobody Here"))).toBe(true);
  });

  it("stays silent when the role does match", () => {
    const warnings: string[] = [];
    applyRemove(alphaStaffing, [{ role: "Senior Developer", count: 1 }], warnings);
    expect(warnings).toEqual([]);
  });

  // The roster holds one Senior Developer, so removing two removes one and
  // costs one salary — half the saving the request implies, reported as though
  // it were the whole thing.
  it("warns when fewer than the requested count matched", () => {
    const warnings: string[] = [];
    const result = applyRemove(alphaStaffing, [{ role: "Senior Developer", count: 2 }], warnings);
    expect(result.length).toBe(2);
    expect(warnings.some(w => w.includes("Only 1 of 2") && w.includes("Senior Developer"))).toBe(true);
  });
});

describe("applyAdd", () => {
  it("adds staff with correct rates from category lookup", () => {
    const result = applyAdd(alphaStaffing, categories, [{ role: "Project Manager", count: 1, hours_per_week: 20 }], 1, "Project Alpha");
    expect(result.length).toBe(4);
    const pm = result.find(s => s.labor_category === "Project Manager");
    expect(pm).toBeDefined();
    expect(pm!.bill_rate).toBe(225);
    expect(pm!.cost_rate).toBe(165);
    expect(pm!.hours_per_week).toBe(20);
  });

  it("adds multiple of same role", () => {
    const result = applyAdd(alphaStaffing, categories, [{ role: "Mid-level Developer", count: 2 }], 1, "Project Alpha");
    expect(result.length).toBe(5);
    expect(result.filter(s => s.labor_category === "Mid-level Developer").length).toBe(3);
  });

  it("defaults hours to 40", () => {
    const result = applyAdd([], categories, [{ role: "Senior Developer", count: 1 }], 1, "Test");
    const first = result[0];
    if (!first) throw new Error("result is empty");
    expect(first.hours_per_week).toBe(40);
  });

  it("skips unresolvable roles", () => {
    const result = applyAdd(alphaStaffing, categories, [{ role: "Imaginary Role", count: 1 }], 1, "Test");
    expect(result.length).toBe(3); // unchanged
  });

  it("warns when a role resolves to no rate-card category", () => {
    const warnings: string[] = [];
    const result = applyAdd(
      alphaStaffing, categories,
      [{ role: "Imaginary Role", count: 1 }],
      1, "Test", warnings
    );
    expect(result.length).toBe(3); // nobody added
    expect(warnings.some(w => w.includes("Imaginary Role"))).toBe(true);
  });
});

describe("applySwap", () => {
  it("removes and adds in sequence", () => {
    const result = applySwap(
      alphaStaffing, categories,
      [{ role: "Senior Developer", count: 1 }],
      [{ role: "Mid-level Developer", count: 2 }],
      1, "Project Alpha"
    );
    // Started with 3, removed 1, added 2 = 4
    expect(result.length).toBe(4);
    expect(result.filter(s => s.labor_category === "Senior Developer").length).toBe(0);
    expect(result.filter(s => s.labor_category === "Mid-level Developer").length).toBe(3);
  });

  it("reports an unmatched role from either half", () => {
    const warnings: string[] = [];
    applySwap(
      alphaStaffing, categories,
      [{ role: "Nonexistent Role", count: 1 }],
      [{ role: "Imaginary Role", count: 1 }],
      1, "Project Alpha", warnings
    );
    expect(warnings.some(w => w.includes("Nonexistent Role"))).toBe(true);
    expect(warnings.some(w => w.includes("Imaginary Role"))).toBe(true);
  });
});

describe("applyRateChange", () => {
  it("updates rates for matching role", () => {
    const result = applyRateChange(alphaStaffing, [{ role: "Senior Developer", new_bill_rate: 275 }]);
    const dev = result.find(s => s.labor_category === "Senior Developer");
    expect(dev!.bill_rate).toBe(275);
    expect(dev!.cost_rate).toBe(185); // unchanged
  });

  it("does not mutate original array", () => {
    applyRateChange(alphaStaffing, [{ role: "Senior Developer", new_bill_rate: 999 }]);
    expect(alphaStaffing[0]?.bill_rate).toBe(245); // original unchanged
  });

  it("folds all overlapping matches so both a broad bill change and a narrow cost change apply", () => {
    const result = applyRateChange(alphaStaffing, [
      { role: "Developer", new_bill_rate: 300 },
      { role: "Senior Developer", new_cost_rate: 150 },
    ]);
    const senior = result.find(s => s.labor_category === "Senior Developer");
    expect(senior!.bill_rate).toBe(300); // from the broad "Developer" entry
    expect(senior!.cost_rate).toBe(150); // from the narrow "Senior Developer" entry — not dropped
  });

  it("warns when more than one entry matches the same record", () => {
    const warnings: string[] = [];
    applyRateChange(
      alphaStaffing,
      [
        { role: "Developer", new_bill_rate: 300 },
        { role: "Senior Developer", new_cost_rate: 150 },
      ],
      warnings
    );
    expect(warnings.some(w => w.includes("Senior Developer"))).toBe(true);
  });

  it("warns when an entry's role matches no record", () => {
    const warnings: string[] = [];
    const result = applyRateChange(
      alphaStaffing,
      [{ role: "Nonexistent Role", new_bill_rate: 300 }],
      warnings
    );
    expect(result.every((s, i) => s.bill_rate === alphaStaffing[i]?.bill_rate)).toBe(true);
    expect(warnings.some(w => w.includes("Nonexistent Role"))).toBe(true);
  });
});

describe("applyHoursChange", () => {
  it("updates hours for matching person", () => {
    const result = applyHoursChange(alphaStaffing, [{ person_name: "K. Chen", new_hours_per_week: 20 }]);
    const chen = result.find(s => s.person_name === "K. Chen");
    expect(chen!.hours_per_week).toBe(20);
  });

  it("warns when an entry's person_name matches no record", () => {
    const warnings: string[] = [];
    const result = applyHoursChange(
      alphaStaffing,
      [{ person_name: "Nobody Here", new_hours_per_week: 20 }],
      warnings
    );
    expect(result.every((s, i) => s.hours_per_week === alphaStaffing[i]?.hours_per_week)).toBe(true);
    expect(warnings.some(w => w.includes("Nobody Here"))).toBe(true);
  });
});

// ─── Impact Calculation ──────────────────────────────────────────────────────

describe("calcScenarioImpact", () => {
  it("computes correct deltas for a swap", () => {
    const beforeStaffing = alphaStaffing;
    const afterStaffing = applySwap(
      alphaStaffing, categories,
      [{ role: "Senior Developer", count: 1 }],
      [{ role: "Mid-level Developer", count: 2 }],
      1, "Project Alpha"
    );

    const beforeLabor = calcProjectLabor(beforeStaffing);
    const afterLabor = calcProjectLabor(afterStaffing);
    const beforeMargin = calcProjectMargin(beforeStaffing);
    const afterMargin = calcProjectMargin(afterStaffing);
    const beforeBudget = calcBudgetMetrics(alphaProject, beforeLabor.monthly_cost);
    const afterBudget = calcBudgetMetrics(alphaProject, afterLabor.monthly_cost);

    const impact = calcScenarioImpact(
      { labor: beforeLabor, margin: beforeMargin, budget: beforeBudget },
      { labor: afterLabor, margin: afterMargin, budget: afterBudget }
    );

    // Cost delta: removed 1 Sr Dev ($185/hr*40), added 2 Mid Devs ($135/hr*40 each)
    // The exact formula: (2*monthlyCost(135,40) - monthlyCost(185,40))
    const expectedCostDelta = 2 * monthlyCost(135, 40) - monthlyCost(185, 40);
    expect(impact.cost_delta_monthly).toBeCloseTo(expectedCostDelta, 2);

    // Revenue delta: removed 1 Sr ($245/hr*40), added 2 Mid ($185/hr*40 each)
    const expectedRevenueDelta = 2 * monthlyRevenue(185, 40) - monthlyRevenue(245, 40);
    expect(impact.revenue_delta_monthly).toBeCloseTo(expectedRevenueDelta, 2);

    // Headcount: removed 1, added 2 = net +1
    expect(impact.headcount_delta).toBe(1);

    // Cost went up, so burn rate delta should be positive
    expect(impact.burn_rate_delta).toBeGreaterThan(0);
  });

  it("computes correct delta for a remove", () => {
    const afterStaffing = applyRemove(alphaStaffing, [{ role: "QA Engineer", count: 1 }]);
    // QA isn't on Alpha, so no change
    const beforeLabor = calcProjectLabor(alphaStaffing);
    const afterLabor = calcProjectLabor(afterStaffing);

    expect(afterLabor.monthly_cost).toBe(beforeLabor.monthly_cost);
  });
});

// ─── Timeline & Cost Impact ──────────────────────────────────────────────────

const alphaSnapshot: ProjectSnapshot = {
  ...alphaProject,
  staffing: alphaStaffing,
};

describe("calcTimelineExtensionImpact", () => {
  const monthlyBurn = 100000;

  it("uses extensionMonths when provided", () => {
    const result = calcTimelineExtensionImpact(alphaSnapshot, monthlyBurn, 3);
    expect(result.additional_months).toBe(3);
    // additional_cost is burn applied across the requested months
    expect(result.additional_cost).toBe(monthlyBurn * 3);
    // The new end date advances past the original end_date
    expect(result.new_end_date > alphaProject.end_date).toBe(true);
  });

  it("derives additional months from an explicit newEndDate", () => {
    // ~6 months after the original Sep 30 2026 end date
    const result = calcTimelineExtensionImpact(
      alphaSnapshot,
      monthlyBurn,
      undefined,
      "2027-03-31"
    );
    // 6 months ± rounding from the 30.44-day month approximation
    expect(result.additional_months).toBeGreaterThan(5.5);
    expect(result.additional_months).toBeLessThan(6.5);
    expect(result.new_end_date).toBe("2027-03-31");
  });

  it("returns a no-op result when neither extension nor end date is given", () => {
    const result = calcTimelineExtensionImpact(alphaSnapshot, monthlyBurn);
    expect(result.additional_months).toBe(0);
    expect(result.additional_cost).toBe(0);
    expect(result.new_end_date).toBe(alphaProject.end_date);
    expect(result.new_total_projected).toBe(alphaProject.spent_to_date);
    expect(result.budget_gap).toBe(0);
  });

  it("reports a positive budget gap when projected spend exceeds budget", () => {
    // A very high burn over a long extension should overrun the $1.25M budget
    const result = calcTimelineExtensionImpact(alphaSnapshot, 500000, 24);
    expect(result.budget_gap).toBeGreaterThan(0);
    expect(result.new_total_projected).toBeGreaterThan(alphaProject.total_budget);
  });
});

describe("calcUnexpectedCostImpact", () => {
  const monthlyBurn = 50000;

  it("returns baseline runway when there are no additional costs", () => {
    const result = calcUnexpectedCostImpact(alphaSnapshot, monthlyBurn, []);
    expect(result.total_one_time).toBe(0);
    expect(result.total_recurring_monthly).toBe(0);
    expect(result.impact_on_remaining).toBe(0);
    // remaining budget / burn = positive runway
    expect(result.new_months_remaining).toBeGreaterThan(0);
  });

  it("treats undefined costs the same as an empty list", () => {
    const result = calcUnexpectedCostImpact(alphaSnapshot, monthlyBurn, undefined);
    expect(result.total_one_time).toBe(0);
    expect(result.total_recurring_monthly).toBe(0);
  });

  it("sums one-time costs", () => {
    const result = calcUnexpectedCostImpact(alphaSnapshot, monthlyBurn, [
      { description: "License", amount: 20000, is_recurring: false },
    ]);
    expect(result.total_one_time).toBe(20000);
    expect(result.total_recurring_monthly).toBe(0);
  });

  it("normalizes recurring costs by frequency to a monthly amount", () => {
    // Quarterly cost of 30000 -> 10000/month
    const result = calcUnexpectedCostImpact(alphaSnapshot, monthlyBurn, [
      { description: "Quarterly fee", amount: 30000, is_recurring: true, frequency_months: 3 },
    ]);
    expect(result.total_recurring_monthly).toBe(10000);
    expect(result.total_one_time).toBe(0);
  });

  it("defaults recurring frequency to monthly when not specified", () => {
    const result = calcUnexpectedCostImpact(alphaSnapshot, monthlyBurn, [
      { description: "Monthly tool", amount: 5000, is_recurring: true },
    ]);
    expect(result.total_recurring_monthly).toBe(5000);
  });

  it("shortens runway when recurring costs raise the burn rate", () => {
    const baseline = calcUnexpectedCostImpact(alphaSnapshot, monthlyBurn, []);
    const withRecurring = calcUnexpectedCostImpact(alphaSnapshot, monthlyBurn, [
      { description: "New SaaS", amount: 25000, is_recurring: true, frequency_months: 1 },
    ]);
    expect(withRecurring.new_months_remaining).toBeLessThan(baseline.new_months_remaining);
  });
});

import { describe, it, expect } from "vitest";
import {
  applyRemove,
  applyAdd,
  applySwap,
  applyRateChange,
  applyHoursChange,
  calcScenarioImpact,
} from "../scenarios.js";
import { calcProjectLabor, monthlyCost, monthlyRevenue } from "../labor.js";
import { calcProjectMargin } from "../margin.js";
import { calcBudgetMetrics } from "../budget.js";
import type { StaffingRecord, LaborCategory, Project } from "../types.js";

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
    const twoDevs = [...alphaStaffing, { ...alphaStaffing[0], id: 99, person_name: "Other Dev" }];
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
    expect(result[0].hours_per_week).toBe(40);
  });

  it("skips unresolvable roles", () => {
    const result = applyAdd(alphaStaffing, categories, [{ role: "Imaginary Role", count: 1 }], 1, "Test");
    expect(result.length).toBe(3); // unchanged
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
    expect(alphaStaffing[0].bill_rate).toBe(245); // original unchanged
  });
});

describe("applyHoursChange", () => {
  it("updates hours for matching person", () => {
    const result = applyHoursChange(alphaStaffing, [{ person_name: "K. Chen", new_hours_per_week: 20 }]);
    const chen = result.find(s => s.person_name === "K. Chen");
    expect(chen!.hours_per_week).toBe(20);
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

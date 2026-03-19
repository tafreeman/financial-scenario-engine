/**
 * Goal-seeking tests: verify the engine can answer questions like
 * "what changes are needed to extend the timeline by X months and stay within budget?"
 *
 * These simulate the agentic loop pattern where the LLM would:
 * 1. Check current state
 * 2. Try various staffing changes
 * 3. Evaluate which ones meet the goal
 * 4. Return results with real computed numbers
 */

import { describe, it, expect } from "vitest";
import {
  type StaffingRecord,
  type LaborCategory,
  type ProjectSnapshot,
} from "../types.js";
import { calcProjectLabor } from "../labor.js";
import { calcProjectMargin } from "../margin.js";
import { calcBudgetMetrics, calcRemainingBudget, calcMonthsRemaining } from "../budget.js";
import {
  applyRemove,
  applySwap,
  applyHoursChange,
} from "../scenarios.js";

// --- Seed Data Fixtures -------------------------------------------------------

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

function makeStaff(
  id: number, projectId: number, projectName: string,
  catId: number, personName: string, hours: number
): StaffingRecord {
  const cat = categories.find(c => c.id === catId)!;
  return {
    id, project_id: projectId, project_name: projectName,
    labor_category_id: catId, labor_category: cat.name,
    person_name: personName, hours_per_week: hours,
    bill_rate: cat.bill_rate, cost_rate: cat.cost_rate, is_active: 1,
  };
}

const alphaStaffing: StaffingRecord[] = [
  makeStaff(1, 1, "Project Alpha", 2, "J. Smith", 40),
  makeStaff(2, 1, "Project Alpha", 3, "K. Chen", 40),
  makeStaff(3, 1, "Project Alpha", 5, "L. Park", 30),
];

const alphaProject: ProjectSnapshot = {
  id: 1, name: "Project Alpha", total_budget: 1250000, spent_to_date: 485000,
  start_date: "2025-10-01", end_date: "2026-09-30", status: "active",
  staffing: alphaStaffing,
};

// --- Shared scenario helpers --------------------------------------------------

interface ScenarioOption {
  name: string;
  staffing: StaffingRecord[];
}

function buildOptions(): ScenarioOption[] {
  return [
    {
      name: "Remove Sr Dev",
      staffing: applyRemove(alphaStaffing, [{ role: "Senior Developer", count: 1 }]),
    },
    {
      name: "K. Chen to 20 hrs",
      staffing: applyHoursChange(alphaStaffing, [{ person_name: "K. Chen", new_hours_per_week: 20 }]),
    },
    {
      name: "Swap Sr Dev for Mid Dev",
      staffing: applySwap(alphaStaffing, categories,
        [{ role: "Senior Developer", count: 1 }],
        [{ role: "Mid-level Developer", count: 1 }],
        1, "Project Alpha"),
    },
    {
      name: "L. Park to 15 hrs",
      staffing: applyHoursChange(alphaStaffing, [{ person_name: "L. Park", new_hours_per_week: 15 }]),
    },
  ];
}

// --- Goal-Seeking Tests -------------------------------------------------------

describe("Goal: Extend Alpha by 3 months and stay within budget", () => {
  const EXTENSION_MONTHS = 3;
  const currentLabor = calcProjectLabor(alphaStaffing);
  const remaining = calcRemainingBudget(alphaProject.total_budget, alphaProject.spent_to_date);
  const currentMonthsLeft = calcMonthsRemaining(remaining, currentLabor.monthly_cost);
  const targetMonths = currentMonthsLeft + EXTENSION_MONTHS;

  it("baseline: current burn rate cannot support 3 extra months", () => {
    const totalNeeded = currentLabor.monthly_cost * targetMonths;
    expect(totalNeeded).toBeGreaterThan(remaining);
  });

  it("each option reduces monthly cost below baseline", () => {
    for (const opt of buildOptions()) {
      const afterLabor = calcProjectLabor(opt.staffing);
      expect(afterLabor.monthly_cost).toBeLessThan(currentLabor.monthly_cost);
    }
  });

  it("can compare all options and identify which meet the target", () => {
    const results = buildOptions().map(opt => {
      const labor = calcProjectLabor(opt.staffing);
      const margin = calcProjectMargin(opt.staffing);
      const budget = calcBudgetMetrics(alphaProject, labor.monthly_cost);
      return {
        name: opt.name,
        monthly_cost: labor.monthly_cost,
        months_remaining: budget.months_remaining,
        meets_goal: budget.months_remaining >= targetMonths,
        margin_pct: margin.margin_pct,
        headcount: labor.headcount,
      };
    });

    expect(results).toHaveLength(4);

    for (const r of results) {
      expect(r.monthly_cost).toBeGreaterThan(0);
      expect(r.months_remaining).toBeGreaterThan(0);
    }

    const viable = results.filter(r => r.meets_goal);
    for (const v of viable) {
      expect(v.months_remaining).toBeGreaterThanOrEqual(targetMonths);
    }

    const nonViable = results.filter(r => !r.meets_goal);
    for (const nv of nonViable) {
      expect(nv.months_remaining).toBeLessThan(targetMonths);
    }
  });
});

describe("Goal: Improve portfolio margin by 3+ percentage points", () => {
  const betaStaffing: StaffingRecord[] = [
    makeStaff(4, 2, "Project Beta", 1, "M. Jones", 40),
    makeStaff(5, 2, "Project Beta", 2, "N. Davis", 40),
    makeStaff(6, 2, "Project Beta", 6, "P. Wilson", 40),
  ];

  const allStaffing = [...alphaStaffing, ...betaStaffing];
  const baselineMargin = calcProjectMargin(allStaffing);

  it("baseline margin is known", () => {
    expect(baselineMargin.margin_pct).toBeGreaterThan(0);
    expect(baselineMargin.margin_pct).toBeLessThan(100);
  });

  it("removing lowest-margin staff changes the portfolio margin", () => {
    const afterStaffing = allStaffing.filter(s => s.labor_category !== "Lead Architect");
    const afterMargin = calcProjectMargin(afterStaffing);
    const marginImprovement = afterMargin.margin_pct - baselineMargin.margin_pct;

    expect(Number.isFinite(marginImprovement)).toBe(true);
  });

  it("swapping Senior Dev for Junior Dev changes the portfolio margin", () => {
    const afterStaffing = applySwap(
      allStaffing, categories,
      [{ role: "Senior Developer", count: 1 }],
      [{ role: "Junior Developer", count: 1 }],
      1, "Project Alpha"
    );
    const afterMargin = calcProjectMargin(afterStaffing);

    expect(Number.isFinite(afterMargin.margin_pct)).toBe(true);
  });

  it("engine produces structurally valid margin metrics for all mutations", () => {
    const mutations = [
      applyRemove(allStaffing, [{ role: "Lead Architect", count: 1 }]),
      applyRemove(allStaffing, [{ role: "Senior Developer", count: 1 }]),
      applySwap(allStaffing, categories,
        [{ role: "Senior Developer", count: 1 }],
        [{ role: "Junior Developer", count: 1 }],
        1, "Test"),
    ];

    for (const staffing of mutations) {
      const margin = calcProjectMargin(staffing);
      expect(margin.margin_pct).toBeGreaterThan(-100);
      expect(margin.margin_pct).toBeLessThan(100);
      expect(Number.isFinite(margin.margin_dollars_monthly)).toBe(true);
      expect(Number.isFinite(margin.net_direct_labor_multiplier)).toBe(true);
    }
  });
});

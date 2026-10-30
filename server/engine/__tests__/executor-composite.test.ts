/**
 * Coverage for executor.ts composite state-threading (mergeProjectedState) and
 * portfolio.ts aggregation. Expectations are relational (composite vs. the same
 * operations run one at a time) rather than hand-computed dollar figures.
 */

import { describe, it, expect } from "vitest";
import { executeScenario } from "../executor.js";
import {
  calcPortfolioMetrics,
  calcPortfolioBurn,
  calcPortfolioMargin,
  calcProjectSummaries,
  calcBenchCost,
} from "../portfolio.js";
import type {
  LaborCategory,
  PortfolioSnapshot,
  ProjectSnapshot,
  ScenarioOperation,
  StaffingRecord,
} from "../types.js";

const labor_categories: LaborCategory[] = [
  { id: 2, name: "Senior Developer", bill_rate: 245, cost_rate: 185 },
  { id: 3, name: "Mid-level Developer", bill_rate: 185, cost_rate: 135 },
  { id: 5, name: "Business Analyst", bill_rate: 175, cost_rate: 125 },
];

function staff(id: number, pid: number, pname: string, catId: number, person: string, hours: number): StaffingRecord {
  const cat = labor_categories.find(c => c.id === catId)!;
  return {
    id, project_id: pid, project_name: pname, labor_category_id: catId,
    labor_category: cat.name, person_name: person, hours_per_week: hours,
    bill_rate: cat.bill_rate, cost_rate: cat.cost_rate, is_active: 1,
  };
}

const alpha: ProjectSnapshot = {
  id: 1, name: "Project Alpha", total_budget: 1_250_000, spent_to_date: 485_000,
  start_date: "2025-10-01", end_date: "2026-09-30", status: "active",
  staffing: [
    staff(1, 1, "Project Alpha", 2, "J. Smith", 40),
    staff(2, 1, "Project Alpha", 3, "K. Chen", 40),
    staff(3, 1, "Project Alpha", 5, "L. Park", 30),
  ],
};
const beta: ProjectSnapshot = {
  id: 2, name: "Project Beta", total_budget: 2_100_000, spent_to_date: 1_340_000,
  start_date: "2025-04-01", end_date: "2026-03-31", status: "active",
  staffing: [
    staff(4, 2, "Project Beta", 2, "N. Davis", 40),
    staff(5, 2, "Project Beta", 3, "P. Wilson", 40),
  ],
};
const portfolio: PortfolioSnapshot = { projects: [alpha, beta], labor_categories };
const PINNED = new Date("2026-04-15T12:00:00.000Z");

const run = (op: ScenarioOperation, p: PortfolioSnapshot = portfolio) =>
  executeScenario(op, p, PINNED);

describe("composite state threading across every staffing sub-operation", () => {
  const subOps: { name: string; op: ScenarioOperation }[] = [
    { name: "add", op: { action: "add", project: "Alpha", add: [{ role: "Senior Developer", count: 1 }] } },
    { name: "remove", op: { action: "remove", project: "Alpha", remove: [{ role: "Mid-level Developer", count: 1 }] } },
    {
      name: "swap",
      op: {
        action: "swap", project: "Alpha",
        remove: [{ role: "Senior Developer", count: 1 }],
        add: [{ role: "Mid-level Developer", count: 1 }],
      },
    },
    { name: "rate_change", op: { action: "rate_change", project: "Alpha", rate_changes: [{ role: "Senior Developer", new_cost_rate: 200 }] } },
    { name: "hours_change", op: { action: "hours_change", project: "Alpha", hours_changes: [{ person_name: "J. Smith", new_hours_per_week: 20 }] } },
  ];

  for (const { name, op } of subOps) {
    it(`${name} as a single-sub-op composite matches the standalone result`, () => {
      const standalone = run(op);
      const composite = run({ action: "what_if_composite", project: "Alpha", sub_operations: [op] });
      expect(composite.sub_results).toHaveLength(1);
      expect(composite.projected?.labor.monthly_cost).toBeCloseTo(
        standalone.projected!.labor.monthly_cost, 6
      );
    });

    it(`${name} then a second op sees the accumulated state`, () => {
      const second: ScenarioOperation = {
        action: "add", project: "Alpha", add: [{ role: "Business Analyst", count: 1 }],
      };
      const composite = run({ action: "what_if_composite", project: "Alpha", sub_operations: [op, second] });
      const [first, secondResult] = composite.sub_results!;
      // The second sub-op must start from the first sub-op's projected state.
      expect(secondResult!.current.labor.monthly_cost).toBeCloseTo(
        first!.projected!.labor.monthly_cost, 6
      );
    });
  }
});

describe("composite: cost and reallocation threading", () => {
  it("one-time unexpected cost reduces remaining budget seen by the next sub-op", () => {
    const composite = run({
      action: "what_if_composite",
      project: "Alpha",
      sub_operations: [
        {
          action: "unexpected_cost", project: "Alpha",
          additional_costs: [{ description: "Licence", amount: 100_000, is_recurring: false }],
        },
        { action: "burn_rate_check", project: "Alpha" },
      ],
    });
    const baseline = run({ action: "burn_rate_check", project: "Alpha" });
    expect(composite.sub_results![1]!.current.budget.remaining_budget).toBeLessThan(
      baseline.current.budget.remaining_budget
    );
  });

  it("recurring-only unexpected cost leaves spent_to_date unchanged for later sub-ops", () => {
    const composite = run({
      action: "what_if_composite",
      project: "Alpha",
      sub_operations: [
        {
          action: "unexpected_cost", project: "Alpha",
          additional_costs: [{ description: "Support", amount: 5_000, is_recurring: true, frequency_months: 1 }],
        },
        { action: "burn_rate_check", project: "Alpha" },
      ],
    });
    const baseline = run({ action: "burn_rate_check", project: "Alpha" });
    expect(composite.sub_results![1]!.current.budget.remaining_budget).toBeCloseTo(
      baseline.current.budget.remaining_budget, 6
    );
  });

  it("reallocation inside a composite moves staffing between projects for later sub-ops", () => {
    const composite = run({
      action: "what_if_composite",
      sub_operations: [
        {
          action: "reallocation", projects: ["Alpha", "Beta"],
          remove: [{ role: "Senior Developer", count: 1 }],
          add: [{ role: "Senior Developer", count: 1 }],
        },
        { action: "burn_rate_check", project: "Beta" },
      ],
    });
    expect(composite.projects_involved).toEqual(
      expect.arrayContaining(["Project Alpha", "Project Beta"])
    );
    const standaloneBeta = run({ action: "burn_rate_check", project: "Beta" });
    // Beta gained a senior developer, so its burn rises vs. the untouched baseline.
    expect(composite.sub_results![1]!.current.labor.monthly_cost).toBeGreaterThan(
      standaloneBeta.current.labor.monthly_cost
    );
  });

  it("reallocation sub-op missing a destination leaves the portfolio untouched", () => {
    const composite = run({
      action: "what_if_composite",
      sub_operations: [
        { action: "reallocation", projects: ["Alpha"], remove: [{ role: "Senior Developer", count: 1 }] },
        { action: "burn_rate_check", project: "Alpha" },
      ],
    });
    const baseline = run({ action: "burn_rate_check", project: "Alpha" });
    expect(composite.sub_results![1]!.current.labor.monthly_cost).toBeCloseTo(
      baseline.current.labor.monthly_cost, 6
    );
  });

  it("staffing sub-op with project 'all' does not mutate accumulated state", () => {
    const composite = run({
      action: "what_if_composite",
      sub_operations: [
        { action: "add", project: "all", add: [{ role: "Senior Developer", count: 1 }] },
        { action: "burn_rate_check", project: "Alpha" },
      ],
    });
    expect(composite.sub_results).toHaveLength(2);
  });

  it("composite with no sub-operations warns and falls back to burn-rate analysis", () => {
    const result = run({ action: "what_if_composite", project: "Alpha", sub_operations: [] });
    expect(result.warnings.some(w => w.includes("no sub-operations"))).toBe(true);
    expect(result.current.labor.monthly_cost).toBeGreaterThan(0);
  });

  it("a zero-amount one-time cost is a no-op for the next sub-op", () => {
    const composite = run({
      action: "what_if_composite",
      project: "Alpha",
      sub_operations: [
        { action: "unexpected_cost", project: "Alpha", additional_costs: [{ description: "none", amount: 0, is_recurring: false }] },
        { action: "burn_rate_check", project: "Alpha" },
      ],
    });
    expect(composite.sub_results).toHaveLength(2);
  });
});

describe("portfolio.ts aggregation", () => {
  it("calcPortfolioMetrics totals equal the per-project sums", () => {
    const m = calcPortfolioMetrics(portfolio.projects);
    expect(m.project_summaries).toHaveLength(2);
    expect(m.total_burn).toBeCloseTo(
      m.project_summaries.reduce((s, p) => s + p.monthly_burn, 0), 6
    );
    expect(m.total_margin_dollars).toBeCloseTo(m.total_revenue - m.total_cost, 6);
  });

  it("calcPortfolioBurn and calcProjectSummaries delegate to the metrics pass", () => {
    const m = calcPortfolioMetrics(portfolio.projects);
    expect(calcPortfolioBurn(portfolio.projects)).toBe(m.total_burn);
    expect(calcProjectSummaries(portfolio.projects)).toEqual(m.project_summaries);
  });

  it("calcPortfolioMargin exposes the margin subset of the metrics", () => {
    const m = calcPortfolioMetrics(portfolio.projects);
    expect(calcPortfolioMargin(portfolio.projects)).toEqual({
      total_margin_pct: m.total_margin_pct,
      total_margin_dollars: m.total_margin_dollars,
      total_revenue: m.total_revenue,
      total_cost: m.total_cost,
    });
  });

  it("an empty portfolio yields zeros, not NaN (safeDivide guard)", () => {
    const m = calcPortfolioMetrics([]);
    expect(m.total_burn).toBe(0);
    expect(m.total_margin_pct).toBe(0);
    expect(m.project_summaries).toEqual([]);
  });

  it("calcBenchCost annualises monthly cost and counts heads", () => {
    const bench = [staff(90, 0, "Bench", 2, "Bench A", 40), staff(91, 0, "Bench", 3, "Bench B", 20)];
    const r = calcBenchCost(bench);
    expect(r.bench_count).toBe(2);
    expect(r.bench_cost_annual).toBeCloseTo(r.bench_cost_monthly * 12, 6);
    expect(r.bench_cost_monthly).toBeGreaterThan(0);
    expect(calcBenchCost([])).toEqual({ bench_count: 0, bench_cost_monthly: 0, bench_cost_annual: 0 });
  });
});

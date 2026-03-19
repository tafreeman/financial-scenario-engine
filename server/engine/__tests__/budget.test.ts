import { describe, it, expect } from "vitest";
import {
  calcRemainingBudget,
  calcMonthsRemaining,
  calcExhaustionDate,
  calcBudgetVariance,
  calcBudgetVariancePct,
  calcAnnualRunRate,
  calcBurnRateDelta,
  calcBurnRateDeltaPct,
  calcBudgetMetrics,
} from "../budget.js";
import type { Project } from "../types.js";

const testProject: Project = {
  id: 1, name: "Test", total_budget: 1250000, spent_to_date: 485000,
  start_date: "2025-10-01", end_date: "2026-09-30", status: "active",
};

describe("calcRemainingBudget", () => {
  it("returns total - spent", () => {
    expect(calcRemainingBudget(1250000, 485000)).toBe(765000);
  });

  it("can be negative if overspent", () => {
    expect(calcRemainingBudget(100000, 150000)).toBe(-50000);
  });
});

describe("calcMonthsRemaining", () => {
  it("divides remaining by burn", () => {
    expect(calcMonthsRemaining(765000, 76500)).toBe(10);
  });

  it("returns 0 for zero burn", () => {
    expect(calcMonthsRemaining(765000, 0)).toBe(0);
  });

  it("returns negative when budget exhausted", () => {
    expect(calcMonthsRemaining(-50000, 10000)).toBe(-5);
  });
});

describe("calcExhaustionDate", () => {
  it("returns ISO date string for valid months", () => {
    const result = calcExhaustionDate(6, new Date("2026-01-01"));
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns 'exhausted' for zero or negative months", () => {
    expect(calcExhaustionDate(0)).toBe("exhausted");
    expect(calcExhaustionDate(-3)).toBe("exhausted");
  });

  it("returns 'N/A' for non-finite months", () => {
    expect(calcExhaustionDate(Infinity)).toBe("N/A");
  });
});

describe("calcBudgetVariance", () => {
  it("returns planned - actual (positive = under budget)", () => {
    expect(calcBudgetVariance(500000, 485000)).toBe(15000);
  });

  it("negative when over budget", () => {
    expect(calcBudgetVariance(400000, 485000)).toBe(-85000);
  });
});

describe("calcBudgetVariancePct", () => {
  it("returns percentage variance", () => {
    expect(calcBudgetVariancePct(500000, 400000)).toBe(20);
  });

  it("returns 0 for zero planned", () => {
    expect(calcBudgetVariancePct(0, 100)).toBe(0);
  });
});

describe("calcAnnualRunRate", () => {
  it("multiplies monthly burn by 12", () => {
    expect(calcAnnualRunRate(10000)).toBe(120000);
  });
});

describe("calcBurnRateDelta", () => {
  it("returns after - before", () => {
    expect(calcBurnRateDelta(50000, 60000)).toBe(10000);
  });
});

describe("calcBurnRateDeltaPct", () => {
  it("returns percentage change", () => {
    expect(calcBurnRateDeltaPct(50000, 60000)).toBe(20);
  });

  it("returns 0 for zero before burn", () => {
    expect(calcBurnRateDeltaPct(0, 10000)).toBe(0);
  });
});

describe("calcBudgetMetrics", () => {
  it("assembles full budget metrics", () => {
    const result = calcBudgetMetrics(testProject, 76500);

    expect(result.remaining_budget).toBe(765000);
    expect(result.months_remaining).toBe(10);
    expect(result.monthly_burn_rate).toBe(76500);
    expect(result.annual_run_rate).toBe(76500 * 12);
    expect(result.budget_exhaustion_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("handles zero burn rate", () => {
    const result = calcBudgetMetrics(testProject, 0);
    expect(result.months_remaining).toBe(0);
  });
});

import { describe, it, expect } from "vitest";
import {
  monthlyCost,
  monthlyRevenue,
  annualCost,
  annualRevenue,
  loadedCost,
  fte,
  calcBlendedCostRate,
  calcBlendedBillRate,
  calcTotalFTE,
  calcProjectLabor,
} from "../labor.js";
import { WEEKS_PER_MONTH, WEEKS_PER_YEAR, type StaffingRecord } from "../types.js";

// ─── Test fixtures ───────────────────────────────────────────────────────────

function makeStaff(overrides: Partial<StaffingRecord> = {}): StaffingRecord {
  return {
    id: 1,
    project_id: 1,
    project_name: "Test Project",
    labor_category_id: 1,
    labor_category: "Senior Developer",
    person_name: "Test Person",
    hours_per_week: 40,
    bill_rate: 245,
    cost_rate: 185,
    is_active: 1,
    ...overrides,
  };
}

// ─── Per-person calculations ─────────────────────────────────────────────────

describe("monthlyCost", () => {
  it("computes cost_rate * hours * WEEKS_PER_MONTH", () => {
    // Formula: costRate × hoursPerWeek × 4.33
    expect(monthlyCost(185, 40)).toBe(185 * 40 * WEEKS_PER_MONTH);
  });

  it("handles zero hours", () => {
    expect(monthlyCost(185, 0)).toBe(0);
  });

  it("handles zero rate", () => {
    expect(monthlyCost(0, 40)).toBe(0);
  });

  it("handles part-time hours", () => {
    expect(monthlyCost(165, 20)).toBe(165 * 20 * WEEKS_PER_MONTH);
  });
});

describe("monthlyRevenue", () => {
  it("computes bill_rate * hours * WEEKS_PER_MONTH", () => {
    expect(monthlyRevenue(245, 40)).toBe(245 * 40 * WEEKS_PER_MONTH);
  });

  it("handles part-time", () => {
    expect(monthlyRevenue(225, 20)).toBe(225 * 20 * WEEKS_PER_MONTH);
  });
});

describe("annualCost", () => {
  it("computes cost_rate * hours * 52", () => {
    expect(annualCost(185, 40)).toBe(185 * 40 * WEEKS_PER_YEAR);
  });
});

describe("annualRevenue", () => {
  it("computes bill_rate * hours * 52", () => {
    expect(annualRevenue(245, 40)).toBe(245 * 40 * WEEKS_PER_YEAR);
  });
});

describe("loadedCost", () => {
  it("multiplies base cost by overhead", () => {
    expect(loadedCost(100, 1.45)).toBeCloseTo(145, 2);
  });

  it("1.0 overhead returns base cost", () => {
    expect(loadedCost(100, 1)).toBe(100);
  });
});

describe("fte", () => {
  it("40 hrs = 1.0 FTE", () => {
    expect(fte(40)).toBe(1);
  });

  it("20 hrs = 0.5 FTE", () => {
    expect(fte(20)).toBe(0.5);
  });

  it("0 hrs = 0 FTE", () => {
    expect(fte(0)).toBe(0);
  });
});

// ─── Aggregate calculations ──────────────────────────────────────────────────

describe("calcBlendedCostRate", () => {
  it("returns weighted average of cost rates", () => {
    const staffing = [
      makeStaff({ cost_rate: 185, hours_per_week: 40 }),
      makeStaff({ cost_rate: 135, hours_per_week: 40 }),
    ];
    // Weighted: (185*40 + 135*40) / (40+40) = (7400+5400)/80 = 160
    const expected = (185 * 40 + 135 * 40) / (40 + 40);
    expect(calcBlendedCostRate(staffing)).toBe(expected);
  });

  it("weights by hours correctly for mixed schedules", () => {
    const staffing = [
      makeStaff({ cost_rate: 200, hours_per_week: 40 }),
      makeStaff({ cost_rate: 100, hours_per_week: 20 }),
    ];
    // 200 has 2x the weight of 100
    const expected = (200 * 40 + 100 * 20) / (40 + 20);
    expect(calcBlendedCostRate(staffing)).toBe(expected);
  });

  it("returns 0 for empty array", () => {
    expect(calcBlendedCostRate([])).toBe(0);
  });
});

describe("calcBlendedBillRate", () => {
  it("returns weighted average of bill rates", () => {
    const staffing = [
      makeStaff({ bill_rate: 245, hours_per_week: 40 }),
      makeStaff({ bill_rate: 185, hours_per_week: 40 }),
    ];
    const expected = (245 * 40 + 185 * 40) / (40 + 40);
    expect(calcBlendedBillRate(staffing)).toBe(expected);
  });
});

describe("calcTotalFTE", () => {
  it("sums FTE across all records", () => {
    const staffing = [
      makeStaff({ hours_per_week: 40 }),
      makeStaff({ hours_per_week: 40 }),
      makeStaff({ hours_per_week: 20 }),
    ];
    expect(calcTotalFTE(staffing)).toBe(2.5);
  });

  it("returns 0 for empty array", () => {
    expect(calcTotalFTE([])).toBe(0);
  });
});

describe("calcProjectLabor", () => {
  it("aggregates all labor metrics", () => {
    const staffing = [
      makeStaff({ bill_rate: 245, cost_rate: 185, hours_per_week: 40 }),
      makeStaff({ bill_rate: 185, cost_rate: 135, hours_per_week: 40 }),
    ];

    const result = calcProjectLabor(staffing);

    expect(result.headcount).toBe(2);
    expect(result.fte_count).toBe(2);
    expect(result.monthly_cost).toBe(
      monthlyCost(185, 40) + monthlyCost(135, 40)
    );
    expect(result.monthly_revenue).toBe(
      monthlyRevenue(245, 40) + monthlyRevenue(185, 40)
    );
    expect(result.annual_cost).toBe(
      annualCost(185, 40) + annualCost(135, 40)
    );
    expect(result.annual_revenue).toBe(
      annualRevenue(245, 40) + annualRevenue(185, 40)
    );
  });

  it("returns zeros for empty staffing", () => {
    const result = calcProjectLabor([]);
    expect(result.headcount).toBe(0);
    expect(result.fte_count).toBe(0);
    expect(result.monthly_cost).toBe(0);
    expect(result.monthly_revenue).toBe(0);
  });
});

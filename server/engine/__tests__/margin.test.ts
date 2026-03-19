import { describe, it, expect } from "vitest";
import {
  calcPersonMarginPct,
  calcPersonMarginDollars,
  calcGrossMarginPct,
  calcContributionMargin,
  calcLaborMultiplier,
  calcProjectMargin,
} from "../margin.js";
import { WEEKS_PER_MONTH, type StaffingRecord } from "../types.js";

function makeStaff(overrides: Partial<StaffingRecord> = {}): StaffingRecord {
  return {
    id: 1, project_id: 1, project_name: "Test", labor_category_id: 1,
    labor_category: "Senior Developer", person_name: "Test",
    hours_per_week: 40, bill_rate: 245, cost_rate: 185, is_active: 1,
    ...overrides,
  };
}

describe("calcPersonMarginPct", () => {
  it("computes (bill - cost) / bill * 100", () => {
    expect(calcPersonMarginPct(245, 185)).toBe((245 - 185) / 245 * 100);
  });

  it("returns 0 when bill_rate is 0", () => {
    expect(calcPersonMarginPct(0, 100)).toBe(0);
  });

  it("returns positive when bill > cost", () => {
    expect(calcPersonMarginPct(200, 100)).toBeGreaterThan(0);
  });

  it("returns negative when cost > bill", () => {
    expect(calcPersonMarginPct(100, 200)).toBeLessThan(0);
  });
});

describe("calcPersonMarginDollars", () => {
  it("computes (bill - cost) * hours * WEEKS_PER_MONTH", () => {
    expect(calcPersonMarginDollars(245, 185, 40)).toBe((245 - 185) * 40 * WEEKS_PER_MONTH);
  });

  it("returns 0 at zero hours", () => {
    expect(calcPersonMarginDollars(245, 185, 0)).toBe(0);
  });
});

describe("calcGrossMarginPct", () => {
  it("computes (revenue - cost) / revenue * 100", () => {
    expect(calcGrossMarginPct(1000, 700)).toBe(30);
  });

  it("returns 0 for zero revenue", () => {
    expect(calcGrossMarginPct(0, 100)).toBe(0);
  });

  it("returns 100% when cost is 0", () => {
    expect(calcGrossMarginPct(1000, 0)).toBe(100);
  });
});

describe("calcContributionMargin", () => {
  it("returns revenue - direct costs", () => {
    expect(calcContributionMargin(1000, 700)).toBe(300);
  });
});

describe("calcLaborMultiplier", () => {
  it("returns revenue / labor cost", () => {
    expect(calcLaborMultiplier(300, 100)).toBe(3);
  });

  it("returns 0 for zero labor cost", () => {
    expect(calcLaborMultiplier(300, 0)).toBe(0);
  });
});

describe("calcProjectMargin", () => {
  it("returns valid margin metrics", () => {
    const staffing = [
      makeStaff({ bill_rate: 245, cost_rate: 185, hours_per_week: 40 }),
    ];
    const result = calcProjectMargin(staffing);

    expect(result.margin_pct).toBeGreaterThan(0);
    expect(result.margin_pct).toBeLessThan(100);
    expect(result.margin_dollars_monthly).toBeGreaterThan(0);
    expect(result.net_direct_labor_multiplier).toBeGreaterThan(1);
  });

  it("returns 0 margin for zero staffing", () => {
    const result = calcProjectMargin([]);
    expect(result.margin_pct).toBe(0);
    expect(result.margin_dollars_monthly).toBe(0);
  });
});

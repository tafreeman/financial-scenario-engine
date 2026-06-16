import { describe, it, expect } from "vitest";
import {
  calcUtilizationRate,
  calcEffectiveBillRate,
  calcRevenuePerEmployee,
  calcBreakEvenUtilization,
  calcUtilization,
} from "../utilization.js";
import type { LaborCategory, StaffingRecord } from "../types.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const categories: LaborCategory[] = [
  { id: 1, name: "Senior Developer", bill_rate: 245, cost_rate: 185 },
  { id: 2, name: "Junior Developer", bill_rate: 135, cost_rate: 95 },
  // Negative-margin role: cost > bill (a structurally unprofitable assignment).
  { id: 3, name: "Underwater Role", bill_rate: 100, cost_rate: 150 },
];

function makeStaff(
  id: number,
  catId: number,
  hours: number
): StaffingRecord {
  const cat = categories.find(c => c.id === catId)!;
  return {
    id,
    project_id: 1,
    project_name: "Test Project",
    labor_category_id: catId,
    labor_category: cat.name,
    person_name: `Person ${id}`,
    hours_per_week: hours,
    bill_rate: cat.bill_rate,
    cost_rate: cat.cost_rate,
    is_active: 1,
  };
}

// ─── Individual calculations ─────────────────────────────────────────────────

describe("calcUtilizationRate", () => {
  it("computes billable / available × 100", () => {
    expect(calcUtilizationRate(30, 40)).toBe(75);
  });

  it("returns 0 when available hours is 0 (safeDivide guard)", () => {
    expect(calcUtilizationRate(30, 0)).toBe(0);
  });
});

describe("calcEffectiveBillRate", () => {
  it("computes revenue / billable hours", () => {
    expect(calcEffectiveBillRate(2000, 10)).toBe(200);
  });

  it("returns 0 when billable hours is 0", () => {
    expect(calcEffectiveBillRate(2000, 0)).toBe(0);
  });
});

describe("calcRevenuePerEmployee", () => {
  it("computes revenue / headcount", () => {
    expect(calcRevenuePerEmployee(9000, 3)).toBe(3000);
  });

  it("returns 0 when headcount is 0", () => {
    expect(calcRevenuePerEmployee(9000, 0)).toBe(0);
  });
});

describe("calcBreakEvenUtilization", () => {
  it("computes cost / bill × 100", () => {
    // 185 / 245 × 100 ≈ 75.51 — a healthy senior-dev margin.
    expect(calcBreakEvenUtilization(185, 245)).toBeCloseTo((185 / 245) * 100, 6);
  });

  it("exceeds 100 when cost > bill (negative-margin role)", () => {
    // 150 / 100 × 100 = 150 — break-even utilisation above 100% is impossible to
    // achieve, signalling a structurally unprofitable assignment.
    expect(calcBreakEvenUtilization(150, 100)).toBe(150);
  });

  it("returns 0 when bill rate is 0", () => {
    expect(calcBreakEvenUtilization(150, 0)).toBe(0);
  });
});

// ─── Aggregate calcUtilization ───────────────────────────────────────────────

describe("calcUtilization — empty staffing", () => {
  it("returns all-zero metrics for an empty list", () => {
    expect(calcUtilization([])).toEqual({
      utilization_rate: 0,
      effective_bill_rate: 0,
      revenue_per_employee: 0,
      break_even_utilization: 0,
    });
  });
});

describe("calcUtilization — single full-time staffer", () => {
  const staffing = [makeStaff(1, 1, 40)]; // Senior Dev, 40 hrs

  it("reports 100% utilization for a 40/40 full-time staffer", () => {
    expect(calcUtilization(staffing).utilization_rate).toBe(100);
  });

  it("effective bill rate equals the staffer's bill rate", () => {
    // revenue = 245 × 40, billable hours = 40 → effective bill rate = 245
    expect(calcUtilization(staffing).effective_bill_rate).toBeCloseTo(245, 6);
  });

  it("revenue per employee equals weekly revenue (single head)", () => {
    expect(calcUtilization(staffing).revenue_per_employee).toBeCloseTo(245 * 40, 6);
  });

  it("break-even utilization equals cost/bill × 100 for the single role", () => {
    expect(calcUtilization(staffing).break_even_utilization).toBeCloseTo(
      (185 / 245) * 100,
      6
    );
  });
});

describe("calcUtilization — mixed hours", () => {
  // Senior Dev @ 40 hrs + Junior Dev @ 20 hrs. Available = 2 × 40 = 80.
  const staffing = [makeStaff(1, 1, 40), makeStaff(2, 2, 20)];

  it("utilization rate = total billable / total available × 100", () => {
    // billable = 60, available = 80 → 75%
    expect(calcUtilization(staffing).utilization_rate).toBe(75);
  });

  it("effective bill rate is hours-weighted across the mix", () => {
    // revenue = 245×40 + 135×20 = 9800 + 2700 = 12500 ; billable hours = 60
    const expected = (245 * 40 + 135 * 20) / 60;
    expect(calcUtilization(staffing).effective_bill_rate).toBeCloseTo(expected, 6);
  });

  it("revenue per employee divides total revenue by headcount", () => {
    const totalRevenue = 245 * 40 + 135 * 20;
    expect(calcUtilization(staffing).revenue_per_employee).toBeCloseTo(
      totalRevenue / 2,
      6
    );
  });

  it("break-even utilization uses hours-weighted cost and bill rates", () => {
    // weighted cost = (185×40 + 95×20)/60 ; weighted bill = (245×40 + 135×20)/60
    const billableHours = 60;
    const weightedCost = (185 * 40 + 95 * 20) / billableHours;
    const weightedBill = (245 * 40 + 135 * 20) / billableHours;
    expect(calcUtilization(staffing).break_even_utilization).toBeCloseTo(
      (weightedCost / weightedBill) * 100,
      6
    );
  });
});

describe("calcUtilization — negative-margin role (cost > bill)", () => {
  // Single "Underwater Role" staffer: cost_rate 150 > bill_rate 100.
  const staffing = [makeStaff(1, 3, 40)];

  it("break_even_utilization exceeds 100 when cost > bill", () => {
    // weighted cost/bill = 150/100 → 150% break-even, i.e. unachievable.
    expect(calcUtilization(staffing).break_even_utilization).toBeGreaterThan(100);
    expect(calcUtilization(staffing).break_even_utilization).toBeCloseTo(150, 6);
  });

  it("effective bill rate still reflects the (low) bill rate", () => {
    expect(calcUtilization(staffing).effective_bill_rate).toBeCloseTo(100, 6);
  });
});

import { describe, it, expect } from "vitest";
import { scenarioOperationSchema } from "../validation.js";

// ─── Helper ──────────────────────────────────────────────────────────────────

function validAdd(overrides: Record<string, unknown> = {}) {
  return {
    action: "add",
    add: [{ role: "Senior Developer", count: 1, ...overrides }],
  };
}

// ─── count field ─────────────────────────────────────────────────────────────

describe("scenarioOperationSchema — count field", () => {
  it("rejects negative count", () => {
    expect(
      scenarioOperationSchema.safeParse(validAdd({ count: -1 })).success
    ).toBe(false);
  });

  it("rejects zero count", () => {
    expect(
      scenarioOperationSchema.safeParse(validAdd({ count: 0 })).success
    ).toBe(false);
  });

  it("rejects fractional count (.int() guard)", () => {
    expect(
      scenarioOperationSchema.safeParse(validAdd({ count: 1.5 })).success
    ).toBe(false);
  });

  it("accepts a positive integer count", () => {
    expect(
      scenarioOperationSchema.safeParse(validAdd({ count: 2 })).success
    ).toBe(true);
  });
});

// ─── hours_per_week field ─────────────────────────────────────────────────────

describe("scenarioOperationSchema — hours_per_week", () => {
  it("rejects zero hours_per_week", () => {
    expect(
      scenarioOperationSchema.safeParse(validAdd({ hours_per_week: 0 })).success
    ).toBe(false);
  });

  it("rejects negative hours_per_week", () => {
    expect(
      scenarioOperationSchema.safeParse(validAdd({ hours_per_week: -10 })).success
    ).toBe(false);
  });

  it("rejects hours_per_week > 168", () => {
    expect(
      scenarioOperationSchema.safeParse(validAdd({ hours_per_week: 169 })).success
    ).toBe(false);
  });

  it("accepts 40 hours_per_week", () => {
    expect(
      scenarioOperationSchema.safeParse(validAdd({ hours_per_week: 40 })).success
    ).toBe(true);
  });

  it("accepts max boundary 168 hours_per_week", () => {
    expect(
      scenarioOperationSchema.safeParse(validAdd({ hours_per_week: 168 })).success
    ).toBe(true);
  });
});

// ─── new_hours_per_week field (hours_change action) ──────────────────────────

describe("scenarioOperationSchema — new_hours_per_week (hours_change)", () => {
  function hoursChange(newHours: unknown) {
    return {
      action: "hours_change",
      hours_changes: [{ person_name: "J. Smith", new_hours_per_week: newHours }],
    };
  }

  it("rejects zero new_hours_per_week", () => {
    expect(scenarioOperationSchema.safeParse(hoursChange(0)).success).toBe(false);
  });

  it("rejects negative new_hours_per_week", () => {
    expect(scenarioOperationSchema.safeParse(hoursChange(-5)).success).toBe(false);
  });

  it("rejects new_hours_per_week > 168", () => {
    expect(scenarioOperationSchema.safeParse(hoursChange(200)).success).toBe(false);
  });

  it("accepts 20 new_hours_per_week", () => {
    expect(scenarioOperationSchema.safeParse(hoursChange(20)).success).toBe(true);
  });
});

// ─── new_bill_rate / new_cost_rate fields ────────────────────────────────────

describe("scenarioOperationSchema — new_bill_rate and new_cost_rate", () => {
  function rateChange(overrides: Record<string, unknown> = {}) {
    return {
      action: "rate_change",
      rate_changes: [{ role: "Senior Developer", ...overrides }],
    };
  }

  it("rejects zero new_bill_rate", () => {
    expect(scenarioOperationSchema.safeParse(rateChange({ new_bill_rate: 0 })).success).toBe(false);
  });

  it("rejects negative new_bill_rate", () => {
    expect(scenarioOperationSchema.safeParse(rateChange({ new_bill_rate: -100 })).success).toBe(false);
  });

  it("rejects zero new_cost_rate", () => {
    expect(scenarioOperationSchema.safeParse(rateChange({ new_cost_rate: 0 })).success).toBe(false);
  });

  it("accepts positive new_bill_rate", () => {
    expect(scenarioOperationSchema.safeParse(rateChange({ new_bill_rate: 250 })).success).toBe(true);
  });

  it("rejects a rate_change entry that supplies neither new_bill_rate nor new_cost_rate (ghost mutation)", () => {
    expect(
      scenarioOperationSchema.safeParse({
        action: "rate_change",
        project: "X",
        rate_changes: [{ role: "Y" }],
      }).success
    ).toBe(false);
  });

  it("accepts a rate_change entry that supplies new_cost_rate only", () => {
    expect(scenarioOperationSchema.safeParse(rateChange({ new_cost_rate: 150 })).success).toBe(true);
  });
});

// ─── amount field (unexpected_cost) ──────────────────────────────────────────

describe("scenarioOperationSchema — amount (unexpected_cost)", () => {
  function unexpectedCost(amount: unknown) {
    return {
      action: "unexpected_cost",
      additional_costs: [{
        description: "License",
        amount,
        is_recurring: false,
      }],
    };
  }

  it("rejects negative amount", () => {
    expect(scenarioOperationSchema.safeParse(unexpectedCost(-500)).success).toBe(false);
  });

  it("rejects zero amount", () => {
    expect(scenarioOperationSchema.safeParse(unexpectedCost(0)).success).toBe(false);
  });

  it("accepts positive amount", () => {
    expect(scenarioOperationSchema.safeParse(unexpectedCost(1000)).success).toBe(true);
  });
});

// ─── frequency_months field ───────────────────────────────────────────────────

describe("scenarioOperationSchema — frequency_months", () => {
  function recurringCost(frequencyMonths: unknown) {
    return {
      action: "unexpected_cost",
      additional_costs: [{
        description: "Quarterly fee",
        amount: 3000,
        is_recurring: true,
        frequency_months: frequencyMonths,
      }],
    };
  }

  it("rejects zero frequency_months", () => {
    expect(scenarioOperationSchema.safeParse(recurringCost(0)).success).toBe(false);
  });

  it("rejects negative frequency_months", () => {
    expect(scenarioOperationSchema.safeParse(recurringCost(-1)).success).toBe(false);
  });

  it("rejects fractional frequency_months", () => {
    expect(scenarioOperationSchema.safeParse(recurringCost(1.5)).success).toBe(false);
  });

  it("accepts integer frequency_months", () => {
    expect(scenarioOperationSchema.safeParse(recurringCost(3)).success).toBe(true);
  });
});

// ─── extension_months field ───────────────────────────────────────────────────

describe("scenarioOperationSchema — extension_months", () => {
  function timelineExtension(extensionMonths: unknown) {
    return {
      action: "timeline_extension",
      extension_months: extensionMonths,
    };
  }

  it("rejects zero extension_months", () => {
    expect(scenarioOperationSchema.safeParse(timelineExtension(0)).success).toBe(false);
  });

  it("rejects negative extension_months", () => {
    expect(scenarioOperationSchema.safeParse(timelineExtension(-3)).success).toBe(false);
  });

  it("rejects fractional extension_months (.int() guard)", () => {
    expect(scenarioOperationSchema.safeParse(timelineExtension(1.5)).success).toBe(false);
  });

  it("accepts positive integer extension_months", () => {
    expect(scenarioOperationSchema.safeParse(timelineExtension(6)).success).toBe(true);
  });
});

// ─── new_end_date field (timeline_extension) ─────────────────────────────────

describe("scenarioOperationSchema — new_end_date (timeline_extension)", () => {
  function timelineExtension(newEndDate: unknown) {
    return { action: "timeline_extension", new_end_date: newEndDate };
  }

  it("rejects a non-date string", () => {
    expect(scenarioOperationSchema.safeParse(timelineExtension("not-a-date")).success).toBe(false);
  });

  it("rejects a non-ISO format (MM/DD/YYYY)", () => {
    expect(scenarioOperationSchema.safeParse(timelineExtension("09/30/2026")).success).toBe(false);
  });

  it("rejects an impossible calendar date (2026-02-30)", () => {
    expect(scenarioOperationSchema.safeParse(timelineExtension("2026-02-30")).success).toBe(false);
  });

  it("accepts a valid ISO date (YYYY-MM-DD)", () => {
    expect(scenarioOperationSchema.safeParse(timelineExtension("2026-12-31")).success).toBe(true);
  });
});

// ─── string min(1) fields ─────────────────────────────────────────────────────

describe("scenarioOperationSchema — string fields require min length 1", () => {
  it("rejects empty role in add", () => {
    expect(scenarioOperationSchema.safeParse(validAdd({ role: "" })).success).toBe(false);
  });

  it("rejects empty role in rate_change", () => {
    expect(
      scenarioOperationSchema.safeParse({
        action: "rate_change",
        rate_changes: [{ role: "", new_bill_rate: 200 }],
      }).success
    ).toBe(false);
  });

  it("rejects empty person_name in hours_change", () => {
    expect(
      scenarioOperationSchema.safeParse({
        action: "hours_change",
        hours_changes: [{ person_name: "", new_hours_per_week: 20 }],
      }).success
    ).toBe(false);
  });

  it("rejects empty description in additional_costs", () => {
    expect(
      scenarioOperationSchema.safeParse({
        action: "unexpected_cost",
        additional_costs: [{ description: "", amount: 1000, is_recurring: false }],
      }).success
    ).toBe(false);
  });
});

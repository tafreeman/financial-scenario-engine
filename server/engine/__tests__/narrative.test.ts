import { describe, it, expect } from "vitest";
import { generateNarrative } from "../narrative.js";
import type { ScenarioResult } from "../types.js";

const baseResult: ScenarioResult = {
  operation: { action: "burn_rate_check" },
  timestamp: "2026-01-01T00:00:00Z",
  projects_involved: ["Project Alpha"],
  project_name: "Project Alpha",
  current: {
    labor: {
      monthly_cost: 76500, monthly_revenue: 95000,
      annual_cost: 918000, annual_revenue: 1140000,
      blended_cost_rate: 170, blended_bill_rate: 210,
      fte_count: 2.75, headcount: 3,
    },
    margin: {
      margin_pct: 19.5, margin_dollars_monthly: 18500,
      margin_dollars_annual: 222000, gross_margin_pct: 19.5,
      contribution_margin: 18500, net_direct_labor_multiplier: 1.24,
    },
    budget: {
      monthly_burn_rate: 76500, remaining_budget: 765000,
      months_remaining: 10.0, budget_exhaustion_date: "2026-11-01",
      annual_run_rate: 918000,
    },
  },
  warnings: [],
};

describe("generateNarrative", () => {
  it("generates a narrative for a burn rate check", () => {
    const narrative = generateNarrative(baseResult);
    expect(narrative).toContain("## Impact Summary");
    expect(narrative).toContain("## Recommendation");
    expect(narrative).toContain("Project Alpha");
    expect(narrative).toContain("$76,500");
  });

  it("generates a narrative with delta table for staffing changes", () => {
    const result: ScenarioResult = {
      ...baseResult,
      operation: { action: "swap", project: "Project Alpha" },
      projected: {
        labor: {
          monthly_cost: 65000, monthly_revenue: 80000,
          annual_cost: 780000, annual_revenue: 960000,
          blended_cost_rate: 150, blended_bill_rate: 190,
          fte_count: 2.75, headcount: 3,
        },
        margin: {
          margin_pct: 18.8, margin_dollars_monthly: 15000,
          margin_dollars_annual: 180000, gross_margin_pct: 18.8,
          contribution_margin: 15000, net_direct_labor_multiplier: 1.23,
        },
        budget: {
          monthly_burn_rate: 65000, remaining_budget: 765000,
          months_remaining: 11.8, budget_exhaustion_date: "2026-12-15",
          annual_run_rate: 780000,
        },
      },
      impact: {
        cost_delta_monthly: -11500, cost_delta_annual: -138000,
        revenue_delta_monthly: -15000, revenue_delta_annual: -180000,
        margin_delta_pct: -0.7, margin_delta_dollars_monthly: -3500,
        burn_rate_delta: -11500, burn_rate_delta_pct: -15.0,
        months_remaining_delta: 1.8, headcount_delta: 0, fte_delta: 0,
      },
    };

    const narrative = generateNarrative(result);
    expect(narrative).toContain("## Financial Delta");
    expect(narrative).toContain("Before");
    expect(narrative).toContain("After");
    expect(narrative).toContain("decrease");
    expect(narrative).toContain("$-11,500");
  });

  it("generates a narrative for portfolio analysis", () => {
    const result: ScenarioResult = {
      ...baseResult,
      project_name: undefined,
      projects_involved: ["Project Alpha", "Project Beta", "Project Gamma"],
      portfolio: {
        total_burn: 180000,
        total_margin_pct: 25.3,
        total_margin_dollars: 61000,
        project_summaries: [
          { name: "Project Alpha", monthly_burn: 76500, margin_pct: 19.5, months_remaining: 10.0 },
          { name: "Project Beta", monthly_burn: 72000, margin_pct: 28.1, months_remaining: 2.5 },
          { name: "Project Gamma", monthly_burn: 31500, margin_pct: 29.6, months_remaining: 14.9 },
        ],
      },
    };

    const narrative = generateNarrative(result);
    expect(narrative).toContain("## Portfolio Overview");
    expect(narrative).toContain("Project Alpha");
    expect(narrative).toContain("Project Beta");
    expect(narrative).toContain("2.5");
    expect(narrative).toContain("## Risks");
    // Beta at 2.5 months should trigger a risk
    expect(narrative).toContain("budget remaining");
  });

  it("generates a narrative for EVM analysis", () => {
    const result: ScenarioResult = {
      ...baseResult,
      operation: { action: "evm_analysis", project: "Project Alpha" },
      evm: {
        bac: 1250000, ac: 485000, pv: 600000, ev: 480000,
        cpi: 0.99, spi: 0.80, cv: -5000, sv: -120000,
        eac_typical: 1262626, eac_atypical: 1255000, eac_mixed: 1269841,
        etc: 777626, vac: -12626, tcpi: 1.01,
      },
    };

    const narrative = generateNarrative(result);
    expect(narrative).toContain("## Earned Value Metrics");
    expect(narrative).toContain("CPI");
    expect(narrative).toContain("SPI");
    expect(narrative).toContain("Behind schedule");
  });

  it("includes warnings from the engine", () => {
    const result: ScenarioResult = {
      ...baseResult,
      warnings: ["Budget running low", "Schedule at risk"],
    };

    const narrative = generateNarrative(result);
    expect(narrative).toContain("Budget running low");
    expect(narrative).toContain("Schedule at risk");
  });
});

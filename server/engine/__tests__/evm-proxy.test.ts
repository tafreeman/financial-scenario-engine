import { describe, it, expect } from "vitest";
import { executeScenario } from "../executor.js";
import { calcEarnedValue } from "../evm.js";
import type {
  LaborCategory,
  PortfolioSnapshot,
  ProjectSnapshot,
  ScenarioOperation,
} from "../types.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────
// A single project with a clean 40% spend ratio (AC / BAC = 400k / 1M) so the
// spend-ratio proxy and an explicit percent_complete are easy to tell apart.

const BAC = 1_000_000;
const AC = 400_000; // → spend-ratio proxy = 40% complete

const categories: LaborCategory[] = [
  { id: 1, name: "Senior Developer", bill_rate: 245, cost_rate: 185 },
];

function makePortfolio(percent_complete?: number): PortfolioSnapshot {
  const project: ProjectSnapshot = {
    id: 1,
    name: "Test Project",
    total_budget: BAC,
    spent_to_date: AC,
    start_date: "2025-10-01",
    end_date: "2026-09-30",
    status: "active",
    ...(percent_complete !== undefined ? { percent_complete } : {}),
    staffing: [
      {
        id: 1, project_id: 1, project_name: "Test Project",
        labor_category_id: 1, labor_category: "Senior Developer",
        person_name: "J. Smith", hours_per_week: 40,
        bill_rate: 245, cost_rate: 185, is_active: 1,
      },
    ],
  };
  return { projects: [project], labor_categories: categories };
}

const evmOp: ScenarioOperation = { action: "evm_analysis", project: "Test Project" };

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("handleEvmAnalysis percent-complete source", () => {
  it("falls back to the spend-ratio proxy when percent_complete is absent", () => {
    const result = executeScenario(evmOp, makePortfolio());
    const proxyPct = (AC / BAC) * 100;
    // EV must be derived from the spend-ratio proxy (AC/BAC), per the disclosure.
    expect(result.evm?.ev).toBe(calcEarnedValue(proxyPct, BAC));
    expect(result.evm?.bac).toBe(BAC);
    expect(result.evm?.ac).toBe(AC);
  });

  it("uses an explicit percent_complete value when provided", () => {
    const result = executeScenario(evmOp, makePortfolio(75));
    // EV is driven by the explicit progress signal, not the spend ratio…
    expect(result.evm?.ev).toBe(calcEarnedValue(75, BAC));
    // …and that value is distinct from what the proxy would have produced.
    expect(result.evm?.ev).not.toBe(calcEarnedValue((AC / BAC) * 100, BAC));
  });

  it("clamps an explicit percent_complete above 100", () => {
    const result = executeScenario(evmOp, makePortfolio(150));
    expect(result.evm?.ev).toBe(calcEarnedValue(100, BAC));
  });

  it("clamps a negative explicit percent_complete to 0", () => {
    const result = executeScenario(evmOp, makePortfolio(-10));
    expect(result.evm?.ev).toBe(calcEarnedValue(0, BAC));
  });
});

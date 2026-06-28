/**
 * Executor guard tests — covering the three wave-3 fixes:
 *
 * 1. Fix #13 (non-empty portfolio): when the caller names a specific project that
 *    does not exist in a NON-empty portfolio, project-level actions must return an
 *    error result naming the unknown project rather than silently operating on
 *    portfolio.projects[0].  Portfolio-level actions (burn_rate_check,
 *    margin_analysis) must continue to fall back to portfolio-wide behavior.
 *
 * 2. Fix #2 (sumImpacts pct suppression): for multi-project composites the
 *    aggregate impact must omit margin_delta_pct and burn_rate_delta_pct (both
 *    undefined) while still summing dollar/headcount/fte deltas correctly.
 *    Single-project composites must still report a meaningful margin_delta_pct.
 *
 * 3. Fix #3 (reallocation projectNames guard): a reallocation with fewer than 2
 *    project names must return a clean error result rather than crashing or
 *    producing undefined-named output.
 */

import { describe, it, expect } from "vitest";
import { executeScenario } from "../executor.js";
import type {
  PortfolioSnapshot,
  ProjectSnapshot,
  ScenarioOperation,
  StaffingRecord,
  LaborCategory,
} from "../types.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const labor_categories: LaborCategory[] = [
  { id: 1, name: "Lead Architect",      bill_rate: 285, cost_rate: 210 },
  { id: 2, name: "Senior Developer",    bill_rate: 245, cost_rate: 185 },
  { id: 3, name: "Mid-level Developer", bill_rate: 185, cost_rate: 135 },
  { id: 4, name: "Junior Developer",    bill_rate: 135, cost_rate: 95  },
  { id: 5, name: "Business Analyst",    bill_rate: 175, cost_rate: 125 },
  { id: 6, name: "QA Engineer",         bill_rate: 165, cost_rate: 115 },
  { id: 7, name: "Project Manager",     bill_rate: 225, cost_rate: 165 },
];

function makeStaff(
  id: number,
  projectId: number,
  projectName: string,
  catId: number,
  personName: string,
  hours: number
): StaffingRecord {
  const cat = labor_categories.find(c => c.id === catId)!;
  return {
    id,
    project_id: projectId,
    project_name: projectName,
    labor_category_id: catId,
    labor_category: cat.name,
    person_name: personName,
    hours_per_week: hours,
    bill_rate: cat.bill_rate,
    cost_rate: cat.cost_rate,
    is_active: 1,
  };
}

const alphaSnapshot: ProjectSnapshot = {
  id: 1, name: "Project Alpha", total_budget: 1_250_000, spent_to_date: 485_000,
  start_date: "2025-10-01", end_date: "2026-09-30", status: "active",
  staffing: [
    makeStaff(1, 1, "Project Alpha", 2, "J. Smith", 40),
    makeStaff(2, 1, "Project Alpha", 3, "K. Chen",  40),
    makeStaff(3, 1, "Project Alpha", 5, "L. Park",  30),
  ],
};

const betaSnapshot: ProjectSnapshot = {
  id: 2, name: "Project Beta", total_budget: 2_100_000, spent_to_date: 1_340_000,
  start_date: "2025-04-01", end_date: "2026-03-31", status: "active",
  staffing: [
    makeStaff(4, 2, "Project Beta", 1, "M. Jones",  40),
    makeStaff(5, 2, "Project Beta", 2, "N. Davis",  40),
    makeStaff(6, 2, "Project Beta", 6, "P. Wilson", 40),
  ],
};

/** Non-empty two-project portfolio */
const twoProjectPortfolio: PortfolioSnapshot = {
  projects: [alphaSnapshot, betaSnapshot],
  labor_categories,
};

/** Single-project portfolio — used to verify portfolio-level fall-back still works */
const singleProjectPortfolio: PortfolioSnapshot = {
  projects: [alphaSnapshot],
  labor_categories,
};

const PINNED = new Date("2026-04-15T12:00:00.000Z");

// ─── Fix #13: unknown project in a NON-empty portfolio ───────────────────────

describe("Fix #13 — unknown project name against a non-empty portfolio", () => {
  const UNKNOWN = "NoSuchProject";

  const projectLevelActions: { name: string; op: ScenarioOperation }[] = [
    {
      name: "add",
      op: { action: "add", project: UNKNOWN, add: [{ role: "Senior Developer", count: 1 }] },
    },
    {
      name: "remove",
      op: { action: "remove", project: UNKNOWN, remove: [{ role: "Senior Developer", count: 1 }] },
    },
    {
      name: "swap",
      op: {
        action: "swap",
        project: UNKNOWN,
        remove: [{ role: "Senior Developer", count: 1 }],
        add:    [{ role: "Mid-level Developer", count: 1 }],
      },
    },
    {
      name: "rate_change",
      op: { action: "rate_change", project: UNKNOWN, rate_changes: [{ role: "Senior Developer", new_bill_rate: 300 }] },
    },
    {
      name: "hours_change",
      op: { action: "hours_change", project: UNKNOWN, hours_changes: [{ person_name: "J. Smith", new_hours_per_week: 20 }] },
    },
    {
      name: "evm_analysis",
      op: { action: "evm_analysis", project: UNKNOWN },
    },
    {
      name: "timeline_extension",
      op: { action: "timeline_extension", project: UNKNOWN, extension_months: 3 },
    },
    {
      name: "unexpected_cost",
      op: {
        action: "unexpected_cost",
        project: UNKNOWN,
        additional_costs: [{ description: "License", amount: 50_000, is_recurring: false }],
      },
    },
  ];

  for (const { name, op } of projectLevelActions) {
    it(`action "${name}" returns an error naming the unknown project — not financials for the first project`, () => {
      const result = executeScenario(op, twoProjectPortfolio, PINNED);

      // Must carry a non-empty error field
      expect(result.error).toBeTruthy();
      expect(result.error).toContain(UNKNOWN);

      // The financials must be zero (no numbers for an unintended project)
      expect(result.current.labor.monthly_cost).toBe(0);
      expect(result.current.labor.headcount).toBe(0);

      // projects_involved must be empty — no project was actually resolved
      expect(result.projects_involved).toHaveLength(0);

      // project_name must NOT be alphaSnapshot.name (we must not have silently
      // fallen through to portfolio.projects[0])
      expect(result.project_name).not.toBe(alphaSnapshot.name);
    });
  }

  it('#7: evm_analysis with a named-but-unknown project against a non-empty portfolio returns result.error (no silent projects[0] fallback)', () => {
    const result = executeScenario(
      { action: "evm_analysis", project: "NoSuchProject" },
      twoProjectPortfolio,
      PINNED
    );

    expect(result.error).toBeTruthy();
    expect(result.error).toContain("NoSuchProject");
    // Must NOT have silently produced EVM for the first project.
    expect(result.evm).toBeUndefined();
    expect(result.project_name).not.toBe(alphaSnapshot.name);
    expect(result.projects_involved).toHaveLength(0);
  });

  it("burn_rate_check with unknown project still falls back to portfolio-wide analysis", () => {
    const result = executeScenario(
      { action: "burn_rate_check", project: UNKNOWN },
      twoProjectPortfolio,
      PINNED
    );

    // No hard error — this action is portfolio-level and the fall-back is intentional
    expect(result.error).toBeUndefined();

    // Should have a warning explaining the fall-back
    expect(result.warnings.some(w => w.includes(UNKNOWN))).toBe(true);

    // Should contain data for ALL portfolio projects
    expect(result.projects_involved.length).toBe(twoProjectPortfolio.projects.length);
  });

  it("margin_analysis with unknown project still falls back to portfolio-wide analysis", () => {
    const result = executeScenario(
      { action: "margin_analysis", project: UNKNOWN },
      twoProjectPortfolio,
      PINNED
    );

    expect(result.error).toBeUndefined();
    expect(result.warnings.some(w => w.includes(UNKNOWN))).toBe(true);
    expect(result.projects_involved.length).toBe(twoProjectPortfolio.projects.length);
  });

  it("burn_rate_check with no project still works portfolio-wide (original behaviour preserved)", () => {
    const result = executeScenario(
      { action: "burn_rate_check" },
      twoProjectPortfolio,
      PINNED
    );

    expect(result.error).toBeUndefined();
    expect(result.projects_involved.length).toBe(twoProjectPortfolio.projects.length);
    expect(result.current.labor.monthly_cost).toBeGreaterThan(0);
  });
});

// ─── Fix #2: sumImpacts percentage-delta suppression for multi-project composites ─

describe("Fix #2 — sumImpacts: pct deltas suppressed for multi-project composites", () => {
  it("two-project composite has undefined margin_delta_pct and burn_rate_delta_pct", () => {
    // Two sub-ops on DIFFERENT projects — makes multiProject = true
    const compositeResult = executeScenario(
      {
        action: "what_if_composite",
        sub_operations: [
          {
            action: "remove",
            project: "Project Alpha",
            remove: [{ role: "Senior Developer", count: 1 }],
          },
          {
            action: "remove",
            project: "Project Beta",
            remove: [{ role: "QA Engineer", count: 1 }],
          },
        ],
      },
      twoProjectPortfolio,
      PINNED
    );

    const impact = compositeResult.impact;
    expect(impact).toBeDefined();

    // Pct deltas must be omitted for multi-project composites (non-additive)
    expect(impact!.margin_delta_pct).toBeUndefined();
    expect(impact!.burn_rate_delta_pct).toBeUndefined();

    // Dollar/headcount deltas must still be summed (they ARE additive)
    expect(impact!.cost_delta_monthly).toBeLessThan(0); // two removes → cost decreases
    expect(impact!.headcount_delta).toBe(-2);           // removed one from each project
  });

  it("two-project composite cost_delta_monthly equals sum of individual removes", () => {
    const alphaRemoveResult = executeScenario(
      { action: "remove", project: "Project Alpha", remove: [{ role: "Senior Developer", count: 1 }] },
      twoProjectPortfolio,
      PINNED
    );
    const betaRemoveResult = executeScenario(
      { action: "remove", project: "Project Beta", remove: [{ role: "QA Engineer", count: 1 }] },
      twoProjectPortfolio,
      PINNED
    );

    const compositeResult = executeScenario(
      {
        action: "what_if_composite",
        sub_operations: [
          { action: "remove", project: "Project Alpha", remove: [{ role: "Senior Developer", count: 1 }] },
          { action: "remove", project: "Project Beta",  remove: [{ role: "QA Engineer",       count: 1 }] },
        ],
      },
      twoProjectPortfolio,
      PINNED
    );

    const expectedCostDelta =
      (alphaRemoveResult.impact?.cost_delta_monthly ?? 0) +
      (betaRemoveResult.impact?.cost_delta_monthly ?? 0);

    expect(compositeResult.impact?.cost_delta_monthly).toBeCloseTo(expectedCostDelta, 2);
  });

  it("same-project composite still reports a meaningful margin_delta_pct", () => {
    // Two sub-ops on the SAME project — makes multiProject = false
    const compositeResult = executeScenario(
      {
        action: "what_if_composite",
        sub_operations: [
          {
            action: "remove",
            project: "Project Alpha",
            remove: [{ role: "Senior Developer", count: 1 }],
          },
          {
            action: "add",
            project: "Project Alpha",
            add: [{ role: "Junior Developer", count: 1, hours_per_week: 40 }],
          },
        ],
      },
      singleProjectPortfolio,
      PINNED
    );

    const impact = compositeResult.impact;
    expect(impact).toBeDefined();

    // For a single-project composite, pct deltas must be present and finite
    expect(impact!.margin_delta_pct).toBeDefined();
    expect(Number.isFinite(impact!.margin_delta_pct)).toBe(true);
    expect(impact!.burn_rate_delta_pct).toBeDefined();
    expect(Number.isFinite(impact!.burn_rate_delta_pct)).toBe(true);
  });
});

// ─── Fix #3: reallocation with fewer than 2 project names returns clean error ─

describe("Fix #3 — handleReallocation: short projectNames guard", () => {
  it("reallocation with 0 projects returns a clean error (not a crash)", () => {
    const result = executeScenario(
      {
        action: "reallocation",
        projects: [],
        remove: [{ role: "Senior Developer", count: 1 }],
        add:    [{ role: "Junior Developer",  count: 1 }],
      },
      twoProjectPortfolio,
      PINNED
    );

    // Handler falls back to burn_rate_check portfolio analysis when < 2 names given
    // (reallocation.projects.length < 2 => existing warning path)
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.error).toBeUndefined(); // the < 2 path warns, not errors
  });

  it("reallocation with exactly 1 project name falls back gracefully", () => {
    const result = executeScenario(
      {
        action: "reallocation",
        projects: ["Project Alpha"],
        remove: [{ role: "Senior Developer", count: 1 }],
        add:    [{ role: "Junior Developer",  count: 1 }],
      },
      twoProjectPortfolio,
      PINNED
    );

    expect(result.warnings.some(w => w.toLowerCase().includes("reallocation"))).toBe(true);
    // Must not crash and must produce a usable result envelope
    expect(result.projects_involved).toBeDefined();
    expect(result.current).toBeDefined();
  });

  it("reallocation with valid two-project names succeeds and has no error", () => {
    const result = executeScenario(
      {
        action: "reallocation",
        projects: ["Project Alpha", "Project Beta"],
        remove: [{ role: "Senior Developer", count: 1 }],
        add:    [{ role: "Mid-level Developer", count: 1, hours_per_week: 40 }],
      },
      twoProjectPortfolio,
      PINNED
    );

    expect(result.error).toBeUndefined();
    expect(result.projects_involved).toContain("Project Alpha");
    expect(result.projects_involved).toContain("Project Beta");
    expect(result.sub_results).toHaveLength(2);
  });
});

// ─── FIX (mergeProjectedState resolved name): abbreviated project name in composite ─
//
// Regression: when the user supplies an abbreviated project name (e.g. "Alpha"
// instead of "Project Alpha"), the first sub-op fuzzy-matches correctly and
// produces the right result.  However, mergeProjectedState was using the raw
// subOp.project string ("Alpha") for the case-insensitive exact-compare against
// portfolio.projects, which always failed, leaving the accumulated portfolio
// unchanged.  Subsequent sub-ops then saw the original un-mutated project state.
//
// Fix threads result.project_name (the resolved canonical name, "Project Alpha")
// into mergeProjectedState so the portfolio is correctly patched.

describe("mergeProjectedState resolved name — abbreviated project name in composite", () => {
  it("two sequential same-project sub-ops with abbreviated name mutate state correctly", () => {
    // Both sub-ops target "Alpha" (abbreviated) rather than "Project Alpha".
    // Sub-op 1: remove one Senior Dev.
    // Sub-op 2: add one Junior Dev.
    // If mergeProjectedState uses the raw "Alpha" string for matching, sub-op 2
    // will see the original headcount (no removal applied), and the aggregate
    // headcount_delta will be wrong (net 0 instead of net 0 from remove+add, but
    // the projected state after sub-op 1 should reflect the removal).
    const compositeResult = executeScenario(
      {
        action: "what_if_composite",
        sub_operations: [
          {
            action: "remove",
            project: "Alpha",  // abbreviated — requires fuzzy match
            remove: [{ role: "Senior Developer", count: 1 }],
          },
          {
            action: "add",
            project: "Alpha",  // abbreviated — same project
            add: [{ role: "Junior Developer", count: 1, hours_per_week: 40 }],
          },
        ],
      },
      singleProjectPortfolio,
      PINNED
    );

    expect(compositeResult.error).toBeUndefined();

    // Both sub-results must resolve to Project Alpha (not an error)
    expect(compositeResult.sub_results).toHaveLength(2);
    const removeResult = compositeResult.sub_results![0]!;
    const addResult = compositeResult.sub_results![1]!;

    expect(removeResult.error).toBeUndefined();
    expect(removeResult.project_name).toBe("Project Alpha");

    expect(addResult.error).toBeUndefined();
    expect(addResult.project_name).toBe("Project Alpha");

    // After the remove sub-op the accumulated portfolio must have one fewer
    // Senior Dev, so the add sub-op's "current" headcount must reflect that
    // reduction — not the original 3.
    // Original staffing: J.Smith (Senior Dev), K.Chen (Mid Dev), L.Park (BA) = headcount 3
    // After removing 1 Senior Dev: headcount 2.
    // The add sub-op's current state (before the add) should show headcount 2.
    expect(addResult.current.labor.headcount).toBe(2);

    // Net composite impact: remove 1 Senior Dev, add 1 Junior Dev → headcount_delta = 0
    expect(compositeResult.impact?.headcount_delta).toBe(0);
  });

  it("abbreviated project name sub-op produces the same cost delta as the exact name", () => {
    // Sanity check: abbreviated and exact names should produce the same result
    // for a single sub-op (the fuzzy match is already known to work for simple ops).
    const exactResult = executeScenario(
      { action: "remove", project: "Project Alpha", remove: [{ role: "Senior Developer", count: 1 }] },
      singleProjectPortfolio,
      PINNED
    );
    const abbrResult = executeScenario(
      { action: "remove", project: "Alpha", remove: [{ role: "Senior Developer", count: 1 }] },
      singleProjectPortfolio,
      PINNED
    );

    expect(abbrResult.error).toBeUndefined();
    expect(abbrResult.project_name).toBe(exactResult.project_name);
    expect(abbrResult.impact?.cost_delta_monthly).toBeCloseTo(
      exactResult.impact?.cost_delta_monthly ?? 0,
      2
    );
  });
});

// ─── Invalid new_end_date guard: a direct call must not throw RangeError ──────
//
// The boundary schema (validation.ts) rejects a malformed new_end_date, but a
// direct executeScenario call bypasses it. An unparseable date string previously
// produced an Invalid Date whose toISOString() threw RangeError on the hot path.

describe("timeline_extension — invalid new_end_date does not throw", () => {
  it("returns a clean result instead of a RangeError for an unparseable date", () => {
    const op: ScenarioOperation = {
      action: "timeline_extension",
      project: "Project Alpha",
      new_end_date: "not-a-date",
    };

    expect(() => executeScenario(op, singleProjectPortfolio, PINNED)).not.toThrow();

    const result = executeScenario(op, singleProjectPortfolio, PINNED);
    expect(result).toBeDefined();
    expect(result.current).toBeDefined();
  });
});

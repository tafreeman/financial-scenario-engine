/**
 * Integration test for #2 — percent_complete DB persistence path.
 *
 * Before this fix, `percent_complete` had no column, no allowlist entry, was not
 * SELECTed by getProjectsWithBurn(), and was not mapped by loadPortfolioSnapshot().
 * As a result the engine could never see an explicit progress signal coming from
 * the database, and EVM always fell back to the spend-ratio proxy (EV ≈ AC), which
 * pins CPI (EV / AC) to ~1.0 regardless of true cost efficiency.
 *
 * This test exercises the full persistence path end-to-end against the live
 * (in-memory) SQLite DB:
 *   addProject → updateProject({ percent_complete }) → getProjectsWithBurn()
 *   → loadPortfolioSnapshot() → executeScenario(evm_analysis)
 *
 * Done-when: a project row with percent_complete = 75 (deliberately ≠ the
 * spent/budget ratio) reaches handleEvmAnalysis and yields a CPI that diverges
 * from the ~1.0 the spend-ratio proxy would produce.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { getDb, addProject, addStaffing, updateProject, getProjectsWithBurn } from "../db.js";
import { loadPortfolioSnapshot } from "../loaders.js";
import { executeScenario } from "../engine/executor.js";
import type { ScenarioOperation } from "../engine/types.js";

describe("percent_complete persistence → EVM (integration)", () => {
  let projectName: string;

  // Budget/spend chosen so the spend-ratio proxy and the explicit progress are
  // clearly distinct: AC / BAC = 300k / 1M = 30%, but percent_complete = 75%.
  const BAC = 1_000_000;
  const AC = 300_000;
  const EXPLICIT_PCT = 75;

  beforeAll(() => {
    getDb(); // ensure schema + migration ran

    projectName = `__test_pct_complete_${Date.now()}`;
    const proj = addProject(projectName, BAC, "2025-01-01", "2025-12-31");
    const projectId = Number(proj.lastInsertRowid);

    // spent_to_date and percent_complete are independent signals.
    updateProject(projectId, { spent_to_date: AC, percent_complete: EXPLICIT_PCT });

    // Give the project some staffing so it is a realistic portfolio member.
    const db = getDb();
    const cat = db.prepare("SELECT id FROM labor_categories LIMIT 1").get() as
      | { id: number }
      | undefined;
    const laborCategoryId = cat
      ? cat.id
      : Number(
          db
            .prepare("INSERT INTO labor_categories (name, bill_rate, cost_rate) VALUES (?, ?, ?)")
            .run("Test Category", 200, 150).lastInsertRowid
        );
    addStaffing(projectId, laborCategoryId, "Test Person", 40);
  });

  it("persists percent_complete and surfaces it through getProjectsWithBurn()", () => {
    const row = getProjectsWithBurn().find(p => p.name === projectName);
    expect(row).toBeDefined();
    expect(row!.percent_complete).toBe(EXPLICIT_PCT);
  });

  it("explicit percent_complete reaches handleEvmAnalysis and CPI diverges from the ~1.0 proxy", () => {
    const portfolio = loadPortfolioSnapshot();
    const project = portfolio.projects.find(p => p.name === projectName);
    expect(project).toBeDefined();
    expect(project!.percent_complete).toBe(EXPLICIT_PCT);

    const op: ScenarioOperation = { action: "evm_analysis", project: projectName };
    // Pin the as-of date so PV (and thus the rest of the envelope) is deterministic.
    const result = executeScenario(op, portfolio, new Date("2025-07-01T00:00:00.000Z"));

    expect(result.error).toBeUndefined();
    expect(result.evm).toBeDefined();

    // EV is driven by the explicit 75% progress, not the 30% spend ratio:
    //   EV = 0.75 × BAC = 750,000 ;  CPI = EV / AC = 750,000 / 300,000 = 2.5
    expect(result.evm!.ev).toBe((EXPLICIT_PCT / 100) * BAC);
    expect(result.evm!.cpi).toBeCloseTo(((EXPLICIT_PCT / 100) * BAC) / AC, 6);

    // The key behavioural assertion: CPI must NOT be pinned to ~1.0 the way the
    // spend-ratio proxy (EV ≈ AC) would force it.
    expect(Math.abs(result.evm!.cpi - 1.0)).toBeGreaterThan(0.5);
  });
});

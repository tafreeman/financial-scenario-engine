/**
 * Tests for Fix #18 — dashboard soft-delete filter.
 *
 * The dashboard route calls getStaffingByProject(undefined, true) to exclude
 * soft-deleted staff (is_active = 0) from totalRevenue / totalCost /
 * blendedMargin calculations.  Before this fix, getStaffingByProject() with
 * no activeOnly flag returned ALL staffing records, so soft-deleted staff
 * still contributed to dashboard totals — diverging from the engine
 * (loadPortfolioSnapshot already skips is_active !== 1).
 *
 * Done-when: A staff member soft-deleted via removeStaffing() no longer
 * contributes to getStaffingByProject(undefined, true) results.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { getDb, addProject, addStaffing, removeStaffing, getStaffingByProject } from "../db.js";

describe("getStaffingByProject — activeOnly filter", () => {
  let projectId: number;
  let activeStaffId: number;
  let deletedStaffId: number;

  beforeAll(() => {
    getDb(); // ensure schema is initialised

    // Create a dedicated test project to avoid interference with seed data
    const proj = addProject(
      `__test_active_filter_${Date.now()}`,
      200_000,
      "2025-01-01",
      "2025-12-31"
    );
    projectId = Number(proj.lastInsertRowid);

    // Add two staffing records — laborCategoryId=2 (Senior Developer from seed)
    const active = addStaffing(projectId, 2, "Active Person", 40);
    activeStaffId = Number(active.lastInsertRowid);

    const deleted = addStaffing(projectId, 3, "Deleted Person", 40);
    deletedStaffId = Number(deleted.lastInsertRowid);

    // Soft-delete one of them
    removeStaffing(deletedStaffId);
  });

  it("returns all staffing (including inactive) when activeOnly is false (default)", () => {
    const all = getStaffingByProject(projectId, false) as Array<{ id: number; is_active: number }>;
    const ids = all.map(s => s.id);
    expect(ids).toContain(activeStaffId);
    expect(ids).toContain(deletedStaffId);
  });

  it("excludes soft-deleted staff when activeOnly is true", () => {
    const active = getStaffingByProject(projectId, true) as Array<{ id: number; is_active: number }>;
    const ids = active.map(s => s.id);
    expect(ids).toContain(activeStaffId);
    expect(ids).not.toContain(deletedStaffId);
  });

  it("all returned records have is_active = 1 when activeOnly is true", () => {
    const active = getStaffingByProject(projectId, true) as Array<{ is_active: number }>;
    for (const s of active) {
      expect(s.is_active).toBe(1);
    }
  });

  it("soft-deleted staff do not contribute to dashboard totals", () => {
    // Simulate what the dashboard route does: sum monthly_revenue across active-only staffing
    const allStaff = getStaffingByProject(undefined, false) as Array<{
      is_active: number;
      monthly_revenue: number;
      monthly_cost: number;
      id: number;
    }>;
    const activeStaff = getStaffingByProject(undefined, true) as Array<{
      is_active: number;
      monthly_revenue: number;
      monthly_cost: number;
      id: number;
    }>;

    const deletedRecord = allStaff.find(s => s.id === deletedStaffId);
    expect(deletedRecord).toBeDefined();
    expect(deletedRecord!.is_active).toBe(0);

    // The deleted record must not be present in the active-only result
    const deletedInActive = activeStaff.find(s => s.id === deletedStaffId);
    expect(deletedInActive).toBeUndefined();

    // Revenue/cost from the deleted record must not appear in active totals
    const activeRevenue = activeStaff.reduce((sum, s) => sum + s.monthly_revenue, 0);
    const allRevenue = allStaff.reduce((sum, s) => sum + s.monthly_revenue, 0);

    // Active-only total must be strictly less than all-staff total
    // (because the deleted record has positive monthly_revenue)
    expect(deletedRecord!.monthly_revenue).toBeGreaterThan(0);
    expect(activeRevenue).toBeLessThan(allRevenue);
  });
});

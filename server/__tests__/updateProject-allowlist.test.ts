/**
 * Tests for Fix #2 — column-injection protection in updateProject and PATCH /projects/:id.
 *
 * Two layers of defence are verified:
 *   1. Route-layer Zod validation (patchProjectSchema) rejects unknown keys before
 *      the DB function is ever reached — this prevents column-name injection.
 *   2. DB-layer updateProject allowlist silently skips any key not in the
 *      PROJECT_UPDATE_ALLOWED set — defence-in-depth if the schema is bypassed.
 *
 * The DB-layer test uses the live SQLite instance so it also acts as a smoke test
 * that the schema initialises and that valid updates round-trip correctly.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";

// ─── 1. Route-layer schema (mirrors the schema defined in routes.ts) ──────────
// We re-declare it here rather than exporting it from routes.ts so the tests
// don't pull in Express/multer and all their side-effects.

const patchProjectSchema = z.object({
  name: z.string().min(1).optional(),
  total_budget: z.number().nonnegative().optional(),
  spent_to_date: z.number().nonnegative().optional(),
  status: z.string().min(1).optional(),
}).strict();

describe("patchProjectSchema — route-layer validation", () => {
  it("accepts a valid partial update", () => {
    expect(patchProjectSchema.safeParse({ name: "New Name", status: "active" }).success).toBe(true);
    expect(patchProjectSchema.safeParse({ total_budget: 500000 }).success).toBe(true);
    expect(patchProjectSchema.safeParse({ spent_to_date: 100000 }).success).toBe(true);
  });

  it("rejects an attempt to overwrite created_at", () => {
    const result = patchProjectSchema.safeParse({ created_at: "2000-01-01" });
    expect(result.success).toBe(false);
  });

  it("rejects an attempt to overwrite id", () => {
    const result = patchProjectSchema.safeParse({ id: 99 });
    expect(result.success).toBe(false);
  });

  it("rejects attempts to write arbitrary unknown columns", () => {
    expect(patchProjectSchema.safeParse({ updated_at: "2000-01-01" }).success).toBe(false);
    expect(patchProjectSchema.safeParse({ evil_col: "DROP TABLE projects" }).success).toBe(false);
  });

  it("rejects an empty name string", () => {
    expect(patchProjectSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("rejects a negative total_budget", () => {
    expect(patchProjectSchema.safeParse({ total_budget: -1 }).success).toBe(false);
  });

  it("accepts an empty object (no-op update)", () => {
    expect(patchProjectSchema.safeParse({}).success).toBe(true);
  });
});

// ─── 2. DB-layer allowlist — updateProject ───────────────────────────────────
// The DB_PATH is derived from the server directory at import time; when vitest
// runs the working directory is the project root, so the relative path resolves
// correctly.  We seed a project, try to inject via the raw fields object, and
// verify the column is not changed.

import { getDb, addProject, updateProject } from "../db.js";

describe("updateProject — DB-layer allowlist", () => {
  let testProjectId: number;

  beforeAll(() => {
    // Ensure the schema is initialised (getDb triggers initSchema idempotently).
    getDb();
    const result = addProject(
      `__test_allowlist_${Date.now()}`,
      100_000,
      "2025-01-01",
      "2025-12-31"
    );
    testProjectId = Number(result.lastInsertRowid);
  });

  it("updates an allowed column (name)", () => {
    const newName = `__renamed_${Date.now()}`;
    updateProject(testProjectId, { name: newName } as Parameters<typeof updateProject>[1]);
    const db = getDb();
    const row = db
      .prepare("SELECT name FROM projects WHERE id = ?")
      .get(testProjectId) as { name: string };
    expect(row.name).toBe(newName);
  });

  it("does NOT update created_at even when the raw fields object contains it", () => {
    const db = getDb();
    const before = db
      .prepare("SELECT created_at FROM projects WHERE id = ?")
      .get(testProjectId) as { created_at: string };

    // Pass created_at directly — this would break if the allowlist were absent.
    updateProject(
      testProjectId,
      { created_at: "2000-01-01" } as unknown as Parameters<typeof updateProject>[1]
    );

    const after = db
      .prepare("SELECT created_at FROM projects WHERE id = ?")
      .get(testProjectId) as { created_at: string };
    expect(after.created_at).toBe(before.created_at);
  });

  it("does NOT update id even when the raw fields object contains it", () => {
    // Attempting to pass id=99999 should be a no-op (not throw, not change the id).
    expect(() =>
      updateProject(
        testProjectId,
        { id: 99999 } as unknown as Parameters<typeof updateProject>[1]
      )
    ).not.toThrow();

    const db = getDb();
    const row = db
      .prepare("SELECT id FROM projects WHERE id = ?")
      .get(testProjectId) as { id: number };
    expect(row.id).toBe(testProjectId);
  });
});

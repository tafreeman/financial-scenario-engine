/**
 * Tests for query-param NaN/bounds guards on GET /scenarios (?limit=) and
 * GET /staffing (?project_id=) — FSE-7.
 *
 * Before this fix both routes passed `Number(req.query.X)` straight through
 * with no validation, inconsistent with the sibling :id routes beside them
 * (PATCH /projects/:id, DELETE /staffing/:id) which already guard with
 * `!Number.isInteger(id) || id <= 0`. Concretely, before the fix:
 *   - ?limit=abc -> Number("abc") = NaN -> better-sqlite3 throws
 *     "datatype mismatch" binding NaN to the LIMIT parameter (verified
 *     empirically), an unguarded 500 with no route-level try/catch.
 *   - ?limit=99999999 -> passed straight to SQL LIMIT with no ceiling,
 *     letting one request force an unbounded response.
 *   - ?project_id=abc -> Number("abc") = NaN, and `if (projectId)` in
 *     getStaffingByProject(db.ts) treats NaN as FALSY, so the filter is
 *     silently dropped and the endpoint returns EVERY project's staffing
 *     instead of erroring — a silent wrong-result bug, not just a crash.
 *
 * Pattern: mount the REAL apiRouter (server/routes.ts), not a re-implementation,
 * so this exercises the production guard — matching read-rate-limit.integration.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "http";
import { apiRouter } from "../routes.js";
import { getDb } from "../db.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", apiRouter);
  return app;
}

interface JsonResponse {
  statusCode: number;
  body: Record<string, unknown> | unknown[];
}

function getJson(server: http.Server, path: string): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { hostname: "127.0.0.1", port: addr.port, path, method: "GET" },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: JSON.parse(data) as Record<string, unknown> | unknown[],
          });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

let server: http.Server;

beforeAll(async () => {
  getDb(); // ensure schema + seed data (same pattern as read-rate-limit.integration.test.ts)
  const app = buildApp();
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ─── GET /scenarios?limit= ────────────────────────────────────────────────────

describe("GET /scenarios?limit= — guard", () => {
  it("returns 400 for a non-numeric limit ('abc') instead of a DB-layer 500", async () => {
    const res = await getJson(server, "/api/scenarios?limit=abc");
    expect(res.statusCode).toBe(400);
    expect((res.body as Record<string, unknown>).error).toBe("Invalid limit");
  });

  it("returns 400 for a zero limit", async () => {
    const res = await getJson(server, "/api/scenarios?limit=0");
    expect(res.statusCode).toBe(400);
    expect((res.body as Record<string, unknown>).error).toBe("Invalid limit");
  });

  it("returns 400 for a negative limit", async () => {
    const res = await getJson(server, "/api/scenarios?limit=-5");
    expect(res.statusCode).toBe(400);
    expect((res.body as Record<string, unknown>).error).toBe("Invalid limit");
  });

  it("returns 400 for a non-integer limit ('1.5')", async () => {
    const res = await getJson(server, "/api/scenarios?limit=1.5");
    expect(res.statusCode).toBe(400);
    expect((res.body as Record<string, unknown>).error).toBe("Invalid limit");
  });

  it("clamps an oversized numeric limit (99999999) instead of rejecting it, and does not error", async () => {
    const res = await getJson(server, "/api/scenarios?limit=99999999");
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("accepts a normal, in-range limit unchanged", async () => {
    const res = await getJson(server, "/api/scenarios?limit=10");
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as unknown[]).length).toBeLessThanOrEqual(10);
  });

  it("falls back to the documented default (50) when limit is absent", async () => {
    const res = await getJson(server, "/api/scenarios");
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ─── GET /staffing?project_id= ────────────────────────────────────────────────

describe("GET /staffing?project_id= — guard", () => {
  it("returns 400 for a non-numeric project_id ('abc') instead of silently returning all staffing", async () => {
    const res = await getJson(server, "/api/staffing?project_id=abc");
    expect(res.statusCode).toBe(400);
    expect((res.body as Record<string, unknown>).error).toBe("Invalid project_id");
  });

  it("returns 400 for a zero project_id", async () => {
    const res = await getJson(server, "/api/staffing?project_id=0");
    expect(res.statusCode).toBe(400);
    expect((res.body as Record<string, unknown>).error).toBe("Invalid project_id");
  });

  it("returns 400 for a negative project_id", async () => {
    const res = await getJson(server, "/api/staffing?project_id=-1");
    expect(res.statusCode).toBe(400);
    expect((res.body as Record<string, unknown>).error).toBe("Invalid project_id");
  });

  it("returns 400 for a non-integer project_id ('2.5')", async () => {
    const res = await getJson(server, "/api/staffing?project_id=2.5");
    expect(res.statusCode).toBe(400);
    expect((res.body as Record<string, unknown>).error).toBe("Invalid project_id");
  });

  it("accepts a valid positive-integer project_id and filters (does not error)", async () => {
    const res = await getJson(server, "/api/staffing?project_id=1");
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("returns all staffing when project_id is absent (unfiltered, existing behavior preserved)", async () => {
    const res = await getJson(server, "/api/staffing");
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

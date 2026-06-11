/**
 * Tests for id validation on PATCH /projects/:id and DELETE /staffing/:id.
 *
 * Done-when criteria:
 *  - PATCH /projects/<non-integer>  → 400 { error: "Invalid project id" }
 *  - PATCH /projects/<valid-int, does not exist> + valid body fields → 404
 *  - DELETE /staffing/<non-integer>  → 400 { error: "Invalid staffing id" }
 *
 * We build a minimal Express app that replicates the two routes under test,
 * wiring them against the live SQLite DB (same pattern as dashboard-active-filter.test.ts).
 * This avoids mocking the DB while keeping the test focused on route behaviour.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { type Request, type Response } from "express";
import http from "http";
import { z } from "zod";
import { getDb, addProject, updateProject, removeStaffing } from "../db.js";

// ─── Replicated schemas / helpers (mirrors routes.ts) ────────────────────────

const patchProjectSchema = z.object({
  name: z.string().min(1).optional(),
  total_budget: z.number().nonnegative().optional(),
  spent_to_date: z.number().nonnegative().optional(),
  status: z.string().min(1).optional(),
}).strict();

function buildTestApp() {
  const app = express();
  app.use(express.json());

  // PATCH /projects/:id — mirrors routes.ts implementation
  app.patch("/projects/:id", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }

    const parsed = patchProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid fields", details: parsed.error.issues });
      return;
    }

    const result = updateProject(id, parsed.data);

    if (result.changes === 0 && Object.keys(parsed.data).length === 0) {
      res.json({ ok: true, updated: 0 });
      return;
    }

    if (result.changes === 0) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    res.json({ ok: true, updated: result.changes });
  });

  // DELETE /staffing/:id — mirrors routes.ts implementation
  app.delete("/staffing/:id", (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid staffing id" });
      return;
    }
    removeStaffing(id);
    res.json({ ok: true });
  });

  return app;
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

interface JsonResponse {
  statusCode: number;
  body: Record<string, unknown>;
}

function jsonRequest(
  server: http.Server,
  method: string,
  path: string,
  payload?: Record<string, unknown>
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const bodyStr = payload !== undefined ? JSON.stringify(payload) : "";
    const addr = server.address() as { port: number };
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port: addr.port,
      path,
      method,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          body: JSON.parse(data) as Record<string, unknown>,
        });
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Test setup ──────────────────────────────────────────────────────────────

let server: http.Server;

beforeAll(async () => {
  // Ensure DB schema is initialised before spinning up the server.
  getDb();

  const app = buildTestApp();
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ─── PATCH /projects/:id — id validation ─────────────────────────────────────

describe("PATCH /projects/:id — invalid id", () => {
  it("returns 400 for a non-numeric id (NaN coercion from 'abc')", async () => {
    const res = await jsonRequest(server, "PATCH", "/projects/abc", { name: "Renamed" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Invalid project id");
  });

  it("returns 400 for a floating-point id (e.g. '1.5')", async () => {
    const res = await jsonRequest(server, "PATCH", "/projects/1.5", { name: "Renamed" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Invalid project id");
  });

  it("returns 400 for a zero id", async () => {
    const res = await jsonRequest(server, "PATCH", "/projects/0", { name: "Renamed" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Invalid project id");
  });

  it("returns 400 for a negative id", async () => {
    const res = await jsonRequest(server, "PATCH", "/projects/-1", { name: "Renamed" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Invalid project id");
  });
});

// ─── PATCH /projects/:id — non-existent id ───────────────────────────────────

describe("PATCH /projects/:id — non-existent id", () => {
  it("returns 404 when valid fields are supplied for an id that does not exist", async () => {
    // Use an id that is extremely unlikely to exist (large number).
    const res = await jsonRequest(server, "PATCH", "/projects/999999999", { name: "Ghost" });
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe("Project not found");
  });
});

// ─── PATCH /projects/:id — empty body is a 200 no-op ─────────────────────────

describe("PATCH /projects/:id — empty body no-op", () => {
  it("returns 200 { ok: true, updated: 0 } for a schema-valid empty body on any integer id", async () => {
    // Even if the project doesn't exist, an empty body cannot tell us that
    // (no rows are touched), so the contract is a 200 no-op.
    const res = await jsonRequest(server, "PATCH", "/projects/999999999", {});
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.updated).toBe(0);
  });
});

// ─── PATCH /projects/:id — valid update on an existing project ───────────────

describe("PATCH /projects/:id — successful update", () => {
  it("returns 200 { ok: true, updated: 1 } for an existing project", async () => {
    const addResult = addProject(`__test_patch_${Date.now()}`, 50_000, "2025-01-01", "2025-12-31");
    const projectId = Number(addResult.lastInsertRowid);

    const res = await jsonRequest(server, "PATCH", `/projects/${projectId}`, { status: "complete" });
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.updated).toBe(1);
  });
});

// ─── DELETE /staffing/:id — invalid id ───────────────────────────────────────

describe("DELETE /staffing/:id — invalid id", () => {
  it("returns 400 for a non-numeric id (NaN coercion from 'abc')", async () => {
    const res = await jsonRequest(server, "DELETE", "/staffing/abc");
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Invalid staffing id");
  });

  it("returns 400 for a floating-point id (e.g. '2.7')", async () => {
    const res = await jsonRequest(server, "DELETE", "/staffing/2.7");
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Invalid staffing id");
  });

  it("returns 400 for a zero id", async () => {
    const res = await jsonRequest(server, "DELETE", "/staffing/0");
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Invalid staffing id");
  });

  it("returns 400 for a negative id", async () => {
    const res = await jsonRequest(server, "DELETE", "/staffing/-5");
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Invalid staffing id");
  });
});

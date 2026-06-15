/**
 * Regression guard for the auth-on-mutating-routes security fix.
 *
 * Unlike the other route tests in this directory (which re-implement the routes
 * inline against a minimal Express app), this test IMPORTS AND MOUNTS THE REAL
 * apiRouter from server/routes.ts. That is the whole point: the auth gap shipped
 * precisely because the existing tests exercised hand-copied route handlers
 * instead of the production router, so a missing requireAppToken on the real
 * router went undetected. Mounting the real apiRouter means this test FAILS the
 * moment any of the six mutating routes drops its requireAppToken guard.
 *
 * Coverage — for every DB-mutating route, assert:
 *   1. request WITHOUT x-app-token            → 401  (guard rejects)
 *   2. request WITH the correct x-app-token    → NOT 401 (auth passes; a 2xx or
 *      a 4xx validation error is acceptable — we only care that auth let it
 *      through, not that the body was valid)
 *
 * Routes under guard:
 *   POST   /api/projects
 *   PATCH  /api/projects/:id
 *   POST   /api/staffing
 *   DELETE /api/staffing/:id
 *   POST   /api/import/excel        (auth MUST run before multer)
 *   POST   /api/import/excel/v2     (auth MUST run before multer)
 *
 * Token sourcing: we use APP_SECRET exported from server/auth.ts as the valid
 * token. APP_SECRET is whatever the auth module resolved at load time — either
 * APP_API_TOKEN (pinned in vitest.config.ts) or an auto-generated value — so
 * this is correct regardless of env wiring. requireAppToken is never a no-op:
 * it always requires a valid header, so the 401 assertions genuinely exercise
 * the guard.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "http";
import { apiRouter } from "../routes.js";
import { APP_SECRET } from "../auth.js";
import { getDb, addProject, addStaffing } from "../db.js";

// ─── Real app: mount the production router exactly as server/index.ts does ─────

function buildApp() {
  const app = express();
  app.use(express.json());
  // Client calls /api/... (see client/src/api.ts); mount the real router there.
  app.use("/api", apiRouter);
  return app;
}

// ─── HTTP helpers (raw http, no extra deps — mirrors sibling route tests) ─────

interface JsonResponse {
  statusCode: number;
  body: Record<string, unknown>;
}

function jsonRequest(
  server: http.Server,
  method: string,
  path: string,
  payload?: Record<string, unknown>,
  headers?: Record<string, string>
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
        ...headers,
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        let parsed: Record<string, unknown>;
        try { parsed = data ? (JSON.parse(data) as Record<string, unknown>) : {}; }
        catch { parsed = { raw: data }; }
        resolve({ statusCode: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Multipart upload helper for the import routes. Used to prove auth runs before
 * multer: the no-token variant sends the same multipart body and must still 401.
 */
function multipartRequest(
  server: http.Server,
  path: string,
  fileBuffer: Buffer,
  mimeType: string,
  filename: string,
  headers?: Record<string, string>
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const boundary = "----AuthTestBoundary" + Date.now();
    const header =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([Buffer.from(header), fileBuffer, Buffer.from(footer)]);

    const addr = server.address() as { port: number };
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port: addr.port,
      path,
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
        ...headers,
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let server: http.Server;
const AUTH = { "x-app-token": APP_SECRET };
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Fixtures created with valid prerequisites so the WITH-token requests reach the
// handler (and therefore can return a non-401) rather than failing on validation.
let projectId: number;
let staffingId: number;
let laborCategoryId: number;

beforeAll(async () => {
  getDb(); // ensure schema + seed data

  const proj = addProject(`__test_auth_routes_${Date.now()}`, 100_000, "2025-01-01", "2025-12-31");
  projectId = Number(proj.lastInsertRowid);

  // Use whatever labor category exists rather than a hardcoded id: getDb()
  // seeds sample categories into the in-memory DB, but query dynamically so the
  // test never depends on a specific seeded id (insert one if none exist).
  const db = getDb();
  const cat = db
    .prepare("SELECT id FROM labor_categories LIMIT 1")
    .get() as { id: number } | undefined;
  laborCategoryId = cat
    ? cat.id
    : Number(
        db
          .prepare(
            "INSERT INTO labor_categories (name, bill_rate, cost_rate) VALUES (?, ?, ?)",
          )
          .run("Test Category", 200, 150).lastInsertRowid,
      );
  const staff = addStaffing(projectId, laborCategoryId, "Auth Test Person", 40);
  staffingId = Number(staff.lastInsertRowid);

  const app = buildApp();
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
});

afterAll(async () => {
  // Guard against beforeAll failing before `server` was assigned, which would
  // otherwise throw a TypeError here and mask the real setup error.
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  // Remove seeded rows (deleting the project cascades to its staffing).
  if (projectId) {
    getDb().prepare("DELETE FROM projects WHERE id = ?").run(projectId);
  }
});

// ─── POST /api/projects ────────────────────────────────────────────────────────

describe("POST /api/projects — requireAppToken guard", () => {
  it("returns 401 without an x-app-token header", async () => {
    const res = await jsonRequest(server, "POST", "/api/projects", { name: `noauth_${Date.now()}` });
    expect(res.statusCode).toBe(401);
  });

  it("passes auth (not 401) with the correct token", async () => {
    const res = await jsonRequest(
      server, "POST", "/api/projects",
      { name: `authed_${Date.now()}`, total_budget: 1000 },
      AUTH
    );
    expect(res.statusCode).not.toBe(401);
  });
});

// ─── PATCH /api/projects/:id ────────────────────────────────────────────────────

describe("PATCH /api/projects/:id — requireAppToken guard", () => {
  it("returns 401 without an x-app-token header", async () => {
    const res = await jsonRequest(server, "PATCH", `/api/projects/${projectId}`, { status: "complete" });
    expect(res.statusCode).toBe(401);
  });

  it("passes auth (not 401) with the correct token", async () => {
    const res = await jsonRequest(
      server, "PATCH", `/api/projects/${projectId}`,
      { status: "active" },
      AUTH
    );
    expect(res.statusCode).not.toBe(401);
  });
});

// ─── POST /api/staffing ─────────────────────────────────────────────────────────

describe("POST /api/staffing — requireAppToken guard", () => {
  it("returns 401 without an x-app-token header", async () => {
    const res = await jsonRequest(server, "POST", "/api/staffing", {
      project_id: projectId,
      labor_category_id: laborCategoryId,
    });
    expect(res.statusCode).toBe(401);
  });

  it("passes auth (not 401) with the correct token", async () => {
    const res = await jsonRequest(
      server, "POST", "/api/staffing",
      { project_id: projectId, labor_category_id: laborCategoryId, person_name: "Authed", hours_per_week: 40 },
      AUTH
    );
    expect(res.statusCode).not.toBe(401);
  });
});

// ─── DELETE /api/staffing/:id ───────────────────────────────────────────────────

describe("DELETE /api/staffing/:id — requireAppToken guard", () => {
  it("returns 401 without an x-app-token header", async () => {
    const res = await jsonRequest(server, "DELETE", `/api/staffing/${staffingId}`);
    expect(res.statusCode).toBe(401);
  });

  it("passes auth (not 401) with the correct token", async () => {
    // Create a throwaway staffing row to delete so we don't depend on ordering.
    const tmp = addStaffing(projectId, laborCategoryId, "Deletable", 40);
    const tmpId = Number(tmp.lastInsertRowid);
    const res = await jsonRequest(server, "DELETE", `/api/staffing/${tmpId}`, undefined, AUTH);
    expect(res.statusCode).not.toBe(401);
  });
});

// ─── POST /api/import/excel (auth before multer) ────────────────────────────────

describe("POST /api/import/excel — requireAppToken guard (runs before multer)", () => {
  it("returns 401 without an x-app-token header, before multer buffers the upload", async () => {
    const res = await multipartRequest(
      server, "/api/import/excel",
      Buffer.alloc(512, 0x00), XLSX_MIME, "noauth.xlsx"
    );
    expect(res.statusCode).toBe(401);
  });

  it("passes auth (not 401) with the correct token", async () => {
    const res = await multipartRequest(
      server, "/api/import/excel",
      Buffer.alloc(512, 0x00), XLSX_MIME, "authed.xlsx",
      AUTH
    );
    // Auth passed → multer + handler run. The dummy buffer is not a real
    // workbook, so a 400 ("Failed to parse Excel") is expected — but NOT 401.
    expect(res.statusCode).not.toBe(401);
  });
});

// ─── POST /api/import/excel/v2 (auth before multer) ─────────────────────────────

describe("POST /api/import/excel/v2 — requireAppToken guard (runs before multer)", () => {
  it("returns 401 without an x-app-token header, before multer buffers the upload", async () => {
    const res = await multipartRequest(
      server, "/api/import/excel/v2",
      Buffer.alloc(512, 0x00), XLSX_MIME, "noauth.xlsx"
    );
    expect(res.statusCode).toBe(401);
  });

  it("passes auth (not 401) with the correct token", async () => {
    const res = await multipartRequest(
      server, "/api/import/excel/v2",
      Buffer.alloc(512, 0x00), XLSX_MIME, "authed.xlsx",
      AUTH
    );
    expect(res.statusCode).not.toBe(401);
  });
});

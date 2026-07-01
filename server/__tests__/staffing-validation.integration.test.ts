/**
 * Regression guard for Zod validation on POST /staffing.
 *
 * Like project-date-range.integration.test.ts and routes-auth.integration.test.ts
 * (and unlike the hand-copied-schema route tests), this MOUNTS THE REAL apiRouter
 * so it exercises the production validation path end to end.
 *
 * POST /staffing used to destructure req.body directly and rely on truthiness
 * checks (`!project_id || !labor_category_id`), which silently accepted 0 or
 * negative ids and ANY hours_per_week value — including negative numbers —
 * straight into the DB via `hours_per_week || 40`. postStaffingSchema
 * (server/routes.ts) now validates at the boundary: a negative hours_per_week
 * must be rejected with a 400 and the DB must not gain a row.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "http";
import { apiRouter } from "../routes.js";
import { APP_SECRET } from "../auth.js";
import { getDb, addProject } from "../db.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", apiRouter);
  return app;
}

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
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        let parsed: Record<string, unknown>;
        try {
          parsed = data ? (JSON.parse(data) as Record<string, unknown>) : {};
        } catch {
          parsed = { raw: data };
        }
        resolve({ statusCode: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

let server: http.Server;
const AUTH = { "x-app-token": APP_SECRET };
let projectId: number;
let laborCategoryId: number;

beforeAll(async () => {
  const db = getDb(); // ensure schema + seed data

  const proj = addProject(`__test_staffing_validation_${Date.now()}`, 100_000, "2025-01-01", "2025-12-31");
  projectId = Number(proj.lastInsertRowid);

  // Use whatever labor category exists rather than a hardcoded id (mirrors
  // routes-auth.integration.test.ts): getDb() seeds sample categories into the
  // in-memory DB, but query dynamically so this test never depends on a
  // specific seeded id (insert one if none exist).
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

  const app = buildApp();
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  // Deleting the project cascades to its staffing (ON DELETE CASCADE).
  if (projectId) {
    getDb().prepare("DELETE FROM projects WHERE id = ?").run(projectId);
  }
});

function post(body: Record<string, unknown>): Promise<JsonResponse> {
  return jsonRequest(server, "POST", "/api/staffing", body, AUTH);
}

function staffingCountForProject(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) as count FROM staffing WHERE project_id = ?")
    .get(projectId) as { count: number };
  return row.count;
}

describe("POST /api/staffing — Zod validation (postStaffingSchema)", () => {
  it("rejects a negative hours_per_week with a 400 and inserts no row", async () => {
    const before = staffingCountForProject();

    const res = await post({
      project_id: projectId,
      labor_category_id: laborCategoryId,
      hours_per_week: -5,
    });

    expect(res.statusCode).toBe(400);
    // Same error shape as the sibling project routes: { error, details: issues[] }.
    expect(res.body.error).toBe("Invalid fields");
    expect(Array.isArray(res.body.details)).toBe(true);

    const after = staffingCountForProject();
    expect(after).toBe(before);
  });

  it("rejects a missing project_id with a 400", async () => {
    const res = await post({ labor_category_id: laborCategoryId });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe("Invalid fields");
  });

  it("rejects a zero/non-positive project_id with a 400 (truthiness bypass regression)", async () => {
    // The old `!project_id` check let 0 slip past a strict falsy test in some
    // call shapes; the schema's .positive() closes that gap explicitly.
    const res = await post({ project_id: 0, labor_category_id: laborCategoryId });
    expect(res.statusCode).toBe(400);
  });

  it("rejects unknown fields (.strict())", async () => {
    const res = await post({
      project_id: projectId,
      labor_category_id: laborCategoryId,
      evil_col: "DROP TABLE staffing",
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts a valid body and defaults hours_per_week to 40 when omitted", async () => {
    const before = staffingCountForProject();

    const res = await post({
      project_id: projectId,
      labor_category_id: laborCategoryId,
      person_name: "Valid Person",
    });

    expect(res.statusCode).toBe(200);
    expect(typeof res.body.id).toBe("number");

    const after = staffingCountForProject();
    expect(after).toBe(before + 1);

    const row = getDb()
      .prepare("SELECT hours_per_week FROM staffing WHERE id = ?")
      .get(res.body.id as number) as { hours_per_week: number };
    expect(row.hours_per_week).toBe(40);
  });
});

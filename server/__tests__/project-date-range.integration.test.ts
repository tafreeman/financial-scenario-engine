/**
 * Regression guard for the inverted-date-range validation on POST /projects.
 *
 * Like routes-auth.integration.test.ts (and unlike the hand-copied-schema route
 * tests), this MOUNTS THE REAL apiRouter so it exercises the production
 * validation path end to end. A project whose start_date falls after its
 * end_date must be rejected at the boundary (400). An inverted range otherwise
 * reaches the engine as a negative planned-duration and silently distorts every
 * EVM metric (PV, SPI, EAC) rather than surfacing an error.
 *
 * NOTE: the scenario operation schema (engine/validation.ts) carries only a
 * single date field (new_end_date), so there is no start/end pair to compare
 * there — this cross-field check applies to POST /projects alone. A separate,
 * pre-existing gap (omitted dates are forwarded to the engine as "" → NaN in
 * EVM) is intentionally out of scope here.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "http";
import { apiRouter } from "../routes.js";
import { APP_SECRET } from "../auth.js";
import { getDb } from "../db.js";

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
const createdIds: number[] = [];

beforeAll(async () => {
  getDb(); // ensure schema + seed data
  const app = buildApp();
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  // Remove projects the accepting cases inserted.
  for (const id of createdIds) {
    getDb().prepare("DELETE FROM projects WHERE id = ?").run(id);
  }
});

describe("POST /projects — inverted date range rejected (EVM integrity)", () => {
  const stamp = String(Date.now());

  function post(body: Record<string, unknown>): Promise<JsonResponse> {
    return jsonRequest(server, "POST", "/api/projects", body, AUTH);
  }

  function track(res: JsonResponse): void {
    if (typeof res.body.id === "number") createdIds.push(res.body.id);
  }

  it("rejects start_date after end_date with a 400 and a clear message", async () => {
    const res = await post({
      name: `__test_inverted_${stamp}`,
      total_budget: 100_000,
      start_date: "2026-12-31",
      end_date: "2026-01-01",
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/on or before/i);
  });

  it("accepts an ascending range (start before end)", async () => {
    const res = await post({
      name: `__test_ascending_${stamp}`,
      total_budget: 100_000,
      start_date: "2026-01-01",
      end_date: "2026-12-31",
    });
    expect(res.statusCode).toBe(200);
    track(res);
  });

  it("accepts equal start and end dates (zero-length, not inverted)", async () => {
    const res = await post({
      name: `__test_equal_${stamp}`,
      total_budget: 100_000,
      start_date: "2026-06-01",
      end_date: "2026-06-01",
    });
    expect(res.statusCode).toBe(200);
    track(res);
  });

  it("accepts a single endpoint (no pair to compare)", async () => {
    const res = await post({
      name: `__test_single_${stamp}`,
      total_budget: 100_000,
      start_date: "2026-01-01",
    });
    expect(res.statusCode).toBe(200);
    track(res);
  });
});

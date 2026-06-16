/**
 * Integration test for #3 — per-IP rate limit on GET read routes.
 *
 * Before this fix only the mutating/LLM endpoints (scenarioRateLimit, 10/min)
 * were throttled; the GET read routes had no per-IP ceiling at all. This test
 * mounts the REAL apiRouter (so it exercises the production readRouteLimiter,
 * not a re-implementation) and proves that:
 *   1. normal read traffic well under the limit returns 200, and
 *   2. once the per-IP ceiling (300/min) is exceeded the router responds 429.
 *
 * The limiter keys on IP; all requests here originate from 127.0.0.1, so they
 * share a single bucket. We fire just over the 300 limit and assert at least one
 * 429 surfaces — without asserting the exact crossover index (robust to the
 * express-rate-limit counting model).
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

function statusOf(server: http.Server, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { hostname: "127.0.0.1", port: addr.port, path, method: "GET" },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve(res.statusCode ?? 0));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

let server: http.Server;

beforeAll(async () => {
  getDb(); // ensure schema + seed data
  const app = buildApp();
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("read-route rate limiter (readRouteLimiter, 300/min)", () => {
  it("serves a normal read under the limit with 200", async () => {
    const status = await statusOf(server, "/api/health");
    expect(status).toBe(200);
  });

  it("returns 429 once the per-IP read ceiling is exceeded", async () => {
    // Fire well past the 300/min ceiling on a read route from a single IP.
    const TOTAL = 360;
    const statuses: number[] = [];
    for (let i = 0; i < TOTAL; i++) {
      // Sequential to keep the shared in-process counter deterministic.
      statuses.push(await statusOf(server, "/api/health"));
    }

    const limited = statuses.filter((s) => s === 429);
    const ok = statuses.filter((s) => s === 200);

    // Early requests succeed…
    expect(ok.length).toBeGreaterThan(0);
    // …and once the ceiling is crossed the limiter kicks in.
    expect(limited.length).toBeGreaterThan(0);
  });
});

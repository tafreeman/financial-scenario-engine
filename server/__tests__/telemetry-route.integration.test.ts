/**
 * Integration test for GET /api/telemetry/llm (WP3-B).
 *
 * Mounts the REAL apiRouter (server/routes.ts) — same pattern as
 * routes-auth.integration.test.ts — so this exercises the production route
 * wiring, not a hand-copied handler.
 *
 * Coverage:
 *   1. The route is reachable WITHOUT an x-app-token header (matches the
 *      posture of the other unauthenticated read routes — see routes.ts
 *      comment above the route for the auth-decision rationale).
 *   2. The response shape matches LlmTelemetrySnapshot and reflects counters
 *      recorded via recordLlmCall() (server/llm-telemetry.ts) — proving the
 *      route reads live process state, not a static/fixture response.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import express from "express";
import http from "http";
import { apiRouter } from "../routes.js";
import { getDb } from "../db.js";
import { recordLlmCall, __resetLlmTelemetryForTests } from "../llm-telemetry.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", apiRouter);
  return app;
}

function getJson(server: http.Server, path: string): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    http
      .get({ hostname: "127.0.0.1", port: addr.port, path }, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(data) as Record<string, unknown> });
        });
      })
      .on("error", reject);
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
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

afterEach(() => {
  __resetLlmTelemetryForTests();
});

describe("GET /api/telemetry/llm", () => {
  it("is reachable without an x-app-token header (read-only, no PII — see routes.ts rationale)", async () => {
    const res = await getJson(server, "/api/telemetry/llm");
    expect(res.statusCode).toBe(200);
  });

  it("returns the LlmTelemetrySnapshot shape", async () => {
    const res = await getJson(server, "/api/telemetry/llm");
    expect(res.body).toHaveProperty("processStartedAt");
    expect(res.body).toHaveProperty("totals");
    expect(res.body).toHaveProperty("byPurpose");
    expect(res.body).toHaveProperty("failuresByCode");
    expect(res.body.totals).toMatchObject({
      calls: expect.any(Number),
      tokensIn: expect.any(Number),
      tokensOut: expect.any(Number),
      failures: expect.any(Number),
      retries: expect.any(Number),
    });
  });

  it("reflects live process counters recorded via recordLlmCall()", async () => {
    recordLlmCall({ purpose: "intent", outcome: "success", tokensOut: 99, retryCount: 1 });

    const res = await getJson(server, "/api/telemetry/llm");
    const body = res.body as unknown as {
      totals: { calls: number; tokensOut: number; retries: number };
      byPurpose: Record<string, { calls: number; tokensOut: number }>;
    };

    expect(body.totals.calls).toBe(1);
    expect(body.totals.tokensOut).toBe(99);
    expect(body.totals.retries).toBe(1);
    expect(body.byPurpose.intent).toMatchObject({ calls: 1, tokensOut: 99 });
  });

  it("never includes prompt/query content or PAT-shaped fields in the response", async () => {
    recordLlmCall({ purpose: "narration", outcome: "failure", failureCode: "invalid_json" });

    const res = await getJson(server, "/api/telemetry/llm");
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/github_pat|pat["']?\s*:|prompt|query/i);
  });
});

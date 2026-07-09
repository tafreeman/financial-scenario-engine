/**
 * Regression guard for the intent-parse-failure -> HTTP 422 contract.
 *
 * docs/decisions/001-llm-engine-separation.md (ADR-001) used to describe an
 * intent-parse failure as silently falling back to a burn_rate_check. That
 * stopped being true once parseIntent() (server/ai.ts) started returning a
 * typed IntentParseFailure that sendIntentParseFailure() (server/routes.ts)
 * turns into an HTTP 422 Unprocessable Entity — but no test asserted that
 * HTTP-level contract, only parseIntent()'s own return value in isolation
 * (server/__tests__/ai.test.ts). This file closes that gap by mounting the
 * REAL apiRouter (same rationale as routes-auth.integration.test.ts: hand-
 * copied route handlers can drift from production and hide regressions) and
 * hitting it over real HTTP, exactly as a client would.
 *
 * Trigger used: the "provider_unconfigured" IntentParseFailureCode. It is
 * the one code reachable deterministically without mocking fetch or making a
 * live model call — parseIntent() checks isProviderConfigured() and returns
 * before ever attempting a network call (server/ai.ts). The other three
 * codes (invalid_json, invalid_operation, provider_error) funnel through the
 * exact same sendIntentParseFailure() response path (server/routes.ts), so
 * asserting the contract for this one code covers all four.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "http";
import { apiRouter } from "../routes.js";
import { APP_SECRET } from "../auth.js";
import { getDb, setConfig } from "../db.js";

// ─── Real app: mount the production router exactly as server/index.ts does ─────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", apiRouter);
  return app;
}

// ─── HTTP helper (raw http, no extra deps — mirrors routes-auth.integration.test.ts) ─

interface JsonResponse {
  statusCode: number;
  body: Record<string, unknown>;
}

function postJson(server: http.Server, path: string, payload: Record<string, unknown>): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(payload);
    const addr = server.address() as { port: number };
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
          "x-app-token": APP_SECRET,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          let parsed: Record<string, unknown>;
          try { parsed = data ? (JSON.parse(data) as Record<string, unknown>) : {}; }
          catch { parsed = { raw: data }; }
          resolve({ statusCode: res.statusCode ?? 0, body: parsed });
        });
      }
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let server: http.Server;
const ORIGINAL_GITHUB_TOKEN = process.env.GITHUB_TOKEN;

beforeAll(async () => {
  getDb(); // ensure schema + seed data exist before the app takes requests
  const app = buildApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  // Deterministically force parseIntent()'s isProviderConfigured() check to
  // fail, regardless of the host machine's ambient environment or DB state
  // left over from another test — mirrors the pattern already used in
  // ai.test.ts's "does not log or record anything when the provider is
  // unconfigured" case.
  setConfig("llm_provider", "github");
  setConfig("github_pat", "");
  delete process.env.GITHUB_TOKEN;
});

afterEach(() => {
  if (ORIGINAL_GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = ORIGINAL_GITHUB_TOKEN;
});

describe("Intent-parse failure -> HTTP 422 (ADR-001 contract)", () => {
  it("POST /api/scenario/v2 returns 422 with a typed code and clarification, not a 500 or a disguised success", async () => {
    const res = await postJson(server, "/api/scenario/v2", { query: "What's the burn rate on Alpha?" });

    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ code: "provider_unconfigured" });
    expect(typeof res.body.error).toBe("string");
    expect((res.body.error as string).length).toBeGreaterThan(0);
    expect(typeof res.body.clarification).toBe("string");
    expect((res.body.clarification as string).length).toBeGreaterThan(0);

    // The behavior this test guards against: a 200 with a disguised
    // burn_rate_check ScenarioResult instead of a typed error.
    expect(res.body).not.toHaveProperty("engine");
  });

  it("POST /api/scenario/v2/parse-only returns the same typed-422 shape", async () => {
    const res = await postJson(server, "/api/scenario/v2/parse-only", { query: "Swap the Senior Dev on Alpha" });

    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ code: "provider_unconfigured" });
    expect(res.body).not.toHaveProperty("operation");
  });
});

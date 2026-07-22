/**
 * FSE#6 (2026-07-21 audit) — request-body validation for the 3 AI-scenario
 * routes (POST /scenario/v2, /scenario/v2/parse-only, /scenario/v3).
 *
 * Before this fix all three destructured req.body untyped and only truthy-
 * checked `query` (`if (!query) ...`), so a non-string query (e.g. an array
 * or object) passed the guard and reached parseIntent()/agenticScenario() —
 * burning a paid LLM call and the scenarioRateLimit budget before failing
 * downstream. A Zod schema now rejects a non-string/empty/oversized/unknown-
 * field body with 400 BEFORE any LLM call is attempted — asserted here via
 * getLlmTelemetrySnapshot().totals.calls staying at 0.
 *
 * Pattern: mount the REAL apiRouter (server/routes.ts), not a
 * re-implementation — mirrors scenario-parse-failure.integration.test.ts /
 * routes-auth.integration.test.ts.
 *
 * Rate-limit isolation: scenarioRateLimit (server/routes.ts) is a SINGLE
 * shared middleware instance applied to all 3 routes under test, capped at
 * 10 requests/min PER IP — cumulative across all three, not per-route. This
 * suite fires ~25 requests total from what would otherwise be one client
 * (the test runner's own loopback connection), so without per-request IP
 * isolation the shared limiter itself returns 429 well before the 25th
 * request, masking the validation behavior this file actually tests. Fixed
 * by enabling `trust proxy` on the test app (mirrors server/index.ts's
 * production wiring — see server/trust-proxy.ts) and giving every request a
 * fresh, distinct X-Forwarded-For value, so each lands in its own
 * rate-limit bucket. This doubles as extra coverage of FSE#5/item 3 (trust
 * proxy correctness) for the SCENARIO limiter specifically, distinct from
 * the READ limiter already covered in trust-proxy.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "http";
import { apiRouter } from "../routes.js";
import { APP_SECRET } from "../auth.js";
import { getDb, setConfig } from "../db.js";
import { getLlmTelemetrySnapshot, __resetLlmTelemetryForTests } from "../llm-telemetry.js";

function buildApp() {
  const app = express();
  // Trust exactly one proxy hop so X-Forwarded-For (set per-request below) is
  // honored for req.ip — see the rate-limit isolation note above and
  // server/trust-proxy.ts for the production rationale (never `true`).
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use("/api", apiRouter);
  return app;
}

interface JsonResponse {
  statusCode: number;
  body: Record<string, unknown>;
}

let ipCounter = 0;

/**
 * A fresh, syntactically valid IPv4 address for X-Forwarded-For, unique per
 * call — see the rate-limit isolation note in the module doc comment above.
 * Never reused, so no two requests in this suite can ever share a
 * scenarioRateLimit bucket regardless of how many tests are added later.
 */
function freshClientIp(): string {
  ipCounter += 1;
  const c = Math.floor(ipCounter / 250) % 250;
  const d = (ipCounter % 250) + 1;
  return `10.99.${c}.${d}`;
}

function postJson(server: http.Server, path: string, payload: unknown): Promise<JsonResponse> {
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
          "X-Forwarded-For": freshClientIp(),
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

let server: http.Server;
const ORIGINAL_GITHUB_TOKEN = process.env.GITHUB_TOKEN;

beforeAll(async () => {
  getDb(); // ensure schema + seed data exist before the app takes requests
  const app = buildApp();
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  __resetLlmTelemetryForTests();
  // Deterministically force parseIntent()'s isProviderConfigured() check to
  // fail, regardless of the host machine's ambient environment — mirrors
  // scenario-parse-failure.integration.test.ts. None of the validation-only
  // assertions below depend on WHICH typed failure comes back; they only
  // need every case that passes schema validation to short-circuit before a
  // real network call, so the suite stays hermetic and fast.
  setConfig("llm_provider", "github");
  setConfig("github_pat", "");
  delete process.env.GITHUB_TOKEN;
});

afterEach(() => {
  if (ORIGINAL_GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = ORIGINAL_GITHUB_TOKEN;
});

const ROUTES = ["/api/scenario/v2", "/api/scenario/v2/parse-only", "/api/scenario/v3"];

describe("POST /api/scenario/* — request body validation (FSE#6)", () => {
  for (const path of ROUTES) {
    it(`${path} rejects a non-string (array) query with 400 before any LLM call`, async () => {
      const res = await postJson(server, path, { query: ["not", "a", "string"] });
      expect(res.statusCode).toBe(400);
      expect(getLlmTelemetrySnapshot().totals.calls).toBe(0);
    });

    it(`${path} rejects a non-string (object) query with 400`, async () => {
      const res = await postJson(server, path, { query: { nested: "object" } });
      expect(res.statusCode).toBe(400);
      expect(getLlmTelemetrySnapshot().totals.calls).toBe(0);
    });

    it(`${path} rejects an empty-string query with 400`, async () => {
      const res = await postJson(server, path, { query: "" });
      expect(res.statusCode).toBe(400);
    });

    it(`${path} rejects a missing query with 400`, async () => {
      const res = await postJson(server, path, {});
      expect(res.statusCode).toBe(400);
    });

    it(`${path} rejects a query over 2000 characters with 400`, async () => {
      const res = await postJson(server, path, { query: "a".repeat(2001) });
      expect(res.statusCode).toBe(400);
    });

    it(`${path} rejects an unknown field with 400 (.strict())`, async () => {
      const res = await postJson(server, path, { query: "valid query", unexpected_field: true });
      expect(res.statusCode).toBe(400);
    });

    it(`${path} rejects a null query with 400`, async () => {
      const res = await postJson(server, path, { query: null });
      expect(res.statusCode).toBe(400);
    });
  }

  it("/api/scenario/v2 accepts a valid query with skip_narrative/use_llm_narrative booleans (validation passes — not a 400)", async () => {
    const res = await postJson(server, "/api/scenario/v2", {
      query: "not-empty",
      skip_narrative: true,
      use_llm_narrative: false,
    });
    // No LLM provider is configured in this test environment, so this reaches
    // the handler body and fails with a typed 422 (provider_unconfigured) —
    // the point of this assertion is that validation passed (NOT 400), not
    // the specific downstream outcome.
    expect(res.statusCode).not.toBe(400);
  });

  it("/api/scenario/v2 rejects skip_narrative when it is not a boolean", async () => {
    const res = await postJson(server, "/api/scenario/v2", { query: "valid query", skip_narrative: "yes" });
    expect(res.statusCode).toBe(400);
  });

  it("/api/scenario/v2/parse-only rejects skip_narrative as an unknown field (route-specific field set)", async () => {
    const res = await postJson(server, "/api/scenario/v2/parse-only", {
      query: "valid query",
      skip_narrative: true,
    });
    expect(res.statusCode).toBe(400);
  });

  it("/api/scenario/v3 rejects use_llm_narrative as an unknown field (route-specific field set)", async () => {
    const res = await postJson(server, "/api/scenario/v3", {
      query: "valid query",
      use_llm_narrative: true,
    });
    expect(res.statusCode).toBe(400);
  });
});

/**
 * FSE#5 (2026-07-21 audit) — `trust proxy` correctness behind a reverse proxy.
 *
 * Before this fix, no `trust proxy` was set anywhere in server/, so behind a
 * reverse proxy every request's `req.ip` resolved to the PROXY's own address
 * — every distinct client behind it shared ONE rate-limit bucket
 * (readRouteLimiter/scenarioRateLimit, server/routes.ts), letting one abusive
 * client exhaust the budget for everyone else.
 *
 * Two things are tested here:
 *   1. resolveTrustProxyHops() (server/trust-proxy.ts) — pure parsing logic,
 *      unit-tested directly (no server needed).
 *   2. The actual effect of `app.set("trust proxy", N)` on rate-limit bucket
 *      separation, using the REAL apiRouter (so this exercises production's
 *      readRouteLimiter, not a re-implementation) — mirrors
 *      read-rate-limit.integration.test.ts's pattern.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import http from "http";
import { apiRouter } from "../routes.js";
import { getDb } from "../db.js";
import { resolveTrustProxyHops } from "../trust-proxy.js";

// ─── Unit tests: resolveTrustProxyHops (pure, no server) ────────────────────

describe("resolveTrustProxyHops (server/trust-proxy.ts)", () => {
  it("defaults to 0 (no proxy trusted) when TRUST_PROXY_HOPS is unset", () => {
    expect(resolveTrustProxyHops({})).toBe(0);
  });

  it("defaults to 0 when TRUST_PROXY_HOPS is an empty string", () => {
    expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: "" })).toBe(0);
  });

  it("defaults to 0 when TRUST_PROXY_HOPS is whitespace-only", () => {
    expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: "   " })).toBe(0);
  });

  it("parses a positive integer hop count", () => {
    expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: "1" })).toBe(1);
    expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: "3" })).toBe(3);
  });

  it("falls back to 0 for a negative value", () => {
    expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: "-1" })).toBe(0);
  });

  it("falls back to 0 for a non-integer value", () => {
    expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: "abc" })).toBe(0);
    expect(resolveTrustProxyHops({ TRUST_PROXY_HOPS: "1.5" })).toBe(0);
  });

  it("never returns `true`-equivalent behavior — the return type is always a finite number", () => {
    for (const raw of ["0", "1", "2", "abc", "", "-5", "1.5"]) {
      const hops = resolveTrustProxyHops({ TRUST_PROXY_HOPS: raw });
      expect(typeof hops).toBe("number");
      expect(Number.isFinite(hops)).toBe(true);
    }
  });
});

// ─── Integration: trust proxy + per-IP rate limiting ─────────────────────────

function buildApp(trustProxyHops: number) {
  const app = express();
  if (trustProxyHops > 0) {
    app.set("trust proxy", trustProxyHops);
  }
  app.use(express.json());
  app.use("/api", apiRouter);
  return app;
}

function statusOf(
  server: http.Server,
  path: string,
  headers?: Record<string, string>
): Promise<number> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request(
      { hostname: "127.0.0.1", port: addr.port, path, method: "GET", headers },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve(res.statusCode ?? 0));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// readRouteLimiter (server/routes.ts) is 300/min — push one bucket past it.
const EXHAUST_COUNT = 305;

describe("trust proxy=1 + per-IP rate limiting (FSE#5 fix)", () => {
  let proxiedServer: http.Server;

  beforeAll(async () => {
    getDb();
    const app = buildApp(1); // mirrors TRUST_PROXY_HOPS=1
    proxiedServer = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => proxiedServer.close(() => resolve()));
  });

  it(
    "gives distinct forwarded IPs distinct rate-limit buckets — exhausting one does not throttle another",
    async () => {
      const statusesA: number[] = [];
      for (let i = 0; i < EXHAUST_COUNT; i++) {
        // Sequential to keep the shared in-process counter deterministic
        // (mirrors read-rate-limit.integration.test.ts).
        statusesA.push(
          await statusOf(proxiedServer, "/api/health", { "X-Forwarded-For": "203.0.113.10" })
        );
      }
      expect(statusesA.filter((s) => s === 200).length).toBeGreaterThan(0);
      expect(statusesA.filter((s) => s === 429).length).toBeGreaterThan(0);

      // A DIFFERENT forwarded client IP must still be served — proves Express
      // (via trust proxy) is keying the limiter on the TRUSTED forwarded IP,
      // not lumping every request from this one proxy connection together.
      const statusB = await statusOf(proxiedServer, "/api/health", {
        "X-Forwarded-For": "198.51.100.20",
      });
      expect(statusB).toBe(200);

      // No X-Forwarded-For at all: falls back to the direct socket address
      // (127.0.0.1, this test's own loopback connection) — a third,
      // independent bucket, also unaffected by A's exhausted bucket.
      const statusDirect = await statusOf(proxiedServer, "/api/health");
      expect(statusDirect).toBe(200);
    },
    30_000
  );
});

describe("trust proxy NOT configured — X-Forwarded-For is ignored (pre-fix baseline)", () => {
  let directServer: http.Server;

  beforeAll(async () => {
    getDb();
    const app = buildApp(0); // TRUST_PROXY_HOPS unset/0 — Express's own default
    directServer = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => directServer.close(() => resolve()));
  });

  it(
    "a spoofed, ever-changing X-Forwarded-For does not create separate buckets — every request lands in the SAME (real socket) bucket",
    async () => {
      const statuses: number[] = [];
      for (let i = 0; i < EXHAUST_COUNT; i++) {
        // Every request claims a DIFFERENT forwarded IP, but without trust
        // proxy configured Express ignores X-Forwarded-For entirely — all of
        // these still land in the SAME bucket (the real loopback address),
        // so the ceiling is still reached exactly like the no-header case.
        statuses.push(
          await statusOf(directServer, "/api/health", {
            "X-Forwarded-For": `203.0.113.${i % 250}`,
          })
        );
      }
      expect(statuses.filter((s) => s === 200).length).toBeGreaterThan(0);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    },
    30_000
  );
});

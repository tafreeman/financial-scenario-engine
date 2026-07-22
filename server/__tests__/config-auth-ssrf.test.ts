/**
 * Tests for the audit-remediation security fix:
 *   1. PUT /api/config requires a valid x-app-token header (auth guard).
 *   2. PUT /api/config with a valid token succeeds.
 *   3. CONFIG_WRITABLE_KEYS rejects endpoint/ollama_endpoint values that
 *      resolve to private or loopback hosts (SSRF guard).
 *
 * Done-when criteria:
 *  (a) Unauthenticated PUT /api/config → 401
 *  (b) Authenticated PUT /api/config   → 200
 *  (c) endpoint pointing at a private/loopback host → 400
 *  (d) ollama_endpoint with a private-range IP → 400
 *  (e) ollama_endpoint at localhost (http) is accepted (legitimate Ollama default)
 *  (f) endpoint using http (not https) is rejected
 *
 * Pattern: spin up a minimal Express app that imports the real middleware and
 * schema from server/auth.ts and server/routes.ts, wired against the live DB.
 * This exercises the actual production code paths without mocking internals.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { type Request, type Response } from "express";
import http from "http";
import { z } from "zod";
import { requireAppToken, APP_SECRET } from "../auth.js";
import { getDb, getAllConfig, setConfig } from "../db.js";
// Import the SSRF refinements from the SAME module routes.ts uses, so this test
// exercises the production guard implementation rather than a hand-copied clone
// that could silently drift out of sync.
import { refineEndpointNoPrivate, refineOllamaEndpoint } from "../ssrf.js";

// ─── CONFIG_WRITABLE_KEYS schema (mirrors routes.ts) ─────────────────────────
// The schema shape is re-declared here to keep the minimal test app self-contained,
// but the SSRF refinements are imported from server/ssrf.ts (not copied) so a real
// regression in the guard would fail this test.

const CONFIG_WRITABLE_KEYS = z.object({
  github_pat: z.string().optional(),
  model: z.string().optional(),
  endpoint: z
    .string()
    .url()
    .refine(refineEndpointNoPrivate, {
      message: "endpoint must use https and must not resolve to a loopback or private-range host",
    })
    .optional(),
  temperature: z.string().optional(),
  max_tokens: z.string().optional(),
  llm_provider: z.enum(["github", "ollama", "openrouter"]).optional(),
  ollama_model: z.string().optional(),
  ollama_endpoint: z
    .string()
    .url()
    .refine(refineOllamaEndpoint, {
      message: "ollama_endpoint must use https (or http for localhost only) and must not resolve to a private-range IP",
    })
    .optional(),
  llm_timeout_ms: z.string().optional(),
  openrouter_api_key: z.string().optional(),
  openrouter_model: z.string().optional(),
  openrouter_endpoint: z
    .string()
    .url()
    .refine(refineEndpointNoPrivate, {
      message: "openrouter_endpoint must use https and must not resolve to a loopback or private-range host",
    })
    .optional(),
}).strict();

// ─── Minimal Express app ──────────────────────────────────────────────────────

function buildTestApp() {
  const app = express();
  app.use(express.json());

  // GET /config — unauthenticated (read-only, safe)
  app.get("/config", (_req: Request, res: Response) => {
    res.json(getAllConfig());
  });

  // PUT /config — guarded by requireAppToken + schema validation
  app.put("/config", requireAppToken, (req: Request, res: Response) => {
    const parsed = CONFIG_WRITABLE_KEYS.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Unknown or invalid config keys", details: parsed.error.issues });
      return;
    }
    const entries = parsed.data as Record<string, string | undefined>;
    for (const [key, value] of Object.entries(entries)) {
      if (value !== undefined) setConfig(key, value);
    }
    res.json({ ok: true });
  });

  return app;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

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

// ─── Test setup ───────────────────────────────────────────────────────────────

let server: http.Server;
const AUTH = { "x-app-token": APP_SECRET };

beforeAll(async () => {
  getDb(); // ensure schema is initialised
  const app = buildTestApp();
  server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ─── (a) Authentication guard: unauthenticated PUT → 401 ─────────────────────

describe("PUT /config — authentication guard", () => {
  it("returns 401 when no x-app-token header is present", async () => {
    const res = await jsonRequest(server, "PUT", "/config", { model: "test-model" });
    expect(res.statusCode).toBe(401);
    expect(typeof res.body.error).toBe("string");
  });

  it("returns 401 when x-app-token header is empty string", async () => {
    const res = await jsonRequest(server, "PUT", "/config", { model: "test-model" }, {
      "x-app-token": "",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when x-app-token is wrong", async () => {
    const res = await jsonRequest(server, "PUT", "/config", { model: "test-model" }, {
      "x-app-token": "definitely-not-the-right-token",
    });
    expect(res.statusCode).toBe(401);
  });
});

// ─── (b) Authentication guard: authenticated PUT → 200 ───────────────────────

describe("PUT /config — authenticated request succeeds", () => {
  it("returns 200 with valid token and a writable key", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { temperature: "0.3" },
      AUTH
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ─── (c)/(d) SSRF guard: private / loopback hosts rejected ───────────────────

describe("PUT /config — SSRF guard on endpoint", () => {
  it("rejects endpoint with loopback host (127.0.0.1)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://127.0.0.1:8080/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects endpoint with loopback hostname (localhost)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://localhost:8080/v1/chat" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects endpoint with 10.x.x.x private IP", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://10.0.0.1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects endpoint with 192.168.x.x private IP", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://192.168.1.100/chat" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects endpoint that uses http (not https)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "http://models.github.ai/inference/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("accepts a legitimate https endpoint (models.github.ai)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://models.github.ai/inference/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(200);
  });

  // ── IPv4-mapped IPv6 SSRF bypass (the FIX) ────────────────────────────────
  // Node preserves these forms verbatim in URL.hostname, so the dotted-decimal
  // filters never matched them. Each resolves to a loopback / private address.

  it("rejects endpoint with hex IPv4-mapped IPv6 loopback ([::ffff:7f00:1] -> 127.0.0.1)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://[::ffff:7f00:1]/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects endpoint with hex IPv4-mapped IPv6 private host ([::ffff:c0a8:0101] -> 192.168.1.1)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://[::ffff:c0a8:0101]/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects endpoint with dotted IPv4-mapped IPv6 private host ([::ffff:192.168.1.1])", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://[::ffff:192.168.1.1]/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects endpoint with dotted IPv4-mapped IPv6 loopback ([::ffff:127.0.0.1])", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://[::ffff:127.0.0.1]/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  // IPv4-COMPATIBLE IPv6 (no ffff: segment). Node normalizes the dotted forms
  // ([::127.0.0.1] / [::192.168.1.1]) to ffff-less hex ([::7f00:1] / [::c0a8:101])
  // before the refinement runs, so the hex match must treat ffff: as optional.
  it("rejects endpoint with compatible IPv6 loopback ([::7f00:1] -> 127.0.0.1)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://[::7f00:1]/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects endpoint with compatible IPv6 private host ([::c0a8:101] -> 192.168.1.1)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://[::c0a8:101]/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects endpoint with dotted compatible IPv6 loopback ([::127.0.0.1])", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://[::127.0.0.1]/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects endpoint with dotted compatible IPv6 private host ([::192.168.1.1])", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://[::192.168.1.1]/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });
});

// ─── SSRF guard on openrouter_endpoint ────────────────────────────────────────
// openrouter_endpoint shares the SAME refineEndpointNoPrivate refinement as
// `endpoint` (GitHub Models) — both are cloud-only inference endpoints with
// no legitimate loopback/private-range use, unlike ollama_endpoint.

describe("PUT /config — SSRF guard on openrouter_endpoint", () => {
  it("rejects openrouter_endpoint with loopback host (127.0.0.1)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { openrouter_endpoint: "https://127.0.0.1:8080/api/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects openrouter_endpoint with 192.168.x.x private IP", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { openrouter_endpoint: "https://192.168.1.100/api/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects openrouter_endpoint that uses http (not https)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { openrouter_endpoint: "http://openrouter.ai/api/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("accepts a legitimate https openrouter_endpoint (openrouter.ai)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { openrouter_endpoint: "https://openrouter.ai/api/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(200);
  });
});

// ─── llm_provider accepts "openrouter" as a valid enum value ─────────────────

describe("PUT /config — llm_provider enum includes openrouter", () => {
  it("accepts llm_provider=openrouter", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { llm_provider: "openrouter" },
      AUTH
    );
    expect(res.statusCode).toBe(200);
  });

  it("rejects an unsupported llm_provider value", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { llm_provider: "anthropic" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });
});

// ─── (d) SSRF guard on ollama_endpoint ───────────────────────────────────────

describe("PUT /config — SSRF guard on ollama_endpoint", () => {
  it("rejects ollama_endpoint with 192.168.x.x private IP", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { ollama_endpoint: "http://192.168.1.1:11434/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects ollama_endpoint with 172.16.x.x private IP", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { ollama_endpoint: "https://172.16.0.1/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  // ollama legitimately allows http://localhost, but a mapped-IPv6 loopback
  // must NOT slip through that allowance.
  it("rejects ollama_endpoint with IPv4-mapped IPv6 loopback ([::ffff:7f00:1] -> 127.0.0.1)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { ollama_endpoint: "http://[::ffff:7f00:1]:11434/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects ollama_endpoint with compatible IPv6 loopback ([::7f00:1] -> 127.0.0.1)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { ollama_endpoint: "http://[::7f00:1]:11434/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });
});

// ─── (e) ollama_endpoint localhost is allowed ─────────────────────────────────

describe("PUT /config — ollama_endpoint localhost is permitted", () => {
  it("accepts http://localhost:11434/v1/chat/completions (Ollama default)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { ollama_endpoint: "http://localhost:11434/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(200);
  });

  it("accepts http://127.0.0.1:11434/v1/chat/completions (Ollama numeric loopback)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { ollama_endpoint: "http://127.0.0.1:11434/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(200);
  });
});

// ─── GET /config remains unauthenticated ─────────────────────────────────────

describe("GET /config — unauthenticated read-only route", () => {
  it("returns 200 with no auth header", async () => {
    const res = await jsonRequest(server, "GET", "/config");
    expect(res.statusCode).toBe(200);
  });
});

/**
 * Tests for the audit-remediation security fix:
 *   1. PUT /api/config requires a valid x-app-token header (auth guard).
 *   2. PUT /api/config with a valid token succeeds.
 *   3. CONFIG_WRITABLE_KEYS rejects endpoint/ollama_endpoint values that
 *      resolve to private or loopback hosts (SSRF guard) — both by literal
 *      IP/hostname string form AND, per FSE#4 (2026-07-21 audit), by DNS
 *      resolution of a DOMAIN hostname (DNS-rebinding-aware check).
 *
 * Done-when criteria:
 *  (a) Unauthenticated PUT /api/config → 401
 *  (b) Authenticated PUT /api/config   → 200
 *  (c) endpoint pointing at a private/loopback host → 400
 *  (d) ollama_endpoint with a private-range IP → 400
 *  (e) ollama_endpoint at localhost (http) is accepted (legitimate Ollama default)
 *  (f) endpoint using http (not https) is rejected
 *  (g) a DOMAIN mocked to resolve to a private/loopback address → 400
 *  (h) a DOMAIN resolving to public addresses → 200
 *  (i) literal-IP behavior is unchanged by the DNS-aware refinement
 *
 * Pattern: spin up a minimal Express app that imports the real middleware and
 * schema from server/auth.ts and server/routes.ts, wired against the live DB.
 * This exercises the actual production code paths without mocking internals.
 *
 * DNS mocking: refineEndpointNoPrivateAsync/refineOllamaEndpointAsync take an
 * injectable `dnsLookup` (mirrors the fetchImpl/exec injection pattern already
 * used in server/ai.ts) — see server/ssrf.ts. This test app binds a stub
 * resolver so NO real DNS lookup ever happens; literal IPs bypass the lookup
 * entirely (see server/ssrf.ts isLiteralHost), so those tests need no fixture.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { type Request, type Response } from "express";
import http from "http";
import { z } from "zod";
import { requireAppToken, APP_SECRET } from "../auth.js";
import { getDb, getAllConfig, setConfig } from "../db.js";
import { apiRouter } from "../routes.js";
// Import the SSRF refinements from the SAME module routes.ts uses, so this test
// exercises the production guard implementation rather than a hand-copied clone
// that could silently drift out of sync.
import { refineEndpointNoPrivateAsync, refineOllamaEndpointAsync, type DnsLookupAll } from "../ssrf.js";

// ─── Stub DNS resolver (no real DNS lookups in this test file) ──────────────
// Keyed on hostname (lowercase). "no fixture" throws, which resolvesToPrivateOrLoopback()
// (server/ssrf.ts) treats as fail-closed (rejected) — mirrors a real NXDOMAIN.
const DNS_STUB_MAP: Record<string, { address: string; family: number }[]> = {
  "models.github.ai": [{ address: "20.42.0.1", family: 4 }],
  "openrouter.ai": [{ address: "104.18.2.2", family: 4 }],
  "public-cloud-llm.example.com": [{ address: "203.0.113.10", family: 4 }], // RFC 5737 TEST-NET-3 — public, non-routable documentation range
  "sneaky-rebind.example.com": [{ address: "127.0.0.1", family: 4 }],
  "metadata-attack.example.com": [{ address: "169.254.169.254", family: 4 }],
  "private-rebind.example.com": [{ address: "10.0.0.5", family: 4 }],
  "public-ollama-domain.example.com": [{ address: "198.51.100.20", family: 4 }], // RFC 5737 TEST-NET-2
  "private-ollama-domain.example.com": [{ address: "192.168.1.50", family: 4 }],
  // 2026-07-22 security review (PR #49, HIGH): a domain resolving to an IPv6
  // unique-local address (fc00::/7) must be rejected the same as a literal one.
  "ula-rebind.example.com": [{ address: "fc00::1", family: 6 }],
};

const stubDnsLookup: DnsLookupAll = async (hostname) => {
  const entry = DNS_STUB_MAP[hostname.toLowerCase()];
  if (!entry) throw new Error(`stubDnsLookup: no fixture for "${hostname}"`);
  return entry;
};

// ─── CONFIG_WRITABLE_KEYS schema (mirrors routes.ts) ─────────────────────────
// The schema shape is re-declared here to keep the minimal test app self-contained,
// but the SSRF refinements are imported from server/ssrf.ts (not copied) so a real
// regression in the guard would fail this test. The stub DNS resolver above is
// bound in so no test performs a real network lookup.

const CONFIG_WRITABLE_KEYS = z.object({
  github_pat: z.string().optional(),
  model: z.string().optional(),
  endpoint: z
    .string()
    .url()
    .refine((url) => refineEndpointNoPrivateAsync(url, stubDnsLookup), {
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
    .refine((url) => refineOllamaEndpointAsync(url, stubDnsLookup), {
      message: "ollama_endpoint must use https (or http for localhost only) and must not resolve to a private-range IP",
    })
    .optional(),
  llm_timeout_ms: z.string().optional(),
  openrouter_api_key: z.string().optional(),
  openrouter_model: z.string().optional(),
  openrouter_endpoint: z
    .string()
    .url()
    .refine((url) => refineEndpointNoPrivateAsync(url, stubDnsLookup), {
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
  app.put("/config", requireAppToken, async (req: Request, res: Response) => {
    const parsed = await CONFIG_WRITABLE_KEYS.safeParseAsync(req.body);
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

// ─── (g)/(h)/(i) FSE#4: DNS-rebinding-aware SSRF guard ───────────────────────
// A DOMAIN hostname (not a literal IP) that RESOLVES to a private/loopback
// address must be rejected the same as if the literal IP had been supplied
// directly — the string "sneaky-rebind.example.com" is itself neither
// loopback nor private-range, only its (mocked) resolved address is. See
// server/ssrf.ts refineEndpointNoPrivateAsync/refineOllamaEndpointAsync.

describe("PUT /config — DNS-rebinding-aware SSRF guard (FSE#4)", () => {
  it("rejects endpoint when the domain resolves to a loopback address (127.0.0.1)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://sneaky-rebind.example.com/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects endpoint when the domain resolves to the cloud-metadata link-local address (169.254.169.254)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://metadata-attack.example.com/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects endpoint when the domain resolves to an RFC-1918 private address (10.0.0.5)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://private-rebind.example.com/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("accepts endpoint when the domain resolves to a public address", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://public-cloud-llm.example.com/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(200);
  });

  it("rejects openrouter_endpoint when the domain resolves to a private address", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { openrouter_endpoint: "https://private-rebind.example.com/api/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects an unresolvable endpoint domain (fail-closed — no fixture registered)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://this-domain-has-no-dns-fixture.example.com/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  // ── Literal-IP behavior is UNCHANGED by the async/DNS-aware refinement ────
  // Literal IPs never reach the DNS lookup (see server/ssrf.ts isLiteralHost),
  // so these reject/accept exactly as the pre-existing synchronous checks did.

  it("still rejects a literal loopback IP without any DNS fixture registered for it (no lookup performed)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://127.0.0.1:9999/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  // Stronger proof that literal IPs skip the DNS branch entirely: 8.8.8.8 has
  // NO entry in DNS_STUB_MAP. If a literal IP were (incorrectly) routed
  // through resolvesToPrivateOrLoopback(), the stub would throw "no fixture"
  // and the fail-closed catch would reject it (400) — a FALSE negative, since
  // a literal public IP has always been accepted by the synchronous checks
  // alone. Getting 200 here proves the literal-IP path truly bypasses DNS.
  it("still accepts a literal public IP with no DNS fixture registered for it (proves the DNS branch is skipped)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://8.8.8.8/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(200);
  });

  it("still accepts a legitimate https domain that IS registered in the DNS stub (models.github.ai)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://models.github.ai/inference/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(200);
  });
});

// ─── Extended IPv6 SSRF ranges (2026-07-22 security review, PR #49, HIGH) ────
//
// isPrivateIp/isLoopback previously covered IPv4 ranges + IPv4-mapped/
// compatible IPv6 only. The forms below all PASSED refineEndpointNoPrivate
// before this fix — each is a literal, so isLiteralHost skipped DNS entirely,
// and a DOMAIN resolving to one of these addresses passed too (since
// resolvesToPrivateOrLoopback reused the same incomplete checks). One test
// per literal form, plus one DNS-path test proving the DOMAIN-resolves case
// is ALSO now covered (not just the literal-string case).

describe("PUT /config — extended IPv6 SSRF ranges (fc00::/7, fe80::/10, unspecified, NAT64, 6to4)", () => {
  it("rejects endpoint with an IPv6 unique-local address (fc00::1, fc00::/7)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://[fc00::1]/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects endpoint with an IPv6 link-local address (fe80::1, fe80::/10)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://[fe80::1]/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects endpoint with the IPv4 unspecified address (0.0.0.0)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://0.0.0.0/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects endpoint with the IPv6 unspecified address (::)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://[::]/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects endpoint with a NAT64-embedded metadata IP (64:ff9b::169.254.169.254)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://[64:ff9b::169.254.169.254]/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects endpoint with a NAT64-embedded metadata IP in Node's normalized hex form (64:ff9b::a9fe:a9fe)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://[64:ff9b::a9fe:a9fe]/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects endpoint with a 6to4-embedded metadata IP (2002:a9fe:a9fe::1)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://[2002:a9fe:a9fe::1]/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  // DNS-path: a DOMAIN resolving to an IPv6 unique-local address must be
  // rejected exactly like the literal-string case above — proves the fix
  // covers resolvesToPrivateOrLoopback() (server/ssrf.ts), not just the
  // synchronous isPrivateIp/isLoopback string-form checks.
  it("rejects endpoint when the domain resolves to an IPv6 unique-local address (fc00::1, stubbed lookup)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { endpoint: "https://ula-rebind.example.com/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });
});

// ─── SSRF guard on openrouter_endpoint ────────────────────────────────────────
// openrouter_endpoint shares the SAME refineEndpointNoPrivateAsync refinement
// as `endpoint` (GitHub Models) — both are cloud-only inference endpoints
// with no legitimate loopback/private-range use, unlike ollama_endpoint.

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

  // FSE#4: ollama_endpoint's non-localhost branch gets the same DNS-rebinding
  // check as endpoint/openrouter_endpoint above — a remote domain resolving
  // to a private address must still be rejected.
  it("rejects ollama_endpoint when the remote domain resolves to a private address (192.168.1.50)", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { ollama_endpoint: "https://private-ollama-domain.example.com/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(400);
  });

  it("accepts ollama_endpoint when the remote domain resolves to a public address", async () => {
    const res = await jsonRequest(
      server, "PUT", "/config",
      { ollama_endpoint: "https://public-ollama-domain.example.com/v1/chat/completions" },
      AUTH
    );
    expect(res.statusCode).toBe(200);
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

// ─── Secret masking shape (security-review follow-up, PR #48) ───────────────
//
// The minimal test app above re-implements GET/PUT /config against the
// production schema/refinements, but NOT the masking logic in routes.ts
// GET /config (github_pat_masked / openrouter_api_key_masked) — that logic
// only exists on the REAL apiRouter. This block mounts apiRouter directly
// (like routes-auth.integration.test.ts / scenario-parse-failure.integration.test.ts)
// so the assertions below exercise the actual production masking behavior,
// not a hand-copied clone of it.

describe("GET /api/config — secret masking shape (security-review follow-up, PR #48)", () => {
  let realServer: http.Server;
  let savedGithubPat: string;
  let savedOpenrouterKey: string;

  beforeAll(async () => {
    savedGithubPat = getAllConfig().github_pat ?? "";
    savedOpenrouterKey = getAllConfig().openrouter_api_key ?? "";

    const app = express();
    app.use(express.json());
    app.use("/api", apiRouter);
    realServer = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
  });

  afterAll(async () => {
    setConfig("github_pat", savedGithubPat);
    setConfig("openrouter_api_key", savedOpenrouterKey);
    await new Promise<void>((resolve) => realServer.close(() => resolve()));
  });

  it("masks github_pat and openrouter_api_key with first4/last4 and never returns the raw secret", async () => {
    const putRes = await jsonRequest(
      realServer, "PUT", "/api/config",
      {
        github_pat: "ghp_1234567890abcdef",
        openrouter_api_key: "sk-or-v1-abcdef1234567890",
      },
      AUTH
    );
    expect(putRes.statusCode).toBe(200);

    const getRes = await jsonRequest(realServer, "GET", "/api/config");
    expect(getRes.statusCode).toBe(200);

    // Raw secrets are ABSENT from the response body.
    expect(getRes.body.github_pat).toBeUndefined();
    expect(getRes.body.openrouter_api_key).toBeUndefined();

    // Masked fields are present, first4/last4 pattern (matches routes.ts:
    // `pat.slice(0,4) + "****" + pat.slice(-4)`).
    expect(getRes.body.github_pat_masked).toBe("ghp_****cdef");
    expect(getRes.body.openrouter_api_key_masked).toBe("sk-o****7890");
    expect(getRes.body.github_pat_masked).toMatch(/^.{4}\*{4}.{4}$/);
    expect(getRes.body.openrouter_api_key_masked).toMatch(/^.{4}\*{4}.{4}$/);
  });

  it("masks a short (<=8 char) secret as a flat '****' rather than leaking any characters", async () => {
    const putRes = await jsonRequest(
      realServer, "PUT", "/api/config",
      { github_pat: "short1" },
      AUTH
    );
    expect(putRes.statusCode).toBe(200);

    const getRes = await jsonRequest(realServer, "GET", "/api/config");
    expect(getRes.body.github_pat).toBeUndefined();
    expect(getRes.body.github_pat_masked).toBe("****");
  });
});

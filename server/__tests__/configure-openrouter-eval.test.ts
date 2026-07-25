/**
 * Tests for server/evals/configure-openrouter-eval.ts — the one-shot DB
 * config writer .github/workflows/real-model-eval.yml runs before
 * `npm run eval:intent` so the gated CI eval exercises "openrouter" instead
 * of the DB's seeded default provider ("github" — see server/db.ts
 * initSchema()), which is fully retired 2026-07-30 (FSE-EVAL-RED).
 *
 * These are pure DB/env-var assertions — no network access. DNS is always
 * stubbed via the injectable dnsLookup parameter (mirrors server/ssrf.ts's
 * own injection pattern) so no test performs a real lookup, even for the
 * domain-form OPENROUTER_ENDPOINT cases.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  configureOpenRouterForEval,
  EVAL_DEFAULT_LLM_TIMEOUT_MS,
} from "../evals/configure-openrouter-eval.js";
import { getConfig, setConfig } from "../db.js";
import { DEFAULT_OPENROUTER_MODEL } from "../ai.js";
import type { DnsLookupAll } from "../ssrf.js";

const publicDnsStub: DnsLookupAll = async () => [{ address: "203.0.113.10", family: 4 }]; // RFC 5737 TEST-NET-3
const privateDnsStub: DnsLookupAll = async () => [{ address: "192.168.1.50", family: 4 }];

const configKeys = [
  "llm_provider",
  "openrouter_api_key",
  "openrouter_model",
  "openrouter_endpoint",
  "llm_timeout_ms",
] as const;
let originalConfig: Record<(typeof configKeys)[number], string>;
let originalApiKeyEnv: string | undefined;
let originalModelEnv: string | undefined;
let originalEndpointEnv: string | undefined;
let originalTimeoutEnv: string | undefined;
let originalExitCode: number | string | null | undefined;

beforeEach(() => {
  originalConfig = Object.fromEntries(
    configKeys.map((key) => [key, getConfig(key)])
  ) as Record<(typeof configKeys)[number], string>;
  originalApiKeyEnv = process.env.OPENROUTER_API_KEY;
  originalModelEnv = process.env.OPENROUTER_MODEL;
  originalEndpointEnv = process.env.OPENROUTER_ENDPOINT;
  originalTimeoutEnv = process.env.OPENROUTER_EVAL_TIMEOUT_MS;
  // configureOpenRouterForEval() sets process.exitCode = 1 on an SSRF
  // rejection instead of throwing (mirrors run-intent-eval.ts's
  // process.exitCode-not-process.exit gate pattern) — save/restore it so a
  // rejection test can never leak a non-zero exit code into the overall
  // vitest process result.
  originalExitCode = process.exitCode;
});

afterEach(() => {
  for (const key of configKeys) {
    setConfig(key, originalConfig[key]);
  }
  if (originalApiKeyEnv === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalApiKeyEnv;
  if (originalModelEnv === undefined) delete process.env.OPENROUTER_MODEL;
  else process.env.OPENROUTER_MODEL = originalModelEnv;
  if (originalEndpointEnv === undefined) delete process.env.OPENROUTER_ENDPOINT;
  else process.env.OPENROUTER_ENDPOINT = originalEndpointEnv;
  if (originalTimeoutEnv === undefined) delete process.env.OPENROUTER_EVAL_TIMEOUT_MS;
  else process.env.OPENROUTER_EVAL_TIMEOUT_MS = originalTimeoutEnv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe("configureOpenRouterForEval()", () => {
  it("sets llm_provider to openrouter and writes the API key from the env var", async () => {
    process.env.OPENROUTER_API_KEY = "test-or-key";
    delete process.env.OPENROUTER_MODEL;

    await configureOpenRouterForEval();

    expect(getConfig("llm_provider")).toBe("openrouter");
    expect(getConfig("openrouter_api_key")).toBe("test-or-key");
    expect(getConfig("openrouter_model")).toBe(DEFAULT_OPENROUTER_MODEL);
  });

  it("uses OPENROUTER_MODEL when set, overriding the default (workflow_dispatch input / repo variable)", async () => {
    process.env.OPENROUTER_API_KEY = "test-or-key";
    process.env.OPENROUTER_MODEL = "openai/gpt-oss-20b:free";

    await configureOpenRouterForEval();

    expect(getConfig("openrouter_model")).toBe("openai/gpt-oss-20b:free");
  });

  it("trims a whitespace-padded OPENROUTER_MODEL and falls back to the default when it is blank", async () => {
    process.env.OPENROUTER_API_KEY = "test-or-key";
    process.env.OPENROUTER_MODEL = "   ";

    await configureOpenRouterForEval();

    expect(getConfig("openrouter_model")).toBe(DEFAULT_OPENROUTER_MODEL);
  });

  it("still writes config (provider=openrouter, empty key) and logs an error when OPENROUTER_API_KEY is absent", async () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_MODEL;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await configureOpenRouterForEval();

    expect(getConfig("llm_provider")).toBe("openrouter");
    expect(getConfig("openrouter_api_key")).toBe("");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/OPENROUTER_API_KEY is empty/);
  });

  // ─── llm_timeout_ms (eval-run timeout — rides out provider stalls) ─────────

  it("writes llm_timeout_ms with the eval default when OPENROUTER_EVAL_TIMEOUT_MS is unset", async () => {
    process.env.OPENROUTER_API_KEY = "test-or-key";
    delete process.env.OPENROUTER_EVAL_TIMEOUT_MS;

    await configureOpenRouterForEval();

    expect(getConfig("llm_timeout_ms")).toBe(String(EVAL_DEFAULT_LLM_TIMEOUT_MS));
  });

  it("writes llm_timeout_ms from OPENROUTER_EVAL_TIMEOUT_MS when it is a positive number", async () => {
    process.env.OPENROUTER_API_KEY = "test-or-key";
    process.env.OPENROUTER_EVAL_TIMEOUT_MS = "45000";

    await configureOpenRouterForEval();

    expect(getConfig("llm_timeout_ms")).toBe("45000");
  });

  it("falls back to the eval default and logs when OPENROUTER_EVAL_TIMEOUT_MS is not a positive number", async () => {
    process.env.OPENROUTER_API_KEY = "test-or-key";
    process.env.OPENROUTER_EVAL_TIMEOUT_MS = "-5";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await configureOpenRouterForEval();

    expect(getConfig("llm_timeout_ms")).toBe(String(EVAL_DEFAULT_LLM_TIMEOUT_MS));
    expect(
      errorSpy.mock.calls.some((c) => String(c[0]).includes("OPENROUTER_EVAL_TIMEOUT_MS"))
    ).toBe(true);
  });

  it("still writes llm_timeout_ms when the endpoint is SSRF-rejected (the gated run still executes)", async () => {
    process.env.OPENROUTER_API_KEY = "test-or-key";
    process.env.OPENROUTER_ENDPOINT = "https://192.168.1.1/v1/chat/completions";
    delete process.env.OPENROUTER_EVAL_TIMEOUT_MS;
    vi.spyOn(console, "error").mockImplementation(() => {});

    await configureOpenRouterForEval();

    expect(getConfig("llm_timeout_ms")).toBe(String(EVAL_DEFAULT_LLM_TIMEOUT_MS));
    expect(process.exitCode).toBe(1);
  });

  // ─── OPENROUTER_ENDPOINT (local verification runs, e.g. NVIDIA NIM) ────────

  it("writes openrouter_endpoint when OPENROUTER_ENDPOINT is a literal https IP (no DNS lookup needed)", async () => {
    process.env.OPENROUTER_API_KEY = "test-or-key";
    process.env.OPENROUTER_ENDPOINT = "https://8.8.8.8/v1/chat/completions";

    await configureOpenRouterForEval();

    expect(getConfig("openrouter_endpoint")).toBe("https://8.8.8.8/v1/chat/completions");
    expect(process.exitCode).toBeFalsy();
  });

  it("writes openrouter_endpoint when the domain resolves to a public address (stubbed lookup)", async () => {
    process.env.OPENROUTER_API_KEY = "test-or-key";
    process.env.OPENROUTER_ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";

    await configureOpenRouterForEval(publicDnsStub);

    expect(getConfig("openrouter_endpoint")).toBe(
      "https://integrate.api.nvidia.com/v1/chat/completions"
    );
    expect(process.exitCode).toBeFalsy();
  });

  it("leaves openrouter_endpoint untouched when OPENROUTER_ENDPOINT is unset (default behavior unchanged)", async () => {
    process.env.OPENROUTER_API_KEY = "test-or-key";
    delete process.env.OPENROUTER_ENDPOINT;
    setConfig("openrouter_endpoint", "pre-existing-value");

    await configureOpenRouterForEval();

    expect(getConfig("openrouter_endpoint")).toBe("pre-existing-value");
  });

  it("leaves openrouter_endpoint untouched when OPENROUTER_ENDPOINT is blank/whitespace-only", async () => {
    process.env.OPENROUTER_API_KEY = "test-or-key";
    process.env.OPENROUTER_ENDPOINT = "   ";
    setConfig("openrouter_endpoint", "pre-existing-value");

    await configureOpenRouterForEval();

    expect(getConfig("openrouter_endpoint")).toBe("pre-existing-value");
  });

  // ─── SSRF validation (2026-07-22 security review, PR #49, MEDIUM) ──────────

  it("rejects and does NOT write a literal loopback/private OPENROUTER_ENDPOINT, and sets a non-zero exit code", async () => {
    process.env.OPENROUTER_API_KEY = "test-or-key";
    process.env.OPENROUTER_ENDPOINT = "https://192.168.1.1/v1/chat/completions";
    setConfig("openrouter_endpoint", "pre-existing-value");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await configureOpenRouterForEval();

    expect(getConfig("openrouter_endpoint")).toBe("pre-existing-value");
    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("failed SSRF validation"))).toBe(true);
    // llm_provider/api_key/model are still written even when the endpoint is rejected
    // — the run falls back to getAiConfig()'s default endpoint rather than aborting outright.
    expect(getConfig("llm_provider")).toBe("openrouter");
    expect(getConfig("openrouter_api_key")).toBe("test-or-key");
  });

  it("rejects and does NOT write an OPENROUTER_ENDPOINT domain that resolves to a private address (stubbed lookup)", async () => {
    process.env.OPENROUTER_API_KEY = "test-or-key";
    process.env.OPENROUTER_ENDPOINT = "https://sneaky-rebind.example.com/v1/chat/completions";
    setConfig("openrouter_endpoint", "pre-existing-value");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await configureOpenRouterForEval(privateDnsStub);

    expect(getConfig("openrouter_endpoint")).toBe("pre-existing-value");
    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes("failed SSRF validation"))).toBe(true);
  });

  it("rejects a non-https OPENROUTER_ENDPOINT", async () => {
    process.env.OPENROUTER_API_KEY = "test-or-key";
    process.env.OPENROUTER_ENDPOINT = "http://integrate.api.nvidia.com/v1/chat/completions";
    setConfig("openrouter_endpoint", "pre-existing-value");
    vi.spyOn(console, "error").mockImplementation(() => {});

    await configureOpenRouterForEval(publicDnsStub);

    expect(getConfig("openrouter_endpoint")).toBe("pre-existing-value");
    expect(process.exitCode).toBe(1);
  });

  it("rejects a malformed OPENROUTER_ENDPOINT URL", async () => {
    process.env.OPENROUTER_API_KEY = "test-or-key";
    process.env.OPENROUTER_ENDPOINT = "not a valid url";
    setConfig("openrouter_endpoint", "pre-existing-value");
    vi.spyOn(console, "error").mockImplementation(() => {});

    await configureOpenRouterForEval();

    expect(getConfig("openrouter_endpoint")).toBe("pre-existing-value");
    expect(process.exitCode).toBe(1);
  });
});

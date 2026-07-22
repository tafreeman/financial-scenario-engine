/**
 * Tests for server/evals/configure-openrouter-eval.ts — the one-shot DB
 * config writer .github/workflows/real-model-eval.yml runs before
 * `npm run eval:intent` so the gated CI eval exercises "openrouter" instead
 * of the DB's seeded default provider ("github" — see server/db.ts
 * initSchema()), which is fully retired 2026-07-30 (FSE-EVAL-RED).
 *
 * These are pure DB/env-var assertions — no network access.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { configureOpenRouterForEval } from "../evals/configure-openrouter-eval.js";
import { getConfig, setConfig } from "../db.js";
import { DEFAULT_OPENROUTER_MODEL } from "../ai.js";

const configKeys = ["llm_provider", "openrouter_api_key", "openrouter_model"] as const;
let originalConfig: Record<(typeof configKeys)[number], string>;
let originalApiKeyEnv: string | undefined;
let originalModelEnv: string | undefined;

beforeEach(() => {
  originalConfig = Object.fromEntries(
    configKeys.map((key) => [key, getConfig(key)])
  ) as Record<(typeof configKeys)[number], string>;
  originalApiKeyEnv = process.env.OPENROUTER_API_KEY;
  originalModelEnv = process.env.OPENROUTER_MODEL;
});

afterEach(() => {
  for (const key of configKeys) {
    setConfig(key, originalConfig[key]);
  }
  if (originalApiKeyEnv === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalApiKeyEnv;
  if (originalModelEnv === undefined) delete process.env.OPENROUTER_MODEL;
  else process.env.OPENROUTER_MODEL = originalModelEnv;
  vi.restoreAllMocks();
});

describe("configureOpenRouterForEval()", () => {
  it("sets llm_provider to openrouter and writes the API key from the env var", () => {
    process.env.OPENROUTER_API_KEY = "test-or-key";
    delete process.env.OPENROUTER_MODEL;

    configureOpenRouterForEval();

    expect(getConfig("llm_provider")).toBe("openrouter");
    expect(getConfig("openrouter_api_key")).toBe("test-or-key");
    expect(getConfig("openrouter_model")).toBe(DEFAULT_OPENROUTER_MODEL);
  });

  it("uses OPENROUTER_MODEL when set, overriding the default (workflow_dispatch input / repo variable)", () => {
    process.env.OPENROUTER_API_KEY = "test-or-key";
    process.env.OPENROUTER_MODEL = "openai/gpt-oss-20b:free";

    configureOpenRouterForEval();

    expect(getConfig("openrouter_model")).toBe("openai/gpt-oss-20b:free");
  });

  it("trims a whitespace-padded OPENROUTER_MODEL and falls back to the default when it is blank", () => {
    process.env.OPENROUTER_API_KEY = "test-or-key";
    process.env.OPENROUTER_MODEL = "   ";

    configureOpenRouterForEval();

    expect(getConfig("openrouter_model")).toBe(DEFAULT_OPENROUTER_MODEL);
  });

  it("still writes config (provider=openrouter, empty key) and logs an error when OPENROUTER_API_KEY is absent", () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_MODEL;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    configureOpenRouterForEval();

    expect(getConfig("llm_provider")).toBe("openrouter");
    expect(getConfig("openrouter_api_key")).toBe("");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toMatch(/OPENROUTER_API_KEY is empty/);
  });
});

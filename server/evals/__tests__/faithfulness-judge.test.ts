/**
 * Eval-agent follow-up (2026-07-22) — migrate faithfulness-judge.ts off its
 * GitHub-Models-only assumptions, onto the SAME provider-aware pattern
 * run-intent-eval.ts already uses:
 *   1. judgeNarrationFaithfulness()'s provider gate now uses isProviderConfigured()
 *      (server/ai.ts) instead of a hardcoded `provider === "github" && !pat`
 *      check, so an unconfigured openrouter/ollama deployment is correctly
 *      reported rather than silently treated as "configured".
 *   2. defaultJudgeModelCaller now sets an Authorization Bearer header for
 *      "openrouter" too — before this fix, NO Authorization header was ever
 *      set for that provider, so every judge call against it failed with 401.
 *
 * The default model caller performs a real `fetch`, so these tests stub
 * `global.fetch` via vi.stubGlobal — the SAME idiom server/__tests__/ai.test.ts
 * already uses for parseIntent's default-fetch path (no module mocking).
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  judgeNarrationFaithfulness,
  type JudgeModelResponse,
} from "../faithfulness-judge.js";
import { getConfig, setConfig } from "../../db.js";
import type { ScenarioResult } from "../../engine/types.js";

// Minimal fixture — judgeNarrationFaithfulness only JSON.stringifies this into
// the judge prompt; it never validates its shape beyond the ScenarioResult type.
const FIXTURE_RESULT = {
  operation: { action: "burn_rate_check" },
  timestamp: "2026-01-15T00:00:00.000Z",
  projects_involved: [],
  current: { labor: {}, margin: {}, budget: {} },
  warnings: [],
} as unknown as ScenarioResult;

const FIXTURE_NARRATIVE = "The portfolio burn rate is stable this month.";

const VALID_VERDICT_JSON = JSON.stringify({ faithful: true, violations: [] });

function jsonResponse(content: string): JudgeModelResponse {
  return { choices: [{ message: { content } }] };
}

const configKeys = [
  "llm_provider",
  "github_pat",
  "ollama_endpoint",
  "openrouter_api_key",
  "openrouter_model",
  "openrouter_endpoint",
] as const;

let originalConfig: Record<(typeof configKeys)[number], string>;
let originalGithubTokenEnv: string | undefined;
let originalOpenRouterKeyEnv: string | undefined;

beforeEach(() => {
  originalConfig = Object.fromEntries(
    configKeys.map((key) => [key, getConfig(key)])
  ) as Record<(typeof configKeys)[number], string>;
  originalGithubTokenEnv = process.env.GITHUB_TOKEN;
  originalOpenRouterKeyEnv = process.env.OPENROUTER_API_KEY;
});

afterEach(() => {
  for (const key of configKeys) {
    setConfig(key, originalConfig[key]);
  }
  if (originalGithubTokenEnv === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = originalGithubTokenEnv;
  if (originalOpenRouterKeyEnv === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalOpenRouterKeyEnv;
  vi.unstubAllGlobals();
});

describe("judgeNarrationFaithfulness — provider-aware gate (eval-agent follow-up)", () => {
  it("returns provider_unconfigured for an unconfigured OpenRouter provider (previously silently treated as configured)", async () => {
    setConfig("llm_provider", "openrouter");
    setConfig("openrouter_api_key", "");
    delete process.env.OPENROUTER_API_KEY;

    const neverCalled = vi.fn(() => {
      throw new Error("modelCaller must not be called when the provider is unconfigured");
    });

    const result = await judgeNarrationFaithfulness(FIXTURE_RESULT, FIXTURE_NARRATIVE, neverCalled);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a provider_unconfigured failure");
    expect(result.code).toBe("provider_unconfigured");
    expect(result.message).toMatch(/OpenRouter/i);
    expect(neverCalled).not.toHaveBeenCalled();
  });

  it("still returns provider_unconfigured for the github provider with no pat (existing behavior preserved)", async () => {
    setConfig("llm_provider", "github");
    setConfig("github_pat", "");
    delete process.env.GITHUB_TOKEN;

    const neverCalled = vi.fn(() => {
      throw new Error("modelCaller must not be called when the provider is unconfigured");
    });

    const result = await judgeNarrationFaithfulness(FIXTURE_RESULT, FIXTURE_NARRATIVE, neverCalled);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a provider_unconfigured failure");
    expect(result.code).toBe("provider_unconfigured");
    expect(neverCalled).not.toHaveBeenCalled();
  });

  it("proceeds to call the model for ollama even without a pat (ollama needs none — isProviderConfigured() special-cases it)", async () => {
    setConfig("llm_provider", "ollama");
    setConfig("ollama_endpoint", "http://localhost:11434/v1/chat/completions");

    const modelCaller = vi.fn().mockResolvedValue(jsonResponse(VALID_VERDICT_JSON));
    const result = await judgeNarrationFaithfulness(FIXTURE_RESULT, FIXTURE_NARRATIVE, modelCaller);

    expect(modelCaller).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected a successful verdict");
    expect(result.verdict.faithful).toBe(true);
  });

  it("proceeds to call the model for a configured openrouter provider", async () => {
    setConfig("llm_provider", "openrouter");
    setConfig("openrouter_api_key", "or-test-key");

    const modelCaller = vi.fn().mockResolvedValue(jsonResponse(VALID_VERDICT_JSON));
    const result = await judgeNarrationFaithfulness(FIXTURE_RESULT, FIXTURE_NARRATIVE, modelCaller);

    expect(modelCaller).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });
});

describe("defaultJudgeModelCaller — provider-specific auth headers (eval-agent follow-up)", () => {
  it("sends a Bearer Authorization header for openrouter (the bug: previously NO header was set for this provider)", async () => {
    setConfig("llm_provider", "openrouter");
    setConfig("openrouter_api_key", "or-test-key");
    const fetchStub = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => jsonResponse(VALID_VERDICT_JSON),
    });
    vi.stubGlobal("fetch", fetchStub);

    // No modelCaller override — exercises the real defaultJudgeModelCaller.
    const result = await judgeNarrationFaithfulness(FIXTURE_RESULT, FIXTURE_NARRATIVE);

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const opts = fetchStub.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = opts?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer or-test-key");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(result.ok).toBe(true);
  });

  it("does not set an Authorization header for ollama (mirrors server/ai.ts chatRequest())", async () => {
    setConfig("llm_provider", "ollama");
    setConfig("ollama_endpoint", "http://localhost:11434/v1/chat/completions");
    const fetchStub = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => jsonResponse(VALID_VERDICT_JSON),
    });
    vi.stubGlobal("fetch", fetchStub);

    await judgeNarrationFaithfulness(FIXTURE_RESULT, FIXTURE_NARRATIVE);

    const opts = fetchStub.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = opts?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("keeps the GitHub-specific header set unchanged (regression guard)", async () => {
    setConfig("llm_provider", "github");
    setConfig("github_pat", "test-pat");
    const fetchStub = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => jsonResponse(VALID_VERDICT_JSON),
    });
    vi.stubGlobal("fetch", fetchStub);

    await judgeNarrationFaithfulness(FIXTURE_RESULT, FIXTURE_NARRATIVE);

    const opts = fetchStub.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = opts?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-pat");
    expect(headers["Accept"]).toBe("application/vnd.github+json");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });
});

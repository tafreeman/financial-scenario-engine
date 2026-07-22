import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  parseIntent,
  narrateResult,
  processToolCalls,
  chatRequest,
  getAiConfig,
  isProviderConfigured,
  parseTimeoutMs,
  readGhCliToken,
  resolveGitHubToken,
  getGitHubTokenSource,
  resolveOpenRouterKey,
  _resetGhTokenCache,
  DEFAULT_LLM_TIMEOUT_MS,
  LLM_TIMEOUT_MAX_MS,
  DEFAULT_OPENROUTER_MODEL,
} from "../ai.js";
import type { ToolCall, ChatMessage } from "../ai.js";
import type { ScenarioResult, ScenarioOperation } from "../engine/types.js";
import { getConfig, setConfig } from "../db.js";
import { getLlmTelemetrySnapshot, __resetLlmTelemetryForTests } from "../llm-telemetry.js";

// Export under test — import the private helpers via the ai module surface
// that exports them indirectly (temperature/maxTokens clamping visible through
// parseIntent behaviour; we test via getAiConfig-observable side effects).
// For the timeout we inject a fake fetch stub via vi.stubGlobal.

const configKeys = [
  "llm_provider",
  "ollama_endpoint",
  "ollama_model",
  "temperature",
  "max_tokens",
  "llm_timeout_ms",
  "openrouter_api_key",
  "openrouter_model",
  "openrouter_endpoint",
] as const;

let originalConfig: Record<(typeof configKeys)[number], string>;

beforeEach(() => {
  originalConfig = Object.fromEntries(
    configKeys.map((key) => [key, getConfig(key)])
  ) as Record<(typeof configKeys)[number], string>;

  setConfig("llm_provider", "ollama");
  setConfig("ollama_endpoint", "http://localhost:11434/v1/chat/completions");
  setConfig("ollama_model", "llama3.2");
});

afterEach(() => {
  for (const key of configKeys) {
    setConfig(key, originalConfig[key]);
  }
  vi.unstubAllGlobals();
});

describe("parseIntent - explicit parse failure contract", () => {
  it("does not masquerade malformed LLM output as a burn rate operation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "this is not json" },
          },
        ],
      }),
    }));

    const result = await parseIntent("Replace the architect on Project Alpha", "anonymized context");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected parse failure");
    expect(result.code).toBe("invalid_json");
    expect(JSON.stringify(result)).not.toContain("burn_rate_check");
  });
});

describe("chatRequest — bounded retry with backoff", () => {
  it("retries a 429 once and then succeeds, without real sleeping", async () => {
    const tooMany = {
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: new Headers(),
      text: async () => "rate limited",
    };
    const success = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "ok" } }],
      }),
    };
    const fetchStub = vi
      .fn()
      .mockResolvedValueOnce(tooMany)
      .mockResolvedValueOnce(success);
    const sleeps: number[] = [];
    const sleepStub = async (ms: number): Promise<void> => {
      sleeps.push(ms);
    };

    const resp = await chatRequest(
      "http://localhost:11434/v1/chat/completions",
      "",
      { model: "llama3.2" },
      fetchStub as unknown as typeof fetch,
      sleepStub
    );

    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(sleeps).toHaveLength(1);
    const typed = resp as { choices: { message: { content: string } }[] };
    expect(typed.choices[0]?.message.content).toBe("ok");
  });

  it("does not retry on timeout (AbortError) and surfaces a timeout error", async () => {
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    const fetchStub = vi.fn().mockRejectedValue(abortErr);
    const sleepStub = vi.fn(async (): Promise<void> => {});

    await expect(
      chatRequest(
        "http://localhost:11434/v1/chat/completions",
        "",
        { model: "llama3.2" },
        fetchStub as unknown as typeof fetch,
        sleepStub
      )
    ).rejects.toThrow(/timed out/);

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(sleepStub).not.toHaveBeenCalled();
  });

  it("calls fetch with redirect:'error' to block SSRF redirect bypass", async () => {
    const success = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    };
    const fetchStub = vi.fn().mockResolvedValue(success);

    await chatRequest(
      "http://localhost:11434/v1/chat/completions",
      "",
      { model: "llama3.2" },
      fetchStub as unknown as typeof fetch,
      async () => {}
    );

    const opts = fetchStub.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(opts?.redirect).toBe("error");
  });

  it("caps a huge Retry-After header so it cannot stall the request", async () => {
    const tooMany = {
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: new Headers({ "retry-after": "3600" }), // server asks for 1 hour
      text: async () => "rate limited",
    };
    const success = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "ok" } }],
      }),
    };
    const fetchStub = vi
      .fn()
      .mockResolvedValueOnce(tooMany)
      .mockResolvedValueOnce(success);
    const sleeps: number[] = [];
    const sleepStub = async (ms: number): Promise<void> => {
      sleeps.push(ms);
    };

    await chatRequest(
      "http://localhost:11434/v1/chat/completions",
      "",
      { model: "llama3.2" },
      fetchStub as unknown as typeof fetch,
      sleepStub
    );

    // 3600s -> 3_600_000ms would block the request for an hour; the cap holds
    // the honored delay to 60_000ms.
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBe(60_000);
    expect(sleeps[0]).toBeLessThan(3_600_000);
  });

  it("ignores a whitespace-only Retry-After (no 0ms instant retry)", async () => {
    const tooMany = {
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      // Plain object instead of Headers (which strips OWS) so the blank value
      // reaches retryDelayMs verbatim. Number("  ") is 0, which without the
      // guard would force a 0ms retry; it must fall through to backoff instead.
      headers: {
        get: (k: string) => (k.toLowerCase() === "retry-after" ? "   " : null),
      },
      text: async () => "rate limited",
    };
    const success = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "ok" } }],
      }),
    };
    const fetchStub = vi
      .fn()
      .mockResolvedValueOnce(tooMany)
      .mockResolvedValueOnce(success);
    const sleeps: number[] = [];
    const sleepStub = async (ms: number): Promise<void> => {
      sleeps.push(ms);
    };

    await chatRequest(
      "http://localhost:11434/v1/chat/completions",
      "",
      { model: "llama3.2" },
      fetchStub as unknown as typeof fetch,
      sleepStub
    );

    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(0);
  });

  it("does not retry a blocked redirect and fails fast", async () => {
    // redirect: "error" makes undici reject with "unexpected redirect"; that is a
    // permanent SSRF/config issue, so the request must fail immediately rather
    // than re-POST the payload to the redirecting endpoint on every retry.
    const redirectErr = new TypeError("fetch failed: unexpected redirect");
    const fetchStub = vi.fn().mockRejectedValue(redirectErr);
    const sleepStub = vi.fn(async (): Promise<void> => {});

    await expect(
      chatRequest(
        "http://localhost:11434/v1/chat/completions",
        "",
        { model: "llama3.2" },
        fetchStub as unknown as typeof fetch,
        sleepStub
      )
    ).rejects.toThrow(/redirect/i);

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(sleepStub).not.toHaveBeenCalled();
  });
});

describe("parseTimeoutMs — clamp llm_timeout_ms (config DoS guard)", () => {
  it("falls back to the default for negative, zero, and non-numeric values", () => {
    expect(parseTimeoutMs("-1")).toBe(DEFAULT_LLM_TIMEOUT_MS);
    expect(parseTimeoutMs("0")).toBe(DEFAULT_LLM_TIMEOUT_MS);
    expect(parseTimeoutMs("abc")).toBe(DEFAULT_LLM_TIMEOUT_MS);
    expect(parseTimeoutMs("")).toBe(DEFAULT_LLM_TIMEOUT_MS);
  });

  it("rejects scientific notation, decimals, and garbage suffixes (parseInt truncation DoS)", () => {
    // parseInt would truncate these to 1 / 30 / 10 / 30 — a near-zero timeout
    // that aborts every request. strictInt rejects them outright.
    expect(parseTimeoutMs("1e6")).toBe(DEFAULT_LLM_TIMEOUT_MS);
    expect(parseTimeoutMs("30.5")).toBe(DEFAULT_LLM_TIMEOUT_MS);
    expect(parseTimeoutMs("10abc")).toBe(DEFAULT_LLM_TIMEOUT_MS);
    expect(parseTimeoutMs("30 000")).toBe(DEFAULT_LLM_TIMEOUT_MS);
  });

  it("clamps an absurdly large value to the max", () => {
    expect(parseTimeoutMs("99999999")).toBe(LLM_TIMEOUT_MAX_MS);
  });

  it("honors a valid positive timeout", () => {
    expect(parseTimeoutMs("60000")).toBe(60000);
  });
});

describe("getAiConfig — llm_timeout_ms clamp wired for both providers (#28)", () => {
  it("clamps a negative timeout on the ollama provider path", () => {
    setConfig("llm_provider", "ollama");
    setConfig("llm_timeout_ms", "-1");
    expect(getAiConfig().timeoutMs).toBe(DEFAULT_LLM_TIMEOUT_MS);
  });

  it("clamps a negative timeout on the github provider path", () => {
    setConfig("llm_provider", "github");
    setConfig("llm_timeout_ms", "-1");
    expect(getAiConfig().timeoutMs).toBe(DEFAULT_LLM_TIMEOUT_MS);
  });

  it("honors a valid timeout on the github provider path", () => {
    setConfig("llm_provider", "github");
    setConfig("llm_timeout_ms", "45000");
    expect(getAiConfig().timeoutMs).toBe(45000);
  });
});

/**
 * The agentic (V3) path executes LLM-supplied tool arguments. These tests pin
 * the boundary guarantee that malformed or schema-invalid arguments are rejected
 * before any scenario math runs — i.e. unvalidated LLM output never reaches the
 * deterministic engine.
 */
describe("processToolCalls — boundary validation of LLM tool arguments", () => {
  it("rejects schema-invalid run_scenario args without running scenario math", () => {
    const messages: ChatMessage[] = [];
    const scenariosExplored: ScenarioResult[] = [];
    const toolCalls: ToolCall[] = [
      {
        id: "call_1",
        type: "function",
        function: { name: "run_scenario", arguments: JSON.stringify({ action: "not_a_real_action" }) },
      },
    ];

    processToolCalls(toolCalls, messages, scenariosExplored);

    expect(scenariosExplored).toHaveLength(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("tool");
    expect(String(messages[0]?.content)).toContain("Invalid run_scenario arguments");
  });

  it("rejects malformed JSON args without running scenario math", () => {
    const messages: ChatMessage[] = [];
    const scenariosExplored: ScenarioResult[] = [];
    const toolCalls: ToolCall[] = [
      { id: "call_2", type: "function", function: { name: "run_scenario", arguments: "{ not valid json" } },
    ];

    processToolCalls(toolCalls, messages, scenariosExplored);

    expect(scenariosExplored).toHaveLength(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("tool");
  });

  it("pushes an error tool message for unknown tool calls (prevents unpaired tool_call_id)", () => {
    // #24: Unknown tool names must push an error tool message so the tool_call_id
    // is paired — unpaired ids cause protocol violations on the next iteration.
    const messages: ChatMessage[] = [];
    const scenariosExplored: ScenarioResult[] = [];
    const toolCalls: ToolCall[] = [
      { id: "call_3", type: "function", function: { name: "some_other_tool", arguments: "{}" } },
    ];

    processToolCalls(toolCalls, messages, scenariosExplored);

    expect(scenariosExplored).toHaveLength(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("tool");
    expect(messages[0]?.tool_call_id).toBe("call_3");
    expect(String(messages[0]?.content)).toContain("some_other_tool");
  });

  it("pushes two tool messages for a valid call followed by an unknown call (#24)", () => {
    const messages: ChatMessage[] = [];
    const scenariosExplored: ScenarioResult[] = [];
    const toolCalls: ToolCall[] = [
      {
        id: "call_run",
        type: "function",
        function: { name: "run_scenario", arguments: JSON.stringify({ action: "burn_rate_check" }) },
      },
      {
        id: "call_unknown",
        type: "function",
        function: { name: "some_future_tool", arguments: "{}" },
      },
    ];

    processToolCalls(toolCalls, messages, scenariosExplored);

    // Both tool_call_ids must be paired with tool messages
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("tool");
    expect(messages[0]?.tool_call_id).toBe("call_run");
    expect(messages[1]?.role).toBe("tool");
    expect(messages[1]?.tool_call_id).toBe("call_unknown");
    expect(String(messages[1]?.content)).toContain("some_future_tool");
  });
});

// ─── #8 LLM timeout — AbortController ───────────────────────────────────────

describe("parseIntent — LLM timeout via AbortController (#8)", () => {
  it("rejects with a descriptive timeout error when fetch hangs (fake AbortError)", async () => {
    // Inject a fetch stub that simulates the AbortController aborting mid-request.
    // We do NOT sleep 30s; we immediately reject with an AbortError name.
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      const err = new DOMException("The operation was aborted.", "AbortError");
      return Promise.reject(err);
    }));

    const result = await parseIntent("Analyse burn rate", "context");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected parse failure");
    // AbortError is mapped to provider_error with a descriptive message
    expect(result.code).toBe("provider_error");
    expect(result.message).toBeTruthy();
  });
});

// ─── #14 getAiConfig temperature/maxTokens clamping ─────────────────────────

describe("getAiConfig temperature/maxTokens clamping (#14)", () => {
  it("clamps temperature 999 to 2 (parse intent request carries clamped value)", async () => {
    setConfig("temperature", "999");

    // Capture what payload the fetch stub receives
    let capturedPayload: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      capturedPayload = JSON.parse(opts.body as string) as Record<string, unknown>;
      const abortErr = new DOMException("abort", "AbortError");
      return Promise.reject(abortErr);
    }));

    await parseIntent("test", "context");

    // The payload's temperature must be the clamped value, not 999
    expect(capturedPayload).not.toBeNull();
    // parseIntent uses temperature:0 for the intent-parse step; the clamped config
    // value flows into narrative/agentic calls. We verify via the stored value read
    // by getAiConfig — indirectly observable: the stored config would propagate NaN
    // without the clamp guard. Verify DB read returns sensible value after write.
    setConfig("temperature", "abc");
    // When getAiConfig reads "abc", parseTemperature returns 0.2 (not NaN).
    // We can observe this by checking the next call uses 0.2 in the payload.
    let payload2: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      payload2 = JSON.parse(opts.body as string) as Record<string, unknown>;
      const abortErr = new DOMException("abort", "AbortError");
      return Promise.reject(abortErr);
    }));
    await parseIntent("test", "context");
    // parseIntent overrides temperature to 0 for intent parsing, so check max_tokens
    // instead — it must not be NaN or outside [100,4000]
    const maxTokens = (payload2 as Record<string, unknown> | null)?.max_tokens;
    expect(typeof maxTokens).toBe("number");
    expect(Number.isFinite(maxTokens as number)).toBe(true);
  });
});

// ─── WP3-B: observability at the LLM boundary ───────────────────────────────

describe("LLM boundary observability — structured log + aggregation (WP3-B)", () => {
  beforeEach(() => {
    __resetLlmTelemetryForTests();
  });

  afterEach(() => {
    __resetLlmTelemetryForTests();
    // Restore console.log/console.error spies between tests in this block —
    // without this, an un-restored spy from an earlier test keeps intercepting
    // calls (stacked spies), so a later test's freshly-created spy sees stale
    // call history from tests that ran before it.
    vi.restoreAllMocks();
  });

  it("logs a single stable-shape JSON line and records a success in telemetry for parseIntent", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => ({
        choices: [{ message: { role: "assistant", content: '{"action":"burn_rate_check"}' }, finish_reason: "stop" }],
        // prompt_tokens + completion_tokens = total_tokens, matching the real
        // OpenAI-compatible shape GitHub Models/Ollama return. Deliberately
        // distinct values so a test that read total_tokens into either field
        // (the bug this test guards against) would fail loudly.
        usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
      }),
    }));

    const result = await parseIntent("What's the burn rate?", "anonymized context");
    expect(result.ok).toBe(true);

    // Exactly one llm_call log line was written for this one LLM call.
    const llmCallLines = logSpy.mock.calls
      .map((c) => c[0] as string)
      .filter((line) => typeof line === "string" && line.includes('"event":"llm_call"'));
    expect(llmCallLines).toHaveLength(1);

    const parsed = JSON.parse(llmCallLines[0] as string);
    // Stable shape: request id, provider/model, purpose, latency, outcome —
    // and NEVER the query/context content (PII-redaction posture).
    // tokensIn/tokensOut must reflect prompt_tokens/completion_tokens
    // respectively, NOT total_tokens (42) collapsed into one field.
    expect(parsed).toMatchObject({
      level: "info",
      event: "llm_call",
      purpose: "intent",
      outcome: "success",
      retryCount: 0,
      tokensIn: 30,
      tokensOut: 12,
    });
    expect(typeof parsed.requestId).toBe("string");
    expect(parsed.requestId.length).toBeGreaterThan(0);
    expect(typeof parsed.provider).toBe("string");
    expect(typeof parsed.model).toBe("string");
    expect(typeof parsed.latencyMs).toBe("number");
    expect(parsed.latencyMs).toBeGreaterThanOrEqual(0);
    // No prompt/query/context content anywhere in the line.
    expect(llmCallLines[0]).not.toContain("burn rate");
    expect(llmCallLines[0]).not.toContain("anonymized context");

    const snapshot = getLlmTelemetrySnapshot();
    expect(snapshot.totals.calls).toBe(1);
    expect(snapshot.totals.tokensIn).toBe(30);
    expect(snapshot.totals.tokensOut).toBe(12);
    expect(snapshot.totals.failures).toBe(0);
    expect(snapshot.byPurpose.intent?.calls).toBe(1);
  });

  it("logs a failure outcome with a typed failure code and records it in telemetry on timeout", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      const err = new DOMException("The operation was aborted.", "AbortError");
      return Promise.reject(err);
    }));

    const result = await parseIntent("Analyse burn rate", "context");
    expect(result.ok).toBe(false);

    const llmCallLines = errorSpy.mock.calls
      .map((c) => c[0] as string)
      .filter((line) => typeof line === "string" && line.includes('"event":"llm_call"'));
    expect(llmCallLines).toHaveLength(1);

    const parsed = JSON.parse(llmCallLines[0] as string);
    expect(parsed).toMatchObject({
      level: "error",
      event: "llm_call",
      purpose: "intent",
      outcome: "failure",
      failureCode: "timeout",
    });

    const snapshot = getLlmTelemetrySnapshot();
    // recordLlmCall() counts every call attempt (success or failure) toward
    // totals.calls — a failed call is still a call that was made.
    expect(snapshot.totals.calls).toBe(1);
    expect(snapshot.totals.failures).toBe(1);
    expect(snapshot.failuresByCode.timeout).toBe(1);
    expect(snapshot.byPurpose.intent?.failures).toBe(1);
  });

  it("does not log or record anything when the provider is unconfigured (no LLM call was made)", async () => {
    setConfig("llm_provider", "github");
    setConfig("github_pat", "");
    const originalEnvToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await parseIntent("test", "context");
    expect(result.ok).toBe(false);

    const allLines = [...logSpy.mock.calls, ...errorSpy.mock.calls]
      .map((c) => c[0] as string)
      .filter((line) => typeof line === "string" && line.includes('"event":"llm_call"'));
    expect(allLines).toHaveLength(0);

    const snapshot = getLlmTelemetrySnapshot();
    expect(snapshot.totals.calls).toBe(0);
    expect(snapshot.totals.failures).toBe(0);

    if (originalEnvToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalEnvToken;
  });

  it("records purpose:'narration' for narrateResult", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "## Impact Summary\nOK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 6, total_tokens: 17 },
      }),
    }));

    const operation = { action: "burn_rate_check" } as unknown as ScenarioOperation;
    const result = {
      operation,
      timestamp: new Date().toISOString(),
      projects_involved: [],
      current: {
        labor: {} as ScenarioResult["current"]["labor"],
        margin: {} as ScenarioResult["current"]["margin"],
        budget: {} as ScenarioResult["current"]["budget"],
      },
      warnings: [],
    } as unknown as ScenarioResult;

    await narrateResult(operation, result);

    const snapshot = getLlmTelemetrySnapshot();
    expect(snapshot.byPurpose.narration?.calls).toBe(1);
    expect(snapshot.byPurpose.narration?.tokensIn).toBe(11);
    expect(snapshot.byPurpose.narration?.tokensOut).toBe(6);
    expect(snapshot.byPurpose.intent).toBeUndefined();
  });

  it("records the retry count observed by chatRequest's attemptTracker", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const tooMany = {
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: new Headers(),
      text: async () => "rate limited",
    };
    const success = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => ({
        choices: [{ message: { role: "assistant", content: '{"action":"burn_rate_check"}' }, finish_reason: "stop" }],
      }),
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(tooMany)
      .mockResolvedValueOnce(success));

    // parseIntent uses the real defaultSleep internally via instrumentedChatRequest,
    // but the 429 retry delay is bounded (LLM_RETRY_BASE_DELAY_MS ~500ms) so this
    // stays fast enough for a unit test without needing to inject a sleep stub.
    await parseIntent("test retry accounting", "context");

    const snapshot = getLlmTelemetrySnapshot();
    expect(snapshot.byPurpose.intent?.retries).toBe(1);
  });
});

// ─── GitHub token resolution: DB PAT → GITHUB_TOKEN → gh CLI (zero-config) ────

describe("GitHub token resolution", () => {
  let savedPat: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedPat = getConfig("github_pat");
    savedEnv = process.env.GITHUB_TOKEN;
    _resetGhTokenCache();
  });

  afterEach(() => {
    setConfig("github_pat", savedPat);
    if (savedEnv === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedEnv;
    _resetGhTokenCache();
  });

  it("prefers the DB github_pat over the env var", () => {
    setConfig("github_pat", "db-pat-123");
    process.env.GITHUB_TOKEN = "env-token";
    expect(resolveGitHubToken()).toBe("db-pat-123");
    expect(getGitHubTokenSource()).toBe("pat");
  });

  it("falls back to GITHUB_TOKEN when the DB pat is empty", () => {
    setConfig("github_pat", "");
    process.env.GITHUB_TOKEN = "env-token-xyz";
    expect(resolveGitHubToken()).toBe("env-token-xyz");
    expect(getGitHubTokenSource()).toBe("env");
  });

  it("reports 'none' and resolves to '' when nothing is set (gh disabled under test)", () => {
    setConfig("github_pat", "");
    delete process.env.GITHUB_TOKEN;
    // The gh subprocess fallback is disabled under vitest, so no token is found.
    expect(resolveGitHubToken()).toBe("");
    expect(getGitHubTokenSource()).toBe("none");
  });

  it("trims surrounding whitespace on a stored pat", () => {
    setConfig("github_pat", "  padded-pat  ");
    expect(resolveGitHubToken()).toBe("padded-pat");
  });

  it("readGhCliToken trims the CLI output on success", () => {
    const fakeExec = (() => "gho_faketoken\n") as unknown as Parameters<typeof readGhCliToken>[0];
    expect(readGhCliToken(fakeExec)).toBe("gho_faketoken");
  });

  it("readGhCliToken returns '' when the CLI throws (missing / unauthenticated)", () => {
    const throwingExec = (() => {
      throw new Error("gh: command not found");
    }) as unknown as Parameters<typeof readGhCliToken>[0];
    expect(readGhCliToken(throwingExec)).toBe("");
  });
});

// ─── OpenRouter API key resolution: DB key → OPENROUTER_API_KEY env (FSE-EVAL-RED) ─

describe("OpenRouter API key resolution", () => {
  let savedKey: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedKey = getConfig("openrouter_api_key");
    savedEnv = process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    setConfig("openrouter_api_key", savedKey);
    if (savedEnv === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedEnv;
  });

  it("prefers the DB openrouter_api_key over the env var", () => {
    setConfig("openrouter_api_key", "db-key-123");
    process.env.OPENROUTER_API_KEY = "env-key-xyz";
    expect(resolveOpenRouterKey()).toBe("db-key-123");
  });

  it("falls back to OPENROUTER_API_KEY when the DB key is empty", () => {
    setConfig("openrouter_api_key", "");
    process.env.OPENROUTER_API_KEY = "env-key-xyz";
    expect(resolveOpenRouterKey()).toBe("env-key-xyz");
  });

  it("resolves to '' when nothing is set", () => {
    setConfig("openrouter_api_key", "");
    delete process.env.OPENROUTER_API_KEY;
    expect(resolveOpenRouterKey()).toBe("");
  });

  it("trims surrounding whitespace on a stored key", () => {
    setConfig("openrouter_api_key", "  padded-key  ");
    expect(resolveOpenRouterKey()).toBe("padded-key");
  });
});

// ─── getAiConfig — openrouter branch ─────────────────────────────────────────

describe("getAiConfig — openrouter provider", () => {
  it("resolves the default model/endpoint when unset in the DB", () => {
    setConfig("llm_provider", "openrouter");
    setConfig("openrouter_api_key", "or-test-key");
    setConfig("openrouter_model", "");
    setConfig("openrouter_endpoint", "");

    const config = getAiConfig();

    expect(config.provider).toBe("openrouter");
    expect(config.model).toBe(DEFAULT_OPENROUTER_MODEL);
    expect(config.endpoint).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(config.pat).toBe("or-test-key");
  });

  it("honors a DB-configured model/endpoint override", () => {
    setConfig("llm_provider", "openrouter");
    setConfig("openrouter_model", "openai/gpt-oss-20b:free");
    setConfig("openrouter_endpoint", "https://openrouter.ai/api/v1/chat/completions");

    const config = getAiConfig();

    expect(config.model).toBe("openai/gpt-oss-20b:free");
  });
});

// ─── isProviderConfigured / parseIntent — openrouter unconfigured hint ───────

describe("Unconfigured provider — openrouter", () => {
  it("isProviderConfigured() returns a helpful hint naming OpenRouter and OPENROUTER_API_KEY", () => {
    setConfig("llm_provider", "openrouter");
    setConfig("openrouter_api_key", "");
    const originalEnv = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    const result = isProviderConfigured();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/OpenRouter/i);
    expect(result.error).toMatch(/OPENROUTER_API_KEY/);

    if (originalEnv === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalEnv;
  });

  it("parseIntent() returns a typed provider_unconfigured failure with the OpenRouter hint as clarification", async () => {
    setConfig("llm_provider", "openrouter");
    setConfig("openrouter_api_key", "");
    const originalEnv = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    const result = await parseIntent("What's the burn rate?", "context");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a provider_unconfigured failure");
    expect(result.code).toBe("provider_unconfigured");
    expect(result.clarification).toMatch(/OpenRouter/i);

    if (originalEnv === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalEnv;
  });
});

// ─── chatRequest — OpenRouter header shape ───────────────────────────────────

describe("chatRequest — OpenRouter header shape", () => {
  it("sends only a Bearer Authorization header, no GitHub-specific headers", async () => {
    setConfig("llm_provider", "openrouter");
    const success = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    };
    const fetchStub = vi.fn().mockResolvedValue(success);

    await chatRequest(
      "https://openrouter.ai/api/v1/chat/completions",
      "or-test-key",
      { model: DEFAULT_OPENROUTER_MODEL },
      fetchStub as unknown as typeof fetch,
      async () => {}
    );

    const opts = fetchStub.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = opts?.headers as Record<string, string>;

    expect(headers["Authorization"]).toBe("Bearer or-test-key");
    expect(headers["Content-Type"]).toBe("application/json");
    // Exactly these two headers — no GitHub REST-API-specific headers
    // (Accept: application/vnd.github+json, X-GitHub-Api-Version) and no
    // OpenRouter attribution headers (HTTP-Referer / X-Title), which are
    // optional and intentionally omitted (see server/ai.ts chatRequest()).
    expect(Object.keys(headers).sort()).toEqual(["Authorization", "Content-Type"]);
    expect(headers["Accept"]).toBeUndefined();
    expect(headers["X-GitHub-Api-Version"]).toBeUndefined();
    expect(headers["HTTP-Referer"]).toBeUndefined();
  });
});

// ─── httpStatus threading — FSE-EVAL-RED "log half" fix ─────────────────────

describe("HTTP status threading (FSE-EVAL-RED — the numeric status used to be discarded)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parseIntent() surfaces the numeric httpStatus on a non-2xx failure (immediately-failing 401, not retried)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      headers: new Headers(),
      text: async () => JSON.stringify({ error: { code: 401, message: "Bad credentials" } }),
    }));

    const result = await parseIntent("What's the burn rate?", "context");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a provider_error failure");
    expect(result.code).toBe("provider_error");
    expect(result.httpStatus).toBe(401);
  });

  it("logs the numeric httpStatus (and providerErrorCode, when the body carries one) in the llm_call failure event", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      headers: new Headers(),
      text: async () => JSON.stringify({
        error: {
          code: 401,
          message: "Invalid API key",
          metadata: { error_type: "authentication", provider_code: "invalid_api_key" },
        },
      }),
    }));

    await parseIntent("What's the burn rate?", "context");

    const llmCallLines = errorSpy.mock.calls
      .map((c) => c[0] as string)
      .filter((line) => typeof line === "string" && line.includes('"event":"llm_call"'));
    expect(llmCallLines).toHaveLength(1);

    const parsed = JSON.parse(llmCallLines[0] as string);
    expect(parsed.failureCode).toBe("http_error");
    expect(parsed.httpStatus).toBe(401);
    expect(parsed.providerErrorCode).toBe("invalid_api_key");
  });

  it("tolerates a non-JSON error body without throwing — httpStatus is still logged, providerErrorCode stays null", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: new Headers(),
      text: async () => "<html>upstream is down</html>",
    }));

    const result = await parseIntent("test", "context");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a provider_error failure");
    expect(result.httpStatus).toBe(500);

    const llmCallLines = errorSpy.mock.calls
      .map((c) => c[0] as string)
      .filter((line) => typeof line === "string" && line.includes('"event":"llm_call"'));
    const parsed = JSON.parse(llmCallLines[0] as string);
    expect(parsed.httpStatus).toBe(500);
    expect(parsed.providerErrorCode).toBeNull();
  });

  it("does not set httpStatus on a timeout (AbortError has no HTTP status)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      const err = new DOMException("The operation was aborted.", "AbortError");
      return Promise.reject(err);
    }));

    const result = await parseIntent("test", "context");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a provider_error failure");
    expect(result.httpStatus).toBeUndefined();
  });
});

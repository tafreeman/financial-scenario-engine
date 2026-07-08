import crypto from "crypto";
import { execFileSync } from "child_process";
import { performance } from "perf_hooks";
import { getConfig, buildAnonymizedContextSnapshot } from "./db.js";
import type { ScenarioOperation, ScenarioResult } from "./engine/types.js";
import { executeScenario } from "./engine/executor.js";
import { loadPortfolioSnapshot } from "./loaders.js";
import { scenarioOperationSchema } from "./engine/validation.js";
import { logEvent } from "./logger.js";
import { recordLlmCall } from "./llm-telemetry.js";

// ─── OpenAI-compatible API response types ────────────────────────────────────

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

type ChatPayloadMessage = Pick<ChatMessage, "role" | "content" | "tool_calls" | "tool_call_id">;

interface ChatChoice {
  message: ChatMessage;
  finish_reason: "stop" | "tool_calls" | string;
}

interface ChatResponse {
  choices: ChatChoice[];
  usage?: { total_tokens: number };
}

// ─── AI Config ───────────────────────────────────────────────────────────────

/** Supported LLM providers */
export type LlmProvider = "github" | "ollama";

/** Default LLM request timeout (ms). Overridable via config key "llm_timeout_ms". */
export const DEFAULT_LLM_TIMEOUT_MS = 30_000;
/** Upper bound for a configured timeout; anything larger is clamped to it. */
export const LLM_TIMEOUT_MAX_MS = 120_000;

/** Bounded-retry policy for transient LLM transport failures. */
export const LLM_MAX_RETRY_ATTEMPTS = 3;
export const LLM_RETRY_BASE_DELAY_MS = 500;
/** HTTP statuses worth retrying: rate limit + transient gateway/upstream errors. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/**
 * Cap on a server-supplied `Retry-After` (ms). A hostile or buggy header
 * (`Retry-After: 3600`) must not stall the request for minutes/hours; beyond
 * this ceiling we sleep the cap rather than the full advertised delay.
 */
const RETRY_AFTER_MAX_MS = 60_000;

/** Real sleep; injectable in tests so retries don't actually wait. */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Delay before the next retry: honor a `Retry-After` header (integer seconds)
 * when the server sends one, else exponential backoff with jitter.
 */
function retryDelayMs(attempt: number, headers?: Headers): number {
  const retryAfter = headers?.get("retry-after");
  // Ignore an empty or whitespace-only Retry-After: Number("") and Number("  ")
  // are both 0 (finite and >= 0), which would otherwise force a 0ms instant
  // retry and skip the exponential backoff.
  if (retryAfter && retryAfter.trim() !== "") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      // Cap the server-supplied delay so a huge Retry-After can't stall the
      // request for minutes/hours.
      return Math.min(seconds * 1000, RETRY_AFTER_MAX_MS);
    }
  }
  const backoff = LLM_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  return backoff + Math.random() * LLM_RETRY_BASE_DELAY_MS;
}

/**
 * Parse and clamp temperature to [0, 2].
 * Returns the default (0.2) when the stored string is not a finite number.
 */
function parseTemperature(raw: string): number {
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) return 0.2;
  return Math.max(0, Math.min(2, v));
}

/**
 * Strict integer parse. Unlike `parseInt`, which stops at the first non-digit
 * and silently truncates ("1e6" -> 1, "30.5" -> 30, "10abc" -> 10, "30 000" ->
 * 30), this rejects any string that is not solely an optional sign plus digits,
 * returning NaN so the caller falls back to its default. Prevents a malformed
 * config value from yielding an absurdly small number.
 */
function strictInt(raw: string): number {
  return /^[+-]?\d+$/.test(raw.trim()) ? Number(raw) : NaN;
}

/**
 * Parse and clamp max_tokens to [100, 4000].
 * Returns the default (2000) when the stored string is not a plain integer.
 */
function parseMaxTokens(raw: string): number {
  const v = strictInt(raw);
  if (!Number.isFinite(v)) return 2000;
  return Math.max(100, Math.min(4000, v));
}

/**
 * Parse llm_timeout_ms into a usable positive timeout. Only a plain integer in
 * [1, LLM_TIMEOUT_MAX_MS] is honored; anything else (negative, zero, NaN,
 * scientific notation like "1e6", a garbage suffix like "10abc", a decimal, or
 * an absurdly large value) returns DEFAULT_LLM_TIMEOUT_MS. This stops a stored
 * "-1"/"0" — or a parseInt-truncated "1e6" -> 1 — from yielding
 * setTimeout(abort, <= a few ms), which aborts every request almost instantly.
 */
export function parseTimeoutMs(raw: string): number {
  const v = strictInt(raw);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_LLM_TIMEOUT_MS;
  return Math.min(v, LLM_TIMEOUT_MAX_MS);
}

// ─── GitHub token resolution (DB PAT → GITHUB_TOKEN → gh CLI) ─────────────────
//
// The app historically required a fine-grained PAT pasted into Settings (or an
// exported GITHUB_TOKEN). But most contributors already have the GitHub CLI
// authenticated locally, and its token works against the Models API — validated
// against both the catalog and inference endpoints. So when no PAT/env token is
// present we fall back to `gh auth token`, making the GitHub provider work with
// zero extra configuration.
//
// The gh subprocess is a LAST resort: it runs only when both higher-precedence
// sources are empty, its result is cached for the process lifetime, and it is
// disabled entirely under test (see ghFallbackEnabled) so the unit suite stays
// hermetic and never shells out.

/** Wall-clock cap for the `gh auth token` fallback subprocess (ms). */
const GH_CLI_TIMEOUT_MS = 3_000;

/** Which source supplied the effective GitHub token (for UI display only). */
export type GitHubTokenSource = "pat" | "env" | "gh" | "none";

/**
 * Read a token from the local GitHub CLI (`gh auth token`), or "" when the CLI
 * is missing, unauthenticated, or slow. `exec` is injectable so tests exercise
 * both the success and failure paths without spawning a real process.
 */
export function readGhCliToken(exec: typeof execFileSync = execFileSync): string {
  try {
    const out = exec("gh", ["auth", "token"], {
      timeout: GH_CLI_TIMEOUT_MS,
      encoding: "utf8",
      windowsHide: true,
    });
    return typeof out === "string" ? out.trim() : "";
  } catch {
    // gh not installed / not logged in / timed out — no token available.
    return "";
  }
}

/** gh fallback is disabled under test so the unit suite never shells out. */
function ghFallbackEnabled(): boolean {
  if (process.env.FSE_DISABLE_GH_TOKEN === "1") return false;
  if (process.env.VITEST) return false;
  if (process.env.NODE_ENV === "test") return false;
  return true;
}

let ghTokenCache: string | null = null;

/** Cached gh-CLI token ("" when unavailable/disabled). Spawns gh at most once. */
function cachedGhToken(): string {
  if (!ghFallbackEnabled()) return "";
  if (ghTokenCache === null) ghTokenCache = readGhCliToken();
  return ghTokenCache;
}

/** Test seam: forget the cached gh token so the next resolve re-reads it. */
export function _resetGhTokenCache(): void {
  ghTokenCache = null;
}

/**
 * Resolve the effective GitHub token in precedence order:
 *   1. DB `github_pat` (set via the Settings UI)
 *   2. `GITHUB_TOKEN` environment variable
 *   3. Local `gh auth token` (zero-config fallback; disabled under test)
 * Returns "" when none is available.
 */
export function resolveGitHubToken(): string {
  const dbPat = (getConfig("github_pat") || "").trim();
  if (dbPat) return dbPat;
  const envToken = (process.env.GITHUB_TOKEN || "").trim();
  if (envToken) return envToken;
  return cachedGhToken();
}

/** Report where the effective token comes from — never the token itself. */
export function getGitHubTokenSource(): GitHubTokenSource {
  if ((getConfig("github_pat") || "").trim()) return "pat";
  if ((process.env.GITHUB_TOKEN || "").trim()) return "env";
  if (cachedGhToken()) return "gh";
  return "none";
}

/** Centralized AI config with defaults applied */
export function getAiConfig() {
  const provider = (getConfig("llm_provider") || "github") as LlmProvider;

  if (provider === "ollama") {
    return {
      provider: "ollama" as const,
      pat: "", // not needed for Ollama
      model: getConfig("ollama_model") || "llama3.2",
      endpoint: getConfig("ollama_endpoint") || "http://localhost:11434/v1/chat/completions",
      temperature: parseTemperature(getConfig("temperature") || "0.2"),
      maxTokens: parseMaxTokens(getConfig("max_tokens") || "2000"),
      timeoutMs: parseTimeoutMs(getConfig("llm_timeout_ms") || ""),
    };
  }

  return {
    provider: "github" as const,
    pat: resolveGitHubToken(),
    model: getConfig("model") || "openai/gpt-4.1",
    endpoint: getConfig("endpoint") || "https://models.github.ai/inference/chat/completions",
    temperature: parseTemperature(getConfig("temperature") || "0.2"),
    maxTokens: parseMaxTokens(getConfig("max_tokens") || "2000"),
    timeoutMs: parseTimeoutMs(getConfig("llm_timeout_ms") || ""),
  };
}

/** Check if any LLM provider is configured and available */
function isProviderConfigured(): { ok: boolean; error?: string } {
  const config = getAiConfig();
  if (config.provider === "ollama") {
    // Ollama doesn't need a PAT — it just needs to be running locally
    return { ok: true };
  }
  if (!config.pat) {
    return {
      ok: false,
      error:
        "No GitHub token available. Add a PAT in Settings, set GITHUB_TOKEN, or run `gh auth login` — or switch to Ollama for fully local operation.",
    };
  }
  return { ok: true };
}

export interface AiResponse {
  content: string;
  model: string;
  tokensUsed?: number;
  error?: string;
}

// ─── Observability at the LLM boundary (WP3-B) ───────────────────────────────
//
// One structured log line (server/logger.ts) + one in-memory counter update
// (server/llm-telemetry.ts) per LLM call, emitted from a single wrapper below
// (instrumentedChatRequest) so parseIntent/narrateResult/agenticScenario all
// get identical accounting without duplicating timing/logging code at each
// call site.
//
// NEVER logged: prompt/query/context content, narrative text, or scenario
// data — only sizes/counts and typed codes. This matches the app's existing
// PII posture (buildAnonymizedContextSnapshot() redacts names before egress;
// this boundary must not become a second leak path for what that redacts).

/** Which production code path triggered the LLM call. */
export type LlmCallPurpose = "intent" | "narration" | "agentic-step";

/** Coarse outcome recorded for every LLM call, success or not. */
export type LlmCallOutcome = "success" | "failure";

/**
 * Failure codes loggable at the transport/boundary level, distinct from
 * IntentParseFailureCode (below) which additionally covers post-transport
 * parse/validation failures specific to parseIntent's contract.
 */
export type LlmBoundaryFailureCode =
  | "timeout"
  | "transport_error"
  | "http_error"
  | IntentParseFailureCode;

/**
 * Wrap chatRequest with structured logging + aggregation. This is the ONLY
 * place chatRequest is called from parseIntent/narrateResult/agenticScenario
 * — every LLM call in this module goes through here so the log line and the
 * in-memory counters can never drift out of sync with each other.
 *
 * Logs and records exactly once per call, whether it succeeds or throws.
 * Re-throws on failure so callers keep their existing error handling.
 */
async function instrumentedChatRequest(
  purpose: LlmCallPurpose,
  endpoint: string,
  pat: string,
  payload: Record<string, unknown>
): Promise<ChatResponse> {
  const requestId = crypto.randomUUID();
  const config = getAiConfig();
  const attemptTracker = { attempts: 0 };
  const startedAt = performance.now();

  try {
    const data = await chatRequest(endpoint, pat, payload, globalThis.fetch, defaultSleep, attemptTracker);
    const latencyMs = Math.round(performance.now() - startedAt);
    const retryCount = Math.max(0, attemptTracker.attempts - 1);
    const tokensOut = data.usage?.total_tokens;

    logEvent("info", "llm_call", {
      requestId,
      provider: config.provider,
      model: config.model,
      purpose,
      latencyMs,
      retryCount,
      tokensOut: tokensOut ?? null,
      outcome: "success",
    });
    recordLlmCall({ purpose, outcome: "success", tokensOut, retryCount });

    return data;
  } catch (err: unknown) {
    const latencyMs = Math.round(performance.now() - startedAt);
    const retryCount = Math.max(0, attemptTracker.attempts - 1);
    const failureCode = classifyBoundaryFailure(err);

    logEvent("error", "llm_call", {
      requestId,
      provider: config.provider,
      model: config.model,
      purpose,
      latencyMs,
      retryCount,
      outcome: "failure",
      failureCode,
    });
    recordLlmCall({ purpose, outcome: "failure", failureCode, retryCount });

    throw err;
  }
}

/** Map a thrown error from chatRequest into a stable, loggable failure code. */
function classifyBoundaryFailure(err: unknown): LlmBoundaryFailureCode {
  if (err instanceof Error) {
    if (/timed out/i.test(err.message)) return "timeout";
    if (/^HTTP \d+:/.test(err.message)) return "http_error";
  }
  return "transport_error";
}

export type IntentParseFailureCode =
  | "provider_unconfigured"
  | "invalid_json"
  | "invalid_operation"
  | "provider_error";

export interface IntentParseSuccess {
  ok: true;
  operation: ScenarioOperation;
}

export interface IntentParseFailure {
  ok: false;
  code: IntentParseFailureCode;
  message: string;
  clarification: string;
  details?: string;
}

export type IntentParseResult = IntentParseSuccess | IntentParseFailure;

const PARSE_CLARIFICATION =
  "Please rephrase the scenario using a supported operation such as adding, removing, swapping, changing rates or hours, extending timelines, adding unexpected costs, reallocating staff, checking burn rate, analyzing margins, or running EVM.";

function intentParseFailure(
  code: IntentParseFailureCode,
  message: string,
  details?: string,
  clarification = PARSE_CLARIFICATION
): IntentParseFailure {
  return { ok: false, code, message, clarification, ...(details ? { details } : {}) };
}

// ─── V2: Structured Intent Parsing ───────────────────────────────────────────

/**
 * System prompt for the V2 intent-parsing step. Exported so the intent eval
 * runner (server/evals/run-intent-eval.ts) exercises the exact production
 * prompt — edits here automatically flow into the eval.
 */
export const PARSE_INTENT_PROMPT = `You are a financial scenario parser. Your job is to convert natural language into a structured JSON operation that the financial engine can execute. You do NOT compute anything — you only extract the user's intent.

## AVAILABLE ENGINE OPERATIONS

Each operation triggers a specific calculation tool. Pick the one that matches the user's intent and supply the required parameters.

### 1. "swap" — Replace staff on a project
Removes N people of one role and adds M people of another role.
REQUIRED: project, remove[], add[]
Example: "Replace the Senior Dev on Alpha with two Mid Devs"
→ {"action":"swap","project":"Project Alpha","remove":[{"role":"Senior Developer","count":1}],"add":[{"role":"Mid-level Developer","count":2,"hours_per_week":40}]}

### 2. "add" — Add staff to a project
REQUIRED: project, add[]
Each entry needs: role (must match rate card), count, hours_per_week (default 40)
Example: "Add a part-time PM to Beta at 20 hours/week"
→ {"action":"add","project":"Project Beta","add":[{"role":"Project Manager","count":1,"hours_per_week":20}]}

### 3. "remove" — Remove staff from a project
REQUIRED: project, remove[]
Each entry needs: role, count. Optional: person_name for specific person.
Example: "Remove the QA Engineer from Beta"
→ {"action":"remove","project":"Project Beta","remove":[{"role":"QA Engineer","count":1}]}

### 4. "rate_change" — Change billing/cost rates for a role
REQUIRED: project, rate_changes[]
Each entry needs: role, and at least one of new_bill_rate or new_cost_rate ($/hr).
Example: "Increase the Senior Dev bill rate to $275/hr on Alpha"
→ {"action":"rate_change","project":"Project Alpha","rate_changes":[{"role":"Senior Developer","new_bill_rate":275}]}

### 5. "hours_change" — Change hours per week for specific person
REQUIRED: project, hours_changes[]
Each entry needs: person_name, new_hours_per_week.
Example: "Cut K. Chen to 20 hours per week"
→ {"action":"hours_change","project":"Project Alpha","hours_changes":[{"person_name":"K. Chen","new_hours_per_week":20}]}

### 6. "timeline_extension" — Extend project end date
REQUIRED: project, and one of extension_months OR new_end_date (YYYY-MM-DD)
Example: "Extend Alpha by 3 months"
→ {"action":"timeline_extension","project":"Project Alpha","extension_months":3}

### 7. "unexpected_cost" — Add unplanned costs to a project
REQUIRED: project, additional_costs[]
Each cost needs: description, amount ($), is_recurring (bool), frequency_months (if recurring: 1=monthly, 3=quarterly, 12=annual)
Example: "Add a $50,000 one-time licensing fee to Gamma"
→ {"action":"unexpected_cost","project":"Project Gamma","additional_costs":[{"description":"Licensing fee","amount":50000,"is_recurring":false}]}

### 8. "reallocation" — Move staff between projects
REQUIRED: projects[] (exactly 2: [source, destination]), remove[], add[]
Example: "Move the QA Engineer from Beta to Gamma"
→ {"action":"reallocation","projects":["Project Beta","Project Gamma"],"remove":[{"role":"QA Engineer","count":1}],"add":[{"role":"QA Engineer","count":1,"hours_per_week":40}]}

### 9. "burn_rate_check" — Analyze current burn rates and budget runway
OPTIONAL: project (specific project, or omit/"all" for portfolio-wide)
Computes: monthly cost, revenue, margin, months remaining, exhaustion date per project.
Example: "What's the burn rate across all projects?"
→ {"action":"burn_rate_check"}

### 10. "margin_analysis" — Analyze margins and profitability
OPTIONAL: project (specific or "all")
Computes: margin %, margin $, labor multiplier, blended rates per project.
Example: "Analyze margins on Project Alpha"
→ {"action":"margin_analysis","project":"Project Alpha"}

### 11. "evm_analysis" — Earned Value Management analysis
REQUIRED: project
Computes: CPI, SPI, EAC, ETC, VAC, TCPI for the specified project.
Example: "Run EVM analysis on Beta"
→ {"action":"evm_analysis","project":"Project Beta"}

### 12. "what_if_composite" — Multiple changes at once
REQUIRED: sub_operations[] (array of any of the above operations)
Use when the user asks about multiple changes in one question.
Example: "What if we add a PM to Alpha AND remove the Junior Dev from Gamma?"
→ {"action":"what_if_composite","sub_operations":[{"action":"add","project":"Project Alpha","add":[{"role":"Project Manager","count":1,"hours_per_week":40}]},{"action":"remove","project":"Project Gamma","remove":[{"role":"Junior Developer","count":1}]}]}

## OUTPUT FORMAT

Return ONLY a valid JSON object. No markdown, no explanation, no code fences.
Only include fields relevant to the matched operation. Omit unused fields entirely.

## RULES
- Role names MUST match the rate card in the context data (e.g., "Senior Developer" not "Sr Dev")
- Project names MUST match projects in the context data (e.g., "Project Alpha" not "Alpha")
- hours_per_week defaults to 40 if the user doesn't specify
- Do NOT perform any math or calculations
- If the user's query doesn't clearly map to a specific operation, default to "burn_rate_check"
- For questions about "current state" or "how are we doing", use "burn_rate_check" or "margin_analysis"`;

/** Parse user query into a structured ScenarioOperation via LLM */
export async function parseIntent(
  userQuery: string,
  contextSnapshot: string
): Promise<IntentParseResult> {
  const config = getAiConfig();
  const providerCheck = isProviderConfigured();

  if (!providerCheck.ok) {
    return intentParseFailure(
      "provider_unconfigured",
      "Intent parsing is not configured.",
      providerCheck.error,
      providerCheck.error ?? "Configure an LLM provider before running AI scenarios."
    );
  }

  const payload = {
    model: config.model,
    max_tokens: 500,
    temperature: 0,
    messages: [
      { role: "system", content: `${PARSE_INTENT_PROMPT}\n\nCURRENT DATA:\n${contextSnapshot}` },
      { role: "user", content: userQuery },
    ],
  };

  try {
    const data = await instrumentedChatRequest("intent", config.endpoint, config.pat, payload);
    const content = data.choices?.[0]?.message?.content ?? "";

    // Strip markdown fences if the model wraps its response
    const cleaned = content.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err: unknown) {
      return intentParseFailure(
        "invalid_json",
        "The model did not return valid scenario JSON.",
        err instanceof Error ? err.message : String(err)
      );
    }

    // Validate against schema — catches malformed LLM output at the boundary
    const validation = scenarioOperationSchema.safeParse(parsed);
    if (!validation.success) {
      return intentParseFailure(
        "invalid_operation",
        "The model returned JSON, but it was not a supported scenario operation.",
        validation.error.message
      );
    }
    return { ok: true, operation: validation.data };
  } catch (err: unknown) {
    const hint = config.provider === "ollama"
      ? " Is Ollama running? Try: ollama serve"
      : "";
    return intentParseFailure(
      "provider_error",
      "The model request failed before a scenario operation could be parsed.",
      `${err instanceof Error ? err.message : String(err)}${hint}`,
      config.provider === "ollama"
        ? "Check that Ollama is running, then try the scenario again."
        : PARSE_CLARIFICATION
    );
  }
}

// ─── V2: Narrative Generation ────────────────────────────────────────────────

const NARRATE_PROMPT = `You are a financial analyst narrator. You receive:
1. A scenario operation (what was asked)
2. Pre-computed financial results (all math is already done by the engine)

Your job is to write a clear, professional markdown narrative explaining the results.
Do NOT perform any calculations. ALL numbers are already computed and provided.
Use the EXACT numbers from the results — do not round, adjust, or recalculate them.

FORMAT:
## Impact Summary
2-3 sentences on the key finding.

## Financial Delta
| Metric | Before | After | Change |
(use numbers from the result object)

## Key Observations
Bullet points about notable findings.

## Risks
Any concerns or flags based on the numbers.

## Recommendation
One clear, actionable next step.

RULES:
- Format currency with $ and commas (e.g., $14,289)
- Format percentages to one decimal (e.g., 32.5%)
- Reference specific project and role names
- Be concise — this feeds into a UI panel
- If the result has warnings, incorporate them into Risks`;

/** Generate a human-readable narrative from pre-computed scenario results */
export async function narrateResult(
  operation: ScenarioOperation,
  result: ScenarioResult
): Promise<AiResponse> {
  const config = getAiConfig();
  const providerCheck = isProviderConfigured();

  if (!providerCheck.ok) {
    return { content: "", model: config.model, error: providerCheck.error };
  }

  const payload = {
    model: config.model,
    max_tokens: 1500,
    // temperature 0: narration is derived from already-fixed engine outputs, so
    // deterministic prose (same inputs → same narrative) is preferred over
    // sampling variety. Mirrors parseIntent, which also uses 0.
    temperature: 0,
    messages: [
      { role: "system", content: NARRATE_PROMPT },
      {
        role: "user",
        content: `Operation: ${JSON.stringify(operation)}\n\nPre-computed results:\n${JSON.stringify(result, null, 2)}`,
      },
    ],
  };

  try {
    const data = await instrumentedChatRequest("narration", config.endpoint, config.pat, payload);
    const content = data.choices?.[0]?.message?.content ?? "(empty response)";
    const tokensUsed = data.usage?.total_tokens;

    return { content, model: config.model, tokensUsed };
  } catch (err: unknown) {
    return { content: "", model: config.model, error: `Narration failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── V3: Agentic Scenario Analysis (tool-calling loop) ──────────────────────

/** Tool definition for the run_scenario function */
const SCENARIO_TOOL = {
  type: "function" as const,
  function: {
    name: "run_scenario",
    description: "Execute a financial scenario through the deterministic calculation engine. Returns exact computed numbers for staffing changes, burn rates, margins, budget runway, etc. Call this tool to get real numbers — do NOT estimate or calculate numbers yourself.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "swap", "add", "remove", "rate_change", "hours_change",
            "timeline_extension", "unexpected_cost", "reallocation",
            "burn_rate_check", "margin_analysis", "evm_analysis",
            "what_if_composite",
          ],
          description: "The type of scenario to analyze",
        },
        project: {
          type: "string",
          description: "Target project name (e.g., 'Project Alpha'). Omit or use 'all' for portfolio-wide analysis.",
        },
        projects: {
          type: "array",
          items: { type: "string" },
          description: "For reallocation: [source_project, destination_project]",
        },
        remove: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: { type: "string", description: "Role name matching rate card" },
              count: { type: "number", description: "Number of people to remove" },
              person_name: { type: "string", description: "Optional: specific person name" },
            },
            required: ["role", "count"],
          },
          description: "Staff to remove",
        },
        add: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: { type: "string", description: "Role name matching rate card" },
              count: { type: "number", description: "Number of people to add" },
              hours_per_week: { type: "number", description: "Hours per week (default 40)" },
            },
            required: ["role", "count"],
          },
          description: "Staff to add",
        },
        rate_changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              role: { type: "string" },
              new_bill_rate: { type: "number" },
              new_cost_rate: { type: "number" },
            },
            required: ["role"],
          },
          description: "Rate changes to apply",
        },
        hours_changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              person_name: { type: "string" },
              new_hours_per_week: { type: "number" },
            },
            required: ["person_name", "new_hours_per_week"],
          },
          description: "Hours changes for specific people",
        },
        extension_months: { type: "number", description: "Number of months to extend timeline" },
        new_end_date: { type: "string", description: "New end date (YYYY-MM-DD)" },
        additional_costs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              amount: { type: "number" },
              is_recurring: { type: "boolean" },
              frequency_months: { type: "number" },
            },
            required: ["description", "amount", "is_recurring"],
          },
        },
        sub_operations: {
          type: "array",
          items: { type: "object" },
          description: "For what_if_composite: array of sub-operations",
        },
      },
      required: ["action"],
    },
  },
};

const AGENTIC_SYSTEM_PROMPT = `You are a financial impact analyst with access to a deterministic calculation engine via the run_scenario tool.

YOUR WORKFLOW:
1. Read the user's question and the current project data
2. Call run_scenario one or more times to get REAL computed numbers
3. Analyze the results and determine if they meet the user's goals
4. If the user has a goal (e.g., "stay within budget", "improve margin by 5%"), try multiple scenarios to find options that achieve it
5. Write your final analysis using ONLY numbers returned by the tool — never estimate or calculate numbers yourself

WHEN TO CALL THE TOOL MULTIPLE TIMES:
- Goal-seeking: "How can I extend by 3 months and stay within budget?" → First check current state, then try removing roles, reducing hours, etc. until you find options that work.
- Comparisons: "Which is better, adding a PM or a QA?" → Run both scenarios and compare the engine's numbers.
- Optimization: "What staffing changes would improve margin by 5 points?" → Try several combinations and report which ones achieve the goal.

IMPORTANT RULES:
- ALWAYS use the tool to get numbers. Never compute costs, margins, or burn rates yourself.
- Every dollar amount and percentage in your response must come from a tool result.
- If you need to explore options, call the tool multiple times with different parameters.
- After getting results, evaluate whether they meet the user's stated goal.
- Present your findings with the exact numbers from the tool results.

RESPONSE FORMAT (after all tool calls are complete):
## Analysis
What the user asked and what you explored.

## Scenarios Evaluated
For each scenario you tested, show the key numbers from the engine.

## Recommendation
Which option(s) best meet the user's goals and why.

## Risks
Any concerns from the engine's warnings or the analysis.`;

export interface AgenticResponse {
  content: string;
  model: string;
  tokensUsed: number;
  scenarios_explored: ScenarioResult[];
  error?: string;
}

function toChatPayloadMessages(messages: ChatMessage[]): ChatPayloadMessage[] {
  return messages.map(({ role, content, tool_calls, tool_call_id }) => ({
    role,
    content,
    ...(tool_calls ? { tool_calls } : {}),
    ...(tool_call_id ? { tool_call_id } : {}),
  }));
}

/** Process tool calls from an LLM response, execute them, and append results to messages */
export function processToolCalls(
  toolCalls: ToolCall[],
  messages: ChatMessage[],
  scenariosExplored: ScenarioResult[]
): void {
  for (const toolCall of toolCalls) {
    // #24: Unknown tool names must push an error tool message so the tool_call_id
    // is paired — unpaired tool_call_ids cause protocol violations on the next
    // iteration of the agentic loop.
    if (toolCall.function.name !== "run_scenario") {
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify({
          error: `Unknown tool "${toolCall.function.name}". Only "run_scenario" is supported.`,
        }),
      });
      continue;
    }
    try {
      // Validate LLM-supplied tool arguments at the boundary before any math runs —
      // mirrors the V2 parse path (scenarioOperationSchema.safeParse) so unvalidated
      // operations never reach executeScenario.
      const validation = scenarioOperationSchema.safeParse(JSON.parse(toolCall.function.arguments));
      if (!validation.success) {
        messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ error: `Invalid run_scenario arguments: ${validation.error.message}` }) });
        continue;
      }
      const result = executeScenario(validation.data, loadPortfolioSnapshot());
      scenariosExplored.push(result);
      messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(result) });
    } catch (err: unknown) {
      messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) });
    }
  }
}

/**
 * Make a chat completion request to the configured LLM provider (GitHub Models or Ollama).
 *
 * Uses an AbortController so a hung endpoint is cancelled after `timeoutMs`
 * (default: DEFAULT_LLM_TIMEOUT_MS = 30 s, configurable via DB key "llm_timeout_ms").
 * A timeout results in an Error whose message contains "LLM request timed out".
 *
 * @param fetchImpl - Injectable fetch implementation (defaults to globalThis.fetch).
 *   Pass a stub in tests to avoid actual network calls or real sleeping.
 * @param attemptTracker - Optional out-param the caller can inspect after the
 *   call resolves/rejects to learn how many attempts were made (retryCount =
 *   attempts - 1). Purely additive: no test or production call site is
 *   required to pass it, so this does not change chatRequest's return shape.
 *   Used by the observability wrappers below (parseIntent/narrateResult/
 *   agenticScenario) to log a retry count without chatRequest itself taking
 *   on logging concerns.
 */
export async function chatRequest(
  endpoint: string,
  pat: string,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch = globalThis.fetch,
  sleepImpl: (ms: number) => Promise<void> = defaultSleep,
  attemptTracker?: { attempts: number }
): Promise<ChatResponse> {
  const config = getAiConfig();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (config.provider === "github") {
    // GitHub Models is an OpenAI-compatible inference endpoint: it only needs a
    // Bearer token (a GitHub token with models:read) plus the JSON content type
    // set above. The REST-API headers this used to send
    // (Accept: application/vnd.github+json, X-GitHub-Api-Version) target
    // api.github.com, not the inference host — tolerated but semantically wrong,
    // so they're dropped to match the validated connection method.
    headers["Authorization"] = `Bearer ${pat}`;
  }
  // Ollama's OpenAI-compatible endpoint needs no auth headers

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= LLM_MAX_RETRY_ATTEMPTS; attempt++) {
    if (attemptTracker) attemptTracker.attempts = attempt;
    // Each attempt gets its own fresh timeout budget.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);

    let resp: Response;
    try {
      resp = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
        // Block SSRF redirect-bypass: an allowlisted endpoint must not be able to
        // 3xx-redirect the request onto an internal host. Node fetch follows up to
        // 20 redirects by default; the supported providers never redirect inference.
        redirect: "error",
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        // A timeout already consumed the full per-attempt budget; do not retry.
        throw new Error(
          `LLM request timed out after ${config.timeoutMs}ms (endpoint: ${endpoint})`,
          { cause: err }
        );
      }
      // A blocked redirect (redirect: "error" makes undici throw "unexpected
      // redirect") is a permanent config/SSRF issue, not a transient failure —
      // fail fast instead of re-POSTing the payload + PAT to the redirecting
      // endpoint LLM_MAX_RETRY_ATTEMPTS times.
      if (err instanceof Error && /redirect/i.test(err.message)) {
        throw err;
      }
      // Transient transport error (e.g. dropped connection): retry if budget remains.
      if (attempt < LLM_MAX_RETRY_ATTEMPTS) {
        lastError = err instanceof Error ? err : new Error(String(err));
        await sleepImpl(retryDelayMs(attempt));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      const errBody = await resp.text();
      const error = new Error(
        `HTTP ${resp.status}: ${resp.statusText}\n${errBody.slice(0, 500)}`
      );
      // Retry only transient statuses; a 4xx like 400/401/404 fails fast.
      if (RETRYABLE_STATUS.has(resp.status) && attempt < LLM_MAX_RETRY_ATTEMPTS) {
        lastError = error;
        await sleepImpl(retryDelayMs(attempt, resp.headers));
        continue;
      }
      throw error;
    }

    return resp.json() as Promise<ChatResponse>;
  }

  // Unreachable in practice — the final attempt always returns or throws above.
  throw lastError ?? new Error("LLM request failed after all retries");
}

/** Run an agentic analysis where the LLM calls the engine multiple times */
export async function agenticScenario(userQuery: string): Promise<AgenticResponse> {
  const config = getAiConfig();
  const providerCheck = isProviderConfigured();

  if (!providerCheck.ok) {
    return {
      content: "", model: config.model, tokensUsed: 0, scenarios_explored: [],
      error: providerCheck.error,
    };
  }

  const context = buildAnonymizedContextSnapshot();
  const scenariosExplored: ScenarioResult[] = [];
  let totalTokens = 0;
  const messages: ChatMessage[] = [
    { role: "system", content: `${AGENTIC_SYSTEM_PROMPT}\n\nCURRENT PROJECT DATA:\n${context}` },
    { role: "user", content: userQuery },
  ];

  const MAX_ITERATIONS = 8;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    try {
      const data = await instrumentedChatRequest("agentic-step", config.endpoint, config.pat, {
        model: config.model, max_tokens: 2000, temperature: 0.2, messages, tools: [SCENARIO_TOOL], tool_choice: "auto",
      });
      totalTokens += data.usage?.total_tokens ?? 0;

      const choice = data.choices?.[0];
      if (!choice) break;

      messages.push(choice.message);

      // Model is done — return final text
      if (choice.finish_reason === "stop" || !choice.message.tool_calls?.length) {
        return {
          content: choice.message.content ?? "(empty response)",
          model: config.model, tokensUsed: totalTokens, scenarios_explored: scenariosExplored,
        };
      }

      // Execute tool calls and feed results back
      processToolCalls(choice.message.tool_calls, messages, scenariosExplored);
    } catch (err: unknown) {
      const hint = config.provider === "ollama"
        ? " Is Ollama running? Try: ollama serve"
        : "";
      return {
        content: "", model: config.model, tokensUsed: totalTokens, scenarios_explored: scenariosExplored,
        error: `Agentic loop failed at iteration ${iteration}: ${err instanceof Error ? err.message : String(err)}${hint}`,
      };
    }
  }

  // Exceeded max iterations — request final summary
  return requestFinalSummary(config.endpoint, config.pat, config.model, messages, totalTokens, scenariosExplored);
}

async function requestFinalSummary(
  endpoint: string, pat: string, model: string,
  messages: ChatMessage[], totalTokens: number, scenariosExplored: ScenarioResult[]
): Promise<AgenticResponse> {
  messages.push({ role: "user", content: "Please provide your final analysis based on the scenarios you've explored so far." });
  try {
    const data = await instrumentedChatRequest("agentic-step", endpoint, pat, {
      model,
      max_tokens: 2000,
      temperature: 0.2,
      messages: toChatPayloadMessages(messages),
    });
    totalTokens += data.usage?.total_tokens ?? 0;
    return {
      content: data.choices?.[0]?.message?.content ?? "(no final response)",
      model, tokensUsed: totalTokens, scenarios_explored: scenariosExplored,
    };
  } catch (_err: unknown) {
    return {
      content: "Analysis reached iteration limit. See explored scenarios for computed data.",
      model, tokensUsed: totalTokens, scenarios_explored: scenariosExplored,
    };
  }
}

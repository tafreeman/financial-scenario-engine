/**
 * LLM-as-judge narration-faithfulness grader (WP3-E).
 *
 * Grades whether a generated narrative (server/engine/narrative.ts template
 * output, or an LLM narration from narrateResult() in server/ai.ts) is
 * faithful to the deterministic ScenarioResult it describes:
 *   - every number the narrative states must match an engine-computed value
 *     (no invented figures, no silently-rounded-differently figures)
 *   - the narrative must not claim a direction (up/down, better/worse) that
 *     contradicts the engine's sign
 *
 * ─── EVAL-SIDE ONLY — NOT IN THE RUNTIME REQUEST PATH ───────────────────────
 * This module is never imported by server/routes.ts, server/ai.ts, or any
 * other production request-handling code. It is invoked only by
 * server/evals/run-faithfulness-eval.ts (a standalone script) and by this
 * module's own tests. Judging a narrative costs an extra LLM call and is not
 * something a live user request should pay for.
 *
 * ─── CALIBRATION-FIRST POLICY (BINDING — eval-framework design spec §9.3) ───
 * This grader is ADVISORY ONLY. It has NOT been calibrated against a
 * human-labeled dataset, so its verdicts carry no known precision/recall and
 * MUST NOT gate CI, block a PR, or be treated as ground truth anywhere.
 * Nothing in this repo wires its output into a pass/fail decision — see
 * run-faithfulness-eval.ts, which always exits 0 on a successful run
 * regardless of the verdicts it collects, and README.md's "Narration
 * faithfulness (advisory judge)" section, which states this explicitly.
 * Do not add a threshold/gate here or in CI until a calibration set with
 * human labels exists and a deliberate calibration PR (mirroring the
 * procedure documented in server/evals/eval-config.ts for the intent eval)
 * establishes one.
 *
 * ─── ISOLATION FOR TESTING ───────────────────────────────────────────────────
 * The actual model call is isolated in callJudgeModel() below, which takes an
 * injectable chatRequest-shaped function — exactly the pattern
 * server/ai.ts's chatRequest() already uses for fetch/sleep injection — so
 * tests can mock the model boundary without a live network call.
 */

import { z } from "zod";
import { getAiConfig } from "../ai.js";
import type { ScenarioResult } from "../engine/types.js";

// ─── Verdict schema ───────────────────────────────────────────────────────────

/** One specific faithfulness problem the judge found in the narrative. */
const violationSchema = z
  .object({
    /** Short machine-readable category for this violation. */
    type: z.enum(["invented_number", "mismatched_number", "wrong_direction", "unsupported_claim"]),
    /** Quote or close paraphrase of the offending narrative text. */
    quote: z.string().min(1),
    /** Why it's a violation — e.g. "narrative says $12,000 but result.impact.cost_delta_monthly is $9,400". */
    explanation: z.string().min(1),
  })
  .strict();

/** Strict JSON verdict schema the judge model's response is validated against. */
export const faithfulnessVerdictSchema = z
  .object({
    faithful: z.boolean(),
    violations: z.array(violationSchema),
  })
  .strict();

export type FaithfulnessViolation = z.infer<typeof violationSchema>;
export type FaithfulnessVerdict = z.infer<typeof faithfulnessVerdictSchema>;

/** Typed failure reasons distinct from a substantive "not faithful" verdict. */
export type JudgeFailureCode =
  | "provider_unconfigured"
  | "invalid_json"
  | "invalid_verdict_schema"
  | "provider_error";

export interface JudgeSuccess {
  ok: true;
  verdict: FaithfulnessVerdict;
}

export interface JudgeFailure {
  ok: false;
  code: JudgeFailureCode;
  message: string;
  details?: string;
}

export type JudgeResult = JudgeSuccess | JudgeFailure;

// ─── Prompt ───────────────────────────────────────────────────────────────────

const JUDGE_SYSTEM_PROMPT = `You are a strict fact-checker grading whether a narrative is FAITHFUL to a deterministic financial calculation result (ScenarioResult) it describes.

You will receive:
1. The ScenarioResult JSON (the ONLY source of truth for numbers)
2. The narrative text that was generated to describe it

Check the narrative against the ScenarioResult JSON for:
- "invented_number": the narrative states a number that does not appear anywhere in the ScenarioResult JSON (not even after reasonable currency/percent formatting)
- "mismatched_number": the narrative restates a number from the result but gets the value wrong
- "wrong_direction": the narrative claims something increased when the result shows a decrease, or vice versa (e.g. calling a negative margin_delta_pct an "improvement")
- "unsupported_claim": the narrative asserts something about the scenario (e.g. "this is the best option") that the result data does not support

Do NOT flag:
- Reasonable rounding or formatting (e.g. "$14,289" for 14288.73, "32.5%" for 32.47)
- Prose, tone, or structure — only factual faithfulness to the numbers
- Numbers the narrative correctly omits

Return ONLY a JSON object matching this exact shape, no markdown, no code fences:
{"faithful": boolean, "violations": [{"type": "invented_number"|"mismatched_number"|"wrong_direction"|"unsupported_claim", "quote": string, "explanation": string}]}

"faithful" is true only when "violations" is an empty array.`;

// ─── Model call (isolated for testing) ───────────────────────────────────────

/** Minimal shape callJudgeModel needs from a chat-completion response. */
export interface JudgeModelResponse {
  choices: { message: { content: string | null } }[];
}

/**
 * Signature-compatible with a narrowed slice of server/ai.ts's chatRequest —
 * intentionally NOT importing chatRequest itself, so this module has no
 * runtime dependency on ai.ts beyond getAiConfig() (config resolution only,
 * no request-path coupling). The default implementation below performs the
 * real HTTP call; tests inject a mock instead.
 */
export type JudgeModelCaller = (
  endpoint: string,
  pat: string,
  payload: Record<string, unknown>
) => Promise<JudgeModelResponse>;

/**
 * Default judge model caller — a minimal, direct fetch POST. Deliberately
 * simpler than ai.ts's chatRequest (no retry/backoff/SSRF-redirect-guard
 * duplication): this is an eval-side tool run by a human/CI job, not a
 * production request path serving live traffic, so the reliability bar
 * server/ai.ts's chatRequest() was hardened for does not apply here. If this
 * eval tool needs the same retry/timeout hardening later, share chatRequest
 * directly rather than re-deriving it.
 */
async function defaultJudgeModelCaller(
  endpoint: string,
  pat: string,
  payload: Record<string, unknown>
): Promise<JudgeModelResponse> {
  const config = getAiConfig();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.provider === "github") {
    headers["Accept"] = "application/vnd.github+json";
    headers["Authorization"] = `Bearer ${pat}`;
    headers["X-GitHub-Api-Version"] = "2022-11-28";
  }
  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    redirect: "error",
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${resp.statusText}\n${body.slice(0, 500)}`);
  }
  return resp.json() as Promise<JudgeModelResponse>;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Judge whether `narrative` is faithful to `result`.
 *
 * @param result - The deterministic ScenarioResult the narrative is supposed
 *   to describe. Serialized verbatim into the judge prompt as ground truth.
 * @param narrative - The narrative text under test.
 * @param modelCaller - Injectable model call (defaults to a real HTTP POST
 *   via defaultJudgeModelCaller). Tests pass a mock so no live model call is
 *   made — mirrors the fetchImpl injection pattern in server/ai.ts's
 *   chatRequest().
 */
export async function judgeNarrationFaithfulness(
  result: ScenarioResult,
  narrative: string,
  modelCaller: JudgeModelCaller = defaultJudgeModelCaller
): Promise<JudgeResult> {
  const config = getAiConfig();

  if (config.provider === "github" && !config.pat) {
    return {
      ok: false,
      code: "provider_unconfigured",
      message: "No GitHub PAT configured for the judge model call.",
    };
  }

  const payload = {
    model: config.model,
    max_tokens: 1000,
    // temperature 0: grading should be as deterministic as the thing it grades.
    temperature: 0,
    messages: [
      { role: "system", content: JUDGE_SYSTEM_PROMPT },
      {
        role: "user",
        content: `ScenarioResult (ground truth):\n${JSON.stringify(result, null, 2)}\n\nNarrative under test:\n${narrative}`,
      },
    ],
  };

  let data: JudgeModelResponse;
  try {
    data = await modelCaller(config.endpoint, config.pat, payload);
  } catch (err: unknown) {
    return {
      ok: false,
      code: "provider_error",
      message: "The judge model request failed.",
      details: err instanceof Error ? err.message : String(err),
    };
  }

  const content = data.choices?.[0]?.message?.content ?? "";
  const cleaned = content.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err: unknown) {
    return {
      ok: false,
      code: "invalid_json",
      message: "The judge model did not return valid JSON.",
      details: err instanceof Error ? err.message : String(err),
    };
  }

  const validation = faithfulnessVerdictSchema.safeParse(parsed);
  if (!validation.success) {
    return {
      ok: false,
      code: "invalid_verdict_schema",
      message: "The judge model returned JSON, but it did not match the verdict schema.",
      details: validation.error.message,
    };
  }

  return { ok: true, verdict: validation.data };
}

/**
 * Intent-parsing eval runner
 *
 * Sends each corpus entry through the SAME intent-parsing path production uses —
 * the real PARSE_INTENT_PROMPT (imported from server/ai.ts, single source of
 * truth), real model call, real scenarioOperationSchema validation — and scores
 * exact-action + field-level match against expected.
 *
 * Production-fidelity note: like parseIntent() in server/ai.ts, a model
 * response that is not valid JSON or fails schema validation falls back to
 * {action: "burn_rate_check", _fallback: true} and is SCORED as that fallback
 * (the per-case result records that a fallback occurred). Only transport/HTTP
 * failures are recorded as errors, since they reflect infrastructure rather
 * than model behavior.
 *
 * Usage:
 *   npm run eval:intent
 *
 * Requires: GITHUB_TOKEN env var (same one the server uses for the GitHub
 * Models API). NOTE: unlike the server, the runner does NOT read the SQLite
 * config table — it always uses the default model and GitHub Models endpoint
 * below, even if your deployment is configured for Ollama or another model.
 *
 * Prints per-case results and an aggregate accuracy summary, then writes JSON
 * results to server/evals/results/latest.json.
 *
 * Exit codes:
 *   0 — ran successfully (even if some cases failed), or API key absent (skip)
 *   1 — fatal error (corpus unreadable, etc.)
 */

import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { PARSE_INTENT_PROMPT } from "../ai.js";
import { scenarioOperationSchema } from "../engine/validation.js";
import type { ScenarioOperation } from "../engine/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const EVAL_MODEL = "openai/gpt-4.1";
const EVAL_ENDPOINT = "https://models.github.ai/inference/chat/completions";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CorpusEntry {
  id: string;
  query: string;
  expected: Partial<ScenarioOperation>;
  /** Alternative acceptable operations (e.g. when the prompt rules allow more
   *  than one valid interpretation). The scorer takes the best match. */
  expectedAlternatives?: Partial<ScenarioOperation>[];
  notes?: string;
}

interface CaseResult {
  id: string;
  query: string;
  expected: Partial<ScenarioOperation>;
  expectedAlternatives?: Partial<ScenarioOperation>[];
  actual: ScenarioOperation | null;
  actionMatch: boolean;
  /** True when the score came from an entry in expectedAlternatives rather
   *  than the primary expected value. */
  matchedAlternative: boolean;
  /** True when the model output failed JSON/schema parsing and production's
   *  burn_rate_check fallback was applied before scoring. */
  fallback: boolean;
  fieldMatches: Record<string, boolean>;
  fieldScore: number;
  notes?: string;
  error?: string;
}

interface EvalSummary {
  runDate: string;
  model: string;
  endpoint: string;
  corpusSize: number;
  /** passCount / corpusSize — transport errors count as misses. */
  actionAccuracy: number;
  /** Mean per-case field score over ALL corpusSize cases — transport errors
   *  score 0. Same denominator as actionAccuracy. */
  meanFieldScore: number;
  passCount: number;
  failCount: number;
  errorCount: number;
  fallbackCount: number;
  cases: CaseResult[];
}

/** Minimal anonymized context snapshot used during eval (mirrors production format) */
const EVAL_CONTEXT_SNAPSHOT = `CURRENT PROJECTS:
  Project Alpha: Budget=$1,250,000, Spent=$485,000, Remaining=$765,000, Monthly Burn=$92,400, Months Left=8.3, Status=active
  Project Beta: Budget=$2,100,000, Spent=$1,050,000, Remaining=$1,050,000, Monthly Burn=$143,500, Months Left=7.3, Status=active
  Project Gamma: Budget=$680,000, Spent=$210,000, Remaining=$470,000, Monthly Burn=$58,200, Months Left=8.1, Status=active

CURRENT STAFFING:
  Project Alpha | Senior Developer | Staff-1 | 40hrs/wk | Cost=$6,647/mo | Revenue=$8,806/mo | Margin=24.5%
  Project Alpha | Mid-level Developer | Staff-2 | 40hrs/wk | Cost=$4,854/mo | Revenue=$6,630/mo | Margin=26.8%
  Project Alpha | Business Analyst | Staff-3 | 30hrs/wk | Cost=$3,638/mo | Revenue=$5,092/mo | Margin=28.6%
  Project Beta | Senior Developer | Staff-4 | 40hrs/wk | Cost=$6,647/mo | Revenue=$8,806/mo | Margin=24.5%
  Project Beta | Mid-level Developer | Staff-5 | 40hrs/wk | Cost=$4,854/mo | Revenue=$6,630/mo | Margin=26.8%
  Project Beta | QA Engineer | Staff-6 | 40hrs/wk | Cost=$4,131/mo | Revenue=$5,926/mo | Margin=30.3%
  Project Gamma | Junior Developer | Staff-7 | 40hrs/wk | Cost=$3,415/mo | Revenue=$4,845/mo | Margin=29.5%
  Project Gamma | Business Analyst | Staff-8 | 40hrs/wk | Cost=$4,492/mo | Revenue=$6,283/mo | Margin=28.5%

RATE CARD:
  Lead Architect: Bill=$285/hr, Cost=$210/hr, Margin=26.3%
  Senior Developer: Bill=$245/hr, Cost=$185/hr, Margin=24.5%
  Mid-level Developer: Bill=$185/hr, Cost=$135/hr, Margin=27.0%
  Junior Developer: Bill=$135/hr, Cost=$95/hr, Margin=29.6%
  Business Analyst: Bill=$175/hr, Cost=$125/hr, Margin=28.6%
  QA Engineer: Bill=$165/hr, Cost=$115/hr, Margin=30.3%
  Project Manager: Bill=$225/hr, Cost=$165/hr, Margin=26.7%
  Scrum Master: Bill=$195/hr, Cost=$145/hr, Margin=25.6%`;

// ─── Scoring helpers ──────────────────────────────────────────────────────────

/**
 * Score field-level match between one expected (partial) candidate and the
 * actual operation. Returns a record of { fieldName: matched } for all
 * expected fields, plus an aggregate score = matched / total.
 */
function scoreFields(
  expected: Partial<ScenarioOperation>,
  actual: ScenarioOperation
): { fieldMatches: Record<string, boolean>; fieldScore: number } {
  const fieldMatches: Record<string, boolean> = {};
  const keys = Object.keys(expected) as Array<keyof ScenarioOperation>;

  for (const key of keys) {
    if (key === "action") {
      fieldMatches[key] = expected.action === actual.action;
      continue;
    }
    // Deep-compare using JSON serialization for arrays/objects
    const expVal = JSON.stringify(expected[key]);
    const actVal = JSON.stringify(actual[key as keyof ScenarioOperation]);
    fieldMatches[key] = expVal === actVal;
  }

  const total = keys.length;
  const matched = Object.values(fieldMatches).filter(Boolean).length;
  return { fieldMatches, fieldScore: total > 0 ? matched / total : 1 };
}

interface CandidateScore {
  actionMatch: boolean;
  matchedAlternative: boolean;
  fieldMatches: Record<string, boolean>;
  fieldScore: number;
}

/**
 * Score the actual operation against the primary expected value and any
 * expectedAlternatives, returning the best-scoring candidate's result.
 * Candidates are ranked by (actionMatch, fieldScore).
 */
function scoreAgainstCandidates(entry: CorpusEntry, actual: ScenarioOperation): CandidateScore {
  const candidates = [entry.expected, ...(entry.expectedAlternatives ?? [])];

  let best: CandidateScore = {
    actionMatch: false,
    matchedAlternative: false,
    fieldMatches: {},
    fieldScore: -1,
  };

  candidates.forEach((candidate, index) => {
    const actionMatch = candidate.action === actual.action;
    const { fieldMatches, fieldScore } = scoreFields(candidate, actual);
    const better =
      (actionMatch && !best.actionMatch) ||
      (actionMatch === best.actionMatch && fieldScore > best.fieldScore);
    if (better) {
      best = { actionMatch, matchedAlternative: index > 0, fieldMatches, fieldScore };
    }
  });

  return best;
}

// ─── LLM call ────────────────────────────────────────────────────────────────

interface ChatResponse {
  choices: Array<{ message: { content: string | null } }>;
}

/**
 * Run one query through the production parse path: same prompt, same model
 * settings (temperature 0, max_tokens 500), same markdown-fence stripping,
 * same schema validation, and the same burn_rate_check fallback on
 * unparseable or schema-invalid output (mirrors parseIntent in server/ai.ts).
 * Throws only on transport/HTTP failures.
 */
async function callParseIntent(query: string, apiKey: string): Promise<ScenarioOperation> {
  const payload = {
    model: EVAL_MODEL,
    max_tokens: 500,
    temperature: 0,
    messages: [
      { role: "system", content: `${PARSE_INTENT_PROMPT}\n\nCURRENT DATA:\n${EVAL_CONTEXT_SNAPSHOT}` },
      { role: "user", content: query },
    ],
  };

  const resp = await fetch(EVAL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${apiKey}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }

  const data = (await resp.json()) as ChatResponse;
  const content = data.choices?.[0]?.message?.content ?? "";
  const cleaned = content.replace(/```(?:json)?\s*/g, "").replace(/```\s*/g, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Production behavior (server/ai.ts parseIntent): non-JSON output falls
    // back to burn_rate_check rather than erroring.
    return {
      action: "burn_rate_check",
      _fallback: true,
      _fallback_reason: `Model returned non-JSON: ${cleaned.slice(0, 200)}`,
    };
  }

  const validation = scenarioOperationSchema.safeParse(parsed);
  if (!validation.success) {
    // Production behavior: schema-invalid output falls back to burn_rate_check.
    return {
      action: "burn_rate_check",
      _fallback: true,
      _fallback_reason: `Schema validation failed: ${validation.error.message.slice(0, 200)}`,
    };
  }
  return validation.data;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const apiKey = process.env.GITHUB_TOKEN ?? "";
  if (!apiKey) {
    console.error(
      "eval:intent — no API key found. Set GITHUB_TOKEN to run against the GitHub Models API.\n" +
        "Exiting without error so CI is not broken."
    );
    process.exit(0);
  }

  // Load corpus
  const corpusPath = resolve(__dirname, "intent-corpus.json");
  const corpus = JSON.parse(readFileSync(corpusPath, "utf-8")) as CorpusEntry[];

  console.log(`\nIntent-parsing eval — ${corpus.length} cases, model: ${EVAL_MODEL}`);
  console.log(
    "NOTE: the runner always uses the default model/endpoint above — it does NOT\n" +
      "read the app's SQLite config, so a deployment configured for Ollama or a\n" +
      "different model is not reflected in this eval."
  );
  console.log("─".repeat(70));

  const results: CaseResult[] = [];
  let passCount = 0;
  let failCount = 0;
  let errorCount = 0;
  let fallbackCount = 0;

  for (const entry of corpus) {
    process.stdout.write(`  ${entry.id.padEnd(26)}`);

    let actual: ScenarioOperation | null = null;
    let caseError: string | undefined;

    try {
      actual = await callParseIntent(entry.query, apiKey);
    } catch (err: unknown) {
      caseError = err instanceof Error ? err.message : String(err);
    }

    const fallback = actual?._fallback === true;
    if (fallback) fallbackCount++;

    const score: CandidateScore =
      actual !== null
        ? scoreAgainstCandidates(entry, actual)
        : { actionMatch: false, matchedAlternative: false, fieldMatches: {}, fieldScore: 0 };

    const statusIcon = caseError ? "ERR" : score.actionMatch ? " OK" : "FAI";
    const fieldPct = `${Math.round(Math.max(score.fieldScore, 0) * 100)}%`.padStart(4);
    const flags = [fallback ? "fallback" : "", score.matchedAlternative ? "alt" : ""]
      .filter(Boolean)
      .join(",");
    console.log(`[${statusIcon}] action=${actual?.action ?? "n/a"} fields=${fieldPct}${flags ? ` (${flags})` : ""}`);

    if (caseError) {
      errorCount++;
    } else if (score.actionMatch) {
      passCount++;
    } else {
      failCount++;
    }

    results.push({
      id: entry.id,
      query: entry.query,
      expected: entry.expected,
      ...(entry.expectedAlternatives ? { expectedAlternatives: entry.expectedAlternatives } : {}),
      actual,
      actionMatch: score.actionMatch,
      matchedAlternative: score.matchedAlternative,
      fallback,
      fieldMatches: score.fieldMatches,
      fieldScore: caseError ? 0 : Math.max(score.fieldScore, 0),
      notes: entry.notes,
      ...(caseError ? { error: caseError } : {}),
    });
  }

  // ─── Aggregate summary ────────────────────────────────────────────────────
  // Both metrics use the SAME denominator: the full corpus size. Transport
  // errors count as misses (score 0) in both, so the two numbers are directly
  // comparable.

  const corpusSize = corpus.length;
  const actionAccuracy = corpusSize > 0 ? passCount / corpusSize : 0;
  const meanFieldScore =
    corpusSize > 0 ? results.reduce((sum, r) => sum + r.fieldScore, 0) / corpusSize : 0;

  console.log("\n" + "─".repeat(70));
  console.log(`Action accuracy : ${passCount}/${corpusSize} = ${(actionAccuracy * 100).toFixed(1)}%  (over all cases; transport errors count as misses)`);
  console.log(`Mean field score: ${(meanFieldScore * 100).toFixed(1)}%  (same denominator: all ${corpusSize} cases)`);
  console.log(`  Passed    : ${passCount}`);
  console.log(`  Failed    : ${failCount}`);
  console.log(`  Errors    : ${errorCount}  (transport/HTTP only — scored 0)`);
  console.log(`  Fallbacks : ${fallbackCount}  (output fell back to burn_rate_check, as in production)`);
  console.log("─".repeat(70));

  // ─── Write results artifact ──────────────────────────────────────────────

  const summary: EvalSummary = {
    runDate: new Date().toISOString(),
    model: EVAL_MODEL,
    endpoint: EVAL_ENDPOINT,
    corpusSize,
    actionAccuracy,
    meanFieldScore,
    passCount,
    failCount,
    errorCount,
    fallbackCount,
    cases: results,
  };

  const resultsDir = resolve(__dirname, "results");
  mkdirSync(resultsDir, { recursive: true });
  const outPath = resolve(resultsDir, "latest.json");
  writeFileSync(outPath, JSON.stringify(summary, null, 2), "utf-8");
  console.log(`\nResults written to: ${outPath}\n`);
}

main().catch((err: unknown) => {
  console.error("eval:intent — fatal error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});

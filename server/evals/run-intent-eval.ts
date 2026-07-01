/**
 * Intent-parsing eval runner
 *
 * Calls the PRODUCTION parseIntent() (server/ai.ts) directly for every corpus
 * entry — same prompt, same model config resolution (getAiConfig() /
 * getConfig(), including the SQLite config table), same schema validation,
 * same typed failure contract. There is no separate reimplementation of the
 * parse path here: this file previously had its own callParseIntent() that
 * duplicated production's HTTP call and JSON/schema handling, and that copy
 * had drifted — it returned a fabricated {action:"burn_rate_check",
 * _fallback:true} shape on failure that production stopped producing once
 * parseIntent() was refactored to return a typed IntentParseResult
 * (IntentParseSuccess | IntentParseFailure; see server/ai.ts). Calling
 * parseIntent() directly means a prompt or schema regression fails this eval
 * exactly the way it fails production — never masked behind a fake
 * burn_rate_check success.
 *
 * Usage:
 *   npm run eval:intent                       # local/dev — missing token skips (exit 0)
 *   EVAL_INTENT_GATED=1 npm run eval:intent    # CI/gated — missing token is FATAL (exit 1)
 *
 * Requires: GITHUB_TOKEN env var (same one the server uses for the GitHub
 * Models API — see server/ai.ts getAiConfig(), which prefers the SQLite
 * "github_pat" config value and falls back to this env var). The model and
 * endpoint used are whatever getAiConfig() resolves — the DB's seeded
 * defaults (model "openai/gpt-4.1", endpoint the GitHub Models chat
 * completions URL, provider "github") unless a deployment has explicitly
 * reconfigured them via /api/config, in which case this eval now faithfully
 * reflects that deployment instead of silently ignoring it.
 *
 * Prints per-case results and an aggregate accuracy summary, then writes JSON
 * results to server/evals/results/latest.json.
 *
 * Accuracy gate: the observed action accuracy is compared against the
 * committed INTENT_CORPUS_ACCURACY_THRESHOLD (server/evals/eval-config.ts).
 * Falling below it fails the run (see exit codes) — this is what lets a real
 * intent-parsing regression fail CI instead of being silently absorbed.
 *
 * Exit codes:
 *   0 — accuracy >= threshold, or API key absent AND not running gated
 *   1 — accuracy < threshold, API key absent while EVAL_INTENT_GATED=1/true,
 *       or a fatal error (corpus unreadable, etc.)
 */

import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parseIntent, getAiConfig } from "../ai.js";
import type { ScenarioOperation } from "../engine/types.js";
import { INTENT_CORPUS_ACCURACY_THRESHOLD } from "./eval-config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * "Gated" runs (CI, or anyone opting in locally) treat a missing GITHUB_TOKEN
 * as a FATAL error rather than a silent skip — otherwise a credential-less CI
 * job would report green without ever exercising the model. Recognizes "1"
 * and "true" (case-insensitive) so either style of CI env-var convention works.
 */
export function isGatedRun(): boolean {
  const flag = (process.env.EVAL_INTENT_GATED ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true";
}

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
  /** Set to production's IntentParseFailure.code when parseIntent() returned
   *  a typed failure (ok: false) instead of a parsed operation — e.g.
   *  "invalid_json" or "invalid_operation". Undefined when parsing
   *  succeeded. Scored as a miss (fieldScore 0), exactly like production
   *  surfaces it as a 422 rather than a disguised burn_rate_check. */
  parseFailureCode?: string;
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
  /** Count of cases where parseIntent() returned a typed IntentParseFailure
   *  (see CaseResult.parseFailureCode) rather than throwing a transport
   *  error. Distinct from errorCount, which is transport/HTTP failures only. */
  parseFailureCount: number;
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const gated = isGatedRun();

  // Fast upfront skip/gate check. This intentionally checks only the
  // GITHUB_TOKEN env var (not the full getAiConfig()/isProviderConfigured()
  // precondition production uses) so a credential-less run exits with one
  // clear message instead of running the whole corpus through parseIntent()
  // and recording a "provider_unconfigured" IntentParseFailure per case. A
  // deployment that instead sets the DB "github_pat" config value (with no
  // GITHUB_TOKEN env var) or that uses the "ollama" provider (no token
  // needed) will not hit this early-exit — it falls through to the real
  // parseIntent() calls below, which resolve their own config correctly.
  if (!process.env.GITHUB_TOKEN) {
    if (gated) {
      console.error(
        "eval:intent — no GITHUB_TOKEN found, but EVAL_INTENT_GATED is set.\n" +
          "Set GITHUB_TOKEN (or configure the DB github_pat / ollama provider) so this\n" +
          "gated run can actually exercise the model. Failing rather than silently\n" +
          "skipping the accuracy gate."
      );
      process.exit(1);
    }
    console.error(
      "eval:intent — no GITHUB_TOKEN found. Set it to run against the GitHub Models API\n" +
        "(or configure the DB github_pat / ollama provider directly).\n" +
        "Exiting without error so ungated/local runs are not broken.\n" +
        "(Set EVAL_INTENT_GATED=1 to make a missing token fail instead of skip.)"
    );
    process.exit(0);
  }

  // Load corpus
  const corpusPath = resolve(__dirname, "intent-corpus.json");
  const corpus = JSON.parse(readFileSync(corpusPath, "utf-8")) as CorpusEntry[];

  // Resolved via the SAME getAiConfig() production uses — reflects the
  // SQLite config table (or its seeded defaults) rather than a value
  // hardcoded in this file, so the printed/recorded model+endpoint always
  // match what parseIntent() actually called below.
  const resolvedConfig = getAiConfig();

  console.log(`\nIntent-parsing eval — ${corpus.length} cases, model: ${resolvedConfig.model}`);
  console.log(
    `Provider: ${resolvedConfig.provider}  Endpoint: ${resolvedConfig.endpoint}\n` +
      "(Resolved via the app's SQLite config table, same as production — see server/ai.ts getAiConfig().)"
  );
  console.log("─".repeat(70));

  const results: CaseResult[] = [];
  let passCount = 0;
  let failCount = 0;
  let errorCount = 0;
  let parseFailureCount = 0;

  for (const entry of corpus) {
    process.stdout.write(`  ${entry.id.padEnd(26)}`);

    let actual: ScenarioOperation | null = null;
    let parseFailureCode: string | undefined;
    let caseError: string | undefined;

    try {
      // Calls the PRODUCTION parse path directly — no reimplementation.
      const result = await parseIntent(entry.query, EVAL_CONTEXT_SNAPSHOT);
      if (result.ok) {
        actual = result.operation;
      } else {
        // Typed failure (server/ai.ts IntentParseFailure) — scored as a miss
        // below via the null `actual`, exactly as production returns a 422
        // rather than a disguised burn_rate_check success.
        parseFailureCode = result.code;
        parseFailureCount++;
      }
    } catch (err: unknown) {
      caseError = err instanceof Error ? err.message : String(err);
    }

    const score: CandidateScore =
      actual !== null
        ? scoreAgainstCandidates(entry, actual)
        : { actionMatch: false, matchedAlternative: false, fieldMatches: {}, fieldScore: 0 };

    const statusIcon = caseError ? "ERR" : score.actionMatch ? " OK" : "FAI";
    const fieldPct = `${Math.round(Math.max(score.fieldScore, 0) * 100)}%`.padStart(4);
    const flags = [parseFailureCode ? `parse:${parseFailureCode}` : "", score.matchedAlternative ? "alt" : ""]
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
      ...(parseFailureCode ? { parseFailureCode } : {}),
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
  console.log(`  Passed         : ${passCount}`);
  console.log(`  Failed         : ${failCount}`);
  console.log(`  Errors         : ${errorCount}  (transport/HTTP only — scored 0)`);
  console.log(`  Parse failures : ${parseFailureCount}  (typed IntentParseFailure from production parseIntent() — scored 0, as production returns 422)`);
  console.log("─".repeat(70));

  // ─── Write results artifact ──────────────────────────────────────────────

  const summary: EvalSummary = {
    runDate: new Date().toISOString(),
    model: resolvedConfig.model,
    endpoint: resolvedConfig.endpoint,
    corpusSize,
    actionAccuracy,
    meanFieldScore,
    passCount,
    failCount,
    errorCount,
    parseFailureCount,
    cases: results,
  };

  const resultsDir = resolve(__dirname, "results");
  mkdirSync(resultsDir, { recursive: true });
  const outPath = resolve(resultsDir, "latest.json");
  writeFileSync(outPath, JSON.stringify(summary, null, 2), "utf-8");
  console.log(`\nResults written to: ${outPath}\n`);

  // ─── Accuracy gate ────────────────────────────────────────────────────────
  // This is the actual regression gate: a real drop in intent-parsing quality
  // must fail the command (and therefore CI), not just print a lower number.
  // Uses process.exitCode (not process.exit) so the console/file output above
  // has already flushed before the process exits non-zero.
  if (actionAccuracy < INTENT_CORPUS_ACCURACY_THRESHOLD) {
    console.error(
      `eval:intent — FAIL: action accuracy ${(actionAccuracy * 100).toFixed(1)}% is below the ` +
        `committed threshold ${(INTENT_CORPUS_ACCURACY_THRESHOLD * 100).toFixed(1)}% ` +
        `(server/evals/eval-config.ts).`
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `eval:intent — PASS: action accuracy ${(actionAccuracy * 100).toFixed(1)}% meets the ` +
      `committed threshold ${(INTENT_CORPUS_ACCURACY_THRESHOLD * 100).toFixed(1)}%.`
  );
}

// Only run when executed directly (`npm run eval:intent` / `tsx
// server/evals/run-intent-eval.ts`), not when imported — e.g. by
// server/__tests__/intent-eval-gate.test.ts, which imports isGatedRun() for
// unit testing and must not trigger a live network run as a side effect of
// that import.
const isDirectExecution = process.argv[1] !== undefined && __filename === resolve(process.argv[1]);

if (isDirectExecution) {
  main().catch((err: unknown) => {
    console.error("eval:intent — fatal error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

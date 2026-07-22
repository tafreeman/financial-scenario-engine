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
 *   npm run eval:intent                       # local/dev — unconfigured provider skips (exit 0)
 *   EVAL_INTENT_GATED=1 npm run eval:intent    # CI/gated — unconfigured provider is FATAL (exit 1)
 *
 * Requires: a configured LLM provider — checked via the SAME
 * isProviderConfigured() production uses (server/ai.ts), so this gate is
 * provider-aware rather than hardcoded to one provider's credential (a prior
 * version of this check looked only at process.env.GITHUB_TOKEN, which broke
 * the moment a deployment or CI job configured a different provider — see
 * server/ai.ts getAiConfig()/isProviderConfigured() for the "github" |
 * "ollama" | "openrouter" resolution). The model and endpoint used are
 * whatever getAiConfig() resolves — the DB's seeded defaults (model
 * "openai/gpt-4.1" on the GitHub Models endpoint, provider "github") unless a
 * deployment or CI step has explicitly reconfigured them (see
 * server/evals/configure-openrouter-eval.ts, run by
 * .github/workflows/real-model-eval.yml before this script, since GitHub
 * Models is fully retired 2026-07-30), in which case this eval faithfully
 * reflects that configuration instead of silently ignoring it.
 *
 * Prints per-case results and an aggregate accuracy summary, then writes JSON
 * results to server/evals/results/latest.json.
 *
 * Accuracy gate: the observed action accuracy is compared against the
 * committed INTENT_CORPUS_ACCURACY_THRESHOLD (server/evals/eval-config.ts).
 * Falling below it fails the run (see exit codes) — this is what lets a real
 * intent-parsing regression fail CI instead of being silently absorbed.
 *
 * Request pacing: when the resolved provider is "openrouter", corpus cases
 * are paced (OPENROUTER_EVAL_PACING_MS below) to stay under OpenRouter's
 * free-tier (":free" model-id suffix) rate limit of 20 requests/minute
 * (https://openrouter.ai/docs/api-reference/limits) — the corpus is large
 * enough to exceed that cap if run back-to-back. This has no effect for
 * github/ollama runs.
 *
 * Exit codes:
 *   0 — accuracy >= threshold, or provider unconfigured AND not running gated
 *   1 — accuracy < threshold, provider unconfigured while EVAL_INTENT_GATED=1/true,
 *       or a fatal error (corpus unreadable, etc.)
 */

import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parseIntent, getAiConfig, isProviderConfigured } from "../ai.js";
import type { ScenarioOperation } from "../engine/types.js";
import { INTENT_CORPUS_ACCURACY_THRESHOLD } from "./eval-config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * "Gated" runs (CI, or anyone opting in locally) treat an unconfigured
 * provider (see isProviderConfigured(), server/ai.ts) as a FATAL error rather
 * than a silent skip — otherwise a credential-less CI job would report green
 * without ever exercising the model. Recognizes "1" and "true"
 * (case-insensitive) so either style of CI env-var convention works.
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
  /** Optional corpus-entry tag (currently only "adversarial" is defined —
   *  see server/__tests__/intent-corpus.test.ts KNOWN_CATEGORIES). Untagged
   *  entries are grouped under the synthetic "core" bucket below so every
   *  case lands in exactly one category for reporting purposes. */
  category?: string;
  notes?: string;
}

interface CaseResult {
  id: string;
  query: string;
  expected: Partial<ScenarioOperation>;
  expectedAlternatives?: Partial<ScenarioOperation>[];
  /** Echoes CorpusEntry.category verbatim (undefined for untagged entries —
   *  see CATEGORY_UNTAGGED for how those are bucketed in the summary). */
  category?: string;
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
  /**
   * Numeric HTTP status from the upstream call, echoed from
   * IntentParseFailure.httpStatus (server/ai.ts) when parseFailureCode is
   * "provider_error" and the failure was a non-2xx response. Undefined for
   * every other case (success, or a failure that never reached transport).
   * Before this field existed, the results artifact only ever recorded the
   * generic "provider_error" code — a run failing with 429 (rate limited),
   * 401 (bad credentials), and 502 (upstream down) were indistinguishable
   * without re-running against a live model. This is what makes a failure
   * diagnosable from server/evals/results/latest.json alone.
   */
  httpStatus?: number;
  fieldMatches: Record<string, boolean>;
  fieldScore: number;
  notes?: string;
  error?: string;
}

/** Synthetic category label for corpus entries with no explicit `category` tag. */
const CATEGORY_UNTAGGED = "core";

interface CategorySummary {
  category: string;
  corpusSize: number;
  passCount: number;
  failCount: number;
  errorCount: number;
  /** passCount / corpusSize, this category's own denominator — NOT the full
   *  corpus size. This is what makes a category-specific accuracy dip visible
   *  instead of averaging out inside the single blended actionAccuracy. */
  actionAccuracy: number;
  /**
   * Typed IntentParseFailureCode counts within this category's cases only
   * (see tallyFailuresByCode()). Already included in failCount — this is a
   * breakdown of WHY those cases missed, not an additional denominator.
   * Lets a reviewer see, e.g., whether "adversarial" cases fail mostly via
   * provider_error (the provider itself refusing/erroring — possibly a
   * content-policy trip on prompt-injection-style inputs) versus
   * invalid_json/invalid_operation (a genuine parsing miss).
   */
  parseFailuresByCode: Record<string, number>;
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
  /**
   * parseFailureCount broken out by IntentParseFailureCode, summed across
   * the whole corpus (see tallyFailuresByCode() and CategorySummary's
   * per-category version of the same breakdown). Every count here is
   * already included in parseFailureCount / failCount / the
   * actionAccuracy denominator (corpusSize) — this NEVER removes a case
   * from a denominator, it only labels why a subset of the misses
   * happened.
   *
   * Rationale for tracking this separately: "provider_error" (the
   * upstream model/provider itself erroring — a rate limit, a malformed
   * response, or a content-policy refusal) is a different failure mode
   * than "invalid_json"/"invalid_operation" (the model responded, but its
   * output didn't parse or validate against scenarioOperationSchema) or
   * "provider_unconfigured" (a setup problem, not reachable in a normal
   * gated run). A spike concentrated in provider_error — especially
   * inside the "adversarial" category (see categoryBreakdown) — points at
   * the provider's own content-policy filter tripping on
   * prompt-injection-style test inputs, which calls for a different fix
   * (rephrase or drop that corpus entry, or accept the refusal as correct
   * behavior) than a genuine PARSE_INTENT_PROMPT quality regression does.
   *
   * This breakdown is informational only and does NOT change the
   * pass/fail gate below or introduce a second threshold: a
   * provider_error is still an inability to produce a usable
   * ScenarioOperation for the user's query, so the gate keeps scoring it
   * as a miss exactly like any other typed failure. Excluding
   * provider_error from the gate would let a real reliability regression
   * (e.g. the provider starting to refuse a class of legitimate queries)
   * pass silently — see the "do NOT hide failures by dropping them from
   * the denominator" acceptance rule this was built to satisfy.
   */
  parseFailuresByCode: Record<string, number>;
  /**
   * Accuracy broken out per category (see CorpusEntry.category /
   * CATEGORY_UNTAGGED), each with its OWN denominator (that category's case
   * count, not corpusSize). Lets a reviewer see e.g. "adversarial: 8/18
   * (44.4%)" sitting next to "core: 29/30 (96.7%)" instead of a single
   * blended actionAccuracy number that would hide a robustness dip in the
   * mean. Does not affect the pass/fail gate below (see
   * actionAccuracyExcludingAdversarial for the number that would).
   */
  categoryBreakdown: CategorySummary[];
  /**
   * Action accuracy computed with the adversarial-category cases removed
   * from BOTH numerator and denominator (i.e. its own denominator = corpusSize
   * - adversarialCount). Reported alongside the full-corpus actionAccuracy so
   * a threshold-calibration reviewer can see the "non-adversarial floor"
   * distinct from a blended mean that a large or hard adversarial slice could
   * drag down. Undefined when the corpus has zero adversarial-tagged entries
   * (nothing to exclude). NOT used by the pass/fail gate below — the gate
   * intentionally keeps checking the full-corpus actionAccuracy so existing
   * CI semantics are unchanged; this field is informational, for the
   * calibration procedure documented in eval-config.ts.
   */
  actionAccuracyExcludingAdversarial?: number;
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

// ─── Failure-code stratification ─────────────────────────────────────────────

/**
 * Tally typed parse-failure codes (IntentParseFailureCode; see
 * CaseResult.parseFailureCode) across a set of cases. Cases with no
 * parseFailureCode (parseIntent() succeeded, whether the action matched or
 * not) are excluded from the tally entirely — this never changes a
 * denominator, it only labels why the cases that already count as misses
 * missed. See EvalSummary.parseFailuresByCode for the rationale.
 *
 * Exported (and kept pure — no I/O) so it's unit-testable without a live
 * model call; main() itself requires network access and isn't unit-testable
 * (see the module comment above isGatedRun()).
 */
export function tallyFailuresByCode(cases: Pick<CaseResult, "parseFailureCode">[]): Record<string, number> {
  const byCode: Record<string, number> = {};
  for (const c of cases) {
    if (!c.parseFailureCode) continue;
    byCode[c.parseFailureCode] = (byCode[c.parseFailureCode] ?? 0) + 1;
  }
  return byCode;
}

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

// ─── OpenRouter free-tier request pacing ─────────────────────────────────────

/**
 * Minimum delay (ms) between corpus cases when the resolved provider is
 * "openrouter". OpenRouter's free-tier (":free" model-id suffix) models are
 * capped at 20 requests/minute per account regardless of purchased credits
 * (https://openrouter.ai/docs/api-reference/limits), and bursts close to that
 * ceiling can trip a Cloudflare-level block even below the nominal cap. The
 * corpus (server/evals/intent-corpus.json) is large enough to exceed 20/min
 * if run back-to-back. 3500ms keeps this comfortably under the cap
 * (60_000ms / 20 = 3000ms minimum) with margin for jitter/clock drift. This
 * constant has no effect for github/ollama runs (see the call site below).
 */
const OPENROUTER_EVAL_PACING_MS = 3_500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const gated = isGatedRun();

  // Fast upfront skip/gate check — provider-aware via the SAME
  // isProviderConfigured() production uses (server/ai.ts), so it correctly
  // reflects whichever provider is actually configured (github/ollama/
  // openrouter) rather than hardcoding one provider's credential env var.
  // (A prior version of this check looked only at process.env.GITHUB_TOKEN,
  // which meant a CI job or deployment configured for a different provider
  // either had to also export a dummy GITHUB_TOKEN to get past this gate, or
  // — for a gated run — failed here even though its actual provider WAS
  // configured. See server/evals/configure-openrouter-eval.ts, which sets
  // the DB config this check now reads, before this script runs.)
  const providerCheck = isProviderConfigured();
  if (!providerCheck.ok) {
    if (gated) {
      console.error(
        `eval:intent — provider not configured (${providerCheck.error ?? "unknown reason"}), but EVAL_INTENT_GATED is set.\n` +
          "Configure a provider (DB config or the corresponding credential env var —\n" +
          "see server/ai.ts getAiConfig()/isProviderConfigured()) so this gated run can\n" +
          "exercise the model. Failing rather than silently skipping the accuracy gate."
      );
      process.exit(1);
    }
    console.error(
      `eval:intent — provider not configured (${providerCheck.error ?? "unknown reason"}). Configure one to run the eval.\n` +
        "Exiting without error so ungated/local runs are not broken.\n" +
        "(Set EVAL_INTENT_GATED=1 to make this failure fatal instead of a skip.)"
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

  for (const [index, entry] of corpus.entries()) {
    // Pace requests against OpenRouter's free-tier rate limit (see
    // OPENROUTER_EVAL_PACING_MS above) — skip before the FIRST case so a
    // clean run isn't penalized with a wasted leading delay. No-op for any
    // other provider.
    if (index > 0 && resolvedConfig.provider === "openrouter") {
      await sleep(OPENROUTER_EVAL_PACING_MS);
    }

    process.stdout.write(`  ${entry.id.padEnd(26)}`);

    let actual: ScenarioOperation | null = null;
    let parseFailureCode: string | undefined;
    let httpStatus: number | undefined;
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
        httpStatus = result.httpStatus;
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
    const flags = [
      parseFailureCode ? `parse:${parseFailureCode}` : "",
      httpStatus !== undefined ? `http:${httpStatus}` : "",
      score.matchedAlternative ? "alt" : "",
    ]
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
      ...(entry.category ? { category: entry.category } : {}),
      actual,
      actionMatch: score.actionMatch,
      matchedAlternative: score.matchedAlternative,
      ...(parseFailureCode ? { parseFailureCode } : {}),
      ...(httpStatus !== undefined ? { httpStatus } : {}),
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

  // ─── Category breakdown ───────────────────────────────────────────────────
  // Groups every case (including untagged ones, under CATEGORY_UNTAGGED) and
  // computes accuracy PER CATEGORY with that category's own denominator. This
  // is what surfaces a robustness dip on adversarial cases as its own visible
  // number instead of letting it get diluted into the single blended mean
  // above — see EvalSummary.categoryBreakdown doc comment.
  const categoryBuckets = new Map<string, CaseResult[]>();
  for (const r of results) {
    const key = r.category ?? CATEGORY_UNTAGGED;
    const bucket = categoryBuckets.get(key);
    if (bucket) bucket.push(r);
    else categoryBuckets.set(key, [r]);
  }
  const categoryBreakdown: CategorySummary[] = [...categoryBuckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, caseResults]) => {
      const catPass = caseResults.filter((r) => r.actionMatch).length;
      const catError = caseResults.filter((r) => r.error !== undefined).length;
      const catFail = caseResults.length - catPass - catError;
      return {
        category,
        corpusSize: caseResults.length,
        passCount: catPass,
        failCount: catFail,
        errorCount: catError,
        actionAccuracy: caseResults.length > 0 ? catPass / caseResults.length : 0,
        parseFailuresByCode: tallyFailuresByCode(caseResults),
      };
    });

  // Full-corpus version of the same breakdown — see EvalSummary.parseFailuresByCode.
  const parseFailuresByCode = tallyFailuresByCode(results);

  // Accuracy with the adversarial slice excluded from both numerator and
  // denominator — the "non-adversarial floor" a calibration reviewer can
  // compare against the full-corpus actionAccuracy above. Undefined (rather
  // than a misleading 0/0 -> 0) when there is no adversarial slice to exclude.
  const adversarialResults = results.filter((r) => r.category === "adversarial");
  const nonAdversarialResults = results.filter((r) => r.category !== "adversarial");
  const actionAccuracyExcludingAdversarial =
    adversarialResults.length > 0 && nonAdversarialResults.length > 0
      ? nonAdversarialResults.filter((r) => r.actionMatch).length / nonAdversarialResults.length
      : undefined;

  console.log("\n" + "─".repeat(70));
  console.log(`Action accuracy : ${passCount}/${corpusSize} = ${(actionAccuracy * 100).toFixed(1)}%  (over all cases; transport errors count as misses)`);
  console.log(`Mean field score: ${(meanFieldScore * 100).toFixed(1)}%  (same denominator: all ${corpusSize} cases)`);
  console.log(`  Passed         : ${passCount}`);
  console.log(`  Failed         : ${failCount}`);
  console.log(`  Errors         : ${errorCount}  (transport/HTTP only — scored 0)`);
  console.log(`  Parse failures : ${parseFailureCount}  (typed IntentParseFailure from production parseIntent() — scored 0, as production returns 422)`);
  if (Object.keys(parseFailuresByCode).length > 0) {
    const breakdown = Object.entries(parseFailuresByCode)
      .sort(([, a], [, b]) => b - a)
      .map(([code, count]) => `${code}=${count}`)
      .join(", ");
    // Stratifies WITHIN parseFailureCount — does not add to or shrink any
    // denominator. See EvalSummary.parseFailuresByCode for the rationale
    // (why provider_error is worth distinguishing from a genuine parsing
    // miss, and why it still counts as a miss for the gate below).
    console.log(`    by code      : ${breakdown}  (stratifies parseFailureCount above — informational, does not change the gate)`);
  }
  console.log("─".repeat(70));
  console.log("Accuracy by category (own denominator per row — NOT corpusSize):");
  for (const cat of categoryBreakdown) {
    const catBreakdown = Object.entries(cat.parseFailuresByCode)
      .sort(([, a], [, b]) => b - a)
      .map(([code, count]) => `${code}=${count}`)
      .join(",");
    console.log(
      `  ${cat.category.padEnd(14)} ${String(cat.passCount).padStart(3)}/${String(cat.corpusSize).padEnd(3)} = ${(cat.actionAccuracy * 100).toFixed(1).padStart(5)}%` +
        `  (fail=${cat.failCount}, err=${cat.errorCount}${catBreakdown ? `, parse-fail: ${catBreakdown}` : ""})`
    );
  }
  if (actionAccuracyExcludingAdversarial !== undefined) {
    console.log(
      `Action accuracy excluding adversarial: ${(actionAccuracyExcludingAdversarial * 100).toFixed(1)}%` +
        `  (${nonAdversarialResults.filter((r) => r.actionMatch).length}/${nonAdversarialResults.length} non-adversarial cases — informational only, does not affect the gate below)`
    );
  }
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
    parseFailuresByCode,
    categoryBreakdown,
    ...(actionAccuracyExcludingAdversarial !== undefined ? { actionAccuracyExcludingAdversarial } : {}),
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

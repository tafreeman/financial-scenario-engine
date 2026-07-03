/**
 * Narration-faithfulness eval runner (WP3-E) — ADVISORY ONLY.
 *
 * Runs a fixed set of representative scenario operations through the REAL
 * production path — executeScenario() over the live portfolio snapshot, then
 * generateNarrative() (server/engine/narrative.ts) — and asks the judge in
 * server/evals/faithfulness-judge.ts whether each narrative is faithful to
 * the deterministic ScenarioResult it describes.
 *
 * ─── CALIBRATION-FIRST POLICY (BINDING — eval-framework design spec §9.3) ───
 * The judge has NOT been calibrated against human-labeled data, so this
 * runner collects verdicts as EVIDENCE, never as a gate: a successful run
 * exits 0 regardless of how many narratives the judge flags. Do not add a
 * threshold here or wire this script into a required CI check until a
 * human-labeled calibration set exists and a deliberate calibration PR
 * (mirroring the procedure in server/evals/eval-config.ts) establishes one.
 *
 * Usage:
 *   npm run eval:faithfulness                            # missing token skips (exit 0)
 *   EVAL_FAITHFULNESS_GATED=1 npm run eval:faithfulness  # missing token is FATAL (exit 1)
 *
 * Requires: GITHUB_TOKEN env var — same upfront presence check as
 * run-intent-eval.ts (the judge itself resolves provider/model/endpoint via
 * getAiConfig(), so a deployment reconfigured via /api/config is reflected
 * here too; the skip/gate check still keys on process.env.GITHUB_TOKEN alone).
 *
 * Exit codes:
 *   0 — run completed and at least one narrative was actually judged
 *       (faithful or not — advisory, no verdict gate), or token absent
 *       while ungated
 *   1 — token absent while EVAL_FAITHFULNESS_GATED=1/true, every judge call
 *       failed (nothing was judged, so the run produced no evidence), or a
 *       fatal error
 *
 * Results artifact: server/evals/results/faithfulness-latest.json (gitignored,
 * like the intent eval's latest.json).
 */

import { mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { executeScenario } from "../engine/executor.js";
import { generateNarrative } from "../engine/narrative.js";
import type { ScenarioResult } from "../engine/types.js";
import { scenarioOperationSchema } from "../engine/validation.js";
import { loadPortfolioSnapshot } from "../loaders.js";
import {
  judgeNarrationFaithfulness,
  type JudgeResult,
} from "./faithfulness-judge.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Mirrors run-intent-eval.ts's isGatedRun(): "1"/"true" (any case) opt in. */
export function isGatedRun(): boolean {
  const flag = (process.env.EVAL_FAITHFULNESS_GATED ?? "").trim().toLowerCase();
  return flag === "1" || flag === "true";
}

/**
 * Fixed reference date so engine outputs (timeline extension, EVM planned
 * value, budget exhaustion) are identical run-to-run — verdict differences
 * between runs then isolate JUDGE behaviour, not input drift.
 */
const EVAL_AS_OF_DATE = new Date("2026-01-15T00:00:00Z");

/**
 * Representative operations spanning the narrative templates: staffing
 * mutations (swap/add), a rate change, and the two portfolio-level analysis
 * actions. Role and project names match the seeded sample data (see
 * "Sample Data" in README.md) so the engine resolves real rows rather than
 * emitting not-found warnings for every case.
 */
const EVAL_OPERATIONS: { id: string; operation: unknown }[] = [
  {
    id: "faith-swap-001",
    operation: {
      action: "swap",
      project: "Project Alpha",
      remove: [{ role: "Senior Developer", count: 1 }],
      add: [{ role: "Mid-level Developer", count: 2, hours_per_week: 40 }],
    },
  },
  {
    id: "faith-add-001",
    operation: {
      action: "add",
      project: "Project Alpha",
      add: [{ role: "Project Manager", count: 1, hours_per_week: 40 }],
    },
  },
  {
    id: "faith-rate-001",
    operation: {
      action: "rate_change",
      project: "Project Beta",
      rate_changes: [{ role: "Lead Architect", new_bill_rate: 310 }],
    },
  },
  {
    id: "faith-burn-001",
    operation: { action: "burn_rate_check" },
  },
  {
    id: "faith-margin-001",
    operation: { action: "margin_analysis", project: "Project Alpha" },
  },
];

interface FaithfulnessCaseResult {
  id: string;
  action: string;
  judged: boolean;
  faithful: boolean | null;
  violationCount: number;
  /** Judge failure code when judged=false (see JudgeFailureCode). */
  failureCode: string | null;
  detail: string;
}

function toCaseResult(id: string, action: string, judge: JudgeResult): FaithfulnessCaseResult {
  if (!judge.ok) {
    return {
      id,
      action,
      judged: false,
      faithful: null,
      violationCount: 0,
      failureCode: judge.code,
      detail: judge.message,
    };
  }
  return {
    id,
    action,
    judged: true,
    faithful: judge.verdict.faithful,
    violationCount: judge.verdict.violations.length,
    failureCode: null,
    detail: judge.verdict.violations
      .map((violation) => `${violation.type}: ${violation.quote}`)
      .join("; "),
  };
}

async function main(): Promise<number> {
  if (!process.env.GITHUB_TOKEN) {
    if (isGatedRun()) {
      console.error(
        "faithfulness-eval: GATED run but GITHUB_TOKEN is not set — failing instead of silently skipping."
      );
      return 1;
    }
    console.log(
      "faithfulness-eval: GITHUB_TOKEN not set; skipping (set EVAL_FAITHFULNESS_GATED=1 to fail instead)."
    );
    return 0;
  }

  const snapshot = loadPortfolioSnapshot();
  const results: FaithfulnessCaseResult[] = [];

  for (const { id, operation } of EVAL_OPERATIONS) {
    // Validate our own fixtures the same way production validates parsed
    // intents — a fixture that drifts from the schema should fail loudly here.
    const parsed = scenarioOperationSchema.safeParse(operation);
    if (!parsed.success) {
      console.error(`faithfulness-eval: fixture ${id} is not a valid ScenarioOperation:`);
      console.error(parsed.error.message);
      return 1;
    }

    const result: ScenarioResult = executeScenario(parsed.data, snapshot, EVAL_AS_OF_DATE);
    const narrative = generateNarrative(result);
    const judge = await judgeNarrationFaithfulness(result, narrative);
    results.push(toCaseResult(id, parsed.data.action, judge));
  }

  // ── Report ──────────────────────────────────────────────────────────────
  console.log("\nid                 action            judged  faithful  detail");
  console.log("-".repeat(90));
  for (const row of results) {
    const faithful = row.faithful === null ? "-" : row.faithful ? "yes" : "NO";
    const detail = row.judged ? row.detail || "(no violations)" : `${row.failureCode}: ${row.detail}`;
    console.log(
      `${row.id.padEnd(18)} ${row.action.padEnd(17)} ${String(row.judged).padEnd(7)} ${faithful.padEnd(9)} ${detail}`
    );
  }

  const judgedCount = results.filter((row) => row.judged).length;
  const faithfulCount = results.filter((row) => row.faithful === true).length;
  console.log(
    `\n${judgedCount}/${results.length} judged; ${faithfulCount}/${judgedCount || 1} faithful — ` +
      "ADVISORY: verdicts are evidence, not a gate (uncalibrated judge; see faithfulness-judge.ts)."
  );

  const resultsDir = resolve(__dirname, "results");
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(
    resolve(resultsDir, "faithfulness-latest.json"),
    JSON.stringify(
      { ranAt: new Date().toISOString(), asOfDate: EVAL_AS_OF_DATE.toISOString(), results },
      null,
      2
    )
  );

  if (judgedCount === 0) {
    console.error(
      "faithfulness-eval: every judge call failed — the run produced no verdicts, treating as failed."
    );
    return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error("faithfulness-eval: fatal error:", err);
    process.exit(1);
  });

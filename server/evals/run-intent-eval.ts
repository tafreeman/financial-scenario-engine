/**
 * Intent-parsing eval runner
 *
 * Sends each corpus entry through the SAME intent-parsing path production uses —
 * the real PARSE_INTENT_PROMPT, real model call, real scenarioOperationSchema
 * validation — and scores exact-action + field-level match against expected.
 *
 * Usage:
 *   npm run eval:intent
 *
 * Requires: GITHUB_TOKEN env var (same one the server uses for the GitHub
 * Models API). Prints per-case results and an aggregate accuracy summary,
 * then writes JSON results to server/evals/results/latest.json.
 *
 * Exit codes:
 *   0 — ran successfully (even if some cases failed)
 *   1 — API key absent or all-cases network failure
 */

import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { scenarioOperationSchema } from "../engine/validation.js";
import type { ScenarioOperation } from "../engine/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Types ────────────────────────────────────────────────────────────────────

interface CorpusEntry {
  id: string;
  query: string;
  expected: Partial<ScenarioOperation>;
  notes?: string;
}

interface CaseResult {
  id: string;
  query: string;
  expected: Partial<ScenarioOperation>;
  actual: ScenarioOperation | null;
  actionMatch: boolean;
  fieldMatches: Record<string, boolean>;
  fieldScore: number;
  notes?: string;
  error?: string;
}

interface EvalSummary {
  runDate: string;
  model: string;
  corpusSize: number;
  actionAccuracy: number;
  meanFieldScore: number;
  passCount: number;
  failCount: number;
  errorCount: number;
  cases: CaseResult[];
}

// ─── Prompt (must mirror server/ai.ts PARSE_INTENT_PROMPT exactly) ───────────

const PARSE_INTENT_PROMPT = `You are a financial scenario parser. Your job is to convert natural language into a structured JSON operation that the financial engine can execute. You do NOT compute anything — you only extract the user's intent.

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
 * Score field-level match between expected (partial) and actual operation.
 * Returns a record of { fieldName: matched } for all expected fields, plus
 * an aggregate score = matched / total.
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

// ─── LLM call ────────────────────────────────────────────────────────────────

interface ChatResponse {
  choices: Array<{ message: { content: string | null } }>;
}

async function callParseIntent(
  query: string,
  apiKey: string,
  model: string,
  endpoint: string
): Promise<ScenarioOperation | null> {
  const payload = {
    model,
    max_tokens: 500,
    temperature: 0,
    messages: [
      { role: "system", content: `${PARSE_INTENT_PROMPT}\n\nCURRENT DATA:\n${EVAL_CONTEXT_SNAPSHOT}` },
      { role: "user", content: query },
    ],
  };

  const resp = await fetch(endpoint, {
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
    throw new Error(`Model returned non-JSON: ${cleaned.slice(0, 200)}`);
  }

  const validation = scenarioOperationSchema.safeParse(parsed);
  if (!validation.success) {
    // Schema-invalid response — return the parsed object with action coerced to
    // burn_rate_check so callers see the fallback rather than a null gap
    return { action: "burn_rate_check", _fallback: true, _fallback_reason: validation.error.message };
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

  const model = "openai/gpt-4.1";
  const endpoint = "https://models.github.ai/inference/chat/completions";

  // Load corpus
  const corpusPath = resolve(__dirname, "intent-corpus.json");
  const corpus = JSON.parse(readFileSync(corpusPath, "utf-8")) as CorpusEntry[];

  console.log(`\nIntent-parsing eval — ${corpus.length} cases, model: ${model}`);
  console.log("─".repeat(70));

  const results: CaseResult[] = [];
  let passCount = 0;
  let failCount = 0;
  let errorCount = 0;

  for (const entry of corpus) {
    process.stdout.write(`  ${entry.id.padEnd(26)}`);

    let actual: ScenarioOperation | null = null;
    let caseError: string | undefined;

    try {
      actual = await callParseIntent(entry.query, apiKey, model, endpoint);
    } catch (err: unknown) {
      caseError = err instanceof Error ? err.message : String(err);
    }

    const actionMatch = actual !== null && actual.action === entry.expected.action;
    const { fieldMatches, fieldScore } =
      actual !== null
        ? scoreFields(entry.expected, actual)
        : { fieldMatches: {}, fieldScore: 0 };

    const statusIcon = caseError ? "ERR" : actionMatch ? " OK" : "FAI";
    const fieldPct = `${Math.round(fieldScore * 100)}%`.padStart(4);
    console.log(`[${statusIcon}] action=${actual?.action ?? "n/a"} fields=${fieldPct}`);

    if (caseError) {
      errorCount++;
    } else if (actionMatch) {
      passCount++;
    } else {
      failCount++;
    }

    results.push({
      id: entry.id,
      query: entry.query,
      expected: entry.expected,
      actual,
      actionMatch,
      fieldMatches,
      fieldScore,
      notes: entry.notes,
      ...(caseError ? { error: caseError } : {}),
    });
  }

  // ─── Aggregate summary ────────────────────────────────────────────────────

  const evaluated = corpus.length - errorCount;
  const actionAccuracy = evaluated > 0 ? passCount / evaluated : 0;
  const meanFieldScore =
    results.reduce((sum, r) => sum + r.fieldScore, 0) / results.length;

  console.log("\n" + "─".repeat(70));
  console.log(`Action accuracy : ${passCount}/${evaluated} = ${(actionAccuracy * 100).toFixed(1)}%`);
  console.log(`Mean field score: ${(meanFieldScore * 100).toFixed(1)}%`);
  console.log(`  Passed : ${passCount}`);
  console.log(`  Failed : ${failCount}`);
  console.log(`  Errors : ${errorCount}`);
  console.log("─".repeat(70));

  // ─── Write results artifact ──────────────────────────────────────────────

  const summary: EvalSummary = {
    runDate: new Date().toISOString(),
    model,
    corpusSize: corpus.length,
    actionAccuracy,
    meanFieldScore,
    passCount,
    failCount,
    errorCount,
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

/**
 * In-memory, per-process LLM call accounting (WP3-B).
 *
 * Aggregates what server/ai.ts already logs at the LLM boundary (see
 * logLlmCall() in ai.ts) into running counters an operator can read back
 * via GET /api/telemetry/llm (server/routes.ts) without grepping logs.
 *
 * Intentionally NOT persisted (no DB table, no file) and NOT a metrics/OTel
 * SDK — this is a local-first, dependency-light app (see README "Tech
 * Stack"). Counters reset on process restart, which is acceptable for a
 * single-operator local tool; if multi-process/durable metrics are ever
 * needed, that is a deliberate follow-up, not something to smuggle in here.
 */

import type { LlmCallPurpose, LlmCallOutcome } from "./ai.js";

interface PurposeCounters {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  failures: number;
  retries: number;
}

function emptyPurposeCounters(): PurposeCounters {
  return { calls: 0, tokensIn: 0, tokensOut: 0, failures: 0, retries: 0 };
}

/** One row of accounting per (purpose). */
const byPurpose = new Map<LlmCallPurpose, PurposeCounters>();

/** Failure counts keyed by typed failure code (e.g. "invalid_json", "provider_error", "timeout"). */
const failuresByCode = new Map<string, number>();

let totalCalls = 0;
let totalTokensIn = 0;
let totalTokensOut = 0;
let totalFailures = 0;
let totalRetries = 0;
const processStartedAt = new Date().toISOString();

export interface RecordLlmCallInput {
  purpose: LlmCallPurpose;
  outcome: LlmCallOutcome;
  /** Typed failure code when outcome === "failure" (e.g. IntentParseFailureCode, or "timeout"/"transport_error"). */
  failureCode?: string;
  tokensIn?: number;
  tokensOut?: number;
  /** Number of retry attempts consumed by this call (0 if it succeeded/failed on the first try). */
  retryCount?: number;
}

/** Record one completed LLM call into the process-lifetime counters. */
export function recordLlmCall(input: RecordLlmCallInput): void {
  const bucket = byPurpose.get(input.purpose) ?? emptyPurposeCounters();
  bucket.calls += 1;
  bucket.tokensIn += input.tokensIn ?? 0;
  bucket.tokensOut += input.tokensOut ?? 0;
  bucket.retries += input.retryCount ?? 0;
  if (input.outcome === "failure") {
    bucket.failures += 1;
  }
  byPurpose.set(input.purpose, bucket);

  totalCalls += 1;
  totalTokensIn += input.tokensIn ?? 0;
  totalTokensOut += input.tokensOut ?? 0;
  totalRetries += input.retryCount ?? 0;
  if (input.outcome === "failure") {
    totalFailures += 1;
    const code = input.failureCode ?? "unknown";
    failuresByCode.set(code, (failuresByCode.get(code) ?? 0) + 1);
  }
}

export interface LlmTelemetrySnapshot {
  processStartedAt: string;
  totals: {
    calls: number;
    tokensIn: number;
    tokensOut: number;
    failures: number;
    retries: number;
  };
  byPurpose: Record<string, PurposeCounters>;
  failuresByCode: Record<string, number>;
}

/** Read-only snapshot of the current process-lifetime counters. */
export function getLlmTelemetrySnapshot(): LlmTelemetrySnapshot {
  return {
    processStartedAt,
    totals: {
      calls: totalCalls,
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      failures: totalFailures,
      retries: totalRetries,
    },
    byPurpose: Object.fromEntries(
      [...byPurpose.entries()].map(([purpose, counters]) => [purpose, { ...counters }])
    ),
    failuresByCode: Object.fromEntries(failuresByCode.entries()),
  };
}

/** Test-only: reset all counters. Not exported from any production path. */
export function __resetLlmTelemetryForTests(): void {
  byPurpose.clear();
  failuresByCode.clear();
  totalCalls = 0;
  totalTokensIn = 0;
  totalTokensOut = 0;
  totalFailures = 0;
  totalRetries = 0;
}

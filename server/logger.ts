/**
 * Minimal structured (JSON-line) logger.
 *
 * The rest of the server logs with bare `console.log`/`console.error` (see
 * server/index.ts, server/auth.ts) — that convention is left alone here.
 * This util exists ONLY for the LLM boundary (server/ai.ts), where a
 * machine-parseable, stable-shape line per call is the point: it lets an
 * operator grep/aggregate latency, token usage, retries, and failure codes
 * across calls without pulling in a logging framework or an OpenTelemetry
 * SDK (this is a dependency-light, local-first app — see README).
 *
 * NEVER log prompts, user queries, or any financial/PII content here — only
 * sizes, counts, and typed codes. This mirrors the app's existing PII
 * posture at the LLM boundary (buildAnonymizedContextSnapshot() in
 * server/db.ts redacts person names before egress; this logger must not
 * become a second channel that leaks what that redaction protects).
 */

/** One JSON-serializable log line. Callers pass a flat, stable-shaped object. */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

/**
 * Write one JSON line to stdout (info-level) or stderr (error-level).
 *
 * Deliberately NOT a class/singleton with configurable transports — this is
 * the smallest thing that gives a stable, greppable shape. `event` is a
 * short machine-readable name (e.g. "llm_call"); `fields` is merged into the
 * emitted object alongside a `ts` (ISO timestamp) and the `event` name.
 */
export function logEvent(level: "info" | "error", event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

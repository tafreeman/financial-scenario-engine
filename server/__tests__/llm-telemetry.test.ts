import { afterEach, describe, it, expect } from "vitest";
import {
  recordLlmCall,
  getLlmTelemetrySnapshot,
  __resetLlmTelemetryForTests,
} from "../llm-telemetry.js";

/**
 * Unit tests for the in-memory LLM call aggregator (WP3-B). These are pure
 * counter-arithmetic tests — no network, no LLM boundary — so they exercise
 * recordLlmCall()/getLlmTelemetrySnapshot() directly rather than going
 * through server/ai.ts (which is covered by ai.test.ts's mocked-fetch
 * suite for the logging/wiring side of this feature).
 */

afterEach(() => {
  __resetLlmTelemetryForTests();
});

describe("llm-telemetry — aggregation", () => {
  it("starts at zero for every counter", () => {
    const snapshot = getLlmTelemetrySnapshot();
    expect(snapshot.totals).toEqual({ calls: 0, tokensIn: 0, tokensOut: 0, failures: 0, retries: 0 });
    expect(snapshot.byPurpose).toEqual({});
    expect(snapshot.failuresByCode).toEqual({});
  });

  it("accumulates calls, tokens, and retries for a single purpose", () => {
    recordLlmCall({ purpose: "intent", outcome: "success", tokensIn: 100, tokensOut: 20, retryCount: 0 });
    recordLlmCall({ purpose: "intent", outcome: "success", tokensIn: 150, tokensOut: 30, retryCount: 2 });

    const snapshot = getLlmTelemetrySnapshot();
    expect(snapshot.totals).toEqual({ calls: 2, tokensIn: 250, tokensOut: 50, failures: 0, retries: 2 });
    expect(snapshot.byPurpose.intent).toEqual({
      calls: 2, tokensIn: 250, tokensOut: 50, failures: 0, retries: 2,
    });
  });

  it("keeps separate buckets per purpose", () => {
    recordLlmCall({ purpose: "intent", outcome: "success", tokensOut: 10 });
    recordLlmCall({ purpose: "narration", outcome: "success", tokensOut: 40 });
    recordLlmCall({ purpose: "agentic-step", outcome: "success", tokensOut: 5 });

    const snapshot = getLlmTelemetrySnapshot();
    expect(Object.keys(snapshot.byPurpose).sort()).toEqual(["agentic-step", "intent", "narration"]);
    expect(snapshot.byPurpose.intent?.tokensOut).toBe(10);
    expect(snapshot.byPurpose.narration?.tokensOut).toBe(40);
    expect(snapshot.byPurpose["agentic-step"]?.tokensOut).toBe(5);
    expect(snapshot.totals.calls).toBe(3);
  });

  it("counts failures by typed code and keeps per-purpose failure counts in sync", () => {
    recordLlmCall({ purpose: "intent", outcome: "failure", failureCode: "invalid_json" });
    recordLlmCall({ purpose: "intent", outcome: "failure", failureCode: "invalid_json" });
    recordLlmCall({ purpose: "narration", outcome: "failure", failureCode: "timeout" });

    const snapshot = getLlmTelemetrySnapshot();
    expect(snapshot.totals.failures).toBe(3);
    expect(snapshot.failuresByCode).toEqual({ invalid_json: 2, timeout: 1 });
    expect(snapshot.byPurpose.intent?.failures).toBe(2);
    expect(snapshot.byPurpose.narration?.failures).toBe(1);
  });

  it("defaults an unspecified failureCode to 'unknown' rather than dropping the failure", () => {
    recordLlmCall({ purpose: "agentic-step", outcome: "failure" });

    const snapshot = getLlmTelemetrySnapshot();
    expect(snapshot.failuresByCode).toEqual({ unknown: 1 });
    expect(snapshot.totals.failures).toBe(1);
  });

  it("treats omitted tokensIn/tokensOut/retryCount as zero, not NaN or undefined", () => {
    recordLlmCall({ purpose: "intent", outcome: "success" });

    const snapshot = getLlmTelemetrySnapshot();
    expect(snapshot.totals).toEqual({ calls: 1, tokensIn: 0, tokensOut: 0, failures: 0, retries: 0 });
  });

  it("__resetLlmTelemetryForTests clears all counters and buckets", () => {
    recordLlmCall({ purpose: "intent", outcome: "failure", failureCode: "provider_error" });
    __resetLlmTelemetryForTests();

    const snapshot = getLlmTelemetrySnapshot();
    expect(snapshot.totals).toEqual({ calls: 0, tokensIn: 0, tokensOut: 0, failures: 0, retries: 0 });
    expect(snapshot.byPurpose).toEqual({});
    expect(snapshot.failuresByCode).toEqual({});
  });

  it("processStartedAt is a stable ISO timestamp across snapshots", () => {
    const first = getLlmTelemetrySnapshot().processStartedAt;
    recordLlmCall({ purpose: "intent", outcome: "success" });
    const second = getLlmTelemetrySnapshot().processStartedAt;
    expect(first).toBe(second);
    expect(() => new Date(first).toISOString()).not.toThrow();
  });
});

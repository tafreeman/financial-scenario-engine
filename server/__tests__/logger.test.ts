import { afterEach, describe, it, expect, vi } from "vitest";
import { logEvent } from "../logger.js";

/**
 * Unit tests for the JSON-line structured logger (WP3-B). Verifies the log
 * shape is stable and machine-parseable, and that info/error route to the
 * correct stream — independent of any LLM-boundary call site.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logEvent — JSON-line shape", () => {
  it("writes info-level events to console.log as a single parseable JSON line", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    logEvent("info", "llm_call", { purpose: "intent", latencyMs: 42 });

    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(line);

    expect(parsed).toMatchObject({ level: "info", event: "llm_call", purpose: "intent", latencyMs: 42 });
    expect(typeof parsed.ts).toBe("string");
    expect(() => new Date(parsed.ts).toISOString()).not.toThrow();
  });

  it("writes error-level events to console.error, not console.log", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    logEvent("error", "llm_call", { purpose: "narration", outcome: "failure" });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
    const parsed = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
    expect(parsed).toMatchObject({ level: "error", event: "llm_call", outcome: "failure" });
  });

  it("omits no fields — null/undefined values still serialize (visible, not silently dropped as absent keys for null)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    logEvent("info", "llm_call", { tokensOut: null, retryCount: 0 });

    const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(parsed.tokensOut).toBeNull();
    expect(parsed.retryCount).toBe(0);
  });

  it("defaults fields to an empty object when omitted", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    logEvent("info", "server_started");

    const parsed = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(parsed.event).toBe("server_started");
    expect(parsed.level).toBe("info");
  });
});

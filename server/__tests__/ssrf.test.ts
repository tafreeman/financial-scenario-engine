/**
 * Direct unit tests for server/ssrf.ts's DNS-lookup timeout (2026-07-22
 * security review, PR #49, LOW): a black-holed/unresponsive resolver must
 * not be able to hold PUT /api/config open indefinitely — the async
 * refinements race the injected dnsLookup against a bounded timeout and fail
 * CLOSED (reject the endpoint) if it elapses.
 *
 * Uses fake timers scoped to this file only (no real 5s wait) — calling the
 * exported async functions directly (not through HTTP/Express), so there is
 * no interference with real socket I/O.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { refineEndpointNoPrivateAsync, type DnsLookupAll } from "../ssrf.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("refineEndpointNoPrivateAsync — DNS lookup timeout (fail-closed)", () => {
  it("rejects the endpoint when the injected dnsLookup never resolves before the internal timeout elapses", async () => {
    vi.useFakeTimers();

    // A resolver that never settles — simulates a black-holed/unresponsive
    // DNS server hanging the lookup indefinitely.
    const neverResolves: DnsLookupAll = () => new Promise(() => {});

    const resultPromise = refineEndpointNoPrivateAsync(
      "https://black-holed.example.com/v1/chat/completions",
      neverResolves
    );

    // Advance the virtual clock past the internal DNS_LOOKUP_TIMEOUT_MS (5s),
    // letting the race's timeout branch reject and the catch's fail-closed
    // path run.
    await vi.advanceTimersByTimeAsync(5_001);

    await expect(resultPromise).resolves.toBe(false);
  });

  it("does not fail closed when dnsLookup resolves well before the timeout", async () => {
    vi.useFakeTimers();

    const fastPublicLookup: DnsLookupAll = async () => [{ address: "203.0.113.10", family: 4 }];

    const resultPromise = refineEndpointNoPrivateAsync(
      "https://fast-public.example.com/v1/chat/completions",
      fastPublicLookup
    );
    // Let any pending microtasks/timers that are already due run, without
    // advancing anywhere near the 5s timeout.
    await vi.advanceTimersByTimeAsync(10);

    await expect(resultPromise).resolves.toBe(true);
  });
});

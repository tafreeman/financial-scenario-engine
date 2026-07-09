/**
 * Tests for tallyFailuresByCode() (server/evals/run-intent-eval.ts) — the
 * pure helper behind the eval report's provider_error-vs-parser-miss-vs-pass
 * stratification (FSE-02).
 *
 * Before this fix, the eval's aggregate summary reported a single combined
 * parseFailureCount with no breakdown by IntentParseFailureCode, so a run
 * with several provider_error failures (the provider itself erroring —
 * possibly a content-policy refusal on an adversarial prompt) was
 * indistinguishable from the same number of invalid_json/invalid_operation
 * failures (a genuine parsing miss). tallyFailuresByCode() is the pure piece
 * of that fix — main() itself needs a live model call and isn't
 * unit-testable (documented in run-intent-eval.ts).
 *
 * These tests are deterministic and require no network access or API key.
 */

import { describe, it, expect } from "vitest";
import { tallyFailuresByCode } from "../evals/run-intent-eval.js";

describe("tallyFailuresByCode()", () => {
  it("returns an empty object for an empty case list", () => {
    expect(tallyFailuresByCode([])).toEqual({});
  });

  it("excludes cases with no parseFailureCode (a successful parse, whether the action matched or not)", () => {
    const cases = [{ parseFailureCode: undefined }, { parseFailureCode: undefined }];
    expect(tallyFailuresByCode(cases)).toEqual({});
  });

  it("counts a single failure code once", () => {
    const cases = [{ parseFailureCode: "provider_error" }];
    expect(tallyFailuresByCode(cases)).toEqual({ provider_error: 1 });
  });

  it("sums repeated occurrences of the same code", () => {
    const cases = [
      { parseFailureCode: "provider_error" },
      { parseFailureCode: "provider_error" },
      { parseFailureCode: "provider_error" },
    ];
    expect(tallyFailuresByCode(cases)).toEqual({ provider_error: 3 });
  });

  it("stratifies multiple distinct codes independently, ignoring successful (undefined-code) cases mixed in", () => {
    const cases = [
      { parseFailureCode: "provider_error" },
      { parseFailureCode: "provider_error" },
      { parseFailureCode: "invalid_json" },
      { parseFailureCode: "invalid_operation" },
      { parseFailureCode: undefined }, // a successful parse — must not appear in the tally
      { parseFailureCode: "provider_unconfigured" },
    ];

    expect(tallyFailuresByCode(cases)).toEqual({
      provider_error: 2,
      invalid_json: 1,
      invalid_operation: 1,
      provider_unconfigured: 1,
    });
  });

  it("the sum of all tallied counts never exceeds the input length (never invents or drops a denominator)", () => {
    const cases = [
      { parseFailureCode: "provider_error" },
      { parseFailureCode: undefined },
      { parseFailureCode: "invalid_json" },
      { parseFailureCode: undefined },
    ];

    const tally = tallyFailuresByCode(cases);
    const totalTallied = Object.values(tally).reduce((sum, n) => sum + n, 0);

    expect(totalTallied).toBeLessThanOrEqual(cases.length);
    expect(totalTallied).toBe(2); // the two defined-code cases, not the two successes
  });

  it("does not mutate the input array", () => {
    const cases = [{ parseFailureCode: "provider_error" }, { parseFailureCode: undefined }];
    const snapshot = JSON.parse(JSON.stringify(cases)) as unknown;

    tallyFailuresByCode(cases);

    expect(cases).toEqual(snapshot);
  });
});

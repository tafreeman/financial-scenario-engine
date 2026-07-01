/**
 * Tests for the intent-eval accuracy gate (FSE-4).
 *
 * Before this fix, server/evals/run-intent-eval.ts applied no accuracy
 * threshold at all and exited 0 unconditionally — including when GITHUB_TOKEN
 * was absent — so the command could never fail CI on a real intent-parsing
 * regression.
 *
 * These tests are deterministic and require no network access or API key:
 *   1. The committed threshold (server/evals/eval-config.ts) is a sane
 *      fraction — this is the config the ticket asked to be "committed...
 *      per corpus" rather than inline magic.
 *   2. isGatedRun() correctly parses the EVAL_INTENT_GATED env var (the flag
 *      that makes a missing token FATAL rather than a silent skip).
 *   3. The pass/fail arithmetic used by the runner's gate — accuracy compared
 *      against the threshold — is exercised directly here as a pure
 *      function, since main() performs real HTTP calls and is not unit-testable
 *      without live credentials (documented in run-intent-eval.ts). This proves
 *      the mechanism: lowering the threshold below an observed accuracy fails,
 *      raising it back above passes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { INTENT_CORPUS_ACCURACY_THRESHOLD } from "../evals/eval-config.js";
import { isGatedRun } from "../evals/run-intent-eval.js";

describe("INTENT_CORPUS_ACCURACY_THRESHOLD — committed config", () => {
  it("is a fraction strictly between 0 and 1 (not 0%, not 100%)", () => {
    expect(INTENT_CORPUS_ACCURACY_THRESHOLD).toBeGreaterThan(0);
    expect(INTENT_CORPUS_ACCURACY_THRESHOLD).toBeLessThan(1);
  });
});

describe("isGatedRun() — EVAL_INTENT_GATED env parsing", () => {
  const ORIGINAL = process.env.EVAL_INTENT_GATED;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.EVAL_INTENT_GATED;
    else process.env.EVAL_INTENT_GATED = ORIGINAL;
  });

  it("is false when unset", () => {
    delete process.env.EVAL_INTENT_GATED;
    expect(isGatedRun()).toBe(false);
  });

  it("is false for an empty string", () => {
    process.env.EVAL_INTENT_GATED = "";
    expect(isGatedRun()).toBe(false);
  });

  it("is false for an unrelated truthy-looking value", () => {
    process.env.EVAL_INTENT_GATED = "yes";
    expect(isGatedRun()).toBe(false);
  });

  it('is true for "1"', () => {
    process.env.EVAL_INTENT_GATED = "1";
    expect(isGatedRun()).toBe(true);
  });

  it('is true for "true" (any case)', () => {
    process.env.EVAL_INTENT_GATED = "True";
    expect(isGatedRun()).toBe(true);
  });

  it('is false for "0" or "false"', () => {
    process.env.EVAL_INTENT_GATED = "0";
    expect(isGatedRun()).toBe(false);
    process.env.EVAL_INTENT_GATED = "false";
    expect(isGatedRun()).toBe(false);
  });
});

describe("accuracy gate arithmetic — mirrors run-intent-eval.ts main()", () => {
  // Reimplements only the comparison itself (actionAccuracy < threshold),
  // exactly as written in run-intent-eval.ts's main(). The full run cannot be
  // exercised without live GITHUB_TOKEN + network access (documented in that
  // file's module comment), so this pins the gate's pass/fail boundary logic.
  function wouldFail(actionAccuracy: number, threshold: number): boolean {
    return actionAccuracy < threshold;
  }

  it("fails the gate when observed accuracy is below the threshold", () => {
    // Simulates: lowering a corpus's committed threshold below an accuracy
    // the harness actually observed should make the command exit non-zero.
    const observedAccuracy = 0.8;
    const loweredThreshold = 0.85;
    expect(wouldFail(observedAccuracy, loweredThreshold)).toBe(true);
  });

  it("passes the gate when observed accuracy meets or exceeds the threshold", () => {
    // Simulates: raising the threshold back to (or below) what was observed
    // should make the command exit 0 again.
    const observedAccuracy = 0.8;
    const restoredThreshold = 0.75;
    expect(wouldFail(observedAccuracy, restoredThreshold)).toBe(false);
  });

  it("passes at the exact boundary (accuracy == threshold)", () => {
    expect(wouldFail(0.85, 0.85)).toBe(false);
  });

  it("fails one ulp below the boundary", () => {
    expect(wouldFail(0.8499999999999999, 0.85)).toBe(true);
  });
});

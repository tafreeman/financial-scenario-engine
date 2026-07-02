import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { scenarioOperationSchema } from "../engine/validation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Deterministic corpus-integrity tests.
 *
 * These tests validate that every entry in the intent eval corpus is
 * structurally correct — no network, no API key required.  They run in CI
 * alongside the unit tests and guard against corpus drift (e.g. a typo in an
 * expected operation that would silently skew eval accuracy).
 *
 * What is checked per corpus entry:
 *   1. Required top-level fields are present (id, query, expected).
 *   2. The `expected` operation (and every entry in the optional
 *      `expectedAlternatives` array) validates against the same Zod schema
 *      that production uses at the parse/boundary step — i.e. every labeled
 *      value is a legal ScenarioOperation.
 *   3. `query` is a non-empty string.
 *   4. `id` is a non-empty string.
 *   5. The optional `category` field, when present, is one of
 *      KNOWN_CATEGORIES (currently just "adversarial") — this is the schema
 *      extension WP2-D introduced to tag prompt-injection/jailbreak/edge-case
 *      corpus entries so run-intent-eval.ts can report accuracy split by
 *      category (overall vs. excluding adversarial cases), rather than
 *      hiding a robustness dip inside a single blended mean.
 *   6. At least one corpus entry is tagged `category: "adversarial"` — a
 *      floor (not an exact count) so the adversarial slice can never
 *      silently regress to empty while every other integrity check still
 *      passes.
 *
 * Degenerate-input corpus entries (e.g. "degenerate-001"/"degenerate-002" —
 * a single meaningless character, a whitespace-only string) intentionally
 * still satisfy the non-empty-string `query` floor below; a literally empty
 * string ("") is deliberately excluded from the corpus so this integrity
 * floor stays an unambiguous guard against accidentally-blank entries rather
 * than a case that has to distinguish "corpus bug" from "deliberate test
 * case" (production separately rejects an empty query with HTTP 400 before
 * parseIntent() is ever reached — see server/routes.ts's `!query` guard).
 */

/** Known values for the optional corpus-entry `category` field. */
const KNOWN_CATEGORIES = ["adversarial"] as const;
type KnownCategory = (typeof KNOWN_CATEGORIES)[number];

interface RawCorpusEntry {
  id: unknown;
  query: unknown;
  expected: unknown;
  expectedAlternatives?: unknown;
  category?: unknown;
  notes?: unknown;
}

describe("intent-corpus — structural integrity", () => {
  const corpusPath = resolve(__dirname, "../evals/intent-corpus.json");
  const raw = JSON.parse(readFileSync(corpusPath, "utf-8")) as unknown;

  it("corpus file is a non-empty array", () => {
    expect(Array.isArray(raw)).toBe(true);
    // Floor, not an exact count (see repo-wide rule against hardcoded,
    // drift-prone metric numbers): the corpus is expected to keep growing —
    // pin only a minimum so this test doesn't need editing every time a case
    // is added. See the "corpus has at least N entries" test below for the
    // authoritative size floor.
    expect((raw as unknown[]).length).toBeGreaterThan(0);
  });

  const entries = raw as RawCorpusEntry[];

  it("every entry has required string fields: id, query", () => {
    for (const entry of entries) {
      expect(typeof entry.id, `entry id must be a string (got ${typeof entry.id})`).toBe("string");
      expect((entry.id as string).length, `entry.id must be non-empty`).toBeGreaterThan(0);

      expect(typeof entry.query, `entry ${String(entry.id)}: query must be a string`).toBe("string");
      expect((entry.query as string).length, `entry ${String(entry.id)}: query must be non-empty`).toBeGreaterThan(0);
    }
  });

  it("all ids are unique", () => {
    const ids = entries.map((e) => e.id as string);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("every expected value is a valid ScenarioOperation", () => {
    for (const entry of entries) {
      const result = scenarioOperationSchema.safeParse(entry.expected);
      expect(
        result.success,
        `Corpus entry "${String(entry.id)}" has invalid expected: ${
          result.success ? "" : result.error.message
        }`
      ).toBe(true);
    }
  });

  it("every expectedAlternatives entry is a valid ScenarioOperation", () => {
    for (const entry of entries) {
      if (entry.expectedAlternatives === undefined) continue;
      expect(
        Array.isArray(entry.expectedAlternatives),
        `Corpus entry "${String(entry.id)}": expectedAlternatives must be an array`
      ).toBe(true);
      for (const alternative of entry.expectedAlternatives as unknown[]) {
        const result = scenarioOperationSchema.safeParse(alternative);
        expect(
          result.success,
          `Corpus entry "${String(entry.id)}" has invalid expectedAlternatives entry: ${
            result.success ? "" : result.error.message
          }`
        ).toBe(true);
      }
    }
  });

  it("every entry's optional category field, when present, is a known category", () => {
    for (const entry of entries) {
      if (entry.category === undefined) continue;
      expect(
        typeof entry.category,
        `Corpus entry "${String(entry.id)}": category must be a string`
      ).toBe("string");
      expect(
        (KNOWN_CATEGORIES as readonly string[]).includes(entry.category as string),
        `Corpus entry "${String(entry.id)}" has unknown category "${String(
          entry.category
        )}" — must be one of: ${KNOWN_CATEGORIES.join(", ")}`
      ).toBe(true);
    }
  });

  it("the adversarial category is non-empty", () => {
    // Floor, not an exact count: guards against the adversarial/prompt-injection
    // slice silently regressing to zero (e.g. an entry losing its category tag
    // during an edit) while every other integrity check above still passes.
    const adversarialCount = entries.filter(
      (e) => (e.category as KnownCategory | undefined) === "adversarial"
    ).length;
    expect(adversarialCount, "corpus must include at least one adversarial-category case").toBeGreaterThan(0);
  });

  it("corpus covers all 12 action types", () => {
    const actions = new Set(
      entries.map((e) => (e.expected as { action: string }).action)
    );
    const allActions = [
      "swap",
      "add",
      "remove",
      "rate_change",
      "hours_change",
      "timeline_extension",
      "unexpected_cost",
      "reallocation",
      "burn_rate_check",
      "margin_analysis",
      "evm_analysis",
      "what_if_composite",
    ];
    for (const action of allActions) {
      expect(actions.has(action), `corpus must include at least one "${action}" case`).toBe(true);
    }
  });

  it("corpus has at least 40 entries", () => {
    // Raised from the original floor of 25 (WP2-D): the corpus grew to cover
    // adversarial/prompt-injection cases meaningfully, not just a token couple
    // of additions. Still a floor — the corpus is expected to keep growing
    // past this number, so this only guards against silently losing entries.
    expect(entries.length).toBeGreaterThanOrEqual(40);
  });
});

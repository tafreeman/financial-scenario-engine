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
 */

interface RawCorpusEntry {
  id: unknown;
  query: unknown;
  expected: unknown;
  expectedAlternatives?: unknown;
  notes?: unknown;
}

describe("intent-corpus — structural integrity", () => {
  const corpusPath = resolve(__dirname, "../evals/intent-corpus.json");
  const raw = JSON.parse(readFileSync(corpusPath, "utf-8")) as unknown;

  it("corpus file is a non-empty array", () => {
    expect(Array.isArray(raw)).toBe(true);
    expect((raw as unknown[]).length).toBe(30);
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

  it("corpus has at least 25 entries", () => {
    expect(entries.length).toBeGreaterThanOrEqual(25);
  });
});

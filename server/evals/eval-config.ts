/**
 * Committed configuration for the intent-parsing eval (server/evals/run-intent-eval.ts).
 *
 * Kept as its own module (rather than inline in the runner) so the accuracy
 * bar is a single, reviewable, git-tracked number living next to the corpus
 * it grades — bumping the corpus (server/evals/intent-corpus.json) and
 * bumping the bar are two separate, visible diffs.
 *
 * The threshold is intentionally NOT derived from any historical eval run:
 * it is a floor the team has agreed the intent parser must clear. Raise it
 * only after a deliberate accuracy improvement; lower it only with a documented
 * reason (e.g. a corpus change that makes cases harder).
 */

/**
 * Minimum acceptable action-accuracy (passCount / corpusSize) for
 * server/evals/intent-corpus.json, as a fraction in [0, 1].
 *
 * Provenance: no historical `npm run eval:intent` result artifact exists in
 * this repo to calibrate against (server/evals/results/ is gitignored and
 * empty, and no CI workflow has run this script). 0.85 is a conservative
 * starting floor, not a number backed by an observed run.
 *
 * ACTION REQUIRED: the first time this eval is run with real credentials
 * (`GITHUB_TOKEN=... npm run eval:intent`), replace this value with the
 * observed actionAccuracy from server/evals/results/latest.json (or a
 * deliberately-chosen floor just below it), so the gate reflects reality
 * rather than a guess. Re-raise it only after a deliberate accuracy
 * improvement; lower it only with a documented reason (e.g. a corpus change
 * that makes cases harder).
 */
export const INTENT_CORPUS_ACCURACY_THRESHOLD = 0.85;

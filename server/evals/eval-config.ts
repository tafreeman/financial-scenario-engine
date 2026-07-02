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
 *
 * ─── CALIBRATION PROCEDURE (for the PR that eventually changes this value) ──
 *
 * This value must not be changed by "feel" — a future accuracy-tuning PR
 * should be able to point at this procedure and the result artifact(s) it
 * produced as its justification, the same way this corpus's WP2-D expansion
 * (server/evals/intent-corpus.json — grown to a 12-action-covering,
 * adversarial/prompt-injection-inclusive corpus) made this an evidence-backed
 * decision instead of a guess:
 *
 *   1. Run the GATED eval (`EVAL_INTENT_GATED=1 GITHUB_TOKEN=... npm run
 *      eval:intent`, or trigger .github/workflows/real-model-eval.yml via
 *      workflow_dispatch / the "run-live-eval" PR label) at least N=5 times
 *      against the SAME corpus and SAME model/provider config
 *      (getAiConfig() — do not mix providers or models across runs in one
 *      calibration set). Keep each run's server/evals/results/latest.json
 *      artifact (rename or copy it out before the next run overwrites it —
 *      the file is gitignored and NOT retained between runs, and the
 *      real-model-eval.yml workflow already uploads each run's artifact via
 *      actions/upload-artifact, so pulling N historical runs from recent
 *      workflow runs is an alternative to N manual local runs).
 *   2. From those N runs, record the `actionAccuracy` (full-corpus,
 *      transport-errors-count-as-misses — see EvalSummary in
 *      run-intent-eval.ts) and — separately — the `categoryBreakdown` row
 *      for "adversarial" and the `actionAccuracyExcludingAdversarial` value,
 *      since the LLM is nondeterministic even at temperature 0 (retries,
 *      provider-side model updates, etc.) and the adversarial slice is
 *      expected to be measurably harder than the core slice — collapsing
 *      them into one number would hide that.
 *   3. Compute the observed accuracy DISTRIBUTION across the N runs (at
 *      minimum: min, median/p50, and the specific run-list — N=5 is too
 *      small for a rigorous percentile estimate, so treat "Xth percentile"
 *      loosely at this sample size, e.g. p50 ≈ median of 5 sorted values;
 *      grow N over time as more gated runs accumulate, e.g. from CI's
 *      nightly schedule, and recompute).
 *   4. Set the new threshold at: (a chosen low percentile of the full-corpus
 *      actionAccuracy distribution, e.g. p25 or the observed minimum) MINUS
 *      a safety margin (e.g. 0.05) to absorb ordinary LLM/provider
 *      variance without the gate flapping red on noise alone. Do NOT set the
 *      threshold at or above the observed mean/median — that guarantees
 *      roughly half of all future runs fail on variance alone.
 *   5. Document in the threshold-changing PR: the N run dates/artifact
 *      references, the observed distribution (min/median/chosen percentile),
 *      the margin applied, and the resulting number — so the number in this
 *      file is traceable back to evidence, not vibes. (Do not hardcode the
 *      observed distribution itself into this file or any doc — per the
 *      project's no-hardcoded-drift-prone-metrics rule, only the resulting
 *      threshold is committed; the evidence lives in the PR description and/or
 *      the retained result artifacts.)
 *   6. If a corpus change (e.g. adding more adversarial cases) measurably
 *      changes difficulty, re-run the N-run calibration rather than assuming
 *      the old threshold still applies — a harder corpus at the same
 *      threshold is a silent tightening of the gate; an easier corpus at the
 *      same threshold is a silent loosening.
 */
export const INTENT_CORPUS_ACCURACY_THRESHOLD = 0.85;

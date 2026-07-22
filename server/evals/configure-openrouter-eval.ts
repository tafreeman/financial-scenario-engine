/**
 * One-shot DB config writer that points the intent-eval harness at OpenRouter.
 *
 * server/evals/run-intent-eval.ts resolves provider/model/endpoint via the
 * SAME getAiConfig() / SQLite config table production uses (see that file's
 * module comment) — there is no separate "eval mode" override, by design.
 * The DB's seeded default provider is still "github" (server/db.ts
 * initSchema()) — that default is a product decision this script does not
 * change; it only affects the fresh SQLite DB this CI job's own checkout is
 * about to create (DB_PATH env var / default `data/finimpact.db` — see
 * server/db.ts).
 *
 * The scheduled/dispatched CI eval (.github/workflows/real-model-eval.yml)
 * needs to run against "openrouter" instead of the seeded "github" default,
 * because GitHub Models is fully retired 2026-07-30 (see README "LLM
 * Providers"). There is no running server in that job to PUT /api/config
 * against (the normal way an operator reconfigures the provider), so this
 * script calls setConfig() directly — same effect, no HTTP round trip.
 *
 * Usage (see .github/workflows/real-model-eval.yml):
 *   OPENROUTER_API_KEY=... [OPENROUTER_MODEL=...] npm run eval:configure-openrouter
 *
 * OPENROUTER_MODEL is optional — omit it to use DEFAULT_OPENROUTER_MODEL
 * (server/ai.ts). The workflow wires this to a workflow_dispatch input (or a
 * repo-level variable for scheduled runs) so the model can be swapped — e.g.
 * to a different ":free" model if the current one is rate-limited or
 * deprecated — without a code change.
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { setConfig } from "../db.js";
import { DEFAULT_OPENROUTER_MODEL } from "../ai.js";

const __filename = fileURLToPath(import.meta.url);

export function configureOpenRouterForEval(): void {
  const apiKey = (process.env.OPENROUTER_API_KEY || "").trim();
  const model = (process.env.OPENROUTER_MODEL || "").trim() || DEFAULT_OPENROUTER_MODEL;

  if (!apiKey) {
    // Not fatal here — run-intent-eval.ts's own upfront gate
    // (isProviderConfigured(), server/ai.ts) reports "provider_unconfigured"
    // and fails a gated run on its own. This just makes that downstream
    // failure clearly attributable to a missing secret rather than a
    // silent misconfiguration a reader has to dig for.
    console.error(
      "configure-openrouter-eval — OPENROUTER_API_KEY is empty; the eval run will report provider_unconfigured."
    );
  }

  setConfig("llm_provider", "openrouter");
  setConfig("openrouter_api_key", apiKey);
  setConfig("openrouter_model", model);

  console.log(`configure-openrouter-eval — DB configured: llm_provider=openrouter, openrouter_model=${model}`);
}

// Only run when executed directly (`tsx server/evals/configure-openrouter-eval.ts`
// / `npm run eval:configure-openrouter`), not when imported by a test —
// mirrors the direct-execution guard used by tests/e2e/reset-e2e-db.ts and
// server/evals/run-intent-eval.ts.
const isDirectExecution = process.argv[1] !== undefined && __filename === resolve(process.argv[1]);

if (isDirectExecution) {
  configureOpenRouterForEval();
}

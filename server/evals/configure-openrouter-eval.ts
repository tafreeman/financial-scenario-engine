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
 *
 * OPENROUTER_ENDPOINT is also optional and, when set, writes the
 * `openrouter_endpoint` DB config key (the SAME SSRF-validated key
 * PUT /api/config accepts — see server/ssrf.ts refineEndpointNoPrivateAsync;
 * this direct DB write is a trusted, operator-controlled local/CI script,
 * matching the existing precedent of the other setConfig() calls below, so it
 * is not re-validated here). Omitting it leaves getAiConfig()'s own default
 * (https://openrouter.ai/api/v1/chat/completions) unchanged. Intended use:
 * local verification runs that point the "openrouter" provider at an
 * OpenAI-compatible endpoint OTHER than OpenRouter itself (e.g. NVIDIA NIM's
 * https://integrate.api.nvidia.com/v1/chat/completions, serving the same
 * model family) to avoid burning OpenRouter's metered free-tier daily budget
 * while still exercising the exact "openrouter" provider code path.
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { setConfig } from "../db.js";
import { DEFAULT_OPENROUTER_MODEL } from "../ai.js";

const __filename = fileURLToPath(import.meta.url);

export function configureOpenRouterForEval(): void {
  const apiKey = (process.env.OPENROUTER_API_KEY || "").trim();
  const model = (process.env.OPENROUTER_MODEL || "").trim() || DEFAULT_OPENROUTER_MODEL;
  const endpoint = (process.env.OPENROUTER_ENDPOINT || "").trim();

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
  // Only write openrouter_endpoint when explicitly set — leaving the DB key
  // untouched otherwise preserves getAiConfig()'s own default endpoint
  // (https://openrouter.ai/api/v1/chat/completions). The scheduled/labeled-PR
  // nightly runs of real-model-eval.yml never set this (no `endpoint` input
  // on those triggers), so their behavior is unaffected; only a manual
  // workflow_dispatch run that selects a non-default `endpoint` choice sets it.
  if (endpoint) {
    setConfig("openrouter_endpoint", endpoint);
  }

  console.log(
    `configure-openrouter-eval — DB configured: llm_provider=openrouter, openrouter_model=${model}` +
      (endpoint ? `, openrouter_endpoint=${endpoint}` : "")
  );
}

// Only run when executed directly (`tsx server/evals/configure-openrouter-eval.ts`
// / `npm run eval:configure-openrouter`), not when imported by a test —
// mirrors the direct-execution guard used by tests/e2e/reset-e2e-db.ts and
// server/evals/run-intent-eval.ts.
const isDirectExecution = process.argv[1] !== undefined && __filename === resolve(process.argv[1]);

if (isDirectExecution) {
  configureOpenRouterForEval();
}

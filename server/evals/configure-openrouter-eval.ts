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
 *   OPENROUTER_API_KEY=... [OPENROUTER_MODEL=...] [OPENROUTER_EVAL_TIMEOUT_MS=...] npm run eval:configure-openrouter
 *
 * OPENROUTER_MODEL is optional — omit it to use DEFAULT_OPENROUTER_MODEL
 * (server/ai.ts). The workflow wires this to a workflow_dispatch input (or a
 * repo-level variable for scheduled runs) so the model can be swapped — e.g.
 * to a different ":free" model if the current one is rate-limited or
 * deprecated — without a code change.
 *
 * OPENROUTER_ENDPOINT is also optional and, when set, writes the
 * `openrouter_endpoint` DB config key — the SAME SSRF-validated key
 * PUT /api/config accepts. UNLIKE the other setConfig() calls below, this one
 * IS re-validated here (2026-07-22 security review, PR #49, MEDIUM): before
 * this fix, an operator/CI-controlled OPENROUTER_ENDPOINT value bypassed the
 * exact refinement PUT /api/config enforces (server/ssrf.ts
 * refineEndpointNoPrivateAsync), so a misconfigured or compromised env var
 * could point the "openrouter" provider's outbound requests (carrying the
 * OpenRouter API key) at a loopback/private/link-local host. The value is now
 * run through refineEndpointNoPrivateAsync before being written; on failure
 * this function sets a non-zero process.exitCode and logs a clear message
 * instead of writing the key. Omitting OPENROUTER_ENDPOINT entirely leaves
 * getAiConfig()'s own default (https://openrouter.ai/api/v1/chat/completions)
 * unchanged and skips validation. Intended use: local verification runs that
 * point the "openrouter" provider at an OpenAI-compatible endpoint OTHER than
 * OpenRouter itself (e.g. NVIDIA NIM's
 * https://integrate.api.nvidia.com/v1/chat/completions, serving the same
 * model family) to avoid burning OpenRouter's metered free-tier daily budget
 * while still exercising the exact "openrouter" provider code path.
 */
import { fileURLToPath } from "url";
import { resolve } from "path";
import { setConfig } from "../db.js";
import { DEFAULT_OPENROUTER_MODEL } from "../ai.js";
import { refineEndpointNoPrivateAsync, type DnsLookupAll } from "../ssrf.js";

const __filename = fileURLToPath(import.meta.url);

/**
 * Default per-request LLM timeout (ms) written for eval runs — deliberately
 * above server/ai.ts DEFAULT_LLM_TIMEOUT_MS (30s). A timed-out request is
 * never retried (ai.ts's RETRYABLE_STATUS covers HTTP statuses only), so with
 * the 30s default every provider stall counts as a hard miss against the
 * accuracy gate: the 2026-07-24 nightly (run 30074508441) failed its 85.0%
 * gate at 83.3% with 5 of its 8 misses being exactly-30s Ollama Cloud
 * timeouts, while every successful call completed in under ~8s. 90s rides
 * out those stalls; ai.ts parseTimeoutMs() clamps the value to
 * LLM_TIMEOUT_MAX_MS (120s) on read, so this can never exceed the server's
 * own ceiling. Like every other key this script writes, it lands in the CI
 * job's fresh SQLite DB only — the app's seeded defaults are unchanged.
 */
export const EVAL_DEFAULT_LLM_TIMEOUT_MS = 90_000;

/**
 * @param dnsLookup - Injectable DNS resolver forwarded to
 *   refineEndpointNoPrivateAsync (defaults to a real `dns.lookup` — see
 *   server/ssrf.ts). Tests pass a stub so no real DNS lookup happens.
 */
export async function configureOpenRouterForEval(dnsLookup?: DnsLookupAll): Promise<void> {
  const apiKey = (process.env.OPENROUTER_API_KEY || "").trim();
  const model = (process.env.OPENROUTER_MODEL || "").trim() || DEFAULT_OPENROUTER_MODEL;
  const endpoint = (process.env.OPENROUTER_ENDPOINT || "").trim();
  const timeoutEnv = (process.env.OPENROUTER_EVAL_TIMEOUT_MS || "").trim();
  const timeoutParsed = Number(timeoutEnv);
  const timeoutEnvValid = timeoutEnv !== "" && Number.isFinite(timeoutParsed) && timeoutParsed > 0;
  const timeoutMs = timeoutEnvValid ? Math.floor(timeoutParsed) : EVAL_DEFAULT_LLM_TIMEOUT_MS;
  if (timeoutEnv && !timeoutEnvValid) {
    console.error(
      `configure-openrouter-eval — OPENROUTER_EVAL_TIMEOUT_MS="${timeoutEnv}" is not a positive ` +
        `number of milliseconds; using the eval default ${EVAL_DEFAULT_LLM_TIMEOUT_MS}ms.`
    );
  }

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

  // SSRF-validate BEFORE writing anything endpoint-related, so a rejected
  // endpoint never partially lands in the DB. llm_provider/api_key/model are
  // still written unconditionally below (bad endpoint or not) — the run then
  // legitimately falls back to getAiConfig()'s own default endpoint, exactly
  // as if OPENROUTER_ENDPOINT had been left unset.
  if (endpoint) {
    const endpointIsSafe = await refineEndpointNoPrivateAsync(endpoint, dnsLookup);
    if (!endpointIsSafe) {
      console.error(
        `configure-openrouter-eval — OPENROUTER_ENDPOINT="${endpoint}" failed SSRF validation ` +
          "(must be https and must not resolve to a loopback/private/link-local host — see server/ssrf.ts) " +
          "— refusing to write it. Falling back to getAiConfig()'s default endpoint."
      );
      process.exitCode = 1;
      setConfig("llm_provider", "openrouter");
      setConfig("openrouter_api_key", apiKey);
      setConfig("openrouter_model", model);
      // The gated run still executes against the default endpoint on this
      // path, so it needs the eval timeout too.
      setConfig("llm_timeout_ms", String(timeoutMs));
      return;
    }
  }

  setConfig("llm_provider", "openrouter");
  setConfig("openrouter_api_key", apiKey);
  setConfig("openrouter_model", model);
  setConfig("llm_timeout_ms", String(timeoutMs));
  // Only write openrouter_endpoint when explicitly set AND validated above —
  // leaving the DB key untouched otherwise preserves getAiConfig()'s own
  // default endpoint (https://openrouter.ai/api/v1/chat/completions). The
  // scheduled/labeled-PR nightly runs of real-model-eval.yml never set this
  // (no `endpoint` input on those triggers), so their behavior is unaffected;
  // only a manual workflow_dispatch run that selects a non-default `endpoint`
  // choice sets it.
  if (endpoint) {
    setConfig("openrouter_endpoint", endpoint);
  }

  console.log(
    `configure-openrouter-eval — DB configured: llm_provider=openrouter, openrouter_model=${model}` +
      `, llm_timeout_ms=${timeoutMs}` +
      (endpoint ? `, openrouter_endpoint=${endpoint}` : "")
  );
}

// Only run when executed directly (`tsx server/evals/configure-openrouter-eval.ts`
// / `npm run eval:configure-openrouter`), not when imported by a test —
// mirrors the direct-execution guard used by tests/e2e/reset-e2e-db.ts and
// server/evals/run-intent-eval.ts.
const isDirectExecution = process.argv[1] !== undefined && __filename === resolve(process.argv[1]);

if (isDirectExecution) {
  configureOpenRouterForEval().catch((err: unknown) => {
    console.error(
      "configure-openrouter-eval — fatal error:",
      err instanceof Error ? err.message : String(err)
    );
    process.exit(1);
  });
}

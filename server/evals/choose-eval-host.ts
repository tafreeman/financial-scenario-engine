/**
 * Picks the OpenAI-compatible host the gated CI intent eval runs against
 * (.github/workflows/real-model-eval.yml, "Choose eval host" step).
 *
 * A manual run that names a host gets it. Otherwise — the nightly schedule, a
 * labeled PR, or a manual run left on "auto" — NVIDIA NIM's free tier is used
 * when NVIDIA_API_KEY is set and a one-token chat request to it answers HTTP
 * 200. A 429, a 503 or no answer at all is retried (NIM's free tier emits
 * capacity 503s — see server/ai.ts RETRYABLE_STATUS); anything else, or a
 * missing key, falls back to OpenRouter's free tier.
 *
 * Why this order: NIM passed this eval's gate at 95.8% (2026-07-22) and draws
 * on a free quota of its own. OpenRouter's free Nemotron pool is the fallback:
 * it does not reliably honor response_format (a nightly once scored 81.3% with
 * 9 invalid_json misses) and allows 50 requests a day without purchased
 * credits, so a run that falls back can fail the gate for host reasons. Ollama
 * Cloud passed at 89.6% but bills a paid plan's included usage, so it is never
 * picked automatically — only when a manual run names it.
 *
 * Only the host NAME is written to $GITHUB_OUTPUT (`endpoint=<name>`); the
 * workflow chooses the matching secret from that name, so no secret ever
 * passes through a step output.
 *
 * Usage: [EVAL_HOST=auto|nvidia-nim|openrouter|ollama-cloud] [NVIDIA_API_KEY=...] npm run eval:choose-host
 */
import { appendFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);

export const EVAL_HOSTS = ["nvidia-nim", "openrouter", "ollama-cloud"] as const;
export type EvalHost = (typeof EVAL_HOSTS)[number];

export const NIM_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
export const NIM_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
/** A cold NIM model can take a while to produce its first token. */
export const PROBE_TIMEOUT_MS = 60_000;
export const PROBE_ATTEMPTS = 3;
export const PROBE_RETRY_DELAY_MS = 15_000;
/** Statuses worth another try; 0 means no HTTP answer arrived at all. */
const RETRYABLE = new Set([0, 429, 503]);

/** HTTP status of one tiny chat request to NVIDIA NIM, or 0 when no answer arrived. */
export type Probe = (key: string) => Promise<number>;
export type Sleep = (ms: number) => Promise<void>;

export interface HostChoice {
  host: EvalHost;
  reason: string;
  /** True when "auto" wanted NVIDIA NIM but had to use OpenRouter. */
  fellBack: boolean;
}

export async function probeNim(key: string): Promise<number> {
  try {
    const response = await fetch(NIM_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: NIM_MODEL,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 8,
      }),
      redirect: "error", // never carry the key to another host
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.status;
  } catch {
    return 0;
  }
}

const wait: Sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export async function chooseEvalHost(
  requested: string | undefined,
  nvidiaKey: string | undefined,
  probe: Probe = probeNim,
  sleep: Sleep = wait
): Promise<HostChoice> {
  const choice = (requested ?? "").trim() || "auto";
  if ((EVAL_HOSTS as readonly string[]).includes(choice)) {
    return { host: choice as EvalHost, reason: "named by this manual run", fellBack: false };
  }
  if (choice !== "auto") {
    throw new Error(`unknown eval host "${choice}"; expected auto or ${EVAL_HOSTS.join(", ")}`);
  }
  const key = (nvidiaKey ?? "").trim();
  if (!key) {
    return { host: "openrouter", reason: "NVIDIA_API_KEY is not set", fellBack: true };
  }
  let status = 0;
  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
    status = await probe(key);
    if (status === 200) {
      return { host: "nvidia-nim", reason: "NVIDIA NIM answered the probe", fellBack: false };
    }
    if (!RETRYABLE.has(status) || attempt === PROBE_ATTEMPTS) break;
    await sleep(PROBE_RETRY_DELAY_MS);
  }
  const reason = status ? `NVIDIA NIM answered HTTP ${status}` : "NVIDIA NIM did not answer";
  return { host: "openrouter", reason, fellBack: true };
}

/** Chooses the host, logs it (as a GitHub Actions warning on a fallback) and writes the output. */
export async function runChooseEvalHost(
  env: Record<string, string | undefined> = process.env,
  probe: Probe = probeNim,
  sleep: Sleep = wait
): Promise<HostChoice> {
  const choice = await chooseEvalHost(env.EVAL_HOST, env.NVIDIA_API_KEY, probe, sleep);
  const prefix = choice.fellBack ? "::warning::" : "";
  console.log(`${prefix}choose-eval-host — host: ${choice.host} (${choice.reason})`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `endpoint=${choice.host}\n`);
  return choice;
}

// Only run when executed directly (`npm run eval:choose-host`), not when imported
// by a test — the same direct-execution guard configure-openrouter-eval.ts uses.
const isDirectExecution = process.argv[1] !== undefined && __filename === resolve(process.argv[1]);

if (isDirectExecution) {
  runChooseEvalHost().catch((err: unknown) => {
    console.error("choose-eval-host — fatal error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

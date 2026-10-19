/**
 * Picks the OpenAI-compatible host the gated CI intent eval runs against
 * (.github/workflows/real-model-eval.yml, "Choose eval host" step).
 *
 * A manual run that names a host gets it. Otherwise — the nightly schedule, a
 * labeled PR, or a manual run left on "auto" — Ollama Cloud is used.
 *
 * Why Ollama Cloud: the default model there (beam:cloud) passed this eval's gate
 * at 91.7% (2026-10-18), while NVIDIA NIM's Nemotron failed it on 13 of 15
 * nightlies in the preceding two weeks (invalid_json misses, 66.7-85.4%) and
 * OpenRouter's free Nemotron pool did worse. The cost is that Ollama Cloud draws
 * on a paid plan's included usage; NVIDIA NIM and OpenRouter stay available as
 * manual choices.
 *
 * There is no probe or fallback: a missing OLLAMA_CLOUD_API_KEY fails fast in
 * the next step (isProviderConfigured()'s "provider_unconfigured" gate) instead
 * of silently scoring a different host.
 *
 * Only the host NAME is written to $GITHUB_OUTPUT (`endpoint=<name>`); the
 * workflow chooses the matching secret from that name, so no secret ever
 * passes through a step output.
 *
 * Usage: [EVAL_HOST=auto|nvidia-nim|openrouter|ollama-cloud] npm run eval:choose-host
 */
import { appendFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);

export const EVAL_HOSTS = ["nvidia-nim", "openrouter", "ollama-cloud"] as const;
export type EvalHost = (typeof EVAL_HOSTS)[number];

/** The host "auto" resolves to. */
export const DEFAULT_EVAL_HOST: EvalHost = "ollama-cloud";

export interface HostChoice {
  host: EvalHost;
  reason: string;
}

export function chooseEvalHost(requested: string | undefined): HostChoice {
  const choice = (requested ?? "").trim() || "auto";
  if ((EVAL_HOSTS as readonly string[]).includes(choice)) {
    return { host: choice as EvalHost, reason: "named by this manual run" };
  }
  if (choice !== "auto") {
    throw new Error(`unknown eval host "${choice}"; expected auto or ${EVAL_HOSTS.join(", ")}`);
  }
  return { host: DEFAULT_EVAL_HOST, reason: "default for scheduled, labeled-PR and auto runs" };
}

/** Chooses the host, logs it and writes the output. */
export function runChooseEvalHost(
  env: Record<string, string | undefined> = process.env
): HostChoice {
  const choice = chooseEvalHost(env.EVAL_HOST);
  console.log(`choose-eval-host — host: ${choice.host} (${choice.reason})`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `endpoint=${choice.host}\n`);
  return choice;
}

// Only run when executed directly (`npm run eval:choose-host`), not when imported
// by a test — the same direct-execution guard configure-openrouter-eval.ts uses.
const isDirectExecution = process.argv[1] !== undefined && __filename === resolve(process.argv[1]);

if (isDirectExecution) {
  try {
    runChooseEvalHost();
  } catch (err: unknown) {
    console.error("choose-eval-host — fatal error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/**
 * Provider-specific Settings presentation, kept out of the JSX so the mapping
 * from provider → panel heading + DB config keys is ONE testable source of
 * truth rather than a set of ternaries scattered through the render tree.
 *
 * Why this module exists: SettingsPanel used a hard binary `isOllama` toggle,
 * so selecting "openrouter" — a provider server/ai.ts has fully supported
 * since getAiConfig() grew its `provider === "openrouter"` branch — rendered
 * the *GitHub Models* panel and read/wrote `model` / `endpoint` /
 * `github_pat` instead of the `openrouter_model` / `openrouter_endpoint` /
 * `openrouter_api_key` keys the server actually reads. The server behaved
 * correctly throughout, so the mismatch was silent: the UI simply edited keys
 * nothing consumed. PR #60 (which moved the default provider off the retiring
 * GitHub Models) cited exactly this gap as its reason for defaulting to
 * "ollama" rather than "openrouter".
 *
 * There is no client-side test runner in this repo beyond the root Vitest
 * project, so keeping this logic pure (no React, no DOM) is what makes it
 * coverable at all — see the sibling __tests__/provider-config.test.ts and
 * the `client/src/**` entry in vitest.config.ts's include glob.
 */

/**
 * Mirrors `LlmProvider` in server/ai.ts and the `llm_provider` enum in
 * server/routes.ts's CONFIG_WRITABLE_KEYS. All three must stay in sync — the
 * server rejects any other value with a 400.
 */
export type LlmProvider = "github" | "ollama" | "openrouter";

/** Provider buttons, in the order the Settings picker renders them. */
export const LLM_PROVIDERS: readonly LlmProvider[] = ["github", "ollama", "openrouter"];

/**
 * Default provider for a database that has no `llm_provider` row yet. Matches
 * the seed in server/db.ts and getAiConfig()'s fallback — GitHub Models
 * retires 2026-07-30, so a fresh install must not land on it.
 */
export const DEFAULT_LLM_PROVIDER: LlmProvider = "ollama";

/** Narrow an untrusted config string (e.g. from GET /api/config) to a provider. */
export function isLlmProvider(value: string): value is LlmProvider {
  return (LLM_PROVIDERS as readonly string[]).includes(value);
}

export interface ProviderPanel {
  /** Button label in the provider picker. */
  label: string;
  /** Heading above this provider's model/endpoint inputs. */
  heading: string;
  /** DB config key holding this provider's model id. */
  modelKey: "model" | "ollama_model" | "openrouter_model";
  /** DB config key holding this provider's chat-completions endpoint. */
  endpointKey: "endpoint" | "ollama_endpoint" | "openrouter_endpoint";
  /**
   * DB config key holding this provider's credential, or null when it needs
   * none. Secrets are write-only from the UI's perspective: GET /api/config
   * returns them masked under a `*_masked` key, so a blank input must leave
   * the stored value alone (see buildConfigUpdates below).
   */
  secretKey: "github_pat" | "openrouter_api_key" | null;
  /** Masked-secret key GET /api/config returns for `secretKey`, when it has one. */
  maskedSecretKey: "github_pat_masked" | "openrouter_api_key_masked" | null;
  /** Value getAiConfig() falls back to when the model row is empty. */
  defaultModel: string;
  /** Value getAiConfig() falls back to when the endpoint row is empty. */
  defaultEndpoint: string;
}

/**
 * Defaults here MUST match getAiConfig() in server/ai.ts. If they drift, the
 * Settings panel shows one value while the engine uses another.
 */
export const PROVIDER_PANELS: Record<LlmProvider, ProviderPanel> = {
  github: {
    label: "GitHub Models",
    heading: "GitHub Models Configuration",
    modelKey: "model",
    endpointKey: "endpoint",
    secretKey: "github_pat",
    maskedSecretKey: "github_pat_masked",
    defaultModel: "openai/gpt-4.1",
    defaultEndpoint: "https://models.github.ai/inference/chat/completions",
  },
  ollama: {
    label: "Ollama (Local)",
    heading: "Ollama Configuration",
    modelKey: "ollama_model",
    endpointKey: "ollama_endpoint",
    // Ollama's OpenAI-compatible endpoint needs no auth header at all — see
    // the header-building block in server/ai.ts's chatRequest().
    secretKey: null,
    maskedSecretKey: null,
    defaultModel: "llama3.2",
    defaultEndpoint: "http://localhost:11434/v1/chat/completions",
  },
  openrouter: {
    label: "OpenRouter",
    heading: "OpenRouter Configuration",
    modelKey: "openrouter_model",
    endpointKey: "openrouter_endpoint",
    secretKey: "openrouter_api_key",
    maskedSecretKey: "openrouter_api_key_masked",
    // Mirrors DEFAULT_OPENROUTER_MODEL in server/ai.ts. A ":free" model-id
    // suffix on OpenRouter means no-charge inference.
    defaultModel: "nvidia/nemotron-3-ultra-550b-a55b:free",
    defaultEndpoint: "https://openrouter.ai/api/v1/chat/completions",
  },
};

/** Every editable Settings field, flattened out of SettingsPanel's useState calls. */
export interface ProviderFieldValues {
  llmProvider: LlmProvider;
  model: string;
  endpoint: string;
  ollamaModel: string;
  ollamaEndpoint: string;
  openrouterModel: string;
  openrouterEndpoint: string;
  temperature: string;
  maxTokens: string;
  /** Newly typed GitHub PAT. Blank means "leave the stored one alone". */
  githubPat: string;
  /** Newly typed OpenRouter API key. Blank means "leave the stored one alone". */
  openrouterApiKey: string;
}

/**
 * Build the PUT /api/config body for a Save.
 *
 * Every provider's non-secret keys are written on every save, not just the
 * selected provider's. That is deliberate and pre-existing: the panel holds
 * all three providers' values in state simultaneously, so writing them all
 * keeps an edit made under one provider from being silently dropped when the
 * user switches to another before hitting Save. tests/e2e/ui/app.spec.ts's
 * "saves model configuration and persists across page reload" depends on it —
 * its cleanup step restores the GitHub `model` value and *then* switches to
 * Ollama before saving.
 *
 * Secrets are the exception: they are only included when the user actually
 * typed one. GET /api/config never returns a raw secret (server/routes.ts
 * masks both `github_pat` and `openrouter_api_key`), so writing a blank input
 * back would erase a working credential.
 *
 * Every key returned here is in server/routes.ts's CONFIG_WRITABLE_KEYS
 * allowlist; that schema is `.strict()`, so an unknown key fails the whole
 * request with a 400.
 */
export function buildConfigUpdates(fields: ProviderFieldValues): Record<string, string> {
  const updates: Record<string, string> = {
    llm_provider: fields.llmProvider,
    model: fields.model,
    endpoint: fields.endpoint,
    ollama_model: fields.ollamaModel,
    ollama_endpoint: fields.ollamaEndpoint,
    openrouter_model: fields.openrouterModel,
    openrouter_endpoint: fields.openrouterEndpoint,
    temperature: fields.temperature,
    max_tokens: fields.maxTokens,
  };
  if (fields.githubPat.trim()) updates.github_pat = fields.githubPat.trim();
  if (fields.openrouterApiKey.trim()) {
    updates.openrouter_api_key = fields.openrouterApiKey.trim();
  }
  return updates;
}

import { describe, it, expect } from "vitest";
import {
  LLM_PROVIDERS,
  PROVIDER_PANELS,
  buildConfigUpdates,
  isLlmProvider,
  type LlmProvider,
  type ProviderFieldValues,
} from "../provider-config";

/**
 * Regression cover for the bug this module was extracted to fix: SettingsPanel
 * used a hard binary `isOllama` toggle, so provider "openrouter" fell through
 * to the GitHub Models branch — wrong heading, and reads/writes against
 * `model` / `endpoint` / `github_pat` instead of the `openrouter_*` keys
 * getAiConfig() actually reads. Nothing crashed, so the mismatch was silent.
 */

/** Field values with nothing typed into either secret input. */
const baseFields: ProviderFieldValues = {
  llmProvider: "openrouter",
  model: "openai/gpt-4.1",
  endpoint: "https://models.github.ai/inference/chat/completions",
  ollamaModel: "llama3.2",
  ollamaEndpoint: "http://localhost:11434/v1/chat/completions",
  openrouterModel: "nvidia/nemotron-3-ultra-550b-a55b:free",
  openrouterEndpoint: "https://openrouter.ai/api/v1/chat/completions",
  temperature: "0.2",
  maxTokens: "2000",
  githubPat: "",
  openrouterApiKey: "",
};

describe("PROVIDER_PANELS", () => {
  it("gives openrouter its own panel, not the GitHub Models one", () => {
    const openrouter = PROVIDER_PANELS.openrouter;

    expect(openrouter.heading).toBe("OpenRouter Configuration");
    expect(openrouter.heading).not.toBe(PROVIDER_PANELS.github.heading);
  });

  it("binds openrouter to the openrouter_* config keys getAiConfig() reads", () => {
    expect(PROVIDER_PANELS.openrouter).toMatchObject({
      modelKey: "openrouter_model",
      endpointKey: "openrouter_endpoint",
      secretKey: "openrouter_api_key",
      maskedSecretKey: "openrouter_api_key_masked",
    });
  });

  it("keeps GitHub Models fully selectable and on its own keys", () => {
    expect(PROVIDER_PANELS.github).toMatchObject({
      heading: "GitHub Models Configuration",
      modelKey: "model",
      endpointKey: "endpoint",
      secretKey: "github_pat",
    });
    expect(LLM_PROVIDERS).toContain("github");
  });

  it("gives every provider a distinct set of config keys", () => {
    const modelKeys = LLM_PROVIDERS.map((p) => PROVIDER_PANELS[p].modelKey);
    const endpointKeys = LLM_PROVIDERS.map((p) => PROVIDER_PANELS[p].endpointKey);
    const headings = LLM_PROVIDERS.map((p) => PROVIDER_PANELS[p].heading);

    expect(new Set(modelKeys).size).toBe(LLM_PROVIDERS.length);
    expect(new Set(endpointKeys).size).toBe(LLM_PROVIDERS.length);
    expect(new Set(headings).size).toBe(LLM_PROVIDERS.length);
  });

  it("has a panel for every provider the server accepts", () => {
    // Mirrors LlmProvider in server/ai.ts and the llm_provider enum in
    // server/routes.ts. A provider added there without a panel here would
    // reintroduce exactly this bug.
    expect([...LLM_PROVIDERS].sort()).toEqual(["github", "ollama", "openrouter"]);
    for (const provider of LLM_PROVIDERS) {
      expect(PROVIDER_PANELS[provider]).toBeDefined();
    }
  });

  it("marks ollama as needing no credential", () => {
    expect(PROVIDER_PANELS.ollama.secretKey).toBeNull();
    expect(PROVIDER_PANELS.ollama.maskedSecretKey).toBeNull();
  });
});

describe("isLlmProvider", () => {
  it("accepts the three server-supported providers", () => {
    expect(isLlmProvider("openrouter")).toBe(true);
    expect(isLlmProvider("github")).toBe(true);
    expect(isLlmProvider("ollama")).toBe(true);
  });

  it("rejects anything else", () => {
    // "nvidia" is reachable only through the openrouter branch with a custom
    // endpoint — it is not a provider literal (see server/ai.ts).
    expect(isLlmProvider("nvidia")).toBe(false);
    expect(isLlmProvider("")).toBe(false);
  });
});

describe("buildConfigUpdates", () => {
  it("writes the openrouter_* keys when openrouter is selected", () => {
    const updates = buildConfigUpdates({
      ...baseFields,
      llmProvider: "openrouter",
      openrouterModel: "meta-llama/llama-3.3-70b-instruct:free",
      openrouterEndpoint: "https://openrouter.ai/api/v1/chat/completions",
      openrouterApiKey: "sk-or-v1-secret",
    });

    expect(updates.llm_provider).toBe("openrouter");
    expect(updates.openrouter_model).toBe("meta-llama/llama-3.3-70b-instruct:free");
    expect(updates.openrouter_endpoint).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(updates.openrouter_api_key).toBe("sk-or-v1-secret");
  });

  it("does not divert the openrouter model/key onto the GitHub keys", () => {
    // The actual regression: with the old binary toggle, editing the model
    // under "openrouter" wrote `model` and the credential wrote `github_pat`.
    const updates = buildConfigUpdates({
      ...baseFields,
      llmProvider: "openrouter",
      openrouterModel: "meta-llama/llama-3.3-70b-instruct:free",
      openrouterApiKey: "sk-or-v1-secret",
    });

    expect(updates.model).not.toBe("meta-llama/llama-3.3-70b-instruct:free");
    expect(updates.endpoint).not.toBe(updates.openrouter_endpoint);
    expect(updates.github_pat).toBeUndefined();
  });

  it("omits each secret when its input is blank or whitespace", () => {
    const updates = buildConfigUpdates({
      ...baseFields,
      githubPat: "   ",
      openrouterApiKey: "",
    });

    // GET /api/config only ever returns these masked, so writing a blank
    // input back would erase a working credential.
    expect(updates).not.toHaveProperty("openrouter_api_key");
    expect(updates).not.toHaveProperty("github_pat");
  });

  it("trims a pasted secret before sending it", () => {
    const updates = buildConfigUpdates({
      ...baseFields,
      openrouterApiKey: "  sk-or-v1-secret  ",
    });

    expect(updates.openrouter_api_key).toBe("sk-or-v1-secret");
  });

  it("persists every provider's fields regardless of which is selected", () => {
    // Pre-existing behavior the e2e suite depends on: the panel holds all
    // three providers' values at once, so an edit made under one provider is
    // not dropped by switching to another before saving.
    const updates = buildConfigUpdates({ ...baseFields, llmProvider: "ollama" });

    expect(updates.model).toBe(baseFields.model);
    expect(updates.ollama_model).toBe(baseFields.ollamaModel);
    expect(updates.openrouter_model).toBe(baseFields.openrouterModel);
  });

  it("only emits keys server/routes.ts allowlists", () => {
    // CONFIG_WRITABLE_KEYS is .strict() — one unknown key 400s the whole save.
    const allowed = new Set([
      "github_pat", "model", "endpoint", "temperature", "max_tokens",
      "llm_provider", "ollama_model", "ollama_endpoint", "llm_timeout_ms",
      "openrouter_api_key", "openrouter_model", "openrouter_endpoint",
    ]);
    const updates = buildConfigUpdates({
      ...baseFields,
      githubPat: "github_pat_x",
      openrouterApiKey: "sk-or-v1-secret",
    });

    for (const key of Object.keys(updates)) {
      expect(allowed).toContain(key);
    }
  });

  it("sends the selected provider verbatim for every provider", () => {
    for (const provider of LLM_PROVIDERS) {
      const updates = buildConfigUpdates({ ...baseFields, llmProvider: provider });
      expect(updates.llm_provider).toBe(provider satisfies LlmProvider);
    }
  });
});

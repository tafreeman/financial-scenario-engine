/**
 * Tests for server/models-catalog.ts — live GitHub Models catalog discovery
 * with a curated fallback.
 *
 * listModels() resolves a token via resolveGitHubToken() (server/ai.ts). Under
 * vitest the gh-CLI fallback is disabled, so a token is present ONLY when a test
 * sets github_pat (or GITHUB_TOKEN). fetch and the clock are injected so no test
 * touches the real network.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  listModels,
  parseCatalog,
  FALLBACK_MODELS,
  CATALOG_URL,
  _resetModelCache,
} from "../models-catalog.js";
import { getConfig, setConfig } from "../db.js";

let savedPat: string;
let savedEnv: string | undefined;

beforeEach(() => {
  savedPat = getConfig("github_pat");
  savedEnv = process.env.GITHUB_TOKEN;
  _resetModelCache();
});

afterEach(() => {
  setConfig("github_pat", savedPat);
  if (savedEnv === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = savedEnv;
  _resetModelCache();
  vi.restoreAllMocks();
});

describe("parseCatalog", () => {
  it("maps id/name/publisher and drops entries without an id", () => {
    const models = parseCatalog([
      { id: "openai/gpt-4.1", name: "OpenAI GPT-4.1", publisher: "OpenAI", supported_output_modalities: ["text"] },
      { name: "no id here", publisher: "X" },
    ]);
    expect(models).toEqual([{ id: "openai/gpt-4.1", name: "OpenAI GPT-4.1", publisher: "OpenAI" }]);
  });

  it("filters out embeddings-only models but keeps entries missing the modality field", () => {
    const models = parseCatalog([
      {
        id: "openai/text-embedding-3-large",
        name: "Embeddings",
        publisher: "OpenAI",
        supported_output_modalities: ["embeddings"],
      },
      { id: "meta/llama-3.3-70b-instruct", name: "Llama", publisher: "Meta" }, // no field → kept
    ]);
    expect(models.map((m) => m.id)).toEqual(["meta/llama-3.3-70b-instruct"]);
  });

  it("falls back to id when name is missing and returns [] for non-arrays", () => {
    expect(parseCatalog([{ id: "a/b", publisher: "P" }])).toEqual([{ id: "a/b", name: "a/b", publisher: "P" }]);
    expect(parseCatalog({} as unknown)).toEqual([]);
    expect(parseCatalog(null)).toEqual([]);
  });
});

describe("listModels — live catalog with fallback", () => {
  it("returns the live catalog list when the fetch succeeds", async () => {
    setConfig("github_pat", "pat-present");
    const fetchStub = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "openai/gpt-4.1", name: "OpenAI GPT-4.1", publisher: "OpenAI", supported_output_modalities: ["text"] },
      ],
    });

    const result = await listModels(fetchStub as unknown as typeof fetch, () => 1_000);

    expect(result.source).toBe("catalog");
    expect(result.models).toEqual([{ id: "openai/gpt-4.1", name: "OpenAI GPT-4.1", publisher: "OpenAI" }]);
    expect(fetchStub).toHaveBeenCalledWith(
      CATALOG_URL,
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });

  it("degrades to the curated fallback on a non-200 response", async () => {
    setConfig("github_pat", "pat-present");
    const fetchStub = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });

    const result = await listModels(fetchStub as unknown as typeof fetch, () => 2_000);

    expect(result.source).toBe("fallback");
    expect(result.models).toEqual(FALLBACK_MODELS);
  });

  it("returns the fallback WITHOUT fetching when no token is available", async () => {
    setConfig("github_pat", "");
    delete process.env.GITHUB_TOKEN; // gh fallback disabled under vitest → no token
    const fetchStub = vi.fn();

    const result = await listModels(fetchStub as unknown as typeof fetch, () => 3_000);

    expect(result.source).toBe("fallback");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("serves a cached catalog result within the TTL without re-fetching", async () => {
    setConfig("github_pat", "pat-present");
    const fetchStub = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "openai/gpt-4o", name: "GPT-4o", publisher: "OpenAI", supported_output_modalities: ["text"] },
      ],
    });

    await listModels(fetchStub as unknown as typeof fetch, () => 10_000);
    await listModels(fetchStub as unknown as typeof fetch, () => 20_000); // +10s < 5min TTL

    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});

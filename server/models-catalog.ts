/**
 * GitHub Models catalog discovery.
 *
 * Replaces the previously-hardcoded Settings model dropdown with the live list
 * served by the GitHub Models catalog:
 *
 *   GET https://models.github.ai/catalog/models
 *
 * The catalog `id` field ("openai/gpt-4.1") is exactly the publisher/model
 * string the inference endpoint expects — cross-checked against `gh models list`
 * and the runtime probe in the agentic-runtime-platform — so a discovered id can
 * be stored as the `model` config value verbatim.
 *
 * When the catalog can't be reached (no token, offline, non-200, or a parse
 * failure) we degrade to a curated static list so the dropdown is never empty.
 * Results are cached in-process for CATALOG_CACHE_TTL_MS so repeated Settings
 * loads don't re-hit the network (or the gh CLI behind resolveGitHubToken).
 */

import { resolveGitHubToken } from "./ai.js";

/** A single selectable model, shaped for the Settings dropdown. */
export interface ModelInfo {
  /** publisher/model id, ready to store as the `model` config value. */
  id: string;
  /** Human-readable label (falls back to id when the catalog omits a name). */
  name: string;
  /** Publisher/vendor, e.g. "OpenAI" (empty when unknown). */
  publisher: string;
}

export interface ModelListResult {
  models: ModelInfo[];
  /** "catalog" = live GitHub list; "fallback" = curated static list. */
  source: "catalog" | "fallback";
}

/** Live GitHub Models catalog endpoint (same host as inference). */
export const CATALOG_URL = "https://models.github.ai/catalog/models";

/** Wall-clock cap for the catalog request (ms). */
const CATALOG_TIMEOUT_MS = 8_000;

/** In-process cache TTL for the resolved model list (ms). */
const CATALOG_CACHE_TTL_MS = 5 * 60_000;

/**
 * Curated fallback list — a stable subset of chat-capable GitHub Models, used
 * only when the live catalog is unavailable. Ids are in publisher/model form so
 * they work against the inference endpoint unchanged.
 */
export const FALLBACK_MODELS: ModelInfo[] = [
  { id: "openai/gpt-4.1", name: "OpenAI GPT-4.1", publisher: "OpenAI" },
  { id: "openai/gpt-4.1-mini", name: "OpenAI GPT-4.1-mini", publisher: "OpenAI" },
  { id: "openai/gpt-4o", name: "OpenAI GPT-4o", publisher: "OpenAI" },
  { id: "openai/gpt-4o-mini", name: "OpenAI GPT-4o mini", publisher: "OpenAI" },
  { id: "openai/gpt-5", name: "OpenAI gpt-5", publisher: "OpenAI" },
  { id: "openai/gpt-5-mini", name: "OpenAI gpt-5-mini", publisher: "OpenAI" },
  { id: "openai/o4-mini", name: "OpenAI o4-mini", publisher: "OpenAI" },
  { id: "meta/llama-3.3-70b-instruct", name: "Llama-3.3-70B-Instruct", publisher: "Meta" },
  { id: "microsoft/phi-4", name: "Phi-4", publisher: "Microsoft" },
  { id: "mistral-ai/mistral-medium-2505", name: "Mistral Medium 3 (25.05)", publisher: "Mistral AI" },
  { id: "deepseek/deepseek-r1", name: "DeepSeek-R1", publisher: "DeepSeek" },
  { id: "cohere/cohere-command-a", name: "Cohere Command A", publisher: "Cohere" },
];

interface RawCatalogEntry {
  id?: unknown;
  name?: unknown;
  publisher?: unknown;
  supported_output_modalities?: unknown;
}

/**
 * Keep only text-output (chat) models. The catalog also lists embeddings-only
 * models (e.g. text-embedding-3-*), which would break the chat UI if selected.
 * Entries missing the field are kept (fail-open) rather than silently dropped.
 */
function isChatModel(entry: RawCatalogEntry): boolean {
  const mods = entry.supported_output_modalities;
  if (!Array.isArray(mods)) return true;
  return mods.includes("text");
}

/** Parse + filter + sort the raw catalog payload into ModelInfo[]. */
export function parseCatalog(raw: unknown): ModelInfo[] {
  if (!Array.isArray(raw)) return [];
  const models: ModelInfo[] = [];
  for (const entry of raw as RawCatalogEntry[]) {
    if (!entry || typeof entry.id !== "string" || entry.id.length === 0) continue;
    if (!isChatModel(entry)) continue;
    const name =
      typeof entry.name === "string" && entry.name.length > 0 ? entry.name : entry.id;
    const publisher = typeof entry.publisher === "string" ? entry.publisher : "";
    models.push({ id: entry.id, name, publisher });
  }
  models.sort((a, b) => a.publisher.localeCompare(b.publisher) || a.id.localeCompare(b.id));
  return models;
}

let cache: { at: number; result: ModelListResult } | null = null;

/** Test seam: clear the in-process catalog cache. */
export function _resetModelCache(): void {
  cache = null;
}

function fallbackResult(): ModelListResult {
  return { models: FALLBACK_MODELS, source: "fallback" };
}

/**
 * Resolve the model list for the Settings dropdown: the live GitHub catalog when
 * reachable, else the curated fallback. `fetchImpl`/`now` are injectable so the
 * tests stay hermetic.
 *
 * Never throws — every failure path degrades to the fallback list so a dropdown
 * fetch can rely on a well-formed result.
 */
export async function listModels(
  fetchImpl: typeof fetch = globalThis.fetch,
  now: () => number = Date.now,
): Promise<ModelListResult> {
  const ts = now();
  if (cache && ts - cache.at < CATALOG_CACHE_TTL_MS) return cache.result;

  const token = resolveGitHubToken();
  // No token → return the fallback WITHOUT caching, so a freshly-added PAT (or a
  // fresh `gh auth login`) takes effect on the very next call rather than after
  // the cache TTL.
  if (!token) return fallbackResult();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetchImpl(CATALOG_URL, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: controller.signal,
        // A catalog host must never redirect us elsewhere with the token attached.
        redirect: "error",
      });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) throw new Error(`catalog HTTP ${resp.status}`);
    const models = parseCatalog(await resp.json());
    if (models.length === 0) throw new Error("catalog returned no usable models");

    const result: ModelListResult = { models, source: "catalog" };
    cache = { at: ts, result };
    return result;
  } catch {
    // Any failure (network, timeout, non-200, parse) → curated fallback. Cache it
    // so a persistently-down endpoint isn't hammered on every dropdown load.
    const result = fallbackResult();
    cache = { at: ts, result };
    return result;
  }
}

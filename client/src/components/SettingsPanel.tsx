import { useState, useEffect } from "react";
import { Save, CheckCircle, XCircle, Key, Cpu, Link, Shield, Server } from "lucide-react";
import { api, type ModelInfo } from "../api";

/** Default model highlighted in the picker. Matches the DB seed in server/db.ts. */
const RECOMMENDED_MODEL = "openai/gpt-4.1";

export default function SettingsPanel() {
  const [config, setConfig] = useState<Record<string, string>>({});
  const [pat, setPat] = useState("");
  const [apiToken, setApiToken] = useState(
    // Pre-fill from localStorage so the field shows the current stored value.
    () => { try { return localStorage.getItem("app_api_token") ?? ""; } catch { return ""; } }
  );
  // Matches the new server-side default in server/db.ts / server/ai.ts —
  // GitHub Models retires 2026-07-30. See db.ts for why "ollama" (not
  // "openrouter") replaced "github" as the default: this panel has no UI
  // branch for "openrouter" at all (isOllama below is a hard binary toggle),
  // so an "ollama" default keeps this initial value consistent with what the
  // panel actually renders.
  const [llmProvider, setLlmProvider] = useState("ollama");
  const [model, setModel] = useState("openai/gpt-4.1");
  const [endpoint, setEndpoint] = useState("https://models.github.ai/inference/chat/completions");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelSource, setModelSource] = useState<"catalog" | "fallback" | "">("");
  const [ollamaModel, setOllamaModel] = useState("llama3.2");
  const [ollamaEndpoint, setOllamaEndpoint] = useState("http://localhost:11434/v1/chat/completions");
  const [temperature, setTemperature] = useState("0.2");
  const [maxTokens, setMaxTokens] = useState("2000");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    api.getConfig().then((c) => {
      setConfig(c);
      setLlmProvider(c.llm_provider || "github");
      setModel(c.model || "openai/gpt-4.1");
      setEndpoint(c.endpoint || "https://models.github.ai/inference/chat/completions");
      setOllamaModel(c.ollama_model || "llama3.2");
      setOllamaEndpoint(c.ollama_endpoint || "http://localhost:11434/v1/chat/completions");
      setTemperature(c.temperature || "0.2");
      setMaxTokens(c.max_tokens || "2000");
    });
    // Populate the model picker from the live GitHub Models catalog (server
    // degrades to a curated fallback when the catalog is unreachable, so this
    // resolves to a usable list even offline / before a token is configured).
    api
      .getModels()
      .then((r) => {
        setModels(r.models);
        setModelSource(r.source);
      })
      .catch(() => setModelSource("fallback"));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);

    // Persist the API token to localStorage so all subsequent requests include
    // the x-app-token header (see client/src/api.ts getApiToken).
    // This must happen BEFORE api.updateConfig() because that call itself
    // requires the token to be present in the header.
    if (apiToken.trim()) {
      try { localStorage.setItem("app_api_token", apiToken.trim()); } catch { /* ignore */ }
    }

    const updates: Record<string, string> = {
      llm_provider: llmProvider,
      model, endpoint,
      ollama_model: ollamaModel, ollama_endpoint: ollamaEndpoint,
      temperature, max_tokens: maxTokens,
    };
    if (pat.trim()) updates.github_pat = pat.trim();
    await api.updateConfig(updates);
    setSaving(false);
    setSaved(true);
    setPat("");
    // Refresh config display
    api.getConfig().then(setConfig);
    setTimeout(() => setSaved(false), 3000);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.runScenarioV3("What is the current burn rate?");
      if (result.error) {
        setTestResult({ ok: false, message: result.error });
      } else if (result.content) {
        setTestResult({ ok: true, message: `Connected to ${result.model}` });
      }
    } catch (e: unknown) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  const isOllama = llmProvider === "ollama";

  return (
    <div className="max-w-2xl space-y-6">
      {/* LLM Provider Selection */}
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-4">
          <Server size={16} className="text-navy-700" />
          <h2 className="text-sm font-semibold text-navy-800">LLM Provider</h2>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => setLlmProvider("github")}
            className={`p-3 rounded-lg border-2 text-left transition-colors ${
              !isOllama
                ? "border-navy-700 bg-navy-50"
                : "border-steel-200 hover:border-steel-300"
            }`}
          >
            <p className="text-sm font-semibold text-navy-800">GitHub Models</p>
            <p className="text-[10px] text-steel-500 mt-0.5">Cloud API — requires PAT</p>
            <p className="text-[10px] text-amber-600 mt-0.5">Anonymized context sent to cloud</p>
          </button>
          <button
            onClick={() => setLlmProvider("ollama")}
            className={`p-3 rounded-lg border-2 text-left transition-colors ${
              isOllama
                ? "border-emerald-500 bg-emerald-50"
                : "border-steel-200 hover:border-steel-300"
            }`}
          >
            <p className="text-sm font-semibold text-navy-800">Ollama (Local)</p>
            <p className="text-[10px] text-steel-500 mt-0.5">Fully local — no data leaves machine</p>
            <p className="text-[10px] text-emerald-600 mt-0.5">✓ Maximum data privacy</p>
          </button>
        </div>
      </div>

      {/* PAT — only shown for GitHub provider */}
      {!isOllama && (
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-4">
            <Key size={16} className="text-navy-700" />
            <h2 className="text-sm font-semibold text-navy-800">GitHub Personal Access Token</h2>
          </div>
          <p className="text-xs text-steel-500 mb-3">
            Create a fine-grained PAT at{" "}
            <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noreferrer"
               className="text-navy-700 underline">
              github.com/settings/tokens
            </a>{" "}
            with <code className="text-[10px] bg-steel-50 px-1 py-0.5 rounded">models:read</code> permission.
            The token is stored in the local SQLite database and only transmitted to GitHub's API over HTTPS.
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              className="input-field flex-1 font-mono text-xs"
              placeholder={config.github_pat_masked ? `Current: ${config.github_pat_masked}` : "github_pat_..."}
              value={pat}
              onChange={(e) => setPat(e.target.value)}
            />
          </div>
          {config.github_pat_masked && (
            <p className="text-[10px] text-emerald-600 mt-1.5 flex items-center gap-1">
              <CheckCircle size={10} /> PAT configured ({config.github_pat_masked})
            </p>
          )}
          {/* No stored PAT: surface where the effective token actually comes from
              (env var or the local gh login) so the user isn't told "no PAT" when
              the GitHub provider will in fact work. github_token_source is set by
              GET /api/config and never contains the token itself. */}
          {!config.github_pat_masked && !pat && config.github_token_source === "env" && (
            <p className="text-[10px] text-emerald-600 mt-1.5 flex items-center gap-1">
              <CheckCircle size={10} /> Using GITHUB_TOKEN from the environment
            </p>
          )}
          {!config.github_pat_masked && !pat && config.github_token_source === "gh" && (
            <p className="text-[10px] text-emerald-600 mt-1.5 flex items-center gap-1">
              <CheckCircle size={10} /> Using your GitHub CLI login (gh auth token) — paste a PAT above to override
            </p>
          )}
          {!config.github_pat_masked &&
            !pat &&
            config.github_token_source !== "env" &&
            config.github_token_source !== "gh" && (
              <p className="text-[10px] text-amber-600 mt-1.5">
                No GitHub token found. Paste a PAT above, set GITHUB_TOKEN, or run{" "}
                <code className="text-[10px] bg-steel-50 px-1 py-0.5 rounded">gh auth login</code>.
              </p>
            )}
        </div>
      )}

      {/* Model config */}
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-4">
          <Cpu size={16} className="text-navy-700" />
          <h2 className="text-sm font-semibold text-navy-800">
            {isOllama ? "Ollama Configuration" : "GitHub Models Configuration"}
          </h2>
        </div>
        <div className="space-y-3">
          {isOllama ? (
            <>
              <div>
                <label className="text-xs font-medium text-steel-500 block mb-1">Ollama Model</label>
                <select className="input-field" value={ollamaModel} onChange={(e) => setOllamaModel(e.target.value)}>
                  <option value="llama3.2">llama3.2 (recommended, 3B)</option>
                  <option value="llama3.1">llama3.1 (8B)</option>
                  <option value="llama3.3">llama3.3 (70B, if available)</option>
                  <option value="mistral">mistral (7B)</option>
                  <option value="phi3">phi3 (3.8B, fast)</option>
                  <option value="qwen2.5-coder">qwen2.5-coder (7B, code-focused)</option>
                  <option value="deepseek-r1">deepseek-r1 (if available)</option>
                </select>
                <p className="text-[10px] text-steel-500 mt-1">
                  Install models with: <code className="bg-steel-50 px-1 rounded">ollama pull {ollamaModel}</code>
                </p>
              </div>
              <div>
                <label className="text-xs font-medium text-steel-500 block mb-1">Ollama Endpoint</label>
                <input
                  className="input-field font-mono text-xs"
                  value={ollamaEndpoint}
                  onChange={(e) => setOllamaEndpoint(e.target.value)}
                />
                <p className="text-[10px] text-steel-500 mt-1">
                  Start Ollama with: <code className="bg-steel-50 px-1 rounded">ollama serve</code>
                </p>
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="text-xs font-medium text-steel-500 block mb-1">Model</label>
                <select className="input-field" value={model} onChange={(e) => setModel(e.target.value)}>
                  {/* Keep the current value selectable even if the live catalog
                      omits it (a custom entry, or a model GitHub has since removed). */}
                  {model && !models.some((m) => m.id === model) && (
                    <option value={model}>{model} (current)</option>
                  )}
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id === RECOMMENDED_MODEL ? `${m.id} (recommended)` : m.id}
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-steel-500 mt-1">
                  {modelSource === "catalog"
                    ? `${models.length} models from the live GitHub Models catalog`
                    : modelSource === "fallback"
                      ? "Built-in fallback list — live catalog unavailable (check token/network)"
                      : "Loading models…"}
                </p>
              </div>
              <div>
                <label className="text-xs font-medium text-steel-500 block mb-1">Endpoint</label>
                <input
                  className="input-field font-mono text-xs"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                />
              </div>
            </>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-steel-500 block mb-1">
                Temperature ({temperature})
              </label>
              <input
                type="range"
                min="0" max="1" step="0.1"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                className="w-full"
              />
              <p className="text-[10px] text-steel-500">Lower = more precise financial calculations</p>
            </div>
            <div>
              <label className="text-xs font-medium text-steel-500 block mb-1">Max Tokens</label>
              <input
                type="number"
                className="input-field"
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button onClick={handleSave} disabled={saving} className="btn-primary flex items-center gap-2">
          <Save size={14} />
          {saving ? "Saving..." : "Save Settings"}
        </button>
        <button onClick={handleTest} disabled={testing} className="btn-secondary flex items-center gap-2 text-sm">
          <Link size={14} />
          {testing ? "Testing..." : "Test Connection"}
        </button>
        {saved && (
          <span className="text-xs text-emerald-600 flex items-center gap-1">
            <CheckCircle size={14} /> Saved
          </span>
        )}
      </div>

      {testResult && (
        <div className={`card p-4 flex items-start gap-3 ${testResult.ok ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"}`}>
          {testResult.ok
            ? <CheckCircle size={18} className="text-emerald-600 mt-0.5 flex-shrink-0" />
            : <XCircle size={18} className="text-red-600 mt-0.5 flex-shrink-0" />}
          <div>
            <p className={`text-sm font-medium ${testResult.ok ? "text-emerald-800" : "text-red-800"}`}>
              {testResult.ok ? "Connection Successful" : "Connection Failed"}
            </p>
            <p className="text-xs mt-0.5 text-steel-500 break-all">{testResult.message}</p>
          </div>
        </div>
      )}

      {/* API Token — required for mutating routes (config PUT, scenario POST) */}
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-4">
          <Shield size={16} className="text-navy-700" />
          <h2 className="text-sm font-semibold text-navy-800">API Token</h2>
        </div>
        <p className="text-xs text-steel-500 mb-3">
          The server prints a token to its console on startup. Paste it here once;
          it is stored in <code className="bg-steel-50 px-1 rounded">localStorage</code> and
          sent automatically on every settings update and scenario request.
        </p>
        <input
          type="password"
          className="input-field w-full font-mono text-xs"
          placeholder="Paste token from server console…"
          value={apiToken}
          onChange={(e) => setApiToken(e.target.value)}
        />
        {apiToken && (
          <p className="text-[10px] text-emerald-600 mt-1.5 flex items-center gap-1">
            <CheckCircle size={10} /> Token stored in localStorage
          </p>
        )}
      </div>

      {/* Security info */}
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-3">
          <Shield size={16} className="text-navy-700" />
          <h2 className="text-sm font-semibold text-navy-800">Security & Privacy</h2>
        </div>
        <ul className="space-y-2 text-xs text-steel-500">
          <li className="flex items-start gap-2">
            <span className="text-emerald-500 mt-0.5">●</span>
            All data stored locally in <code className="bg-steel-50 px-1 rounded">data/finimpact.db</code> (SQLite)
          </li>
          {isOllama ? (
            <>
              <li className="flex items-start gap-2">
                <span className="text-emerald-500 mt-0.5">●</span>
                <strong>Ollama mode: NO data leaves your machine.</strong> All LLM inference runs locally.
              </li>
              <li className="flex items-start gap-2">
                <span className="text-emerald-500 mt-0.5">●</span>
                Suitable for restricted deployment environments — zero cloud dependency
              </li>
            </>
          ) : (
            <>
              <li className="flex items-start gap-2">
                <span className="text-emerald-500 mt-0.5">●</span>
                PAT is only transmitted to <code className="bg-steel-50 px-1 rounded">models.github.ai</code> via HTTPS
              </li>
              <li className="flex items-start gap-2">
                <span className="text-emerald-500 mt-0.5">●</span>
                Anonymized context sent to LLM — person names are stripped, only financial structure shared
              </li>
              <li className="flex items-start gap-2">
                <span className="text-amber-500 mt-0.5">●</span>
                For DoD environments: verify GitHub Models API is approved for your data classification level
              </li>
            </>
          )}
          <li className="flex items-start gap-2">
            <span className="text-emerald-500 mt-0.5">●</span>
            No telemetry, no external analytics, no cloud storage
          </li>
        </ul>
      </div>
    </div>
  );
}

import { useState, useEffect } from "react";
import { Save, CheckCircle, XCircle, Key, Cpu, Link, Shield } from "lucide-react";
import { api } from "../api";

export default function SettingsPanel() {
  const [config, setConfig] = useState<Record<string, string>>({});
  const [pat, setPat] = useState("");
  const [model, setModel] = useState("openai/gpt-4.1");
  const [endpoint, setEndpoint] = useState("https://models.github.ai/inference/chat/completions");
  const [temperature, setTemperature] = useState("0.2");
  const [maxTokens, setMaxTokens] = useState("2000");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    api.getConfig().then((c) => {
      setConfig(c);
      setModel(c.model || "openai/gpt-4.1");
      setEndpoint(c.endpoint || "https://models.github.ai/inference/chat/completions");
      setTemperature(c.temperature || "0.2");
      setMaxTokens(c.max_tokens || "2000");
    });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    const updates: Record<string, string> = { model, endpoint, temperature, max_tokens: maxTokens };
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
      const result = await api.runScenario("Reply with exactly: CONNECTION_OK");
      if (result.error) {
        setTestResult({ ok: false, message: result.error });
      } else if (result.content) {
        setTestResult({ ok: true, message: `Connected to ${result.model}` });
      }
    } catch (e: any) {
      setTestResult({ ok: false, message: e.message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      {/* PAT */}
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
        {!config.github_pat_masked && !pat && (
          <p className="text-[10px] text-amber-600 mt-1.5">
            No PAT configured. Also checks GITHUB_TOKEN environment variable.
          </p>
        )}
      </div>

      {/* Model config */}
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-4">
          <Cpu size={16} className="text-navy-700" />
          <h2 className="text-sm font-semibold text-navy-800">Model Configuration</h2>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-steel-500 block mb-1">Model</label>
            <select className="input-field" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="openai/gpt-4.1">openai/gpt-4.1 (recommended)</option>
              <option value="openai/gpt-4o">openai/gpt-4o</option>
              <option value="openai/gpt-4.1-mini">openai/gpt-4.1-mini (faster, cheaper)</option>
              <option value="meta/llama-3.3-70b-instruct">meta/llama-3.3-70b-instruct</option>
              <option value="deepseek/deepseek-r1">deepseek/deepseek-r1</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-steel-500 block mb-1">Endpoint</label>
            <input
              className="input-field font-mono text-xs"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
            />
          </div>
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
          <li className="flex items-start gap-2">
            <span className="text-emerald-500 mt-0.5">●</span>
            PAT is only transmitted to <code className="bg-steel-50 px-1 rounded">models.github.ai</code> via HTTPS
          </li>
          <li className="flex items-start gap-2">
            <span className="text-emerald-500 mt-0.5">●</span>
            No telemetry, no external analytics, no cloud storage
          </li>
          <li className="flex items-start gap-2">
            <span className="text-emerald-500 mt-0.5">●</span>
            Workbook context is sent to the AI model as part of each query — ensure data classification allows this
          </li>
          <li className="flex items-start gap-2">
            <span className="text-amber-500 mt-0.5">●</span>
            For DoD environments: verify GitHub Models API is approved for your data classification level
          </li>
        </ul>
      </div>
    </div>
  );
}

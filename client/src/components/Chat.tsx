import { useState, useEffect, useRef } from "react";
import { Send, Loader2, Sparkles, Clock, Zap } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { api, type AgenticResponse, type ScenarioResult } from "../api";
import ScenarioCards from "./ScenarioCards";

const QUICK_QUERIES = [
  {
    label: "Staffing Swap",
    query: "What if we replace the Senior Developer on Project Alpha with two Mid-level Developers? Show cost delta, margin impact, and burn rate change.",
  },
  {
    label: "Burn Rate Check",
    query: "What is the monthly burn rate across all projects? Flag any projects where burn rate will exhaust remaining budget within 3 months.",
  },
  {
    label: "Extend + Stay in Budget",
    query: "What staffing changes would let us extend Project Alpha by 3 months and still stay within budget? Explore multiple options.",
  },
  {
    label: "Improve Margin",
    query: "What staffing changes across the portfolio would improve the blended margin by at least 3 percentage points? Try multiple approaches and show the numbers.",
  },
];

export default function Chat() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [agenticResponse, setAgenticResponse] = useState<AgenticResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [expandedScenario, setExpandedScenario] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Only refetch history when a new response arrives (not when cleared to null)
    if (agenticResponse) {
      api.getScenarios(20).then(setHistory).catch(() => {});
    }
  }, [agenticResponse]);

  // Initial history load
  useEffect(() => {
    api.getScenarios(20).then(setHistory).catch(() => {});
  }, []);

  const runQuery = async (q?: string) => {
    const finalQuery = q || query;
    if (!finalQuery.trim() || loading) return;

    setLoading(true);
    setAgenticResponse(null);
    setError(null);
    setExpandedScenario(null);

    try {
      const result = await api.runScenarioV3(finalQuery);
      if (result.error) {
        setError(result.error);
      } else {
        setAgenticResponse(result);
      }
      if (!q) setQuery("");
    } catch (e: any) {
      setError(e.message);
      if (!q) setQuery("");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      runQuery();
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Main chat area */}
      <div className="lg:col-span-2 space-y-4">
        {/* Input */}
        <div className="card p-4">
          <label className="text-xs font-semibold text-navy-800 uppercase tracking-wider mb-2 block">
            Scenario Question
          </label>
          <div className="relative">
            <textarea
              ref={textareaRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="What staffing changes would let us extend Alpha by 3 months and stay within budget?"
              rows={3}
              className="input-field pr-12 resize-none"
              disabled={loading}
            />
            <button
              onClick={() => runQuery()}
              disabled={loading || !query.trim()}
              className="absolute right-2 bottom-2 p-2 rounded-lg bg-navy-700 text-white
                         hover:bg-navy-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          </div>
          <p className="text-[10px] text-steel-500 mt-1">Ctrl+Enter to send</p>
        </div>

        {/* Quick queries */}
        <div className="flex flex-wrap gap-2">
          {QUICK_QUERIES.map((q, i) => (
            <button
              key={i}
              onClick={() => { setQuery(q.query); runQuery(q.query); }}
              disabled={loading}
              className="px-3 py-1.5 text-xs font-medium bg-white border border-steel-200
                         rounded-full hover:border-navy-700 hover:text-navy-700 transition-colors
                         disabled:opacity-50 flex items-center gap-1.5"
            >
              <Sparkles size={12} />
              {q.label}
            </button>
          ))}
        </div>

        {/* Response */}
        {loading && (
          <div className="card p-8 text-center">
            <Loader2 size={24} className="animate-spin mx-auto text-navy-700 mb-2" />
            <p className="text-sm text-steel-500">Analyzing scenarios...</p>
            <p className="text-[10px] text-steel-500 mt-1">The AI is exploring options using the calculation engine</p>
          </div>
        )}

        {error && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}

        {agenticResponse && (
          <div className="space-y-4">
            {/* Scenarios explored badge */}
            {agenticResponse.scenarios_explored.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-navy-700 text-white text-[10px] font-semibold uppercase tracking-wider rounded-full">
                  <Zap size={10} />
                  {agenticResponse.scenarios_explored.length} scenario{agenticResponse.scenarios_explored.length !== 1 ? "s" : ""} computed
                </span>
                <span className="text-[10px] text-steel-500 font-mono">
                  {agenticResponse.tokensUsed?.toLocaleString()} tokens · {agenticResponse.model}
                </span>
              </div>
            )}

            {/* Expandable scenario cards for each explored scenario */}
            {agenticResponse.scenarios_explored.length > 0 && (
              <div className="space-y-2">
                {agenticResponse.scenarios_explored.map((scenario, i) => (
                  <ScenarioAccordion
                    key={i}
                    index={i}
                    scenario={scenario}
                    isExpanded={expandedScenario === i}
                    onToggle={() => setExpandedScenario(expandedScenario === i ? null : i)}
                  />
                ))}
              </div>
            )}

            {/* AI narrative */}
            {agenticResponse.content && (
              <div className="card">
                <div className="px-5 py-3 border-b border-steel-100 flex items-center justify-between">
                  <span className="text-xs font-semibold text-navy-800 uppercase tracking-wider">
                    AI Analysis
                  </span>
                  <span className="text-[10px] text-steel-500 font-mono">
                    {agenticResponse.model}
                  </span>
                </div>
                <div className="p-5">
                  <div className="ai-response">
                    <ReactMarkdown>{agenticResponse.content}</ReactMarkdown>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Sidebar: history */}
      <div className="space-y-4">
        <div className="card">
          <div className="px-4 py-3 border-b border-steel-100 flex items-center justify-between">
            <span className="text-xs font-semibold text-navy-800 uppercase tracking-wider flex items-center gap-1.5">
              <Clock size={12} /> History
            </span>
            <button
              onClick={() => setShowHistory(!showHistory)}
              className="text-[10px] text-navy-700 hover:underline"
            >
              {showHistory ? "Collapse" : "Expand"}
            </button>
          </div>
          <div className="divide-y divide-steel-100 max-h-[600px] overflow-y-auto">
            {history.length === 0 ? (
              <div className="p-4 text-sm text-steel-500 text-center">No queries yet</div>
            ) : (
              history.map((h: any) => (
                <button
                  key={h.id}
                  onClick={() => setQuery(h.query)}
                  className="w-full text-left px-4 py-2.5 hover:bg-steel-50 transition-colors"
                >
                  <p className="text-xs font-medium text-navy-800 line-clamp-2">{h.query}</p>
                  <p className="text-[10px] text-steel-500 mt-0.5">
                    {new Date(h.created_at).toLocaleString()}
                  </p>
                  {showHistory && (
                    <p className="text-[11px] text-steel-500 mt-1 line-clamp-3">{h.response?.slice(0, 200)}</p>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Accordion for explored scenarios ────────────────────────────────────────

function ScenarioAccordion({ index, scenario, isExpanded, onToggle }: {
  index: number;
  scenario: ScenarioResult;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const action = scenario.operation?.action ?? "analysis";
  const project = scenario.project_name ?? scenario.projects_involved?.join(", ") ?? "Portfolio";
  const hasImpact = !!scenario.impact;

  return (
    <div className="card overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-steel-50/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-5 h-5 bg-navy-700 text-white text-[10px] font-bold rounded-full">
            {index + 1}
          </span>
          <span className="text-xs font-semibold text-navy-800 uppercase tracking-wider">
            {action.replace(/_/g, " ")}
          </span>
          <span className="text-xs text-steel-500">— {project}</span>
        </div>
        <div className="flex items-center gap-3">
          {hasImpact && (
            <span className={`text-xs font-mono font-semibold ${
              scenario.impact!.cost_delta_monthly <= 0 ? "text-emerald-600" : "text-red-600"
            }`}>
              {scenario.impact!.cost_delta_monthly >= 0 ? "+" : ""}
              ${Math.round(scenario.impact!.cost_delta_monthly).toLocaleString()}/mo
            </span>
          )}
          <span className="text-[10px] text-steel-500">{isExpanded ? "▲" : "▼"}</span>
        </div>
      </button>
      {isExpanded && (
        <div className="border-t border-steel-100 p-4">
          <ScenarioCards result={scenario} />
        </div>
      )}
    </div>
  );
}

const BASE = "/api";

// Engine result types (mirrors server/engine/types.ts)
export interface ScenarioImpact {
  cost_delta_monthly: number;
  cost_delta_annual: number;
  revenue_delta_monthly: number;
  revenue_delta_annual: number;
  margin_delta_pct: number;
  margin_delta_dollars_monthly: number;
  burn_rate_delta: number;
  burn_rate_delta_pct: number;
  months_remaining_delta: number;
  headcount_delta: number;
  fte_delta: number;
}

export interface ScenarioResult {
  operation: any;
  timestamp: string;
  project_name?: string;
  projects_involved: string[];
  current: {
    labor: { monthly_cost: number; monthly_revenue: number; annual_cost: number; annual_revenue: number; blended_cost_rate: number; blended_bill_rate: number; fte_count: number; headcount: number };
    margin: { margin_pct: number; margin_dollars_monthly: number; margin_dollars_annual: number; gross_margin_pct: number; contribution_margin: number; net_direct_labor_multiplier: number };
    budget: { monthly_burn_rate: number; remaining_budget: number; months_remaining: number; budget_exhaustion_date: string; annual_run_rate: number };
  };
  projected?: {
    labor: { monthly_cost: number; monthly_revenue: number; annual_cost: number; annual_revenue: number; blended_cost_rate: number; blended_bill_rate: number; fte_count: number; headcount: number };
    margin: { margin_pct: number; margin_dollars_monthly: number; margin_dollars_annual: number; gross_margin_pct: number; contribution_margin: number; net_direct_labor_multiplier: number };
    budget: { monthly_burn_rate: number; remaining_budget: number; months_remaining: number; budget_exhaustion_date: string; annual_run_rate: number };
  };
  impact?: ScenarioImpact;
  evm?: any;
  utilization?: any;
  portfolio?: {
    total_burn: number;
    total_margin_pct: number;
    total_margin_dollars: number;
    project_summaries: { name: string; monthly_burn: number; margin_pct: number; months_remaining: number }[];
  };
  warnings: string[];
  sub_results?: ScenarioResult[];
}

export interface V2Response {
  engine: ScenarioResult;
  narrative: string;
  model: string;
  tokensUsed?: number;
  error?: string;
}

export interface AgenticResponse {
  content: string;
  model: string;
  tokensUsed: number;
  scenarios_explored: ScenarioResult[];
  error?: string;
}

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  getDashboard: () => request<any>("/dashboard"),
  getProjects: () => request<any[]>("/projects"),
  getStaffing: (projectId?: number) =>
    request<any[]>(`/staffing${projectId ? `?project_id=${projectId}` : ""}`),
  getRates: () => request<any[]>("/rates"),
  getConfig: () => request<Record<string, string>>("/config"),
  getScenarios: (limit?: number) =>
    request<any[]>(`/scenarios${limit ? `?limit=${limit}` : ""}`),

  runScenarioV2: (query: string, skipNarrative?: boolean) =>
    request<V2Response>("/scenario/v2", {
      method: "POST",
      body: JSON.stringify({ query, skip_narrative: skipNarrative }),
    }),

  runScenarioV3: (query: string) =>
    request<AgenticResponse>("/scenario/v3", {
      method: "POST",
      body: JSON.stringify({ query }),
    }),

  updateConfig: (entries: Record<string, string>) =>
    request<{ ok: boolean }>("/config", {
      method: "PUT",
      body: JSON.stringify(entries),
    }),

  addStaffing: (data: { project_id: number; labor_category_id: number; person_name: string; hours_per_week: number }) =>
    request<{ id: number }>("/staffing", { method: "POST", body: JSON.stringify(data) }),

  removeStaffing: (id: number) =>
    request<{ ok: boolean }>(`/staffing/${id}`, { method: "DELETE" }),

  addProject: (data: { name: string; total_budget: number; start_date: string; end_date: string }) =>
    request<{ id: number }>("/projects", { method: "POST", body: JSON.stringify(data) }),
};

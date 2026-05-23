import type {
  ScenarioResult as EngineScenarioResult,
  V2Response as EngineV2Response,
} from "../../server/engine/types.ts";

const BASE = "/api";

export type ScenarioResult = EngineScenarioResult;
export type V2Response = EngineV2Response;

export interface AgenticResponse {
  content: string;
  model: string;
  tokensUsed: number;
  scenarios_explored: ScenarioResult[];
  error?: string;
}

export interface DashboardSummary {
  totalBudget: number;
  totalSpent: number;
  totalRemaining: number;
  totalMonthlyBurn: number;
  totalMonthlyRevenue: number;
  blendedMargin: number;
  headcount: number;
  projectCount: number;
}

export interface ProjectSummaryRow {
  id: number;
  name: string;
  total_budget: number;
  spent_to_date: number;
  remaining: number;
  monthly_burn: number;
  months_left: number;
  start_date: string;
  end_date: string;
  status: string;
}

export interface DashboardResponse {
  summary: DashboardSummary;
  projects: ProjectSummaryRow[];
}

export interface StaffingAssignment {
  id: number;
  person_name: string | null;
  hours_per_week: number;
  is_active: number;
  project_name: string;
  project_id: number;
  labor_category: string;
  bill_rate: number;
  cost_rate: number;
  monthly_cost: number;
  monthly_revenue: number;
  margin: number;
}

export interface LaborCategoryRate {
  id: number;
  name: string;
  bill_rate: number;
  cost_rate: number;
  margin: number;
}

export interface ScenarioHistoryEntry {
  id: number;
  query: string;
  response: string;
  model: string;
  created_at: string;
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
  getDashboard: () => request<DashboardResponse>("/dashboard"),
  getProjects: () => request<ProjectSummaryRow[]>("/projects"),
  getStaffing: (projectId?: number) =>
    request<StaffingAssignment[]>(`/staffing${projectId ? `?project_id=${projectId}` : ""}`),
  getRates: () => request<LaborCategoryRate[]>("/rates"),
  getConfig: () => request<Record<string, string>>("/config"),
  getScenarios: (limit?: number) =>
    request<ScenarioHistoryEntry[]>(`/scenarios${limit ? `?limit=${limit}` : ""}`),

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

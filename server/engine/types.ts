// ─── Constants ────────────────────────────────────────────────────────────────

export const WEEKS_PER_MONTH = 4.33; // 365.25 / 12 / 7
export const HOURS_PER_YEAR = 2080; // 52 weeks × 40 hours
export const WORKING_DAYS_PER_MONTH = 21.67; // 260 / 12
export const WEEKS_PER_YEAR = 52;
export const MONTHS_PER_YEAR = 12;

// ─── Utility Functions ───────────────────────────────────────────────────────

/** Safe division that returns a fallback instead of Infinity/NaN on zero denominator */
export function safeDivide(numerator: number, denominator: number, fallback: number = 0): number {
  if (denominator === 0 || !Number.isFinite(denominator)) return fallback;
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : fallback;
}

/** Round to 2 decimal places (for dollar amounts) */
export function roundDollars(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Round to 1 decimal place (for percentages) */
export function roundPct(n: number): number {
  return Math.round(n * 10) / 10;
}

// ─── Input Types (mirroring DB rows) ─────────────────────────────────────────

export interface LaborCategory {
  id: number;
  name: string;
  bill_rate: number;
  cost_rate: number;
}

export interface StaffingRecord {
  id: number;
  project_id: number;
  project_name: string;
  labor_category_id: number;
  labor_category: string;
  person_name: string | null;
  hours_per_week: number;
  bill_rate: number;
  cost_rate: number;
  is_active: number; // 0 | 1
}

export interface Project {
  id: number;
  name: string;
  total_budget: number;
  spent_to_date: number;
  start_date: string;
  end_date: string;
  status: string;
}

export interface ProjectSnapshot extends Project {
  staffing: StaffingRecord[];
}

export interface PortfolioSnapshot {
  projects: ProjectSnapshot[];
  labor_categories: LaborCategory[];
}

// ─── Scenario Operation (LLM-produced intent) ───────────────────────────────

export interface ScenarioOperation {
  action:
    | "swap"
    | "add"
    | "remove"
    | "rate_change"
    | "hours_change"
    | "timeline_extension"
    | "unexpected_cost"
    | "reallocation"
    | "burn_rate_check"
    | "margin_analysis"
    | "evm_analysis"
    | "what_if_composite";

  // Target scope
  project?: string;
  projects?: string[];

  // Staffing changes
  remove?: { role: string; count: number; person_name?: string }[];
  add?: { role: string; count: number; hours_per_week?: number }[];

  // Rate changes
  rate_changes?: { role: string; new_bill_rate?: number; new_cost_rate?: number }[];

  // Hours changes
  hours_changes?: { person_name: string; new_hours_per_week: number }[];

  // Timeline
  new_end_date?: string;
  extension_months?: number;

  // Cost injection
  additional_costs?: {
    description: string;
    amount: number;
    is_recurring: boolean;
    frequency_months?: number; // 1=monthly, 3=quarterly, 12=annual
  }[];

  // Composite (for complex what-ifs)
  sub_operations?: ScenarioOperation[];
}

// ─── Calculation Result Types ────────────────────────────────────────────────

export interface LaborMetrics {
  monthly_cost: number;
  monthly_revenue: number;
  annual_cost: number;
  annual_revenue: number;
  blended_cost_rate: number;
  blended_bill_rate: number;
  fte_count: number;
  headcount: number;
}

export interface MarginMetrics {
  margin_pct: number;
  margin_dollars_monthly: number;
  margin_dollars_annual: number;
  gross_margin_pct: number;
  contribution_margin: number;
  net_direct_labor_multiplier: number;
}

export interface BudgetMetrics {
  monthly_burn_rate: number;
  remaining_budget: number;
  months_remaining: number;
  budget_exhaustion_date: string;
  annual_run_rate: number;
}

export interface EvmMetrics {
  bac: number;
  ac: number;
  pv: number;
  ev: number;
  cpi: number;
  spi: number;
  cv: number;
  sv: number;
  eac_typical: number;     // BAC / CPI
  eac_atypical: number;    // AC + (BAC - EV)
  eac_mixed: number;       // AC + (BAC - EV) / (CPI × SPI)
  etc: number;             // EAC - AC
  vac: number;             // BAC - EAC
  tcpi: number;            // (BAC - EV) / (BAC - AC)
}

export interface UtilizationMetrics {
  utilization_rate: number;
  effective_bill_rate: number;
  revenue_per_employee: number;
  break_even_utilization: number;
}

// ─── Scenario Impact (before/after delta) ────────────────────────────────────

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

// ─── Scenario Result (full output envelope) ──────────────────────────────────

export interface ProjectSummary {
  name: string;
  monthly_burn: number;
  margin_pct: number;
  months_remaining: number;
}

export interface ScenarioResult {
  operation: ScenarioOperation;
  timestamp: string;
  project_name?: string;
  projects_involved: string[];

  // Current state metrics
  current: {
    labor: LaborMetrics;
    margin: MarginMetrics;
    budget: BudgetMetrics;
  };

  // Projected state (only for mutation scenarios)
  projected?: {
    labor: LaborMetrics;
    margin: MarginMetrics;
    budget: BudgetMetrics;
  };

  // Delta summary (only for mutation scenarios)
  impact?: ScenarioImpact;

  // Analysis-only results
  evm?: EvmMetrics;
  utilization?: UtilizationMetrics;

  // Portfolio-level (multi-project)
  portfolio?: {
    total_burn: number;
    total_margin_pct: number;
    total_margin_dollars: number;
    project_summaries: ProjectSummary[];
  };

  // Warnings and flags
  warnings: string[];

  // Sub-results for composite operations
  sub_results?: ScenarioResult[];
}

// ─── API Response Types ──────────────────────────────────────────────────────

export interface V2Response {
  engine: ScenarioResult;
  narrative: string;
  model: string;
  tokensUsed?: number;
  error?: string;
}

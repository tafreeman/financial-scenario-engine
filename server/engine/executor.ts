import {
  type ScenarioOperation,
  type ScenarioResult,
  type PortfolioSnapshot,
  type ProjectSnapshot,
  type LaborCategory,
  type StaffingRecord,
} from "./types.js";
import {
  getProjectsWithBurn,
  getStaffingByProject,
  getLaborCategories,
} from "../db.js";
import { calcProjectLabor } from "./labor.js";
import { calcProjectMarginFromLabor } from "./margin.js";
import { fuzzyMatchWithConfidence, ROLE_ABBREVIATIONS } from "./matching.js";
import { calcBudgetMetrics } from "./budget.js";
import { calcEvm, calcPlannedValue, calcEarnedValue } from "./evm.js";
import { calcUtilization } from "./utilization.js";
import {
  applySwap,
  applyAdd,
  applyRemove,
  applyRateChange,
  applyHoursChange,
  calcScenarioImpact,
  calcTimelineExtensionImpact,
  calcUnexpectedCostImpact,
} from "./scenarios.js";
import { calcPortfolioMetrics } from "./portfolio.js";

// ─── Portfolio Loading ───────────────────────────────────────────────────────

/** Load complete portfolio state from database */
export function loadPortfolioSnapshot(): PortfolioSnapshot {
  const projectRows = getProjectsWithBurn();
  const allStaffing = getStaffingByProject() as StaffingRecord[];
  const categories = getLaborCategories() as LaborCategory[];

  // Group staffing by project_id in O(S) instead of O(P*S) filtering
  const staffingByProject = new Map<number, StaffingRecord[]>();
  for (const s of allStaffing) {
    if (s.is_active !== 1) continue;
    let list = staffingByProject.get(s.project_id);
    if (!list) {
      list = [];
      staffingByProject.set(s.project_id, list);
    }
    list.push(s);
  }

  const projects: ProjectSnapshot[] = projectRows.map(p => ({
    id: p.id,
    name: p.name,
    total_budget: p.total_budget,
    spent_to_date: p.spent_to_date,
    start_date: p.start_date,
    end_date: p.end_date,
    status: p.status,
    staffing: staffingByProject.get(p.id) ?? [],
  }));

  return { projects, labor_categories: categories };
}

// ─── Name Resolution ─────────────────────────────────────────────────────────

/** Fuzzy match a project name against the portfolio, with confidence info */
export function resolveProject(
  name: string,
  portfolio: PortfolioSnapshot,
  warnings?: string[]
): ProjectSnapshot | null {
  if (name.toLowerCase().trim() === "all") return null; // signals portfolio-level operation
  const result = fuzzyMatchWithConfidence(name, portfolio.projects, p => p.name);
  if (result.item && result.confidence < 0.7 && warnings) {
    warnings.push(`Low confidence match: "${name}" resolved to "${result.item.name}" (${result.quality} match, ${Math.round(result.confidence * 100)}% confidence).`);
  }
  return result.item;
}

/** Fuzzy match a role name against labor categories, with confidence info */
export function resolveRole(
  name: string,
  categories: LaborCategory[],
  warnings?: string[]
): LaborCategory | null {
  const result = fuzzyMatchWithConfidence(name, categories, c => c.name, ROLE_ABBREVIATIONS);
  if (result.item && result.confidence < 0.7 && warnings) {
    warnings.push(`Low confidence match: "${name}" resolved to "${result.item.name}" (${result.quality} match, ${Math.round(result.confidence * 100)}% confidence).`);
  }
  return result.item;
}

// ─── Metric Computation Helpers ──────────────────────────────────────────────

function computeState(staffing: StaffingRecord[], project: ProjectSnapshot) {
  const labor = calcProjectLabor(staffing);
  const margin = calcProjectMarginFromLabor(labor);
  const budget = calcBudgetMetrics(project, labor.monthly_cost);
  return { labor, margin, budget };
}

// ─── Main Executor ───────────────────────────────────────────────────────────

/** Execute a scenario operation against current database state.
 *  Accepts an optional pre-loaded portfolio to avoid redundant DB queries (e.g. in composite operations). */
export function executeScenario(operation: ScenarioOperation, preloadedPortfolio?: PortfolioSnapshot): ScenarioResult {
  const portfolio = preloadedPortfolio ?? loadPortfolioSnapshot();
  const warnings: string[] = [];
  const timestamp = new Date().toISOString();

  // Determine target project(s)
  const projectName = operation.project;
  let targetProject: ProjectSnapshot | null = null;

  if (projectName && projectName.toLowerCase() !== "all") {
    targetProject = resolveProject(projectName, portfolio, warnings);
    if (!targetProject) {
      warnings.push(`Could not resolve project "${projectName}". Showing portfolio-level analysis.`);
    }
  }

  const projectsInvolved = targetProject
    ? [targetProject.name]
    : portfolio.projects.map(p => p.name);

  // Route to the appropriate handler
  switch (operation.action) {
    case "burn_rate_check":
    case "margin_analysis":
      return handleAnalysis(operation, portfolio, targetProject, warnings, timestamp);

    case "evm_analysis":
      return handleEvmAnalysis(operation, portfolio, targetProject, warnings, timestamp);

    case "swap":
    case "add":
    case "remove":
    case "rate_change":
    case "hours_change":
      return handleStaffingChange(operation, portfolio, targetProject, warnings, timestamp);

    case "timeline_extension":
      return handleTimelineExtension(operation, portfolio, targetProject, warnings, timestamp);

    case "unexpected_cost":
      return handleUnexpectedCost(operation, portfolio, targetProject, warnings, timestamp);

    case "reallocation":
      return handleReallocation(operation, portfolio, warnings, timestamp);

    case "what_if_composite":
      return handleComposite(operation, portfolio, targetProject, warnings, timestamp);

    default:
      warnings.push(`Unknown action: ${operation.action}. Defaulting to burn rate check.`);
      return handleAnalysis(
        { ...operation, action: "burn_rate_check" },
        portfolio, targetProject, warnings, timestamp
      );
  }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

function handleAnalysis(
  operation: ScenarioOperation,
  portfolio: PortfolioSnapshot,
  targetProject: ProjectSnapshot | null,
  warnings: string[],
  timestamp: string
): ScenarioResult {
  if (targetProject) {
    const current = computeState(targetProject.staffing, targetProject);
    if (current.labor.headcount === 0) {
      warnings.push(`${targetProject.name} has no active staffing.`);
    }

    return {
      operation,
      timestamp,
      project_name: targetProject.name,
      projects_involved: [targetProject.name],
      current,
      utilization: calcUtilization(targetProject.staffing),
      warnings,
    };
  }

  // Portfolio-level analysis
  const allStaffing = portfolio.projects.flatMap(p => p.staffing);
  const totalLabor = calcProjectLabor(allStaffing);
  const totalMargin = calcProjectMarginFromLabor(totalLabor);

  // Single-pass portfolio metrics (avoids redundant calcProjectLabor per project)
  const pm = calcPortfolioMetrics(portfolio.projects);

  // Flag projects with < 3 months remaining
  for (const s of pm.project_summaries) {
    if (s.months_remaining > 0 && s.months_remaining < 3) {
      warnings.push(`${s.name}: only ${s.months_remaining.toFixed(1)} months of budget remaining.`);
    }
  }

  return {
    operation,
    timestamp,
    projects_involved: portfolio.projects.map(p => p.name),
    current: {
      labor: totalLabor,
      margin: totalMargin,
      budget: {
        monthly_burn_rate: totalLabor.monthly_cost,
        remaining_budget: portfolio.projects.reduce(
          (sum, p) => sum + (p.total_budget - p.spent_to_date), 0
        ),
        months_remaining: 0, // not meaningful at portfolio level
        budget_exhaustion_date: "N/A",
        annual_run_rate: totalLabor.monthly_cost * 12,
      },
    },
    portfolio: {
      total_burn: pm.total_burn,
      total_margin_pct: pm.total_margin_pct,
      total_margin_dollars: pm.total_margin_dollars,
      project_summaries: pm.project_summaries,
    },
    utilization: calcUtilization(allStaffing),
    warnings,
  };
}

function handleEvmAnalysis(
  operation: ScenarioOperation,
  portfolio: PortfolioSnapshot,
  targetProject: ProjectSnapshot | null,
  warnings: string[],
  timestamp: string
): ScenarioResult {
  if (!targetProject) {
    warnings.push("EVM analysis requires a specific project. Using first project.");
    targetProject = portfolio.projects[0];
  }

  const current = computeState(targetProject.staffing, targetProject);

  // EVM estimation
  const bac = targetProject.total_budget;
  const ac = targetProject.spent_to_date;
  const pv = calcPlannedValue(targetProject);

  // Estimate percent complete from spend ratio as proxy
  const percentComplete = bac > 0 ? (ac / bac) * 100 : 0;
  const ev = calcEarnedValue(percentComplete, bac);

  const evm = calcEvm(bac, ac, pv, ev);

  if (evm.cpi < 1) warnings.push(`CPI ${evm.cpi.toFixed(2)} < 1: project is over budget.`);
  if (evm.spi < 1) warnings.push(`SPI ${evm.spi.toFixed(2)} < 1: project is behind schedule.`);

  return {
    operation,
    timestamp,
    project_name: targetProject.name,
    projects_involved: [targetProject.name],
    current,
    evm,
    warnings,
  };
}

function handleStaffingChange(
  operation: ScenarioOperation,
  portfolio: PortfolioSnapshot,
  targetProject: ProjectSnapshot | null,
  warnings: string[],
  timestamp: string
): ScenarioResult {
  if (!targetProject) {
    warnings.push("Staffing changes require a specific project. Using first project.");
    targetProject = portfolio.projects[0];
  }

  const beforeStaffing = targetProject.staffing;
  const before = computeState(beforeStaffing, targetProject);

  // Apply the mutation
  let afterStaffing: StaffingRecord[];
  switch (operation.action) {
    case "swap":
      afterStaffing = applySwap(
        beforeStaffing, portfolio.labor_categories,
        operation.remove, operation.add,
        targetProject.id, targetProject.name
      );
      break;
    case "add":
      afterStaffing = applyAdd(
        beforeStaffing, portfolio.labor_categories,
        operation.add, targetProject.id, targetProject.name
      );
      break;
    case "remove":
      afterStaffing = applyRemove(beforeStaffing, operation.remove);
      break;
    case "rate_change":
      afterStaffing = applyRateChange(beforeStaffing, operation.rate_changes);
      break;
    case "hours_change":
      afterStaffing = applyHoursChange(beforeStaffing, operation.hours_changes);
      break;
    default:
      afterStaffing = beforeStaffing;
  }

  const after = computeState(afterStaffing, targetProject);
  const impact = calcScenarioImpact(before, after);

  // Generate warnings
  if (after.budget.months_remaining > 0 && after.budget.months_remaining < 3) {
    warnings.push(`After this change, only ${after.budget.months_remaining.toFixed(1)} months of budget remaining.`);
  }
  if (after.margin.margin_pct < 0) {
    warnings.push("This change results in a negative margin.");
  }
  if (after.budget.remaining_budget < 0) {
    warnings.push("Budget is already exhausted.");
  }

  return {
    operation,
    timestamp,
    project_name: targetProject.name,
    projects_involved: [targetProject.name],
    current: before,
    projected: after,
    impact,
    warnings,
  };
}

function handleTimelineExtension(
  operation: ScenarioOperation,
  portfolio: PortfolioSnapshot,
  targetProject: ProjectSnapshot | null,
  warnings: string[],
  timestamp: string
): ScenarioResult {
  if (!targetProject) {
    warnings.push("Timeline extension requires a specific project. Using first project.");
    targetProject = portfolio.projects[0];
  }

  const current = computeState(targetProject.staffing, targetProject);
  const extensionResult = calcTimelineExtensionImpact(
    targetProject,
    current.labor.monthly_cost,
    operation.extension_months,
    operation.new_end_date
  );

  if (extensionResult.budget_gap > 0) {
    warnings.push(`Extension creates a budget gap of $${extensionResult.budget_gap.toFixed(0)}.`);
  }

  // Projected budget after extension
  const projectedBudget = calcBudgetMetrics(
    { ...targetProject, end_date: extensionResult.new_end_date },
    current.labor.monthly_cost
  );

  return {
    operation,
    timestamp,
    project_name: targetProject.name,
    projects_involved: [targetProject.name],
    current,
    projected: {
      labor: current.labor, // staffing unchanged
      margin: current.margin, // margin unchanged
      budget: projectedBudget,
    },
    impact: {
      cost_delta_monthly: 0,
      cost_delta_annual: 0,
      revenue_delta_monthly: 0,
      revenue_delta_annual: 0,
      margin_delta_pct: 0,
      margin_delta_dollars_monthly: 0,
      burn_rate_delta: 0,
      burn_rate_delta_pct: 0,
      months_remaining_delta: projectedBudget.months_remaining - current.budget.months_remaining,
      headcount_delta: 0,
      fte_delta: 0,
    },
    warnings,
  };
}

function handleUnexpectedCost(
  operation: ScenarioOperation,
  portfolio: PortfolioSnapshot,
  targetProject: ProjectSnapshot | null,
  warnings: string[],
  timestamp: string
): ScenarioResult {
  if (!targetProject) {
    warnings.push("Unexpected cost requires a specific project. Using first project.");
    targetProject = portfolio.projects[0];
  }

  const current = computeState(targetProject.staffing, targetProject);
  const costResult = calcUnexpectedCostImpact(
    targetProject,
    current.labor.monthly_cost,
    operation.additional_costs
  );

  if (costResult.new_months_remaining > 0 && costResult.new_months_remaining < 3) {
    warnings.push(`After these costs, only ${costResult.new_months_remaining.toFixed(1)} months of budget remaining.`);
  }

  const newBurn = current.labor.monthly_cost + costResult.total_recurring_monthly;
  const projectedBudget = calcBudgetMetrics(
    {
      ...targetProject,
      spent_to_date: targetProject.spent_to_date + costResult.total_one_time,
    },
    newBurn
  );

  return {
    operation,
    timestamp,
    project_name: targetProject.name,
    projects_involved: [targetProject.name],
    current,
    projected: {
      labor: {
        ...current.labor,
        monthly_cost: newBurn,
        annual_cost: newBurn * 12,
      },
      margin: current.margin,
      budget: projectedBudget,
    },
    impact: {
      cost_delta_monthly: costResult.total_recurring_monthly,
      cost_delta_annual: costResult.total_recurring_monthly * 12 + costResult.total_one_time,
      revenue_delta_monthly: 0,
      revenue_delta_annual: 0,
      margin_delta_pct: 0,
      margin_delta_dollars_monthly: -costResult.total_recurring_monthly,
      burn_rate_delta: costResult.total_recurring_monthly,
      burn_rate_delta_pct: current.labor.monthly_cost > 0
        ? (costResult.total_recurring_monthly / current.labor.monthly_cost) * 100
        : 0,
      months_remaining_delta: projectedBudget.months_remaining - current.budget.months_remaining,
      headcount_delta: 0,
      fte_delta: 0,
    },
    warnings,
  };
}

function handleReallocation(
  operation: ScenarioOperation,
  portfolio: PortfolioSnapshot,
  warnings: string[],
  timestamp: string
): ScenarioResult {
  const projectNames = operation.projects ?? [];
  if (projectNames.length < 2) {
    warnings.push("Reallocation requires at least 2 projects.");
    return handleAnalysis(
      { ...operation, action: "burn_rate_check" },
      portfolio, null, warnings, timestamp
    );
  }

  const fromProject = resolveProject(projectNames[0], portfolio, warnings);
  const toProject = resolveProject(projectNames[1], portfolio, warnings);

  if (!fromProject || !toProject) {
    warnings.push("Could not resolve one or both projects for reallocation.");
    return handleAnalysis(
      { ...operation, action: "burn_rate_check" },
      portfolio, null, warnings, timestamp
    );
  }

  // Apply remove from source, add to destination
  const fromBefore = computeState(fromProject.staffing, fromProject);
  const toBefore = computeState(toProject.staffing, toProject);

  const fromAfterStaffing = applyRemove(fromProject.staffing, operation.remove);
  const toAfterStaffing = applyAdd(
    toProject.staffing, portfolio.labor_categories,
    operation.add, toProject.id, toProject.name
  );

  const fromAfter = computeState(fromAfterStaffing, fromProject);
  const toAfter = computeState(toAfterStaffing, toProject);

  return {
    operation,
    timestamp,
    projects_involved: [fromProject.name, toProject.name],
    current: fromBefore,
    projected: fromAfter,
    impact: calcScenarioImpact(fromBefore, fromAfter),
    sub_results: [
      {
        operation: { action: "remove", project: fromProject.name, remove: operation.remove },
        timestamp,
        project_name: fromProject.name,
        projects_involved: [fromProject.name],
        current: fromBefore,
        projected: fromAfter,
        impact: calcScenarioImpact(fromBefore, fromAfter),
        warnings: [],
      },
      {
        operation: { action: "add", project: toProject.name, add: operation.add },
        timestamp,
        project_name: toProject.name,
        projects_involved: [toProject.name],
        current: toBefore,
        projected: toAfter,
        impact: calcScenarioImpact(toBefore, toAfter),
        warnings: [],
      },
    ],
    warnings,
  };
}

function handleComposite(
  operation: ScenarioOperation,
  portfolio: PortfolioSnapshot,
  targetProject: ProjectSnapshot | null,
  warnings: string[],
  timestamp: string
): ScenarioResult {
  if (!operation.sub_operations || operation.sub_operations.length === 0) {
    warnings.push("Composite operation has no sub-operations.");
    return handleAnalysis(
      { ...operation, action: "burn_rate_check" },
      portfolio, targetProject, warnings, timestamp
    );
  }

  const subResults = operation.sub_operations.map(subOp => executeScenario(subOp, portfolio));

  // Aggregate: use first sub-result's current as the "before" baseline
  const firstResult = subResults[0];
  const allWarnings = [...warnings, ...subResults.flatMap(r => r.warnings)];

  return {
    operation,
    timestamp,
    project_name: targetProject?.name,
    projects_involved: [...new Set(subResults.flatMap(r => r.projects_involved))],
    current: firstResult.current,
    projected: subResults[subResults.length - 1].projected,
    impact: subResults[subResults.length - 1].impact,
    sub_results: subResults,
    warnings: allWarnings,
  };
}

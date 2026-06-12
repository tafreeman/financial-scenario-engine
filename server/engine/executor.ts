import {
  type ScenarioOperation,
  type ScenarioResult,
  type PortfolioSnapshot,
  type ProjectSnapshot,
  type LaborCategory,
  type StaffingRecord,
} from "./types.js";
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

function computeState(staffing: StaffingRecord[], project: ProjectSnapshot, asOf?: Date) {
  const labor = calcProjectLabor(staffing);
  const margin = calcProjectMarginFromLabor(labor);
  const budget = calcBudgetMetrics(project, labor.monthly_cost, asOf);
  return { labor, margin, budget };
}

// ─── Main Executor ───────────────────────────────────────────────────────────

/** Execute a scenario operation against a portfolio snapshot.
 *
 *  @param operation - The structured scenario operation to execute.
 *  @param portfolio - Pre-loaded portfolio snapshot (required).  Callers are
 *    responsible for loading the portfolio via `loadPortfolioSnapshot()` from
 *    `server/loaders.ts` before calling this function.  Keeping DB I/O out of
 *    the engine makes the calculation functions pure and fully testable without
 *    filesystem access.
 *  @param asOfDate - Reference date for time-dependent calculations (timeline
 *    extension, EVM planned value, budget exhaustion date).  Defaults to the
 *    current wall-clock time when omitted.  Pass an explicit date in tests and
 *    batch runs to make outputs deterministic.
 */
export function executeScenario(
  operation: ScenarioOperation,
  portfolio: PortfolioSnapshot,
  asOfDate?: Date
): ScenarioResult {
  const warnings: string[] = [];
  const timestamp = (asOfDate ?? new Date()).toISOString();

  // Determine target project(s)
  const projectName = operation.project;
  let targetProject: ProjectSnapshot | null = null;

  if (projectName && projectName.toLowerCase() !== "all") {
    targetProject = resolveProject(projectName, portfolio, warnings);
    if (!targetProject) {
      warnings.push(`Could not resolve project "${projectName}". Showing portfolio-level analysis.`);
    }
  }

  const _projectsInvolved = targetProject
    ? [targetProject.name]
    : portfolio.projects.map(p => p.name);

  // Route to the appropriate handler
  switch (operation.action) {
    case "burn_rate_check":
    case "margin_analysis":
      return handleAnalysis(operation, portfolio, targetProject, warnings, timestamp, asOfDate);

    case "evm_analysis":
      return handleEvmAnalysis(operation, portfolio, targetProject, warnings, timestamp, asOfDate);

    case "swap":
    case "add":
    case "remove":
    case "rate_change":
    case "hours_change":
      return handleStaffingChange(operation, portfolio, targetProject, warnings, timestamp, asOfDate);

    case "timeline_extension":
      return handleTimelineExtension(operation, portfolio, targetProject, warnings, timestamp, asOfDate);

    case "unexpected_cost":
      return handleUnexpectedCost(operation, portfolio, targetProject, warnings, timestamp, asOfDate);

    case "reallocation":
      return handleReallocation(operation, portfolio, warnings, timestamp, asOfDate);

    case "what_if_composite":
      return handleComposite(operation, portfolio, targetProject, warnings, timestamp, asOfDate);

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
  timestamp: string,
  asOf?: Date
): ScenarioResult {
  if (targetProject) {
    const current = computeState(targetProject.staffing, targetProject, asOf);
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
  timestamp: string,
  asOfDate?: Date
): ScenarioResult {
  if (!targetProject) {
    warnings.push("EVM analysis requires a specific project. Using first project.");
    targetProject = portfolio.projects[0];
  }

  const current = computeState(targetProject.staffing, targetProject);

  // EVM estimation
  const bac = targetProject.total_budget;
  const ac = targetProject.spent_to_date;
  const pv = calcPlannedValue(targetProject, asOfDate);

  // Percent-complete source: prefer an explicit value from the project record;
  // fall back to the spend-ratio proxy (AC / BAC) when none is provided.
  //
  // DISCLOSURE — spend-ratio proxy limitation:
  // When percent_complete is absent, this engine estimates physical progress as
  // (AC / BAC) × 100 — i.e. it treats the fraction of budget consumed as a
  // stand-in for the fraction of work completed. This makes EV a direct
  // function of AC, which has two analytical consequences readers should be
  // aware of:
  //   • CPI (EV / AC) is mathematically pulled toward 1.0 regardless of true
  //     cost efficiency, because EV ≈ AC when the proxy is used.
  //   • SPI (EV / PV) reflects spend pace relative to the schedule baseline,
  //     not independent physical progress. If a project is overspending ahead
  //     of schedule, SPI can read > 1 even when deliverables are behind.
  // CPI and SPI are therefore not independent signals under this proxy. They
  // should be interpreted as spend-pace indicators, not true performance
  // indices, unless an explicit percent_complete is supplied.
  const rawPct = targetProject.percent_complete;
  const percentComplete = rawPct !== undefined
    ? Math.max(0, Math.min(100, rawPct))   // clamp caller-supplied value to [0, 100]
    : bac > 0 ? (ac / bac) * 100 : 0;     // spend-ratio proxy fallback (see disclosure above)
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
  timestamp: string,
  asOf?: Date
): ScenarioResult {
  if (!targetProject) {
    warnings.push("Staffing changes require a specific project. Using first project.");
    targetProject = portfolio.projects[0];
  }

  const beforeStaffing = targetProject.staffing;
  const before = computeState(beforeStaffing, targetProject, asOf);

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

  const after = computeState(afterStaffing, targetProject, asOf);
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
  timestamp: string,
  asOfDate?: Date
): ScenarioResult {
  if (!targetProject) {
    warnings.push("Timeline extension requires a specific project. Using first project.");
    targetProject = portfolio.projects[0];
  }

  const current = computeState(targetProject.staffing, targetProject, asOfDate);
  const extensionResult = calcTimelineExtensionImpact(
    targetProject,
    current.labor.monthly_cost,
    operation.extension_months,
    operation.new_end_date,
    asOfDate
  );

  if (extensionResult.budget_gap > 0) {
    warnings.push(`Extension creates a budget gap of $${extensionResult.budget_gap.toFixed(0)}.`);
  }

  // Projected budget after extension
  const projectedBudget = calcBudgetMetrics(
    { ...targetProject, end_date: extensionResult.new_end_date },
    current.labor.monthly_cost,
    asOfDate
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
  timestamp: string,
  asOf?: Date
): ScenarioResult {
  if (!targetProject) {
    warnings.push("Unexpected cost requires a specific project. Using first project.");
    targetProject = portfolio.projects[0];
  }

  const current = computeState(targetProject.staffing, targetProject, asOf);
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
    newBurn,
    asOf
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
  timestamp: string,
  asOf?: Date
): ScenarioResult {
  const projectNames = operation.projects ?? [];
  if (projectNames.length < 2) {
    warnings.push("Reallocation requires at least 2 projects.");
    return handleAnalysis(
      { ...operation, action: "burn_rate_check" },
      portfolio, null, warnings, timestamp, asOf
    );
  }

  const fromProject = resolveProject(projectNames[0], portfolio, warnings);
  const toProject = resolveProject(projectNames[1], portfolio, warnings);

  if (!fromProject || !toProject) {
    warnings.push("Could not resolve one or both projects for reallocation.");
    return handleAnalysis(
      { ...operation, action: "burn_rate_check" },
      portfolio, null, warnings, timestamp, asOf
    );
  }

  // Apply remove from source, add to destination
  const fromBefore = computeState(fromProject.staffing, fromProject, asOf);
  const toBefore = computeState(toProject.staffing, toProject, asOf);

  const fromAfterStaffing = applyRemove(fromProject.staffing, operation.remove);
  const toAfterStaffing = applyAdd(
    toProject.staffing, portfolio.labor_categories,
    operation.add, toProject.id, toProject.name
  );

  const fromAfter = computeState(fromAfterStaffing, fromProject, asOf);
  const toAfter = computeState(toAfterStaffing, toProject, asOf);

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
  timestamp: string,
  asOfDate?: Date
): ScenarioResult {
  if (!operation.sub_operations || operation.sub_operations.length === 0) {
    warnings.push("Composite operation has no sub-operations.");
    return handleAnalysis(
      { ...operation, action: "burn_rate_check" },
      portfolio, targetProject, warnings, timestamp
    );
  }

  const subResults = operation.sub_operations.map(subOp => executeScenario(subOp, portfolio, asOfDate));

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

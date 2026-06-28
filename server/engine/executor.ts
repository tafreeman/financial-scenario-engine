import {
  type ScenarioOperation,
  type ScenarioResult,
  type ScenarioImpact,
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

/** Build a minimal error ScenarioResult (no financials) */
function errorResult(
  operation: ScenarioOperation,
  timestamp: string,
  errorMsg: string
): ScenarioResult {
  return {
    operation,
    timestamp,
    projects_involved: [],
    current: {
      labor: {
        monthly_cost: 0, monthly_revenue: 0, annual_cost: 0, annual_revenue: 0,
        blended_cost_rate: 0, blended_bill_rate: 0, fte_count: 0, headcount: 0,
      },
      margin: {
        margin_pct: 0, margin_dollars_monthly: 0, margin_dollars_annual: 0,
        gross_margin_pct: 0, contribution_margin: 0, net_direct_labor_multiplier: 0,
      },
      budget: {
        monthly_burn_rate: 0, remaining_budget: 0, months_remaining: 0,
        budget_exhaustion_date: "N/A", annual_run_rate: 0,
      },
    },
    error: errorMsg,
    warnings: [errorMsg],
  };
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

  // Actions that require a specific named project — NOT portfolio-level actions.
  // burn_rate_check and margin_analysis legitimately fall back to portfolio-wide
  // analysis when no project (or "all") is specified.
  const requiresNamedProject =
    operation.action !== "burn_rate_check" &&
    operation.action !== "margin_analysis" &&
    operation.action !== "reallocation" &&
    operation.action !== "what_if_composite";

  if (projectName && projectName.toLowerCase() !== "all") {
    targetProject = resolveProject(projectName, portfolio, warnings);
    if (!targetProject) {
      if (requiresNamedProject) {
        // The caller named a specific project that does not exist in the portfolio.
        // Return a clean error instead of silently operating on portfolio.projects[0].
        return errorResult(
          operation, timestamp,
          `Unknown project "${projectName}". No matching project found in the portfolio.`
        );
      }
      warnings.push(`Could not resolve project "${projectName}". Showing portfolio-level analysis.`);
    }
  }

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

    default: {
      // Exhaustiveness guard: TypeScript will flag any unhandled action enum value
      // added to ScenarioOperation in the future.
      const _exhaustive: never = operation.action;
      void _exhaustive;
      warnings.push(`Unknown action: ${String(operation.action)}. Defaulting to burn rate check.`);
      return handleAnalysis(
        { ...operation, action: "burn_rate_check" },
        portfolio, targetProject, warnings, timestamp, asOfDate
      );
    }
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
  // #13 / #7: A NAMED-but-unresolvable project is already rejected upstream in
  // executeScenario() — evm_analysis is in `requiresNamedProject`, so an unknown
  // operation.project returns errorResult before reaching this handler. Therefore
  // targetProject === null here means ONLY the no-project-specified case (the
  // caller asked for EVM without naming a project at all).
  if (!targetProject) {
    // EVM is a project-specific analysis; with no project named there is no
    // correct default. Silently using projects[0] would report another project's
    // numbers under the caller's request, so return an explicit error instead.
    return errorResult(
      operation,
      timestamp,
      portfolio.projects.length === 0
        ? "EVM analysis requires a specific project but the portfolio is empty."
        : "EVM analysis requires a specific project. Name the project to analyze."
    );
  }

  const current = computeState(targetProject.staffing, targetProject, asOfDate);

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
  // #13: return an explicit error result when no project can be resolved.
  // Staffing changes target one project's roster; with no project named there is
  // no correct default, so error rather than silently mutating projects[0].
  if (!targetProject) {
    return errorResult(
      operation,
      timestamp,
      portfolio.projects.length === 0
        ? `Staffing changes require a specific project but the portfolio is empty.`
        : `Staffing changes require a specific project. Name the project to modify.`
    );
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
  // #13: return an explicit error result when no project can be resolved
  if (!targetProject) {
    if (portfolio.projects.length === 0) {
      return errorResult(operation, timestamp, "Timeline extension requires a specific project but the portfolio is empty.");
    }
    warnings.push("Timeline extension requires a specific project. Using first project.");
    // Safe because we just checked length > 0
    targetProject = portfolio.projects[0] as ProjectSnapshot;
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
  // #13: return an explicit error result when no project can be resolved
  if (!targetProject) {
    if (portfolio.projects.length === 0) {
      return errorResult(operation, timestamp, "Unexpected cost requires a specific project but the portfolio is empty.");
    }
    warnings.push("Unexpected cost requires a specific project. Using first project.");
    // Safe because we just checked length > 0
    targetProject = portfolio.projects[0] as ProjectSnapshot;
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

  const [fromName, toName] = projectNames;
  if (!fromName || !toName) {
    return errorResult(operation, timestamp, "Reallocation requires exactly two resolvable project names.");
  }
  const fromProject = resolveProject(fromName, portfolio, warnings);
  const toProject = resolveProject(toName, portfolio, warnings);

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
      portfolio, targetProject, warnings, timestamp, asOfDate
    );
  }

  // #20: Thread accumulated state through sub-operations.
  // Each sub-op runs against the UPDATED portfolio from the previous sub-op,
  // so two same-project staffing changes see the correct intermediate state.
  let accPortfolio = portfolio;
  const subResults: ScenarioResult[] = [];
  for (const subOp of operation.sub_operations) {
    const result = executeScenario(subOp, accPortfolio, asOfDate);
    subResults.push(result);
    // Rebuild portfolio by replaying the sub-op's mutations onto the accumulated snapshot.
    // Pass the resolved canonical names from the result so that abbreviated project
    // names (e.g. "Alpha" → "Project Alpha") are matched correctly in the portfolio.
    accPortfolio = mergeProjectedState(
      accPortfolio,
      subOp,
      result.project_name,
      result.projects_involved.length > 0 ? result.projects_involved : undefined
    );
  }

  // #12: Aggregate impact — sum all non-null impact deltas rather than returning
  // the last sub-result's impact, which gives wrong results for multi-project composites.
  const multiProject = [...new Set(subResults.flatMap(r => r.projects_involved))].length > 1;
  const aggregateImpact = sumImpacts(subResults, multiProject);
  const allWarnings = [...warnings, ...subResults.flatMap(r => r.warnings)];

  // For multi-project composites current/projected are not meaningful aggregates;
  // the individual sub_results carry the per-project before/after state.
  // For single-project composites we use the first sub-result's current and last's projected.
  const firstSubResult = subResults[0];
  const lastSubResult = subResults[subResults.length - 1];
  const current = (multiProject || !firstSubResult)
    ? {
        labor: { monthly_cost: 0, monthly_revenue: 0, annual_cost: 0, annual_revenue: 0, blended_cost_rate: 0, blended_bill_rate: 0, fte_count: 0, headcount: 0 },
        margin: { margin_pct: 0, margin_dollars_monthly: 0, margin_dollars_annual: 0, gross_margin_pct: 0, contribution_margin: 0, net_direct_labor_multiplier: 0 },
        budget: { monthly_burn_rate: 0, remaining_budget: 0, months_remaining: 0, budget_exhaustion_date: "N/A", annual_run_rate: 0 },
      }
    : firstSubResult.current;

  return {
    operation,
    timestamp,
    project_name: targetProject?.name,
    projects_involved: [...new Set(subResults.flatMap(r => r.projects_involved))],
    current,
    projected: multiProject ? undefined : lastSubResult?.projected,
    impact: aggregateImpact,
    sub_results: subResults,
    warnings: allWarnings,
  };
}

// ─── Composite helpers ────────────────────────────────────────────────────────

/**
 * After a sub-operation in a composite, rebuild the portfolio by re-applying
 * the staffing mutation to the affected project.  This ensures the next
 * sub-operation sees the accumulated mutations rather than the original snapshot
 * — fixing the "same-project sub-ops see un-mutated state" bug (#20).
 *
 * Since ScenarioResult doesn't carry the raw afterStaffing array, we re-derive
 * the updated staffing by replaying the same apply* functions used in the handler.
 */
/**
 * Rebuild the accumulated portfolio state after a sub-operation completes.
 *
 * @param resolvedProjectName - The canonical project name returned by executeScenario
 *   in result.project_name.  When provided this takes priority over subOp.project
 *   because executeScenario already ran fuzzy/abbreviation matching, so
 *   "Alpha" → "Project Alpha".  Passing the raw subOp.project string here
 *   breaks later sub-ops when the user supplied an abbreviated name.
 * @param resolvedProjectsInvolved - For reallocation sub-ops: the resolved canonical
 *   project names from result.projects_involved, used instead of subOp.projects.
 */
function mergeProjectedState(
  portfolio: PortfolioSnapshot,
  subOp: ScenarioOperation,
  resolvedProjectName?: string,
  resolvedProjectsInvolved?: string[]
): PortfolioSnapshot {
  switch (subOp.action) {
    case "swap":
    case "add":
    case "remove":
    case "rate_change":
    case "hours_change": {
      // Prefer the resolved canonical name; fall back to the raw op name only
      // when resolution wasn't available (e.g. direct calls from tests).
      const projectName = resolvedProjectName ?? subOp.project;
      if (!projectName || projectName.toLowerCase() === "all") return portfolio;
      const projects = portfolio.projects.map(p => {
        if (p.name.toLowerCase() !== projectName.toLowerCase()) return p;
        let updated: StaffingRecord[];
        switch (subOp.action) {
          case "swap":
            updated = applySwap(p.staffing, portfolio.labor_categories, subOp.remove, subOp.add, p.id, p.name);
            break;
          case "add":
            updated = applyAdd(p.staffing, portfolio.labor_categories, subOp.add, p.id, p.name);
            break;
          case "remove":
            updated = applyRemove(p.staffing, subOp.remove);
            break;
          case "rate_change":
            updated = applyRateChange(p.staffing, subOp.rate_changes);
            break;
          case "hours_change":
            updated = applyHoursChange(p.staffing, subOp.hours_changes);
            break;
          default:
            updated = p.staffing;
        }
        return { ...p, staffing: updated };
      });
      return { ...portfolio, projects };
    }
    case "unexpected_cost": {
      // Patch spent_to_date for one-time costs so subsequent sub-ops see correct budget
      // Use the resolved name if available, otherwise fall back to the raw op name.
      const projectName = resolvedProjectName ?? subOp.project;
      if (!projectName || projectName.toLowerCase() === "all") return portfolio;
      const additionalOneTime = (subOp.additional_costs ?? [])
        .filter(c => !c.is_recurring)
        .reduce((s, c) => s + c.amount, 0);
      if (additionalOneTime === 0) return portfolio;
      const projects = portfolio.projects.map(p =>
        p.name.toLowerCase() !== projectName.toLowerCase()
          ? p
          : { ...p, spent_to_date: p.spent_to_date + additionalOneTime }
      );
      return { ...portfolio, projects };
    }
    case "reallocation": {
      // Replay remove from source, add to destination.
      // Prefer resolved project names (from ScenarioResult.projects_involved) over the
      // raw subOp.projects strings so that abbreviated names fuzzy-matched during
      // execution are correctly applied here too.
      const resolvedNames = resolvedProjectsInvolved ?? subOp.projects ?? [];
      const fromName = resolvedNames[0];
      const toName = resolvedNames[1];
      if (!fromName || !toName) return portfolio;
      const projects = portfolio.projects.map(p => {
        if (p.name.toLowerCase() === fromName.toLowerCase()) {
          return { ...p, staffing: applyRemove(p.staffing, subOp.remove) };
        }
        if (p.name.toLowerCase() === toName.toLowerCase()) {
          return { ...p, staffing: applyAdd(p.staffing, portfolio.labor_categories, subOp.add, p.id, p.name) };
        }
        return p;
      });
      return { ...portfolio, projects };
    }
    default:
      // Analysis-only or composite — no staffing state change to propagate
      return portfolio;
  }
}

/**
 * Sum all non-null impact deltas across sub-results to form the composite
 * aggregate (#12).
 *
 * @param multiProject - When true the composite spans more than one project.
 *   In that case, margin_delta_pct and burn_rate_delta_pct are intentionally
 *   omitted from the aggregate: percentage-point deltas from *different*
 *   projects are not additive — summing them yields a dimensionless-meaningless
 *   number.  Dollar/headcount/fte deltas ARE additive across projects and are
 *   always summed.
 *
 *   months_remaining_delta is also omitted for multi-project composites: each
 *   project has its own remaining budget, so the sum of per-project month
 *   changes is not a coherent portfolio-level figure.
 *
 *   For single-project composites all fields are summed normally (valid).
 */
function sumImpacts(subResults: ScenarioResult[], multiProject: boolean): ScenarioImpact {
  const impacts = subResults
    .map(r => r.impact)
    .filter((i): i is ScenarioImpact => i != null);

  return {
    cost_delta_monthly: impacts.reduce((s, i) => s + i.cost_delta_monthly, 0),
    cost_delta_annual: impacts.reduce((s, i) => s + i.cost_delta_annual, 0),
    revenue_delta_monthly: impacts.reduce((s, i) => s + i.revenue_delta_monthly, 0),
    revenue_delta_annual: impacts.reduce((s, i) => s + i.revenue_delta_annual, 0),
    // Percentage-point deltas are not additive across projects; omit for multi-project.
    margin_delta_pct: multiProject ? undefined : impacts.reduce((s, i) => s + (i.margin_delta_pct ?? 0), 0),
    margin_delta_dollars_monthly: impacts.reduce((s, i) => s + i.margin_delta_dollars_monthly, 0),
    burn_rate_delta: impacts.reduce((s, i) => s + i.burn_rate_delta, 0),
    // Percentage-point deltas are not additive across projects; omit for multi-project.
    burn_rate_delta_pct: multiProject ? undefined : impacts.reduce((s, i) => s + (i.burn_rate_delta_pct ?? 0), 0),
    // months_remaining is per-project; summing across projects is not meaningful.
    months_remaining_delta: multiProject ? 0 : impacts.reduce((s, i) => s + i.months_remaining_delta, 0),
    headcount_delta: impacts.reduce((s, i) => s + i.headcount_delta, 0),
    fte_delta: impacts.reduce((s, i) => s + i.fte_delta, 0),
  };
}

/**
 * Template-based narrative renderer (server-side).
 * Generates deterministic markdown narratives from ScenarioResult objects
 * without requiring an LLM call. This is a local-only alternative to the
 * LLM narration in V2.
 */
import type { ScenarioResult } from "./types.js";

/** Format a number as a dollar string: "$1,234" */
function fmt(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

/** Format a signed delta: "+$1,234" or "-$1,234" */
function fmtDelta(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  return sign + fmt(Math.abs(n));
}

/** Format percentage to one decimal: "24.5%" */
function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

/** Format a signed percentage delta: "+3.2%" or "-1.5%" */
function fmtPctDelta(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

/** Produce a human-readable action label */
function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    swap: "Staffing Swap",
    add: "Staff Addition",
    remove: "Staff Removal",
    rate_change: "Rate Change",
    hours_change: "Hours Change",
    timeline_extension: "Timeline Extension",
    unexpected_cost: "Unexpected Cost",
    reallocation: "Staff Reallocation",
    burn_rate_check: "Burn Rate Analysis",
    margin_analysis: "Margin Analysis",
    evm_analysis: "Earned Value Analysis",
    what_if_composite: "Composite What-If Analysis",
  };
  return labels[action] ?? action.replace(/_/g, " ");
}

/** Generate impact summary section */
function renderImpactSummary(result: ScenarioResult): string {
  const action = result.operation?.action ?? "analysis";
  const project = result.project_name ?? result.projects_involved?.join(" and ") ?? "the portfolio";
  const label = actionLabel(action);

  if (result.impact) {
    const { cost_delta_monthly, margin_delta_pct, headcount_delta, months_remaining_delta } = result.impact;
    const costDir = cost_delta_monthly > 0 ? "increase" : cost_delta_monthly < 0 ? "decrease" : "no change in";
    const lines = [`This **${label}** on **${project}** would result in a monthly cost ${costDir} of **${fmt(Math.abs(cost_delta_monthly))}**.`];

    if (margin_delta_pct !== 0) {
      const marginDir = margin_delta_pct > 0 ? "improve" : "decrease";
      lines.push(`Margin would ${marginDir} by **${fmtPct(Math.abs(margin_delta_pct))}** percentage points.`);
    }
    if (headcount_delta !== 0) {
      lines.push(`Net headcount change: **${headcount_delta > 0 ? "+" : ""}${headcount_delta}**.`);
    }
    if (months_remaining_delta !== 0) {
      const budgetDir = months_remaining_delta > 0 ? "extend" : "reduce";
      lines.push(`Budget runway would ${budgetDir} by **${Math.abs(months_remaining_delta).toFixed(1)} months**.`);
    }
    return lines.join(" ");
  }

  // Analysis-only (no projected state)
  if (result.portfolio) {
    return `**${label}** across **${result.projects_involved.length} projects** shows a total monthly burn of **${fmt(result.portfolio.total_burn)}** with a blended margin of **${fmtPct(result.portfolio.total_margin_pct)}**.`;
  }

  return `**${label}** for **${project}**: current monthly cost is **${fmt(result.current.labor.monthly_cost)}** with a margin of **${fmtPct(result.current.margin.margin_pct)}**.`;
}

/** Generate the financial delta table */
function renderDeltaTable(result: ScenarioResult): string {
  if (!result.projected) return "";

  const { current, projected } = result;
  const rows = [
    ["Monthly Cost", fmt(current.labor.monthly_cost), fmt(projected.labor.monthly_cost), fmtDelta(projected.labor.monthly_cost - current.labor.monthly_cost)],
    ["Monthly Revenue", fmt(current.labor.monthly_revenue), fmt(projected.labor.monthly_revenue), fmtDelta(projected.labor.monthly_revenue - current.labor.monthly_revenue)],
    ["Margin %", fmtPct(current.margin.margin_pct), fmtPct(projected.margin.margin_pct), fmtPctDelta(projected.margin.margin_pct - current.margin.margin_pct)],
    ["Burn Rate / Mo", fmt(current.budget.monthly_burn_rate), fmt(projected.budget.monthly_burn_rate), fmtDelta(projected.budget.monthly_burn_rate - current.budget.monthly_burn_rate)],
    ["Months Remaining", current.budget.months_remaining.toFixed(1), projected.budget.months_remaining.toFixed(1), `${(projected.budget.months_remaining - current.budget.months_remaining) >= 0 ? "+" : ""}${(projected.budget.months_remaining - current.budget.months_remaining).toFixed(1)}`],
    ["Headcount", String(current.labor.headcount), String(projected.labor.headcount), `${(projected.labor.headcount - current.labor.headcount) >= 0 ? "+" : ""}${projected.labor.headcount - current.labor.headcount}`],
    ["FTE", current.labor.fte_count.toFixed(1), projected.labor.fte_count.toFixed(1), `${(projected.labor.fte_count - current.labor.fte_count) >= 0 ? "+" : ""}${(projected.labor.fte_count - current.labor.fte_count).toFixed(1)}`],
  ];

  let table = "| Metric | Before | After | Change |\n";
  table += "|--------|--------|-------|--------|\n";
  for (const [metric, before, after, change] of rows) {
    table += `| ${metric} | ${before} | ${after} | ${change} |\n`;
  }
  return table;
}

/** Generate key observations */
function renderObservations(result: ScenarioResult): string[] {
  const obs: string[] = [];
  const { current } = result;

  if (result.impact) {
    const { cost_delta_monthly, revenue_delta_monthly, margin_delta_pct, burn_rate_delta_pct } = result.impact;
    if (cost_delta_monthly < 0 && revenue_delta_monthly < 0) {
      obs.push("Both cost and revenue decrease — ensure the revenue loss is acceptable.");
    }
    if (cost_delta_monthly > 0 && margin_delta_pct > 0) {
      obs.push("Cost increases but margin improves — the additional revenue outpaces the cost.");
    }
    if (Math.abs(burn_rate_delta_pct) > 20) {
      obs.push(`Burn rate changes significantly (${fmtPctDelta(burn_rate_delta_pct)}) — monitor budget runway closely.`);
    }
  }

  if (current.margin.margin_pct > 30) {
    obs.push(`Current margin of ${fmtPct(current.margin.margin_pct)} is healthy.`);
  } else if (current.margin.margin_pct > 0) {
    obs.push(`Current margin of ${fmtPct(current.margin.margin_pct)} is below typical target of 30%.`);
  }

  if (current.budget.months_remaining > 0 && current.budget.months_remaining < 6) {
    obs.push(`Only ${current.budget.months_remaining.toFixed(1)} months of budget remaining — consider budget planning.`);
  }

  if (result.evm) {
    const { cpi, spi } = result.evm;
    if (cpi < 1) obs.push(`CPI of ${cpi.toFixed(2)} indicates the project is over budget.`);
    if (spi < 1) obs.push(`SPI of ${spi.toFixed(2)} indicates the project is behind schedule.`);
    if (cpi >= 1) obs.push(`CPI of ${cpi.toFixed(2)} indicates cost performance is on or under budget.`);
    if (spi >= 1) obs.push(`SPI of ${spi.toFixed(2)} indicates schedule performance is on or ahead.`);
  }

  return obs;
}

/** Generate risks section */
function renderRisks(result: ScenarioResult): string[] {
  const risks: string[] = [];

  for (const w of result.warnings) {
    risks.push(w);
  }

  if (result.projected) {
    if (result.projected.margin.margin_pct < 0) {
      risks.push("⚠️ This change results in a **negative margin** — the project would be losing money.");
    } else if (result.projected.margin.margin_pct < 15) {
      risks.push(`Projected margin of ${fmtPct(result.projected.margin.margin_pct)} is dangerously thin.`);
    }

    if (result.projected.budget.remaining_budget < 0) {
      risks.push("⚠️ Budget is **exhausted** — no remaining funds.");
    }

    if (result.projected.budget.months_remaining > 0 && result.projected.budget.months_remaining < 3) {
      risks.push(`Only ${result.projected.budget.months_remaining.toFixed(1)} months of budget remaining after this change.`);
    }
  }

  if (result.portfolio) {
    for (const p of result.portfolio.project_summaries) {
      if (p.months_remaining > 0 && p.months_remaining < 3) {
        risks.push(`**${p.name}**: only ${p.months_remaining.toFixed(1)} months of budget remaining.`);
      }
      if (p.margin_pct < 15) {
        risks.push(`**${p.name}**: margin of ${fmtPct(p.margin_pct)} is below healthy threshold.`);
      }
    }
  }

  return risks;
}

/** Generate recommendation */
function renderRecommendation(result: ScenarioResult): string {
  if (result.impact) {
    const { cost_delta_monthly, margin_delta_pct, months_remaining_delta } = result.impact;

    if (cost_delta_monthly < 0 && margin_delta_pct >= 0) {
      return "This change reduces costs while maintaining or improving margins — **recommend proceeding** with appropriate stakeholder review.";
    }
    if (cost_delta_monthly > 0 && months_remaining_delta < -2) {
      return "This change significantly reduces budget runway — **consider alternatives** that achieve the same goal with lower cost impact.";
    }
    if (margin_delta_pct < -5) {
      return "Significant margin compression — **explore alternative staffing models** before implementing.";
    }
    return "Review the numbers above and assess alignment with project goals before making changes.";
  }

  if (result.evm) {
    if (result.evm.cpi < 1 || result.evm.spi < 1) {
      return "Project performance indices are below 1.0 — **initiate a corrective action plan** to address cost or schedule variances.";
    }
    return "Project performance is on track — continue monitoring key EVM indicators.";
  }

  if (result.portfolio) {
    const atRisk = result.portfolio.project_summaries.filter(p => p.months_remaining > 0 && p.months_remaining < 3);
    if (atRisk.length > 0) {
      return `${atRisk.length} project(s) have less than 3 months of budget remaining — **prioritize budget reviews** for these projects.`;
    }
    return "Portfolio health appears stable — continue regular monitoring.";
  }

  return "Review the current state metrics and determine if any adjustments are needed.";
}

/**
 * Generate a complete markdown narrative from a ScenarioResult.
 * This is a deterministic, template-based replacement for the LLM narration step.
 */
export function generateNarrative(result: ScenarioResult): string {
  const sections: string[] = [];

  // Impact Summary
  sections.push("## Impact Summary\n");
  sections.push(renderImpactSummary(result));

  // Financial Delta table
  const deltaTable = renderDeltaTable(result);
  if (deltaTable) {
    sections.push("\n\n## Financial Delta\n");
    sections.push(deltaTable);
  }

  // Portfolio table
  if (result.portfolio) {
    sections.push("\n\n## Portfolio Overview\n");
    let table = "| Project | Burn / Mo | Margin | Margin $ / Mo | Months Left |\n";
    table += "|---------|-----------|--------|----------------|-------------|\n";
    for (const p of result.portfolio.project_summaries) {
      table += `| ${p.name} | ${fmt(p.monthly_burn)} | ${fmtPct(p.margin_pct)} | — | ${p.months_remaining.toFixed(1)} |\n`;
    }
    table += `| **Portfolio Total** | **${fmt(result.portfolio.total_burn)}** | **${fmtPct(result.portfolio.total_margin_pct)}** | **${fmt(result.portfolio.total_margin_dollars)}/mo** | **—** |\n`;
    sections.push(table);
  }

  // EVM summary
  if (result.evm) {
    sections.push("\n\n## Earned Value Metrics\n");
    let table = "| Metric | Value | Status |\n";
    table += "|--------|-------|--------|\n";
    table += `| CPI | ${result.evm.cpi.toFixed(3)} | ${result.evm.cpi >= 1 ? "✅ On/under budget" : "⚠️ Over budget"} |\n`;
    table += `| SPI | ${result.evm.spi.toFixed(3)} | ${result.evm.spi >= 1 ? "✅ On/ahead of schedule" : "⚠️ Behind schedule"} |\n`;
    table += `| EAC (typical) | ${fmt(result.evm.eac_typical)} | If current CPI persists |\n`;
    table += `| EAC (atypical) | ${fmt(result.evm.eac_atypical)} | If variance was one-time |\n`;
    table += `| VAC | ${fmt(result.evm.vac)} | ${result.evm.vac >= 0 ? "Under budget at completion" : "Over budget at completion"} |\n`;
    table += `| TCPI | ${result.evm.tcpi.toFixed(3)} | CPI needed to finish on budget |\n`;
    sections.push(table);
  }

  // Key Observations
  const observations = renderObservations(result);
  if (observations.length > 0) {
    sections.push("\n\n## Key Observations\n");
    for (const o of observations) {
      sections.push(`- ${o}\n`);
    }
  }

  // Risks
  const risks = renderRisks(result);
  if (risks.length > 0) {
    sections.push("\n\n## Risks\n");
    for (const r of risks) {
      sections.push(`- ${r}\n`);
    }
  }

  // Recommendation
  sections.push("\n\n## Recommendation\n");
  sections.push(renderRecommendation(result));

  return sections.join("");
}

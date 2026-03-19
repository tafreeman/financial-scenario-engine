/**
 * Validation script: runs engine calculations against the seed data
 * and prints results for manual verification with a calculator/spreadsheet.
 *
 * Run with: npx tsx server/engine/__tests__/validate-seed-data.ts
 */

import {
  WEEKS_PER_MONTH,
  WEEKS_PER_YEAR,
  type StaffingRecord,
  type LaborCategory,
  type ProjectSnapshot,
} from "../types.js";
import {
  monthlyCost,
  monthlyRevenue,
  annualCost,
  annualRevenue,
  calcProjectLabor,
  calcBlendedCostRate,
  calcBlendedBillRate,
  calcTotalFTE,
} from "../labor.js";
import { calcProjectMargin, calcPersonMarginPct } from "../margin.js";
import { calcBudgetMetrics, calcRemainingBudget } from "../budget.js";
import { calcEvm, calcPlannedValue, calcEarnedValue } from "../evm.js";
import { calcUtilization } from "../utilization.js";
import {
  applySwap,
  applyAdd,
  applyRemove,
  applyHoursChange,
  calcScenarioImpact,
  calcTimelineExtensionImpact,
} from "../scenarios.js";
import { calcPortfolioBurn, calcPortfolioMargin, calcProjectSummaries } from "../portfolio.js";

// ─── Seed Data (exact copy from db.ts seedSampleData) ───────────────────────

const categories: LaborCategory[] = [
  { id: 1, name: "Lead Architect", bill_rate: 285, cost_rate: 210 },
  { id: 2, name: "Senior Developer", bill_rate: 245, cost_rate: 185 },
  { id: 3, name: "Mid-level Developer", bill_rate: 185, cost_rate: 135 },
  { id: 4, name: "Junior Developer", bill_rate: 135, cost_rate: 95 },
  { id: 5, name: "Business Analyst", bill_rate: 175, cost_rate: 125 },
  { id: 6, name: "QA Engineer", bill_rate: 165, cost_rate: 115 },
  { id: 7, name: "Project Manager", bill_rate: 225, cost_rate: 165 },
  { id: 8, name: "Scrum Master", bill_rate: 195, cost_rate: 145 },
];

function makeStaff(
  id: number, projectId: number, projectName: string,
  catId: number, personName: string, hours: number
): StaffingRecord {
  const cat = categories.find(c => c.id === catId)!;
  return {
    id, project_id: projectId, project_name: projectName,
    labor_category_id: catId, labor_category: cat.name,
    person_name: personName, hours_per_week: hours,
    bill_rate: cat.bill_rate, cost_rate: cat.cost_rate, is_active: 1,
  };
}

// Alpha staffing: Sr Dev (40hr), Mid Dev (40hr), BA (30hr)
const alphaStaffing: StaffingRecord[] = [
  makeStaff(1, 1, "Project Alpha", 2, "J. Smith", 40),  // Senior Developer
  makeStaff(2, 1, "Project Alpha", 3, "K. Chen", 40),   // Mid-level Developer
  makeStaff(3, 1, "Project Alpha", 5, "L. Park", 30),   // Business Analyst
];

// Beta staffing: Lead Arch (40hr), Sr Dev (40hr), QA (40hr)
const betaStaffing: StaffingRecord[] = [
  makeStaff(4, 2, "Project Beta", 1, "M. Jones", 40),   // Lead Architect
  makeStaff(5, 2, "Project Beta", 2, "N. Davis", 40),   // Senior Developer
  makeStaff(6, 2, "Project Beta", 6, "P. Wilson", 40),  // QA Engineer
];

// Gamma staffing: Mid Dev (40hr), Jr Dev (40hr)
const gammaStaffing: StaffingRecord[] = [
  makeStaff(7, 3, "Project Gamma", 3, "R. Brown", 40),  // Mid-level Developer
  makeStaff(8, 3, "Project Gamma", 4, "S. Lee", 40),    // Junior Developer
];

const alphaProject: ProjectSnapshot = {
  id: 1, name: "Project Alpha", total_budget: 1250000, spent_to_date: 485000,
  start_date: "2025-10-01", end_date: "2026-09-30", status: "active",
  staffing: alphaStaffing,
};

const betaProject: ProjectSnapshot = {
  id: 2, name: "Project Beta", total_budget: 2100000, spent_to_date: 1340000,
  start_date: "2025-04-01", end_date: "2026-03-31", status: "active",
  staffing: betaStaffing,
};

const gammaProject: ProjectSnapshot = {
  id: 3, name: "Project Gamma", total_budget: 680000, spent_to_date: 210000,
  start_date: "2026-01-15", end_date: "2026-12-31", status: "active",
  staffing: gammaStaffing,
};

const allProjects = [alphaProject, betaProject, gammaProject];

// ─── Helper ──────────────────────────────────────────────────────────────────

function fmt(n: number): string { return "$" + n.toFixed(2); }
function fmtK(n: number): string { return "$" + Math.round(n).toLocaleString(); }
function hr() { console.log("─".repeat(80)); }

// ─── Validation Runs ─────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(80));
console.log("  FINANCIAL ENGINE VALIDATION — Seed Data");
console.log("  Constants: WEEKS_PER_MONTH = " + WEEKS_PER_MONTH + ", WEEKS_PER_YEAR = " + WEEKS_PER_YEAR);
console.log("═".repeat(80));

// ─── 1. Rate Card Verification ───────────────────────────────────────────────
console.log("\n📋 RATE CARD");
hr();
console.log("Role                    | Bill $/hr | Cost $/hr | Margin %");
hr();
for (const c of categories) {
  const marginPct = calcPersonMarginPct(c.bill_rate, c.cost_rate);
  console.log(
    `${c.name.padEnd(24)}| ${("$" + c.bill_rate).padEnd(10)}| ${("$" + c.cost_rate).padEnd(10)}| ${marginPct.toFixed(1)}%`
  );
}

// ─── 2. Per-Person Monthly Costs (verify formula: rate × hours × 4.33) ──────
console.log("\n\n📊 PER-PERSON MONTHLY CALCULATIONS");
console.log("Formula: rate × hours_per_week × " + WEEKS_PER_MONTH);
hr();
console.log("Person      | Role             | Hrs | Cost Rate | Monthly Cost      | Bill Rate | Monthly Revenue");
hr();

const allStaffing = [...alphaStaffing, ...betaStaffing, ...gammaStaffing];
for (const s of allStaffing) {
  const mc = monthlyCost(s.cost_rate, s.hours_per_week);
  const mr = monthlyRevenue(s.bill_rate, s.hours_per_week);
  console.log(
    `${(s.person_name ?? "TBD").padEnd(12)}| ${s.labor_category.padEnd(17)}| ${String(s.hours_per_week).padEnd(4)}| ${("$" + s.cost_rate).padEnd(10)}| ${fmt(mc).padEnd(18)}| ${("$" + s.bill_rate).padEnd(10)}| ${fmt(mr)}`
  );
  // Show the formula explicitly
  console.log(
    `${"".padEnd(12)}| ${"".padEnd(17)}|     | ${"".padEnd(10)}| = ${s.cost_rate} × ${s.hours_per_week} × ${WEEKS_PER_MONTH} | ${"".padEnd(10)}| = ${s.bill_rate} × ${s.hours_per_week} × ${WEEKS_PER_MONTH}`
  );
}

// ─── 3. Project Summaries ────────────────────────────────────────────────────
console.log("\n\n📁 PROJECT SUMMARIES");
hr();

for (const proj of allProjects) {
  const labor = calcProjectLabor(proj.staffing);
  const margin = calcProjectMargin(proj.staffing);
  const budget = calcBudgetMetrics(proj, labor.monthly_cost);
  const util = calcUtilization(proj.staffing);

  console.log(`\n  ${proj.name}`);
  console.log(`    Budget: ${fmtK(proj.total_budget)} | Spent: ${fmtK(proj.spent_to_date)} | Remaining: ${fmtK(budget.remaining_budget)}`);
  console.log(`    Headcount: ${labor.headcount} | FTE: ${labor.fte_count.toFixed(1)}`);
  console.log(`    Monthly Cost:    ${fmt(labor.monthly_cost)}`);
  console.log(`    Monthly Revenue: ${fmt(labor.monthly_revenue)}`);
  console.log(`    Margin:          ${margin.margin_pct.toFixed(1)}% (${fmt(margin.margin_dollars_monthly)}/mo)`);
  console.log(`    Labor Multiplier: ${margin.net_direct_labor_multiplier.toFixed(2)}x`);
  console.log(`    Burn Rate:       ${fmt(labor.monthly_cost)}/mo`);
  console.log(`    Months Left:     ${budget.months_remaining.toFixed(1)}`);
  console.log(`    Exhaustion Date: ${budget.budget_exhaustion_date}`);
  console.log(`    Annual Run Rate: ${fmt(budget.annual_run_rate)}`);
  console.log(`    Blended Cost Rate: ${fmt(calcBlendedCostRate(proj.staffing))}/hr`);
  console.log(`    Blended Bill Rate: ${fmt(calcBlendedBillRate(proj.staffing))}/hr`);
  console.log(`    Utilization: ${util.utilization_rate.toFixed(1)}%`);
  console.log(`    Break-even Utilization: ${util.break_even_utilization.toFixed(1)}%`);
}

// ─── 4. Portfolio Summary ────────────────────────────────────────────────────
console.log("\n\n🏢 PORTFOLIO SUMMARY");
hr();
const portfolioMargin = calcPortfolioMargin(allProjects);
const portfolioBurn = calcPortfolioBurn(allProjects);
const summaries = calcProjectSummaries(allProjects);

console.log(`  Total Monthly Burn:    ${fmt(portfolioBurn)}`);
console.log(`  Total Monthly Revenue: ${fmt(portfolioMargin.total_revenue)}`);
console.log(`  Total Monthly Cost:    ${fmt(portfolioMargin.total_cost)}`);
console.log(`  Portfolio Margin:      ${portfolioMargin.total_margin_pct.toFixed(1)}% (${fmt(portfolioMargin.total_margin_dollars)}/mo)`);
console.log(`\n  Per-project breakdown:`);
for (const s of summaries) {
  console.log(`    ${s.name.padEnd(16)} | Burn: ${fmt(s.monthly_burn).padEnd(14)} | Margin: ${s.margin_pct.toFixed(1)}% | Months: ${s.months_remaining.toFixed(1)}`);
}

// ─── 5. SCENARIO TEST CASES (from briefing) ─────────────────────────────────
console.log("\n\n" + "═".repeat(80));
console.log("  SCENARIO TEST CASES");
console.log("═".repeat(80));

// Test Case 1: Swap 1 Sr Dev for 2 Mid Devs on Alpha
console.log("\n🔄 TEST CASE 1: Swap 1 Senior Dev for 2 Mid-level Devs on Alpha");
hr();
{
  const before = alphaStaffing;
  const after = applySwap(
    before, categories,
    [{ role: "Senior Developer", count: 1 }],
    [{ role: "Mid-level Developer", count: 2 }],
    1, "Project Alpha"
  );

  const beforeLabor = calcProjectLabor(before);
  const afterLabor = calcProjectLabor(after);
  const beforeMargin = calcProjectMargin(before);
  const afterMargin = calcProjectMargin(after);
  const beforeBudget = calcBudgetMetrics(alphaProject, beforeLabor.monthly_cost);
  const afterBudget = calcBudgetMetrics(alphaProject, afterLabor.monthly_cost);
  const impact = calcScenarioImpact(
    { labor: beforeLabor, margin: beforeMargin, budget: beforeBudget },
    { labor: afterLabor, margin: afterMargin, budget: afterBudget }
  );

  console.log(`  Removed: 1 Senior Developer ($${185}/hr cost, $${245}/hr bill, 40 hrs/wk)`);
  console.log(`  Added:   2 Mid-level Developers ($${135}/hr cost, $${185}/hr bill, 40 hrs/wk each)`);
  console.log();
  console.log(`  Removed monthly cost: ${fmt(monthlyCost(185, 40))} = 185 × 40 × ${WEEKS_PER_MONTH}`);
  console.log(`  Added monthly cost:   ${fmt(2 * monthlyCost(135, 40))} = 2 × (135 × 40 × ${WEEKS_PER_MONTH})`);
  console.log(`  Cost delta:           ${fmt(impact.cost_delta_monthly)}/mo`);
  console.log(`  Revenue delta:        ${fmt(impact.revenue_delta_monthly)}/mo`);
  console.log(`  Margin before:        ${beforeMargin.margin_pct.toFixed(1)}%`);
  console.log(`  Margin after:         ${afterMargin.margin_pct.toFixed(1)}%`);
  console.log(`  Margin delta:         ${impact.margin_delta_pct.toFixed(1)} ppts`);
  console.log(`  Headcount delta:      ${impact.headcount_delta > 0 ? "+" : ""}${impact.headcount_delta}`);
  console.log(`  Months left before:   ${beforeBudget.months_remaining.toFixed(1)}`);
  console.log(`  Months left after:    ${afterBudget.months_remaining.toFixed(1)}`);
}

// Test Case 2: Remove 1 QA from Beta
console.log("\n\n➖ TEST CASE 2: Remove 1 QA Engineer from Beta");
hr();
{
  const before = betaStaffing;
  const after = applyRemove(before, [{ role: "QA Engineer", count: 1 }]);

  const beforeLabor = calcProjectLabor(before);
  const afterLabor = calcProjectLabor(after);
  const beforeMargin = calcProjectMargin(before);
  const afterMargin = calcProjectMargin(after);
  const beforeBudget = calcBudgetMetrics(betaProject, beforeLabor.monthly_cost);
  const afterBudget = calcBudgetMetrics(betaProject, afterLabor.monthly_cost);
  const impact = calcScenarioImpact(
    { labor: beforeLabor, margin: beforeMargin, budget: beforeBudget },
    { labor: afterLabor, margin: afterMargin, budget: afterBudget }
  );

  console.log(`  Removed: 1 QA Engineer ($${115}/hr cost, $${165}/hr bill, 40 hrs/wk)`);
  console.log();
  console.log(`  Removed monthly cost:    ${fmt(monthlyCost(115, 40))} = 115 × 40 × ${WEEKS_PER_MONTH}`);
  console.log(`  Removed monthly revenue: ${fmt(monthlyRevenue(165, 40))} = 165 × 40 × ${WEEKS_PER_MONTH}`);
  console.log(`  Cost delta:              ${fmt(impact.cost_delta_monthly)}/mo`);
  console.log(`  Revenue delta:           ${fmt(impact.revenue_delta_monthly)}/mo`);
  console.log(`  Margin before:           ${beforeMargin.margin_pct.toFixed(1)}%`);
  console.log(`  Margin after:            ${afterMargin.margin_pct.toFixed(1)}%`);
  console.log(`  Margin delta:            ${impact.margin_delta_pct.toFixed(1)} ppts`);
  console.log(`  Headcount delta:         ${impact.headcount_delta}`);
  console.log(`  Months left before:      ${beforeBudget.months_remaining.toFixed(1)}`);
  console.log(`  Months left after:       ${afterBudget.months_remaining.toFixed(1)}`);
}

// Test Case 3: Add 1 PM (20 hrs/wk) to Gamma
console.log("\n\n➕ TEST CASE 3: Add 1 Project Manager (20 hrs/wk) to Gamma");
hr();
{
  const before = gammaStaffing;
  const after = applyAdd(before, categories, [{ role: "Project Manager", count: 1, hours_per_week: 20 }], 3, "Project Gamma");

  const beforeLabor = calcProjectLabor(before);
  const afterLabor = calcProjectLabor(after);
  const beforeMargin = calcProjectMargin(before);
  const afterMargin = calcProjectMargin(after);
  const beforeBudget = calcBudgetMetrics(gammaProject, beforeLabor.monthly_cost);
  const afterBudget = calcBudgetMetrics(gammaProject, afterLabor.monthly_cost);
  const impact = calcScenarioImpact(
    { labor: beforeLabor, margin: beforeMargin, budget: beforeBudget },
    { labor: afterLabor, margin: afterMargin, budget: afterBudget }
  );

  console.log(`  Added: 1 Project Manager ($${165}/hr cost, $${225}/hr bill, 20 hrs/wk)`);
  console.log();
  console.log(`  Added monthly cost:    ${fmt(monthlyCost(165, 20))} = 165 × 20 × ${WEEKS_PER_MONTH}`);
  console.log(`  Added monthly revenue: ${fmt(monthlyRevenue(225, 20))} = 225 × 20 × ${WEEKS_PER_MONTH}`);
  console.log(`  Cost delta:            ${fmt(impact.cost_delta_monthly)}/mo`);
  console.log(`  Revenue delta:         ${fmt(impact.revenue_delta_monthly)}/mo`);
  console.log(`  Margin before:         ${beforeMargin.margin_pct.toFixed(1)}%`);
  console.log(`  Margin after:          ${afterMargin.margin_pct.toFixed(1)}%`);
  console.log(`  Margin delta:          ${impact.margin_delta_pct.toFixed(1)} ppts`);
  console.log(`  FTE delta:             +${impact.fte_delta.toFixed(1)}`);
  console.log(`  Months left before:    ${beforeBudget.months_remaining.toFixed(1)}`);
  console.log(`  Months left after:     ${afterBudget.months_remaining.toFixed(1)}`);
}

// Test Case 4: Extend Alpha by 3 months
console.log("\n\n📅 TEST CASE 4: Extend Project Alpha by 3 months");
hr();
{
  const labor = calcProjectLabor(alphaStaffing);
  const ext = calcTimelineExtensionImpact(alphaProject, labor.monthly_cost, 3);

  console.log(`  Current end date:      ${alphaProject.end_date}`);
  console.log(`  New end date:          ${ext.new_end_date}`);
  console.log(`  Extension:             ${ext.additional_months} months`);
  console.log(`  Monthly burn:          ${fmt(labor.monthly_cost)}`);
  console.log(`  Additional cost:       ${fmt(ext.additional_cost)} = ${fmt(labor.monthly_cost)} × 3`);
  console.log(`  New total projected:   ${fmt(ext.new_total_projected)}`);
  console.log(`  Budget gap:            ${fmt(ext.budget_gap)}`);
  console.log(`  Budget:                ${fmtK(alphaProject.total_budget)}`);
  console.log(`  ${ext.budget_gap > 0 ? "⚠️  OVER BUDGET by " + fmtK(ext.budget_gap) : "✅ Within budget"}`);
}

// Test Case 5: Hours change — K. Chen from 40 to 20 hrs/wk
console.log("\n\n⏱️  TEST CASE 5: K. Chen hours 40 → 20 hrs/wk on Alpha");
hr();
{
  const before = alphaStaffing;
  const after = applyHoursChange(before, [{ person_name: "K. Chen", new_hours_per_week: 20 }]);

  const beforeLabor = calcProjectLabor(before);
  const afterLabor = calcProjectLabor(after);
  const beforeBudget = calcBudgetMetrics(alphaProject, beforeLabor.monthly_cost);
  const afterBudget = calcBudgetMetrics(alphaProject, afterLabor.monthly_cost);
  const impact = calcScenarioImpact(
    { labor: beforeLabor, margin: calcProjectMargin(before), budget: beforeBudget },
    { labor: afterLabor, margin: calcProjectMargin(after), budget: afterBudget }
  );

  console.log(`  K. Chen: Mid-level Developer, cost $${135}/hr, bill $${185}/hr`);
  console.log(`  Hours: 40 → 20 hrs/wk`);
  console.log(`  Cost saved:      ${fmt(-impact.cost_delta_monthly)}/mo = ${135} × (40-20) × ${WEEKS_PER_MONTH}`);
  console.log(`  Revenue lost:    ${fmt(-impact.revenue_delta_monthly)}/mo = ${185} × (40-20) × ${WEEKS_PER_MONTH}`);
  console.log(`  FTE delta:       ${impact.fte_delta.toFixed(1)}`);
  console.log(`  Months left:     ${beforeBudget.months_remaining.toFixed(1)} → ${afterBudget.months_remaining.toFixed(1)}`);
}

// ─── 6. EVM Analysis for Beta ────────────────────────────────────────────────
console.log("\n\n📈 EVM ANALYSIS — Project Beta");
hr();
{
  const bac = betaProject.total_budget;
  const ac = betaProject.spent_to_date;
  const pv = calcPlannedValue(betaProject);
  const percentComplete = bac > 0 ? (ac / bac) * 100 : 0;
  const ev = calcEarnedValue(percentComplete, bac);
  const evm = calcEvm(bac, ac, pv, ev);

  console.log(`  BAC (Budget at Completion): ${fmtK(evm.bac)}`);
  console.log(`  AC  (Actual Cost):          ${fmtK(evm.ac)}`);
  console.log(`  PV  (Planned Value):        ${fmtK(Math.round(evm.pv))}`);
  console.log(`  EV  (Earned Value):         ${fmtK(Math.round(evm.ev))} (est. ${percentComplete.toFixed(1)}% complete based on spend)`);
  console.log();
  console.log(`  CPI (Cost Performance):     ${evm.cpi.toFixed(3)} ${evm.cpi >= 1 ? "✅ under budget" : "⚠️  over budget"}`);
  console.log(`  SPI (Schedule Performance): ${evm.spi.toFixed(3)} ${evm.spi >= 1 ? "✅ on/ahead" : "⚠️  behind schedule"}`);
  console.log(`  CV  (Cost Variance):        ${fmtK(Math.round(evm.cv))}`);
  console.log(`  SV  (Schedule Variance):    ${fmtK(Math.round(evm.sv))}`);
  console.log();
  console.log(`  EAC (typical):   ${fmtK(Math.round(evm.eac_typical))} — if current CPI persists`);
  console.log(`  EAC (atypical):  ${fmtK(Math.round(evm.eac_atypical))} — if variance was one-time`);
  console.log(`  EAC (mixed):     ${fmtK(Math.round(evm.eac_mixed))} — if both cost+schedule persist`);
  console.log(`  ETC (remaining): ${fmtK(Math.round(evm.etc))}`);
  console.log(`  VAC (at end):    ${fmtK(Math.round(evm.vac))}`);
  console.log(`  TCPI (needed):   ${evm.tcpi.toFixed(3)} — CPI needed to finish on budget`);
}

console.log("\n" + "═".repeat(80));
console.log("  Verify these numbers with a calculator:");
console.log("  monthly_cost = cost_rate × hours_per_week × " + WEEKS_PER_MONTH);
console.log("  monthly_revenue = bill_rate × hours_per_week × " + WEEKS_PER_MONTH);
console.log("  margin_pct = (bill_rate - cost_rate) / bill_rate × 100");
console.log("  months_remaining = remaining_budget / monthly_burn");
console.log("═".repeat(80) + "\n");

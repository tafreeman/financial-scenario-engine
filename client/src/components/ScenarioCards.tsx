import { DollarSign, TrendingDown, TrendingUp, Users, AlertTriangle } from "lucide-react";
import type { ScenarioResult } from "../api";
import { fmt, fmtDelta, fmtPctDelta, deltaColor } from "../format";

interface Props {
  result: ScenarioResult;
}

export default function ScenarioCards({ result }: Props) {
  const { impact, current, projected, warnings, portfolio } = result;

  return (
    <div className="space-y-4">
      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle size={14} className="text-amber-600" />
            <span className="text-xs font-semibold text-amber-800 uppercase tracking-wider">Warnings</span>
          </div>
          <ul className="text-xs text-amber-700 space-y-0.5 ml-5 list-disc">
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {/* Impact delta cards (shown for mutation scenarios) */}
      {impact && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <DeltaCard
            label="Cost / Mo"
            value={fmtDelta(impact.cost_delta_monthly)}
            color={deltaColor(impact.cost_delta_monthly, true)}
            icon={DollarSign}
          />
          <DeltaCard
            label="Revenue / Mo"
            value={fmtDelta(impact.revenue_delta_monthly)}
            color={deltaColor(impact.revenue_delta_monthly)}
            icon={TrendingUp}
          />
          <DeltaCard
            label="Margin"
            value={fmtPctDelta(impact.margin_delta_pct)}
            color={deltaColor(impact.margin_delta_pct)}
            icon={TrendingDown}
          />
          <DeltaCard
            label="Headcount"
            value={`${impact.headcount_delta >= 0 ? "+" : ""}${impact.headcount_delta}`}
            color={deltaColor(impact.headcount_delta)}
            icon={Users}
          />
        </div>
      )}

      {/* Before / After table (shown when projected state exists) */}
      {projected && (
        <div className="card overflow-hidden">
          <div className="px-4 py-2.5 border-b border-steel-100">
            <span className="text-xs font-semibold text-navy-800 uppercase tracking-wider">
              Before vs After {result.project_name && `— ${result.project_name}`}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-steel-50 text-left">
                  <th className="px-4 py-2 font-semibold text-steel-500 uppercase tracking-wider">Metric</th>
                  <th className="px-4 py-2 font-semibold text-steel-500 uppercase tracking-wider text-right">Before</th>
                  <th className="px-4 py-2 font-semibold text-steel-500 uppercase tracking-wider text-right">After</th>
                  <th className="px-4 py-2 font-semibold text-steel-500 uppercase tracking-wider text-right">Change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-steel-100">
                <CompareRow label="Monthly Cost" before={fmt(current.labor.monthly_cost)} after={fmt(projected.labor.monthly_cost)} delta={fmtDelta(projected.labor.monthly_cost - current.labor.monthly_cost)} deltaNum={projected.labor.monthly_cost - current.labor.monthly_cost} invertColor />
                <CompareRow label="Monthly Revenue" before={fmt(current.labor.monthly_revenue)} after={fmt(projected.labor.monthly_revenue)} delta={fmtDelta(projected.labor.monthly_revenue - current.labor.monthly_revenue)} deltaNum={projected.labor.monthly_revenue - current.labor.monthly_revenue} />
                <CompareRow label="Margin %" before={`${current.margin.margin_pct.toFixed(1)}%`} after={`${projected.margin.margin_pct.toFixed(1)}%`} delta={fmtPctDelta(projected.margin.margin_pct - current.margin.margin_pct)} deltaNum={projected.margin.margin_pct - current.margin.margin_pct} />
                <CompareRow label="Burn Rate / Mo" before={fmt(current.budget.monthly_burn_rate)} after={fmt(projected.budget.monthly_burn_rate)} delta={fmtDelta(projected.budget.monthly_burn_rate - current.budget.monthly_burn_rate)} deltaNum={projected.budget.monthly_burn_rate - current.budget.monthly_burn_rate} invertColor />
                <CompareRow label="Months Remaining" before={current.budget.months_remaining.toFixed(1)} after={projected.budget.months_remaining.toFixed(1)} delta={`${(projected.budget.months_remaining - current.budget.months_remaining) >= 0 ? "+" : ""}${(projected.budget.months_remaining - current.budget.months_remaining).toFixed(1)}`} deltaNum={projected.budget.months_remaining - current.budget.months_remaining} />
                <CompareRow label="Headcount" before={String(current.labor.headcount)} after={String(projected.labor.headcount)} delta={`${(projected.labor.headcount - current.labor.headcount) >= 0 ? "+" : ""}${projected.labor.headcount - current.labor.headcount}`} deltaNum={projected.labor.headcount - current.labor.headcount} />
                <CompareRow label="FTE" before={current.labor.fte_count.toFixed(1)} after={projected.labor.fte_count.toFixed(1)} delta={`${(projected.labor.fte_count - current.labor.fte_count) >= 0 ? "+" : ""}${(projected.labor.fte_count - current.labor.fte_count).toFixed(1)}`} deltaNum={projected.labor.fte_count - current.labor.fte_count} />
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Current state summary (for analysis-only actions) */}
      {!projected && !portfolio && (
        <div className="card overflow-hidden">
          <div className="px-4 py-2.5 border-b border-steel-100">
            <span className="text-xs font-semibold text-navy-800 uppercase tracking-wider">
              Current State {result.project_name && `— ${result.project_name}`}
            </span>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 p-4">
            <StatMini label="Monthly Cost" value={fmt(current.labor.monthly_cost)} />
            <StatMini label="Monthly Revenue" value={fmt(current.labor.monthly_revenue)} />
            <StatMini label="Margin" value={`${current.margin.margin_pct.toFixed(1)}%`} />
            <StatMini label="Months Left" value={current.budget.months_remaining.toFixed(1)} />
            <StatMini label="Headcount" value={String(current.labor.headcount)} />
            <StatMini label="FTE" value={current.labor.fte_count.toFixed(1)} />
            <StatMini label="Burn Rate" value={fmt(current.budget.monthly_burn_rate)} />
            <StatMini label="Remaining Budget" value={fmt(current.budget.remaining_budget)} />
          </div>
        </div>
      )}

      {/* Portfolio summary table */}
      {portfolio && (
        <div className="card overflow-hidden">
          <div className="px-4 py-2.5 border-b border-steel-100">
            <span className="text-xs font-semibold text-navy-800 uppercase tracking-wider">
              Portfolio Summary
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-steel-50 text-left">
                  <th className="px-4 py-2 font-semibold text-steel-500 uppercase tracking-wider">Project</th>
                  <th className="px-4 py-2 font-semibold text-steel-500 uppercase tracking-wider text-right">Burn / Mo</th>
                  <th className="px-4 py-2 font-semibold text-steel-500 uppercase tracking-wider text-right">Margin</th>
                  <th className="px-4 py-2 font-semibold text-steel-500 uppercase tracking-wider text-right">Months Left</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-steel-100">
                {portfolio.project_summaries.map((p, i) => (
                  <tr key={i} className="hover:bg-steel-50/50">
                    <td className="px-4 py-2 font-medium text-navy-800">{p.name}</td>
                    <td className="px-4 py-2 text-right font-mono">{fmt(p.monthly_burn)}</td>
                    <td className={`px-4 py-2 text-right font-mono ${p.margin_pct > 25 ? "text-emerald-600" : "text-red-600"}`}>{p.margin_pct.toFixed(1)}%</td>
                    <td className={`px-4 py-2 text-right font-mono ${p.months_remaining < 3 && p.months_remaining > 0 ? "text-red-600 font-semibold" : ""}`}>{p.months_remaining.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-steel-50 font-semibold">
                <tr>
                  <td className="px-4 py-2 text-navy-800">Portfolio Total</td>
                  <td className="px-4 py-2 text-right font-mono">{fmt(portfolio.total_burn)}</td>
                  <td className="px-4 py-2 text-right font-mono">{portfolio.total_margin_pct.toFixed(1)}%</td>
                  <td className="px-4 py-2 text-right font-mono">{fmt(portfolio.total_margin_dollars)}/mo</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function DeltaCard({ label, value, color, icon: Icon }: {
  label: string; value: string; color: string; icon: any;
}) {
  return (
    <div className="card p-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-semibold text-steel-500 uppercase tracking-wider">{label}</span>
        <Icon size={14} className={color} />
      </div>
      <span className={`text-lg font-bold font-mono ${color}`}>{value}</span>
    </div>
  );
}

function CompareRow({ label, before, after, delta, deltaNum, invertColor }: {
  label: string; before: string; after: string; delta: string; deltaNum: number; invertColor?: boolean;
}) {
  return (
    <tr className="hover:bg-steel-50/50">
      <td className="px-4 py-2 font-medium text-navy-800">{label}</td>
      <td className="px-4 py-2 text-right font-mono text-steel-500">{before}</td>
      <td className="px-4 py-2 text-right font-mono text-navy-800">{after}</td>
      <td className={`px-4 py-2 text-right font-mono font-semibold ${deltaColor(deltaNum, invertColor)}`}>
        {delta}
      </td>
    </tr>
  );
}

function StatMini({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-semibold text-steel-500 uppercase tracking-wider">{label}</div>
      <div className="text-sm font-bold text-navy-800 font-mono">{value}</div>
    </div>
  );
}

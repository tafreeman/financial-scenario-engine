import { useState, useEffect } from "react";
import { DollarSign, TrendingDown, Users, Clock, AlertTriangle } from "lucide-react";
import { api } from "../api";
import { fmt } from "../format";

export default function Dashboard() {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getDashboard().then(setData).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-center py-12 text-steel-500">Loading...</div>;
  if (!data) return <div className="text-center py-12 text-red-500">Failed to load</div>;

  const { summary, projects } = data;

  const stats = [
    { label: "Total Budget", value: fmt(summary.totalBudget), icon: DollarSign, color: "text-emerald-600" },
    { label: "Monthly Burn", value: fmt(summary.totalMonthlyBurn), icon: TrendingDown, color: "text-amber-600" },
    { label: "Blended Margin", value: `${summary.blendedMargin}%`, icon: DollarSign, color: summary.blendedMargin > 25 ? "text-emerald-600" : "text-red-600" },
    { label: "Headcount", value: summary.headcount, icon: Users, color: "text-navy-700" },
  ];

  return (
    <div className="space-y-6">
      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((s, i) => {
          const Icon = s.icon;
          return (
            <div key={i} className="card p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="stat-label">{s.label}</span>
                <Icon size={16} className={s.color} />
              </div>
              <div className={`stat-value ${s.color}`}>{s.value}</div>
            </div>
          );
        })}
      </div>

      {/* Budget overview */}
      <div className="card">
        <div className="px-5 py-3 border-b border-steel-100">
          <h2 className="text-sm font-semibold text-navy-800">Project Budget Overview</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-steel-50 text-left">
                <th className="px-5 py-2 font-medium text-steel-500">Project</th>
                <th className="px-5 py-2 font-medium text-steel-500 text-right">Budget</th>
                <th className="px-5 py-2 font-medium text-steel-500 text-right">Spent</th>
                <th className="px-5 py-2 font-medium text-steel-500 text-right">Remaining</th>
                <th className="px-5 py-2 font-medium text-steel-500 text-right">Burn/Mo</th>
                <th className="px-5 py-2 font-medium text-steel-500 text-right">Months Left</th>
                <th className="px-5 py-2 font-medium text-steel-500">Health</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-steel-100">
              {projects.map((p: any) => {
                const pctSpent = p.total_budget > 0 ? (p.spent_to_date / p.total_budget) * 100 : 0;
                const isRisk = p.months_left < 3 && p.months_left > 0;
                return (
                  <tr key={p.id} className="hover:bg-steel-50/50">
                    <td className="px-5 py-2.5 font-medium text-navy-800">{p.name}</td>
                    <td className="px-5 py-2.5 text-right font-mono text-xs">{fmt(p.total_budget)}</td>
                    <td className="px-5 py-2.5 text-right font-mono text-xs">{fmt(p.spent_to_date)}</td>
                    <td className="px-5 py-2.5 text-right font-mono text-xs">{fmt(p.remaining)}</td>
                    <td className="px-5 py-2.5 text-right font-mono text-xs">{fmt(p.monthly_burn)}</td>
                    <td className="px-5 py-2.5 text-right font-mono text-xs">{p.months_left.toFixed(1)}</td>
                    <td className="px-5 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="w-20 h-1.5 bg-steel-100 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${
                              pctSpent > 80 ? "bg-red-500" : pctSpent > 60 ? "bg-amber-500" : "bg-emerald-500"
                            }`}
                            style={{ width: `${Math.min(pctSpent, 100)}%` }}
                          />
                        </div>
                        {isRisk && (
                          <AlertTriangle size={14} className="text-amber-500 flex-shrink-0" />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

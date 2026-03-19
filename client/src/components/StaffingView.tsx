import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, Filter, RefreshCw } from "lucide-react";
import { api } from "../api";
import { fmt } from "../format";

export default function StaffingView() {
  const [staffing, setStaffing] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [rates, setRates] = useState<any[]>([]);
  const [filterProject, setFilterProject] = useState<number | undefined>();
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  // Add form state
  const [newProjectId, setNewProjectId] = useState<number>(0);
  const [newCategoryId, setNewCategoryId] = useState<number>(0);
  const [newName, setNewName] = useState("");
  const [newHours, setNewHours] = useState(40);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [s, p, r] = await Promise.all([
        api.getStaffing(filterProject),
        api.getProjects(),
        api.getRates(),
      ]);
      setStaffing(s);
      setProjects(p);
      setRates(r);
    } finally {
      setLoading(false);
    }
  }, [filterProject]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleAdd = async () => {
    if (!newProjectId || !newCategoryId) return;
    await api.addStaffing({
      project_id: newProjectId,
      labor_category_id: newCategoryId,
      person_name: newName,
      hours_per_week: newHours,
    });
    setShowAdd(false);
    setNewName("");
    setNewHours(40);
    refresh();
  };

  const handleRemove = async (id: number) => {
    if (!confirm("Remove this staffing assignment?")) return;
    await api.removeStaffing(id);
    refresh();
  };

  const active = staffing.filter((s) => s.is_active);
  const totalMonthlyCost = active.reduce((s, r) => s + (r.monthly_cost || 0), 0);
  const totalMonthlyRevenue = active.reduce((s, r) => s + (r.monthly_revenue || 0), 0);
  const blendedMargin = totalMonthlyRevenue > 0
    ? ((totalMonthlyRevenue - totalMonthlyCost) / totalMonthlyRevenue) * 100 : 0;

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Filter size={14} className="text-steel-500" />
            <select
              className="input-field w-48"
              value={filterProject ?? ""}
              onChange={(e) => setFilterProject(e.target.value ? Number(e.target.value) : undefined)}
            >
              <option value="">All Projects</option>
              {projects.map((p: any) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <button onClick={refresh} className="btn-secondary flex items-center gap-1.5 text-xs">
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
        <button onClick={() => setShowAdd(!showAdd)} className="btn-primary flex items-center gap-1.5 text-sm">
          <Plus size={14} /> Add Staffing
        </button>
      </div>

      {/* Summary bar */}
      <div className="card p-4 flex items-center gap-8 flex-wrap">
        <div>
          <span className="stat-label">Active Staff</span>
          <div className="stat-value text-lg">{active.length}</div>
        </div>
        <div>
          <span className="stat-label">Monthly Cost</span>
          <div className="stat-value text-lg text-amber-600">{fmt(totalMonthlyCost)}</div>
        </div>
        <div>
          <span className="stat-label">Monthly Revenue</span>
          <div className="stat-value text-lg text-emerald-600">{fmt(totalMonthlyRevenue)}</div>
        </div>
        <div>
          <span className="stat-label">Blended Margin</span>
          <div className={`stat-value text-lg ${blendedMargin > 25 ? "text-emerald-600" : "text-red-600"}`}>
            {blendedMargin.toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="card p-4">
          <h3 className="text-xs font-semibold text-navy-800 uppercase tracking-wider mb-3">
            Add Staffing Assignment
          </h3>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <select
              className="input-field"
              value={newProjectId}
              onChange={(e) => setNewProjectId(Number(e.target.value))}
            >
              <option value={0}>Select Project</option>
              {projects.map((p: any) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <select
              className="input-field"
              value={newCategoryId}
              onChange={(e) => setNewCategoryId(Number(e.target.value))}
            >
              <option value={0}>Select Role</option>
              {rates.map((r: any) => (
                <option key={r.id} value={r.id}>{r.name} ({fmt(r.bill_rate)}/hr)</option>
              ))}
            </select>
            <input
              className="input-field"
              placeholder="Person name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <input
              className="input-field"
              type="number"
              placeholder="Hrs/week"
              value={newHours}
              onChange={(e) => setNewHours(Number(e.target.value))}
            />
            <div className="flex gap-2">
              <button onClick={handleAdd} className="btn-primary text-sm flex-1">Add</button>
              <button onClick={() => setShowAdd(false)} className="btn-secondary text-sm">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="card overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-steel-500 text-sm">Loading...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-steel-50 text-left">
                  <th className="px-4 py-2 font-medium text-steel-500">Project</th>
                  <th className="px-4 py-2 font-medium text-steel-500">Role</th>
                  <th className="px-4 py-2 font-medium text-steel-500">Name</th>
                  <th className="px-4 py-2 font-medium text-steel-500 text-right">Hrs/Wk</th>
                  <th className="px-4 py-2 font-medium text-steel-500 text-right">Bill Rate</th>
                  <th className="px-4 py-2 font-medium text-steel-500 text-right">Cost Rate</th>
                  <th className="px-4 py-2 font-medium text-steel-500 text-right">Monthly Cost</th>
                  <th className="px-4 py-2 font-medium text-steel-500 text-right">Monthly Rev</th>
                  <th className="px-4 py-2 font-medium text-steel-500 text-right">Margin</th>
                  <th className="px-4 py-2 font-medium text-steel-500 w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-steel-100">
                {active.map((s: any) => (
                  <tr key={s.id} className="hover:bg-steel-50/50">
                    <td className="px-4 py-2.5 font-medium text-navy-800">{s.project_name}</td>
                    <td className="px-4 py-2.5">{s.labor_category}</td>
                    <td className="px-4 py-2.5 text-steel-500">{s.person_name || "TBD"}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">{s.hours_per_week}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">{fmt(s.bill_rate)}/hr</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">{fmt(s.cost_rate)}/hr</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">{fmt(s.monthly_cost)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-emerald-700">{fmt(s.monthly_revenue)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">
                      <span className={`${s.margin > 0.25 ? "text-emerald-600" : "text-amber-600"}`}>
                        {(s.margin * 100).toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <button
                        onClick={() => handleRemove(s.id)}
                        className="p-1 rounded hover:bg-red-50 text-steel-500 hover:text-red-500 transition-colors"
                        title="Remove"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
                {active.length === 0 && (
                  <tr><td colSpan={10} className="px-4 py-8 text-center text-steel-500">No staffing data</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Rate Card */}
      <div className="card">
        <div className="px-4 py-3 border-b border-steel-100">
          <h2 className="text-xs font-semibold text-navy-800 uppercase tracking-wider">Rate Card</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-steel-50 text-left">
                <th className="px-4 py-2 font-medium text-steel-500">Labor Category</th>
                <th className="px-4 py-2 font-medium text-steel-500 text-right">Bill Rate</th>
                <th className="px-4 py-2 font-medium text-steel-500 text-right">Cost Rate</th>
                <th className="px-4 py-2 font-medium text-steel-500 text-right">Margin</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-steel-100">
              {rates.map((r: any) => (
                <tr key={r.id} className="hover:bg-steel-50/50">
                  <td className="px-4 py-2 font-medium text-navy-800">{r.name}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs">{fmt(r.bill_rate)}/hr</td>
                  <td className="px-4 py-2 text-right font-mono text-xs">{fmt(r.cost_rate)}/hr</td>
                  <td className="px-4 py-2 text-right font-mono text-xs">
                    <span className={r.margin > 0.25 ? "text-emerald-600" : "text-amber-600"}>
                      {(r.margin * 100).toFixed(1)}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

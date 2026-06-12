import {
  getProjectsWithBurn,
  getStaffingByProject,
  getLaborCategories,
} from "./db.js";
import type {
  PortfolioSnapshot,
  ProjectSnapshot,
  LaborCategory,
  StaffingRecord,
} from "./engine/types.js";

/**
 * Load the complete portfolio state from the database.
 *
 * This is the single authorised point where the server layer (routes, ai)
 * fetches live data and converts it into the pure-value PortfolioSnapshot
 * that the deterministic engine functions consume.  engine/ modules must
 * never import from db.ts directly.
 */
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

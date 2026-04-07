import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "finimpact.db");

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initSchema();
  }
  return db;
}

function initSchema() {
  const d = getDb();

  d.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      total_budget REAL NOT NULL DEFAULT 0,
      spent_to_date REAL NOT NULL DEFAULT 0,
      start_date TEXT,
      end_date TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS labor_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      bill_rate REAL NOT NULL,
      cost_rate REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS staffing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      labor_category_id INTEGER NOT NULL REFERENCES labor_categories(id),
      person_name TEXT,
      hours_per_week REAL NOT NULL DEFAULT 40,
      start_date TEXT,
      end_date TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS scenarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      response TEXT NOT NULL,
      context_snapshot TEXT,
      model TEXT,
      tokens_used INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Seed default config if empty
  const configCount = d.prepare("SELECT COUNT(*) as c FROM config").get() as any;
  if (configCount.c === 0) {
    const insertConfig = d.prepare("INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)");
    insertConfig.run("github_pat", "");
    insertConfig.run("model", "openai/gpt-4.1");
    insertConfig.run("endpoint", "https://models.github.ai/inference/chat/completions");
    insertConfig.run("temperature", "0.2");
    insertConfig.run("max_tokens", "2000");
  }

  // Seed sample data if empty
  const projCount = d.prepare("SELECT COUNT(*) as c FROM projects").get() as any;
  if (projCount.c === 0) {
    seedSampleData(d);
  }
}

function seedSampleData(d: Database.Database) {
  // Labor categories
  const insertCat = d.prepare(
    "INSERT INTO labor_categories (name, bill_rate, cost_rate) VALUES (?, ?, ?)"
  );
  const categories = [
    ["Lead Architect", 285, 210],
    ["Senior Developer", 245, 185],
    ["Mid-level Developer", 185, 135],
    ["Junior Developer", 135, 95],
    ["Business Analyst", 175, 125],
    ["QA Engineer", 165, 115],
    ["Project Manager", 225, 165],
    ["Scrum Master", 195, 145],
  ];
  for (const [name, bill, cost] of categories) {
    insertCat.run(name, bill, cost);
  }

  // Projects
  const insertProj = d.prepare(
    "INSERT INTO projects (name, total_budget, spent_to_date, start_date, end_date, status) VALUES (?, ?, ?, ?, ?, ?)"
  );
  insertProj.run("Project Alpha", 1250000, 485000, "2025-10-01", "2026-09-30", "active");
  insertProj.run("Project Beta", 2100000, 1340000, "2025-04-01", "2026-03-31", "active");
  insertProj.run("Project Gamma", 680000, 210000, "2026-01-15", "2026-12-31", "active");

  // Staffing
  const insertStaff = d.prepare(
    "INSERT INTO staffing (project_id, labor_category_id, person_name, hours_per_week) VALUES (?, ?, ?, ?)"
  );
  // Alpha
  insertStaff.run(1, 2, "J. Smith", 40);   // Senior Dev
  insertStaff.run(1, 3, "K. Chen", 40);    // Mid Dev
  insertStaff.run(1, 5, "L. Park", 30);    // BA
  // Beta
  insertStaff.run(2, 1, "M. Jones", 40);   // Lead Architect
  insertStaff.run(2, 2, "N. Davis", 40);   // Senior Dev
  insertStaff.run(2, 6, "P. Wilson", 40);  // QA
  // Gamma
  insertStaff.run(3, 3, "R. Brown", 40);   // Mid Dev
  insertStaff.run(3, 4, "S. Lee", 40);     // Junior Dev
}

// ---- Query helpers ----

export function getConfig(key: string): string {
  const d = getDb();
  const row = d.prepare("SELECT value FROM config WHERE key = ?").get(key) as any;
  return row?.value ?? "";
}

export function setConfig(key: string, value: string) {
  const d = getDb();
  d.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(key, value);
}

export function getAllConfig(): Record<string, string> {
  const d = getDb();
  const rows = d.prepare("SELECT key, value FROM config").all() as any[];
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

export interface ProjectRow {
  id: number;
  name: string;
  total_budget: number;
  spent_to_date: number;
  remaining: number;
  monthly_burn: number;
  months_left: number;
  start_date: string;
  end_date: string;
  status: string;
}

export function getProjectsWithBurn(): ProjectRow[] {
  const d = getDb();
  return d.prepare(`
    SELECT
      p.id, p.name, p.total_budget, p.spent_to_date,
      (p.total_budget - p.spent_to_date) as remaining,
      p.start_date, p.end_date, p.status,
      COALESCE(SUM(lc.cost_rate * s.hours_per_week * 4.33), 0) as monthly_burn,
      CASE
        WHEN COALESCE(SUM(lc.cost_rate * s.hours_per_week * 4.33), 0) > 0
        THEN (p.total_budget - p.spent_to_date) / SUM(lc.cost_rate * s.hours_per_week * 4.33)
        ELSE 0
      END as months_left
    FROM projects p
    LEFT JOIN staffing s ON s.project_id = p.id AND s.is_active = 1
    LEFT JOIN labor_categories lc ON lc.id = s.labor_category_id
    GROUP BY p.id
    ORDER BY p.name
  `).all() as ProjectRow[];
}

export function getStaffingByProject(projectId?: number) {
  const d = getDb();
  let sql = `
    SELECT s.id, s.person_name, s.hours_per_week, s.is_active,
           p.name as project_name, p.id as project_id,
           lc.name as labor_category, lc.bill_rate, lc.cost_rate,
           (lc.cost_rate * s.hours_per_week * 4.33) as monthly_cost,
           (lc.bill_rate * s.hours_per_week * 4.33) as monthly_revenue,
           ((lc.bill_rate - lc.cost_rate) / lc.bill_rate) as margin
    FROM staffing s
    JOIN projects p ON p.id = s.project_id
    JOIN labor_categories lc ON lc.id = s.labor_category_id
  `;
  if (projectId) {
    sql += ` WHERE s.project_id = ?`;
    sql += ` ORDER BY p.name, lc.bill_rate DESC`;
    return d.prepare(sql).all(projectId);
  }
  sql += ` ORDER BY p.name, lc.bill_rate DESC`;
  return d.prepare(sql).all();
}

export function getLaborCategories() {
  const d = getDb();
  return d.prepare(`
    SELECT id, name, bill_rate, cost_rate,
           ((bill_rate - cost_rate) / bill_rate) as margin
    FROM labor_categories ORDER BY bill_rate DESC
  `).all();
}

export function buildContextSnapshot(): string {
  const projects = getProjectsWithBurn();
  const staffing = getStaffingByProject();
  const categories = getLaborCategories();

  let ctx = "CURRENT PROJECTS:\n";
  for (const p of projects) {
    ctx += `  ${p.name}: Budget=$${p.total_budget.toLocaleString()}, `;
    ctx += `Spent=$${p.spent_to_date.toLocaleString()}, `;
    ctx += `Remaining=$${Math.round(p.remaining).toLocaleString()}, `;
    ctx += `Monthly Burn=$${Math.round(p.monthly_burn).toLocaleString()}, `;
    ctx += `Months Left=${p.months_left.toFixed(1)}, `;
    ctx += `Status=${p.status}\n`;
  }

  ctx += "\nCURRENT STAFFING:\n";
  for (const s of staffing as any[]) {
    ctx += `  ${s.project_name} | ${s.labor_category} | ${s.person_name || "TBD"} | `;
    ctx += `${s.hours_per_week}hrs/wk | Cost=$${Math.round(s.monthly_cost)}/mo | `;
    ctx += `Revenue=$${Math.round(s.monthly_revenue)}/mo | Margin=${(s.margin * 100).toFixed(1)}%\n`;
  }

  ctx += "\nRATE CARD:\n";
  for (const c of categories as any[]) {
    ctx += `  ${c.name}: Bill=$${c.bill_rate}/hr, Cost=$${c.cost_rate}/hr, `;
    ctx += `Margin=${(c.margin * 100).toFixed(1)}%\n`;
  }

  return ctx;
}

/**
 * Build an anonymized context snapshot that strips person names (PII)
 * while preserving project names and role names (needed for LLM intent mapping).
 * Financial figures are kept because the LLM needs them to reason about scenarios,
 * but no personally identifiable information leaves the machine.
 */
export function buildAnonymizedContextSnapshot(): string {
  const projects = getProjectsWithBurn();
  const staffing = getStaffingByProject();
  const categories = getLaborCategories();

  let ctx = "CURRENT PROJECTS:\n";
  for (const p of projects) {
    ctx += `  ${p.name}: Budget=$${p.total_budget.toLocaleString()}, `;
    ctx += `Spent=$${p.spent_to_date.toLocaleString()}, `;
    ctx += `Remaining=$${Math.round(p.remaining).toLocaleString()}, `;
    ctx += `Monthly Burn=$${Math.round(p.monthly_burn).toLocaleString()}, `;
    ctx += `Months Left=${p.months_left.toFixed(1)}, `;
    ctx += `Status=${p.status}\n`;
  }

  ctx += "\nCURRENT STAFFING:\n";
  let staffIndex = 1;
  for (const s of staffing as any[]) {
    ctx += `  ${s.project_name} | ${s.labor_category} | Staff-${staffIndex} | `;
    ctx += `${s.hours_per_week}hrs/wk | Cost=$${Math.round(s.monthly_cost)}/mo | `;
    ctx += `Revenue=$${Math.round(s.monthly_revenue)}/mo | Margin=${(s.margin * 100).toFixed(1)}%\n`;
    staffIndex++;
  }

  ctx += "\nRATE CARD:\n";
  for (const c of categories as any[]) {
    ctx += `  ${c.name}: Bill=$${c.bill_rate}/hr, Cost=$${c.cost_rate}/hr, `;
    ctx += `Margin=${(c.margin * 100).toFixed(1)}%\n`;
  }

  return ctx;
}

export function saveScenario(query: string, response: string, context: string, model: string) {
  const d = getDb();
  d.prepare(
    "INSERT INTO scenarios (query, response, context_snapshot, model) VALUES (?, ?, ?, ?)"
  ).run(query, response, context, model);
}

export function getScenarioHistory(limit = 50) {
  const d = getDb();
  return d.prepare(
    "SELECT id, query, response, model, created_at FROM scenarios ORDER BY created_at DESC LIMIT ?"
  ).all(limit);
}

// ---- CRUD for staffing/projects/categories ----

export function addStaffing(projectId: number, laborCategoryId: number, personName: string, hoursPerWeek: number) {
  const d = getDb();
  return d.prepare(
    "INSERT INTO staffing (project_id, labor_category_id, person_name, hours_per_week) VALUES (?, ?, ?, ?)"
  ).run(projectId, laborCategoryId, personName, hoursPerWeek);
}

export function removeStaffing(id: number) {
  const d = getDb();
  d.prepare("UPDATE staffing SET is_active = 0 WHERE id = ?").run(id);
}

export function addProject(name: string, totalBudget: number, startDate: string, endDate: string) {
  const d = getDb();
  return d.prepare(
    "INSERT INTO projects (name, total_budget, start_date, end_date) VALUES (?, ?, ?, ?)"
  ).run(name, totalBudget, startDate, endDate);
}

export function updateProject(id: number, fields: Partial<{ name: string; total_budget: number; spent_to_date: number; status: string }>) {
  const d = getDb();
  const sets: string[] = [];
  const vals: any[] = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  d.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DB_PATH is overridable via env (12-factor) so tests can use an isolated
// in-memory database (":memory:") instead of mutating the persistent dev DB.
const DB_PATH = process.env.DB_PATH ?? path.join(__dirname, "..", "data", "finimpact.db");

type CountRow = { c: number };

interface StaffingQueryRow {
  id: number;
  person_name: string | null;
  hours_per_week: number;
  is_active: number;
  project_name: string;
  project_id: number;
  labor_category: string;
  bill_rate: number;
  cost_rate: number;
  monthly_cost: number;
  monthly_revenue: number;
  margin: number;
}

interface LaborCategoryRow {
  id: number;
  name: string;
  bill_rate: number;
  cost_rate: number;
  margin: number;
}

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

interface TableColumnInfo {
  name: string;
}

/**
 * Idempotently add a column to a table when it does not already exist.
 *
 * SQLite does not support `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so we
 * inspect PRAGMA table_info first and only issue the ALTER when the column is
 * missing. `columnType` is interpolated (not parameterized) because SQLite does
 * not allow bound parameters in DDL — callers pass only trusted literals here.
 */
function ensureColumn(
  d: Database.Database,
  table: string,
  column: string,
  columnType: string
): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as TableColumnInfo[];
  if (cols.some(c => c.name === column)) return;
  d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnType}`);
}

/** GitHub Models inference endpoint — retiring 2026-07-30. */
const RETIRED_GITHUB_MODELS_ENDPOINT = "https://models.github.ai/inference/chat/completions";

interface ConfigValueRow {
  value: string;
}

/**
 * One-time startup fix-up: rewrite `llm_provider` away from the retiring
 * GitHub Models default, but ONLY for rows that still hold the EXACT retired
 * values — `llm_provider = "github"` AND `endpoint` = the retiring
 * `models.github.ai` URL.
 *
 * `INSERT OR IGNORE` (used to seed config, below) never overwrites an existing
 * row, so it only fixes brand-new databases. Any database that already ran
 * with the old seed has `llm_provider = "github"` persisted forever unless
 * something rewrites it — this does that, idempotently, on every startup.
 *
 * The exact-match guard is deliberate: a user who left `llm_provider =
 * "github"` but pointed `endpoint` somewhere else (e.g. a GitHub Enterprise
 * Server Models endpoint) made a deliberate custom choice and must not be
 * touched; a row already switched to "ollama" or "openrouter" is untouched
 * for the same reason.
 *
 * This repo has no migrations directory or schema-version table (see
 * `ensureColumn` above for the same idempotent-startup-fixup convention used
 * for schema changes) — this follows that existing pattern rather than
 * introducing new migration infrastructure for a single one-time value swap.
 */
export function migrateRetiredGithubModelsDefault(d: Database.Database): void {
  const provider = d.prepare("SELECT value FROM config WHERE key = 'llm_provider'").get() as
    | ConfigValueRow
    | undefined;
  const endpoint = d.prepare("SELECT value FROM config WHERE key = 'endpoint'").get() as
    | ConfigValueRow
    | undefined;

  if (provider?.value === "github" && endpoint?.value === RETIRED_GITHUB_MODELS_ENDPOINT) {
    d.prepare("UPDATE config SET value = ? WHERE key = 'llm_provider'").run("ollama");
  }
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
      percent_complete REAL,
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

  // Migration: add projects.percent_complete to databases created before the
  // column existed. CREATE TABLE IF NOT EXISTS above only adds the column to a
  // brand-new table, so an ALTER is required for pre-existing dev/prod DBs.
  // SQLite has no "ADD COLUMN IF NOT EXISTS", so we probe PRAGMA table_info and
  // only ALTER when absent — making this safe to run on every startup.
  ensureColumn(d, "projects", "percent_complete", "REAL");

  // Seed default config — INSERT OR IGNORE is idempotent (safe for concurrent workers)
  const insertConfig = d.prepare("INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)");
  insertConfig.run("github_pat", "");
  insertConfig.run("model", "openai/gpt-4.1");
  insertConfig.run("endpoint", RETIRED_GITHUB_MODELS_ENDPOINT);
  insertConfig.run("temperature", "0.2");
  insertConfig.run("max_tokens", "2000");
  // GitHub Models retires 2026-07-30 (github.blog changelog). "ollama" is the
  // new default: it is a fully-supported provider with a matching Settings UI
  // branch (SettingsPanel.tsx already renders dedicated Ollama config fields
  // that exactly match ollama_model/ollama_endpoint below), fits this app's
  // local-first design, and has no request quota. "openrouter" was the more
  // obvious swap and IS fully supported server-side, but was rejected as the
  // *default*: (1) SettingsPanel.tsx has no UI branch for it at all — it's a
  // hard GitHub/Ollama toggle, so an openrouter default would render as a
  // mislabeled "GitHub Models Configuration" panel edited via the wrong
  // config keys; (2) the owner's OpenRouter account has never purchased
  // credits, capping the ":free" model pool at 50 requests/day. Ollama
  // requires a local Ollama install and fails without one, but does so via
  // the existing fail-closed retry + "Is Ollama running? Try: ollama serve"
  // hint path (see server/ai.ts), not silently.
  insertConfig.run("llm_provider", "ollama");
  insertConfig.run("ollama_model", "llama3.2");
  insertConfig.run("ollama_endpoint", "http://localhost:11434/v1/chat/completions");

  // One-time fix-up for databases that already persisted the retired GitHub
  // Models default before this change (INSERT OR IGNORE above never overwrites
  // an existing row, so a pre-existing DB would otherwise silently keep
  // llm_provider="github" forever, breaking the moment GitHub Models retires).
  migrateRetiredGithubModelsDefault(d);

  // Seed sample data — wrapped in a transaction so concurrent workers can't
  // both observe projCount === 0 and then race to INSERT the same rows.
  // INSERT OR IGNORE on labor_categories prevents UNIQUE violations if a
  // parallel worker already committed the same name between the count check
  // and the insert.
  d.transaction(() => {
    const projCount = d.prepare("SELECT COUNT(*) as c FROM projects").get() as CountRow;
    if (projCount.c === 0) {
      seedSampleData(d);
    }
  })();
}

function seedSampleData(d: Database.Database) {
  // Labor categories — INSERT OR IGNORE so repeated calls are safe
  const insertCat = d.prepare(
    "INSERT OR IGNORE INTO labor_categories (name, bill_rate, cost_rate) VALUES (?, ?, ?)"
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

  // Projects — INSERT OR IGNORE so repeated calls are safe
  const insertProj = d.prepare(
    "INSERT OR IGNORE INTO projects (name, total_budget, spent_to_date, start_date, end_date, status) VALUES (?, ?, ?, ?, ?, ?)"
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
  const row = d.prepare("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? "";
}

export function setConfig(key: string, value: string) {
  const d = getDb();
  d.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(key, value);
}

export function getAllConfig(): Record<string, string> {
  const d = getDb();
  const rows = d.prepare("SELECT key, value FROM config").all() as { key: string; value: string }[];
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
  /** Explicit physical percent complete (0–100); null when never set by a PM. */
  percent_complete: number | null;
}

export function getProjectsWithBurn(): ProjectRow[] {
  const d = getDb();
  return d.prepare(`
    SELECT
      p.id, p.name, p.total_budget, p.spent_to_date,
      (p.total_budget - p.spent_to_date) as remaining,
      p.start_date, p.end_date, p.status, p.percent_complete,
      COALESCE(SUM(lc.cost_rate * s.hours_per_week * 52.0 / 12), 0) as monthly_burn,
      CASE
        WHEN COALESCE(SUM(lc.cost_rate * s.hours_per_week * 52.0 / 12), 0) > 0
        THEN (p.total_budget - p.spent_to_date) / SUM(lc.cost_rate * s.hours_per_week * 52.0 / 12)
        ELSE 0
      END as months_left
    FROM projects p
    LEFT JOIN staffing s ON s.project_id = p.id AND s.is_active = 1
    LEFT JOIN labor_categories lc ON lc.id = s.labor_category_id
    GROUP BY p.id
    ORDER BY p.name
  `).all() as ProjectRow[];
}

export function getStaffingByProject(projectId?: number, activeOnly = false) {
  const d = getDb();
  const conditions: string[] = [];
  if (projectId) conditions.push("s.project_id = ?");
  if (activeOnly) conditions.push("s.is_active = 1");

  const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT s.id, s.person_name, s.hours_per_week, s.is_active,
           p.name as project_name, p.id as project_id,
           lc.name as labor_category, lc.bill_rate, lc.cost_rate,
           (lc.cost_rate * s.hours_per_week * 52.0 / 12) as monthly_cost,
           (lc.bill_rate * s.hours_per_week * 52.0 / 12) as monthly_revenue,
           ((lc.bill_rate - lc.cost_rate) / lc.bill_rate) as margin
    FROM staffing s
    JOIN projects p ON p.id = s.project_id
    JOIN labor_categories lc ON lc.id = s.labor_category_id
    ${whereClause}
    ORDER BY p.name, lc.bill_rate DESC
  `;
  if (projectId) return d.prepare(sql).all(projectId);
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
  for (const s of staffing as StaffingQueryRow[]) {
    if (s.is_active !== 1) continue;
    ctx += `  ${s.project_name} | ${s.labor_category} | Staff-${staffIndex} | `;
    ctx += `${s.hours_per_week}hrs/wk | Cost=$${Math.round(s.monthly_cost)}/mo | `;
    ctx += `Revenue=$${Math.round(s.monthly_revenue)}/mo | Margin=${(s.margin * 100).toFixed(1)}%\n`;
    staffIndex++;
  }

  ctx += "\nRATE CARD:\n";
  for (const c of categories as LaborCategoryRow[]) {
    ctx += `  ${c.name}: Bill=$${c.bill_rate}/hr, Cost=$${c.cost_rate}/hr, `;
    ctx += `Margin=${(c.margin * 100).toFixed(1)}%\n`;
  }

  return ctx;
}

export function saveScenario(
  query: string,
  response: string,
  context: string,
  model: string,
  tokensUsed: number = 0
) {
  const d = getDb();
  d.prepare(
    "INSERT INTO scenarios (query, response, context_snapshot, model, tokens_used) VALUES (?, ?, ?, ?, ?)"
  ).run(query, response, context, model, tokensUsed);
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

/** Column names accepted by updateProject. Any key not in this set is silently ignored. */
const PROJECT_UPDATE_ALLOWED = new Set([
  "name",
  "total_budget",
  "spent_to_date",
  "status",
  "percent_complete",
]);

/**
 * Update mutable fields on a project row.
 *
 * Returns the SQLite RunResult so callers can inspect `changes`:
 *   - changes === 0 when the id does not exist in the table.
 *   - changes === 0 also when `fields` contains no allowed keys (no-op).
 */
export function updateProject(
  id: number,
  fields: Partial<{
    name: string;
    total_budget: number;
    spent_to_date: number;
    status: string;
    percent_complete: number | null;
  }>
): Database.RunResult {
  const d = getDb();
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!PROJECT_UPDATE_ALLOWED.has(k)) continue; // reject unlisted columns
    sets.push(`${k} = ?`);
    vals.push(v as string | number);
  }
  if (sets.length === 0) {
    // No allowed fields to update — return a synthetic no-op result so the
    // caller can still read `.changes` without hitting the database.
    return { changes: 0, lastInsertRowid: 0 };
  }
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  return d.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

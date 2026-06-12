import { Router, Request, Response } from "express";
import multer from "multer";
import { z } from "zod";
import {
  getProjectsWithBurn,
  getStaffingByProject,
  getLaborCategories,
  getScenarioHistory,
  getAllConfig,
  setConfig,
  addStaffing,
  removeStaffing,
  addProject,
  updateProject,
  buildAnonymizedContextSnapshot,
  saveScenario,
} from "./db.js";
import { parseIntent, narrateResult, agenticScenario, type IntentParseFailure } from "./ai.js";
import { executeScenario } from "./engine/executor.js";
import { loadPortfolioSnapshot } from "./loaders.js";
import { generateNarrative } from "./engine/narrative.js";
import { handleExcelImportV1, handleExcelImportV2 } from "./import/excel/index.js";

interface StaffingRow {
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

export const apiRouter = Router();

/** Accepted MIME types for Excel uploads. */
const XLSX_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel",                                           // .xls (legacy)
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB — prevents OOM from arbitrarily large uploads
  fileFilter(_req, file, cb) {
    if (XLSX_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      // Reject with an Error so multer surfaces it through the standard error path.
      // We do NOT use MulterError here because MulterError codes are all size/field
      // limits — MIME rejection is a caller error (400), not a limit exceeded error.
      cb(new Error(`Unsupported file type: ${file.mimetype}. Only XLSX/XLS files are accepted.`));
    }
  },
});

/**
 * Wrap a multer single-file upload middleware so that multer errors are
 * translated to the correct HTTP status codes instead of propagating as 500s:
 *   - LIMIT_FILE_SIZE  → 413 Payload Too Large
 *   - MIME-type error  → 400 Bad Request
 */
function uploadSingle(fieldName: string): (req: Request, res: Response, next: () => void) => void {
  const middleware = upload.single(fieldName);
  return (req: Request, res: Response, next: () => void) => {
    middleware(req, res, (err: unknown) => {
      if (!err) { next(); return; }
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "File too large. Maximum size is 10 MB." });
        return;
      }
      // MIME-type errors and anything else from fileFilter → 400
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    });
  };
}

function sendIntentParseFailure(res: Response, failure: IntentParseFailure) {
  res.status(422).json({
    error: failure.message,
    code: failure.code,
    clarification: failure.clarification,
    ...(failure.details ? { details: failure.details } : {}),
  });
}

// ─── Request body schemas ─────────────────────────────────────────────────────

/** Only the four mutable project columns are accepted; all other keys are rejected. */
const patchProjectSchema = z.object({
  name: z.string().min(1).optional(),
  total_budget: z.number().nonnegative().optional(),
  spent_to_date: z.number().nonnegative().optional(),
  status: z.string().min(1).optional(),
}).strict();

// ---- Health ----
apiRouter.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ---- Dashboard summary ----
apiRouter.get("/dashboard", (_req, res) => {
  const projects = getProjectsWithBurn();
  // activeOnly=true: soft-deleted staff (is_active=0) must not count toward
  // dashboard revenue/cost/margin totals (matches the engine's loadPortfolioSnapshot filter).
  const staffing = getStaffingByProject(undefined, true) as StaffingRow[];

  const totalBudget = projects.reduce((s, p) => s + p.total_budget, 0);
  const totalSpent = projects.reduce((s, p) => s + p.spent_to_date, 0);
  const totalBurn = projects.reduce((s, p) => s + p.monthly_burn, 0);
  const totalRevenue = staffing.reduce((s, r) => s + (r.monthly_revenue || 0), 0);
  const totalCost = staffing.reduce((s, r) => s + (r.monthly_cost || 0), 0);
  const blendedMargin = totalRevenue > 0 ? ((totalRevenue - totalCost) / totalRevenue) * 100 : 0;
  const headcount = staffing.filter((s) => s.is_active).length;

  res.json({
    summary: {
      totalBudget,
      totalSpent,
      totalRemaining: totalBudget - totalSpent,
      totalMonthlyBurn: totalBurn,
      totalMonthlyRevenue: totalRevenue,
      blendedMargin: Math.round(blendedMargin * 10) / 10,
      headcount,
      projectCount: projects.length,
    },
    projects,
  });
});

// ---- Projects ----
apiRouter.get("/projects", (_req, res) => {
  res.json(getProjectsWithBurn());
});

apiRouter.post("/projects", (req: Request, res: Response) => {
  const { name, total_budget, start_date, end_date } = req.body;
  if (!name) { res.status(400).json({ error: "name required" }); return; }
  try {
    const result = addProject(name, total_budget || 0, start_date || "", end_date || "");
    res.json({ id: result.lastInsertRowid });
  } catch (e: unknown) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

apiRouter.patch("/projects/:id", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  const parsed = patchProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid fields", details: parsed.error.issues });
    return;
  }

  const result = updateProject(id, parsed.data);

  // No fields were provided (empty body) — valid no-op.
  if (result.changes === 0 && Object.keys(parsed.data).length === 0) {
    res.json({ ok: true, updated: 0 });
    return;
  }

  // Fields were provided but 0 rows changed — the project does not exist.
  if (result.changes === 0) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json({ ok: true, updated: result.changes });
});

// ---- Staffing ----
apiRouter.get("/staffing", (req, res) => {
  const projectId = req.query.project_id ? Number(req.query.project_id) : undefined;
  res.json(getStaffingByProject(projectId));
});

apiRouter.post("/staffing", (req: Request, res: Response) => {
  const { project_id, labor_category_id, person_name, hours_per_week } = req.body;
  if (!project_id || !labor_category_id) {
    res.status(400).json({ error: "project_id and labor_category_id required" }); return;
  }
  const result = addStaffing(project_id, labor_category_id, person_name || "", hours_per_week || 40);
  res.json({ id: result.lastInsertRowid });
});

apiRouter.delete("/staffing/:id", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid staffing id" });
    return;
  }
  removeStaffing(id);
  res.json({ ok: true });
});

// ---- Rate Card ----
apiRouter.get("/rates", (_req, res) => {
  res.json(getLaborCategories());
});

// ---- AI Scenario ----
// V1 removed — it sent raw financial data to LLM and let it hallucinate numbers.
// Use V2 (deterministic engine + optional narration) or V3 (agentic tool-calling) instead.

apiRouter.get("/scenarios", (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : 50;
  res.json(getScenarioHistory(limit));
});

// ---- AI Scenario V2 (deterministic engine + narrative) ----
apiRouter.post("/scenario/v2", async (req: Request, res: Response) => {
  const { query, skip_narrative, use_llm_narrative } = req.body;
  if (!query) { res.status(400).json({ error: "query required" }); return; }

  try {
    // Step 1: LLM parses intent into structured operation (anonymized context sent to LLM)
    const context = buildAnonymizedContextSnapshot();
    const parseResult = await parseIntent(query, context);
    if (!parseResult.ok) {
      sendIntentParseFailure(res, parseResult);
      return;
    }
    const operation = parseResult.operation;

    // Step 2: Deterministic engine computes results
    const engineResult = executeScenario(operation, loadPortfolioSnapshot());

    // Step 3: Generate narrative (template-based by default, LLM if explicitly requested)
    let narrative = "";
    let model = "";
    let tokensUsed = 0;
    if (!skip_narrative) {
      if (use_llm_narrative) {
        // LLM narration (opt-in) — sends computed results to LLM for prose generation
        const narration = await narrateResult(operation, engineResult);
        narrative = narration.content;
        model = narration.model;
        tokensUsed = narration.tokensUsed || 0;
        if (narration.error) {
          narrative = `(Narration unavailable: ${narration.error})`;
        }
      } else {
        // Template-based narrative (default) — fully local, no LLM call
        narrative = generateNarrative(engineResult);
        model = "template";
      }
    }

    // Step 4: Persist to history
    saveScenario(query, narrative, JSON.stringify(engineResult), model);

    res.json({ engine: engineResult, narrative, model, tokensUsed });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

apiRouter.post("/scenario/v2/parse-only", async (req: Request, res: Response) => {
  const { query } = req.body;
  if (!query) { res.status(400).json({ error: "query required" }); return; }

  try {
    const context = buildAnonymizedContextSnapshot();
    const parseResult = await parseIntent(query, context);
    if (!parseResult.ok) {
      sendIntentParseFailure(res, parseResult);
      return;
    }
    res.json(parseResult.operation);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- AI Scenario V3 (agentic tool-calling loop) ----
apiRouter.post("/scenario/v3", async (req: Request, res: Response) => {
  const { query } = req.body;
  if (!query) { res.status(400).json({ error: "query required" }); return; }

  try {
    const result = await agenticScenario(query);

    // Persist to history
    saveScenario(query, result.content, JSON.stringify(result.scenarios_explored), result.model);

    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ---- Config ----
apiRouter.get("/config", (_req, res) => {
  const config = getAllConfig();
  // Mask PAT for frontend display
  if (config.github_pat) {
    const pat = config.github_pat;
    config.github_pat_masked = pat.length > 8
      ? pat.slice(0, 4) + "****" + pat.slice(-4)
      : "****";
    delete config.github_pat;
  }
  res.json(config);
});

apiRouter.put("/config", (req: Request, res: Response) => {
  const entries = req.body as Record<string, string>;
  for (const [key, value] of Object.entries(entries)) {
    setConfig(key, value);
  }
  res.json({ ok: true });
});

// ---- Excel Import ----
apiRouter.post("/import/excel", uploadSingle("file"), handleExcelImportV1);
apiRouter.post("/import/excel/v2", uploadSingle("file"), handleExcelImportV2);

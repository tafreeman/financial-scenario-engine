import { Router, Request, Response } from "express";
import multer from "multer";
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
  buildContextSnapshot,
  saveScenario,
} from "./db.js";
import { runScenario, parseIntent, narrateResult, agenticScenario } from "./ai.js";
import { executeScenario } from "./engine/executor.js";
import { handleExcelImportV1, handleExcelImportV2 } from "./import/excel/index.js";

export const apiRouter = Router();
const upload = multer({ storage: multer.memoryStorage() });

// ---- Health ----
apiRouter.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ---- Dashboard summary ----
apiRouter.get("/dashboard", (_req, res) => {
  const projects = getProjectsWithBurn();
  const staffing = getStaffingByProject() as any[];

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
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

apiRouter.patch("/projects/:id", (req: Request, res: Response) => {
  updateProject(Number(req.params.id), req.body);
  res.json({ ok: true });
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
  removeStaffing(Number(req.params.id));
  res.json({ ok: true });
});

// ---- Rate Card ----
apiRouter.get("/rates", (_req, res) => {
  res.json(getLaborCategories());
});

// ---- AI Scenario ----
apiRouter.post("/scenario", async (req: Request, res: Response) => {
  const { query } = req.body;
  if (!query) { res.status(400).json({ error: "query required" }); return; }
  const result = await runScenario(query);
  res.json(result);
});

apiRouter.get("/scenarios", (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : 50;
  res.json(getScenarioHistory(limit));
});

// ---- AI Scenario V2 (deterministic engine + LLM narration) ----
apiRouter.post("/scenario/v2", async (req: Request, res: Response) => {
  const { query, skip_narrative } = req.body;
  if (!query) { res.status(400).json({ error: "query required" }); return; }

  try {
    // Step 1: LLM parses intent into structured operation
    const context = buildContextSnapshot();
    const operation = await parseIntent(query, context);

    // Step 2: Deterministic engine computes results
    const engineResult = executeScenario(operation);

    // Step 3: LLM narrates the pre-computed results (optional)
    let narrative = "";
    let model = "";
    let tokensUsed = 0;
    if (!skip_narrative) {
      const narration = await narrateResult(operation, engineResult);
      narrative = narration.content;
      model = narration.model;
      tokensUsed = narration.tokensUsed || 0;
      if (narration.error) {
        narrative = `(Narration unavailable: ${narration.error})`;
      }
    }

    // Step 4: Persist to history
    saveScenario(query, narrative, JSON.stringify(engineResult), model);

    res.json({ engine: engineResult, narrative, model, tokensUsed });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post("/scenario/v2/parse-only", async (req: Request, res: Response) => {
  const { query } = req.body;
  if (!query) { res.status(400).json({ error: "query required" }); return; }

  try {
    const context = buildContextSnapshot();
    const operation = await parseIntent(query, context);
    res.json(operation);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
apiRouter.post("/import/excel", upload.single("file"), handleExcelImportV1);
apiRouter.post("/import/excel/v2", upload.single("file"), handleExcelImportV2);

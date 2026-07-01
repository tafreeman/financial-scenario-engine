import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { z } from "zod";
import { requireAppToken } from "./auth.js";
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
import { refineEndpointNoPrivate, refineOllamaEndpoint } from "./ssrf.js";

/** Maximum wall-clock budget for the v3 agentic endpoint (ms). */
const MAX_AGENTIC_TIMEOUT_MS = 90_000;
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

/**
 * Baseline per-IP rate limiter for ALL /api routes (reads included).
 *
 * Previously only the mutating/LLM endpoints were throttled, leaving the GET
 * read routes (/dashboard, /projects, /staffing, /rates, /scenarios, /config)
 * with no per-IP ceiling — a single client could hammer them unbounded. 300
 * req/min/IP is generous enough for normal dashboard polling and multi-panel
 * page loads while still capping abusive traffic.
 *
 * Applied via apiRouter.use() below, BEFORE any route is defined, so it runs
 * for every endpoint. The stricter scenarioRateLimit (10/min) still stacks on
 * top of this for the paid LLM endpoints.
 */
const readRouteLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down." },
});

apiRouter.use(readRouteLimiter);

/**
 * Per-IP rate limiter applied only to the LLM-backed scenario endpoints.
 * Each of these can trigger up to 8 paid LLM calls (ai.ts MAX_ITERATIONS=8),
 * so we throttle to 10 requests per minute per IP to prevent runaway spend.
 * Stacks on top of readRouteLimiter (above).
 */
const scenarioRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many scenario requests — please wait before trying again." },
});

/** Accepted MIME types for Excel uploads. */
const XLSX_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel",                                           // .xls (legacy)
]);

/**
 * Bounds for GET /scenarios ?limit=.
 *
 * Mirrors getScenarioHistory's own default (server/db.ts) so an absent param
 * behaves identically to before this fix. SCENARIOS_MAX_LIMIT caps an
 * oversized-but-numeric value (e.g. ?limit=99999999) so a single request
 * can't force an unbounded table scan/response — verified empirically that
 * better-sqlite3 has no built-in ceiling on a bound LIMIT parameter.
 */
const SCENARIOS_DEFAULT_LIMIT = 50;
const SCENARIOS_MAX_LIMIT = 500;

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

/** Only these mutable project columns are accepted; all other keys are rejected. */
const patchProjectSchema = z.object({
  name: z.string().min(1).optional(),
  total_budget: z.number().nonnegative().optional(),
  spent_to_date: z.number().nonnegative().optional(),
  status: z.string().min(1).optional(),
  // Physical percent complete (0–100). Drives Earned Value directly instead of
  // the spend-ratio proxy when supplied; validated at the boundary so out-of-range
  // values never reach the engine's clamp.
  percent_complete: z.number().min(0).max(100).optional(),
}).strict();

/** ISO calendar date (YYYY-MM-DD) that must also be a *real* date. The regex
 *  alone accepts impossible dates like "2026-02-31", which `new Date()` silently
 *  rolls over (→ 2026-03-03); the round-trip refine (mirroring the new_end_date
 *  guard in engine/validation.ts) rejects them. The NaN check runs first so an
 *  unparseable value short-circuits before toISOString() can throw RangeError. */
function isoCalendarDate(field: string) {
  return z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${field} must be an ISO date (YYYY-MM-DD)`)
    .refine(
      (s) => {
        const d = new Date(`${s}T00:00:00Z`);
        return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
      },
      { message: `${field} must be a real calendar date` },
    );
}

/** POST /projects body. Dates, when provided, must be real ISO calendar dates:
 *  the engine does `new Date(project.start_date)`, and a garbage or impossible
 *  date yields an Invalid Date → NaN that silently poisons every EVM metric
 *  (PV, CPI, SPI, EAC). Validate at the boundary; unknown keys are rejected.
 *  When BOTH dates are supplied they must form a forward range: an inverted
 *  range (start after end) yields a negative planned-duration that distorts the
 *  same EVM metrics, so reject it here rather than letting it reach the engine. */
const postProjectSchema = z
  .object({
    name: z.string().min(1),
    total_budget: z.number().nonnegative().optional(),
    start_date: isoCalendarDate("start_date").optional(),
    end_date: isoCalendarDate("end_date").optional(),
  })
  .strict()
  .refine(
    (data) =>
      // Only compare when both endpoints are present; each has already passed
      // isoCalendarDate (a real YYYY-MM-DD), so the Date parse cannot be NaN.
      data.start_date === undefined ||
      data.end_date === undefined ||
      new Date(`${data.start_date}T00:00:00Z`).getTime() <=
        new Date(`${data.end_date}T00:00:00Z`).getTime(),
    { message: "start_date must be on or before end_date", path: ["end_date"] },
  );

/** POST /staffing body. Unlike every other mutating route, this endpoint used to
 *  destructure req.body directly and rely on truthiness checks (`!project_id`),
 *  which silently accept 0/negative ids and any hours_per_week value (including
 *  negative numbers) into the DB. Validate at the boundary like the project
 *  routes; unknown keys are rejected. hours_per_week defaults to 40 (matching
 *  the DB column default and the prior `|| 40` fallback) and is capped at 168
 *  (hours in a week) to reject nonsensical values. */
const postStaffingSchema = z.object({
  project_id: z.number().int().positive(),
  labor_category_id: z.number().int().positive(),
  person_name: z.string().min(1).max(200).optional(),
  hours_per_week: z.number().positive().max(168).default(40),
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

apiRouter.post("/projects", requireAppToken, (req: Request, res: Response) => {
  const parsed = postProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid fields", details: parsed.error.issues });
    return;
  }
  const { name, total_budget, start_date, end_date } = parsed.data;
  try {
    const result = addProject(name, total_budget ?? 0, start_date ?? "", end_date ?? "");
    res.json({ id: result.lastInsertRowid });
  } catch (e: unknown) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

apiRouter.patch("/projects/:id", requireAppToken, (req: Request, res: Response) => {
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
apiRouter.get("/staffing", (req: Request, res: Response) => {
  let projectId: number | undefined;
  if (req.query.project_id !== undefined) {
    const parsedId = Number(req.query.project_id);
    // Mirrors the :id guard on PATCH /projects/:id and DELETE /staffing/:id
    // below — reject non-numeric/non-positive-integer values instead of
    // silently falling through. Without this, Number("abc") = NaN, and
    // `if (projectId)` in getStaffingByProject treats NaN as falsy, so a
    // request scoped to one project silently returns EVERY project's
    // staffing instead of erroring.
    if (!Number.isInteger(parsedId) || parsedId <= 0) {
      res.status(400).json({ error: "Invalid project_id" });
      return;
    }
    projectId = parsedId;
  }
  res.json(getStaffingByProject(projectId));
});

apiRouter.post("/staffing", requireAppToken, (req: Request, res: Response) => {
  const parsed = postStaffingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid fields", details: parsed.error.issues });
    return;
  }
  const { project_id, labor_category_id, person_name, hours_per_week } = parsed.data;
  const result = addStaffing(project_id, labor_category_id, person_name ?? "", hours_per_week);
  res.json({ id: result.lastInsertRowid });
});

apiRouter.delete("/staffing/:id", requireAppToken, (req: Request, res: Response) => {
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

apiRouter.get("/scenarios", (req: Request, res: Response) => {
  let limit = SCENARIOS_DEFAULT_LIMIT;
  if (req.query.limit !== undefined) {
    const parsedLimit = Number(req.query.limit);
    // Without this guard, ?limit=abc produces NaN, which better-sqlite3
    // rejects at bind time with a thrown "datatype mismatch" (verified
    // empirically) — an unguarded 500 with no matching route-level try/catch.
    // Reject non-numeric/non-positive input the same way the sibling :id
    // routes below reject invalid ids, rather than let it reach the DB layer.
    if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
      res.status(400).json({ error: "Invalid limit" });
      return;
    }
    // A numeric-but-oversized value (e.g. ?limit=99999999) is not "invalid,"
    // just too large — clamp it rather than reject, matching LIMIT/page-size
    // conventions elsewhere.
    limit = Math.min(parsedLimit, SCENARIOS_MAX_LIMIT);
  }
  res.json(getScenarioHistory(limit));
});

// ---- AI Scenario V2 (deterministic engine + narrative) ----
// requireAppToken: scenario routes send financial context to the LLM and
// persist results to the database — they must not be callable by unauthenticated
// co-located processes.
apiRouter.post("/scenario/v2", requireAppToken, scenarioRateLimit, async (req: Request, res: Response) => {
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

    // Surface project-resolution errors as 422 Unprocessable Entity
    if (engineResult.error) {
      res.status(422).json({ error: engineResult.error });
      return;
    }

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
    saveScenario(query, narrative, JSON.stringify(engineResult), model, tokensUsed);

    // Rounding policy (see server/engine/types.ts): the engine returns full
    // floating-point precision in all financial fields.  Clients are responsible
    // for formatting dollar values to cents and percentages to one decimal place.
    res.json({ engine: engineResult, narrative, model, tokensUsed });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

apiRouter.post("/scenario/v2/parse-only", requireAppToken, scenarioRateLimit, async (req: Request, res: Response) => {
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
apiRouter.post("/scenario/v3", requireAppToken, scenarioRateLimit, async (req: Request, res: Response) => {
  const { query } = req.body;
  if (!query) { res.status(400).json({ error: "query required" }); return; }

  try {
    // Race the agentic loop against an endpoint budget to prevent runaway iteration.
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("AGENTIC_TIMEOUT")), MAX_AGENTIC_TIMEOUT_MS)
    );
    let result;
    try {
      result = await Promise.race([agenticScenario(query), timeoutPromise]);
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "AGENTIC_TIMEOUT") {
        res.status(504).json({ error: `Agentic scenario timed out after ${MAX_AGENTIC_TIMEOUT_MS / 1000}s. Try a simpler query.` });
        return;
      }
      throw err;
    }

    // Persist to history
    saveScenario(query, result.content, JSON.stringify(result.scenarios_explored), result.model, result.tokensUsed);

    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── Config key allowlist ────────────────────────────────────────────────────
// Only these keys may be written via PUT /api/config.  Any request containing
// a key outside this set is rejected with 400.  This prevents clients from
// injecting arbitrary config keys (closes partial mitigation from Wave-1).
//
// SSRF guards:
//  - `endpoint` (GitHub Models) must use https and must NOT resolve to a private
//    or loopback address.  The only legitimate value points at models.github.ai
//    or another cloud endpoint; pointing it at 127.0.0.1 / 192.168.x makes no
//    sense and would allow a co-located process to redirect PAT exfiltration.
//  - `ollama_endpoint` MUST also use https in production, but Ollama's default
//    local binding is plain http://localhost:11434 — that specific host is
//    explicitly allowed so the Ollama workflow continues to work.  Private-range
//    IPs (10/8, 172.16/12, 192.168/16) and link-local (169.254/16) are still
//    blocked even for ollama_endpoint.
//
// The host-classification + refinement helpers used below live in server/ssrf.ts
// (imported above) so the security tests exercise the exact same implementation.

const CONFIG_WRITABLE_KEYS = z.object({
  github_pat: z.string().optional(),
  model: z.string().optional(),
  endpoint: z
    .string()
    .url()
    .refine(refineEndpointNoPrivate, {
      message:
        "endpoint must use https and must not resolve to a loopback or private-range host",
    })
    .optional(),
  temperature: z.string().optional(),
  max_tokens: z.string().optional(),
  llm_provider: z.enum(["github", "ollama"]).optional(),
  ollama_model: z.string().optional(),
  ollama_endpoint: z
    .string()
    .url()
    .refine(refineOllamaEndpoint, {
      message:
        "ollama_endpoint must use https (or http for localhost only) and must not resolve to a private-range IP",
    })
    .optional(),
  llm_timeout_ms: z.string().optional(),
}).strict();

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

// requireAppToken guards PUT /api/config against unauthenticated writes.
// Without this guard, any co-located process could overwrite `endpoint` to an
// attacker-controlled host and cause the next scenario request to exfiltrate
// the GitHub PAT and financial data (SSRF + PAT exfiltration).
apiRouter.put("/config", requireAppToken, (req: Request, res: Response) => {
  const parsed = CONFIG_WRITABLE_KEYS.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Unknown or invalid config keys", details: parsed.error.issues });
    return;
  }
  const entries = parsed.data as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) setConfig(key, value);
  }
  res.json({ ok: true });
});

// ---- Excel Import ----
// requireAppToken runs BEFORE uploadSingle so an unauthenticated caller is
// rejected with 401 before multer ever buffers the upload. These routes bulk-
// overwrite the portfolio, so they must not be callable by an unauthenticated
// co-located process.
apiRouter.post("/import/excel", requireAppToken, uploadSingle("file"), handleExcelImportV1);
apiRouter.post("/import/excel/v2", requireAppToken, uploadSingle("file"), handleExcelImportV2);

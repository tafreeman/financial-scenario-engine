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
 * Per-IP rate limiter applied only to the LLM-backed scenario endpoints.
 * Each of these can trigger up to 8 paid LLM calls (ai.ts MAX_ITERATIONS=8),
 * so we throttle to 10 requests per minute per IP to prevent runaway spend.
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

apiRouter.post("/projects", requireAppToken, (req: Request, res: Response) => {
  const { name, total_budget, start_date, end_date } = req.body;
  if (!name) { res.status(400).json({ error: "name required" }); return; }
  try {
    const result = addProject(name, total_budget || 0, start_date || "", end_date || "");
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
apiRouter.get("/staffing", (req, res) => {
  const projectId = req.query.project_id ? Number(req.query.project_id) : undefined;
  res.json(getStaffingByProject(projectId));
});

apiRouter.post("/staffing", requireAppToken, (req: Request, res: Response) => {
  const { project_id, labor_category_id, person_name, hours_per_week } = req.body;
  if (!project_id || !labor_category_id) {
    res.status(400).json({ error: "project_id and labor_category_id required" }); return;
  }
  const result = addStaffing(project_id, labor_category_id, person_name || "", hours_per_week || 40);
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

apiRouter.get("/scenarios", (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : 50;
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

/**
 * If `hostname` is an IPv4-mapped or IPv4-compatible IPv6 address, return the
 * embedded dotted-decimal IPv4 string; otherwise return null.
 *
 * Node preserves these forms verbatim in URL.hostname (with surrounding
 * brackets), so the plain dotted-decimal checks below never match them:
 *   new URL("https://[::ffff:c0a8:0101]/").hostname === "[::ffff:c0a8:101]"  // 192.168.1.1
 *   new URL("https://[::ffff:7f00:1]/").hostname     === "[::ffff:7f00:1]"   // 127.0.0.1
 *   new URL("https://[::ffff:192.168.1.1]/").hostname=== "[::ffff:c0a8:101]" // 192.168.1.1
 * Without extracting and re-checking the embedded IPv4, these slip past the
 * loopback/private filters and reopen the SSRF / PAT-exfiltration path.
 *
 * Handles both notations, with or without surrounding brackets:
 *   - hex embedded:    ::ffff:c0a8:0101  ->  192.168.1.1
 *   - dotted embedded: ::ffff:192.168.1.1 / ::192.168.1.1 -> 192.168.1.1
 */
function mappedIpv4(hostname: string): string | null {
  let h = hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  // Dotted embedded form: ::ffff:192.168.1.1 (mapped) or ::192.168.1.1 (compatible)
  const dotted = h.match(/^::(?:ffff:)?((?:\d{1,3}\.){3}\d{1,3})$/);
  if (dotted?.[1]) return dotted[1];
  // Hex embedded form: ::[ffff:]<hi16>:<lo16> — mapped (::ffff:) OR compatible
  // (::, no ffff:). Node normalizes dotted ::127.0.0.1 / ::192.168.1.1 to this
  // ffff-less hex form, so the ffff: group must be optional to catch them.
  const hex = h.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex?.[1] && hex[2]) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join(".");
  }
  return null;
}

/** Returns true if the hostname is a loopback address. */
function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase();
  // IPv4-mapped / IPv4-compatible IPv6 (e.g. [::ffff:7f00:1] -> 127.0.0.1):
  // re-check the embedded IPv4 so mapped loopback can't bypass this filter.
  const embedded = mappedIpv4(h);
  if (embedded !== null) return isLoopback(embedded);
  // IPv4 loopback (127.0.0.0/8)
  if (/^127\./.test(h)) return true;
  // IPv6 loopback
  if (h === "::1" || h === "[::1]") return true;
  // Hostname aliases
  if (h === "localhost") return true;
  return false;
}

/** Returns true if the hostname falls within an RFC-1918 or link-local range. */
function isPrivateIp(hostname: string): boolean {
  const h = hostname.toLowerCase();
  // IPv4-mapped / IPv4-compatible IPv6 (e.g. [::ffff:c0a8:0101] -> 192.168.1.1):
  // re-check the embedded IPv4 so mapped private hosts can't bypass this filter.
  const embedded = mappedIpv4(h);
  if (embedded !== null) return isPrivateIp(embedded);
  if (/^10\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  return false;
}

/**
 * Zod refinement: reject loopback and private-range hosts in endpoint URLs.
 * Applied to `endpoint` (GitHub Models) — any loopback/private host is invalid.
 */
function refineEndpointNoPrivate(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    if (protocol !== "https:") return false;
    if (isLoopback(hostname)) return false;
    if (isPrivateIp(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Zod refinement for `ollama_endpoint`:
 *  - localhost (loopback) is ALLOWED because Ollama's default binding is
 *    http://localhost:11434 — blocking it would break the primary Ollama flow.
 *  - Private-range IPs (10/8, 172.16/12, 192.168/16, 169.254/16) are still
 *    rejected — they provide no legitimate use case and could host hostile servers.
 *  - https is preferred but http is accepted for localhost only (Ollama does not
 *    expose TLS by default on the local loopback).
 */
function refineOllamaEndpoint(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    if (protocol !== "https:" && protocol !== "http:") return false;
    // IPv4-mapped/compatible IPv6 (e.g. [::ffff:7f00:1]) has no legitimate Ollama
    // use and must never benefit from the localhost allowance below — reject it
    // outright before the loopback check so mapped loopback can't slip through.
    if (mappedIpv4(hostname) !== null) return false;
    // Localhost via http is permitted (Ollama default)
    if (isLoopback(hostname)) return true;
    // Any other host must use https and must not be private-range
    if (protocol !== "https:") return false;
    if (isPrivateIp(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

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

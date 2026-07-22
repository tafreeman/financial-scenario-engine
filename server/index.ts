import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { apiRouter } from "./routes.js";
import { getDb } from "./db.js";
import { resolveTrustProxyHops } from "./trust-proxy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "127.0.0.1";
const IS_DEV = process.env.NODE_ENV !== "production";

const app = express();

// Trust proxy (rate-limit correctness behind a reverse proxy) — FSE#5
// (2026-07-21 audit). See server/trust-proxy.ts for the full threat model
// and why this defaults to 0 (disabled) rather than `true`. Set
// TRUST_PROXY_HOPS=1 when deploying behind exactly one reverse proxy (see
// the CORS_ORIGIN reverse-proxy guidance in README.md, "CORS configuration").
const trustProxyHops = resolveTrustProxyHops();
if (trustProxyHops > 0) {
  app.set("trust proxy", trustProxyHops);
}

// CORS — restrict to an explicit origin in production.
// Set CORS_ORIGIN in the environment for any origin other than the default local dev server.
// Example: CORS_ORIGIN=https://your-app.example.com
//
// Guard: wildcard CORS is a critical misconfiguration — refuse to start.
if (process.env.CORS_ORIGIN === "*") {
  console.error(
    "FATAL: CORS_ORIGIN='*' is not permitted. " +
    "Set CORS_ORIGIN to an explicit origin (e.g. https://your-app.example.com)."
  );
  process.exit(1);
}

// Default covers both Vite dev server hostnames (localhost and 127.0.0.1 on port 5173).
const corsOrigin: string | string[] = process.env.CORS_ORIGIN
  ?? ["http://localhost:5173", "http://127.0.0.1:5173"];

app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: "10mb" }));

// API routes
app.use("/api", apiRouter);

// Rate-limit static asset + SPA-fallback serving (both read from disk).
// This limiter ONLY guards the express.static + SPA-fallback handlers registered
// *below* it — the /api routes mounted above are throttled separately inside
// routes.ts (readRouteLimiter 300/min for all reads, scenarioRateLimit 10/min on
// the paid LLM endpoints). The high 2000/min ceiling here exists because a single
// page load fans out into many asset requests, and must not be throttled.
const staticLimiter = rateLimit({
  windowMs: 60_000,
  limit: 2000,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(staticLimiter);

// Serve built frontend in production
const clientDist = path.join(__dirname, "..", "client", "dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
} else if (!IS_DEV) {
  console.warn("⚠ client/dist not found — run 'npm run build' first");
}

// Ensure data directory exists
const dataDir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Initialize DB on startup
getDb();

app.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`
┌──────────────────────────────────────────────┐
│  Financial Scenario Engine                   │
│  ${url.padEnd(42)}│
│  API:  ${(url + "/api/health").padEnd(38)}│
│  Press Ctrl+C to stop                        │
└──────────────────────────────────────────────┘`);

  // Auto-open browser
  if (!IS_DEV) {
    import("open").then((mod) => mod.default(url)).catch(() => {});
  }
});

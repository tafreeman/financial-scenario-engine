import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { apiRouter } from "./routes.js";
import { getDb } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "127.0.0.1";
const IS_DEV = process.env.NODE_ENV !== "production";

const app = express();

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

// Serve built frontend in production
const clientDist = path.join(__dirname, "..", "client", "dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  // Rate-limit the SPA fallback (it reads index.html from disk on every hit)
  // so the catch-all route cannot be used as an unbounded file-serving vector.
  const spaLimiter = rateLimit({
    windowMs: 60_000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.get("*", spaLimiter, (_req, res) => {
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

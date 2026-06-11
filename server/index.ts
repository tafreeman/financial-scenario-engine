import express from "express";
import cors from "cors";
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
app.use(cors({ origin: process.env.CORS_ORIGIN || "http://127.0.0.1:3000" }));
app.use(express.json({ limit: "10mb" }));

// API routes
app.use("/api", apiRouter);

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

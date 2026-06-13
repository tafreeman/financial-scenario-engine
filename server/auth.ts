/**
 * Local shared-secret middleware for mutating API routes.
 *
 * Threat model: localhost-bound server but any co-located process can PUT
 * /api/config and redirect the LLM endpoint to exfiltrate the GitHub PAT
 * and financial data.  A shared secret eliminates that without requiring
 * a full authentication system.
 *
 * Secret sourcing (in order of precedence):
 *  1. APP_API_TOKEN env var — lets CI/scripts supply a stable token.
 *  2. Auto-generated at startup via crypto.randomBytes(32) — logged ONCE
 *     so the local user / shell can read it.  Never logged again.
 *
 * Header: x-app-token
 * Comparison: crypto.timingSafeEqual to prevent timing-oracle attacks.
 */

import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";

// ─── Secret initialisation ────────────────────────────────────────────────────

const TOKEN_HEADER = "x-app-token";

function initSecret(): string {
  const fromEnv = process.env.APP_API_TOKEN;
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  // Auto-generate a URL-safe base64 token (43 printable chars, 256-bit entropy).
  const generated = crypto.randomBytes(32).toString("base64url");
  // Log ONCE at startup — this is the only time the secret appears in the console.
  console.log(
    "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
    "  APP API TOKEN (set in x-app-token header or APP_API_TOKEN env)\n" +
    `  ${generated}\n` +
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
  );
  return generated;
}

// Initialised once at module load time — stable for the lifetime of the process.
export const APP_SECRET: string = initSecret();

// Pre-encode to Buffer once so we can use timingSafeEqual on every request
// without allocating per-call.
const secretBuf: Buffer = Buffer.from(APP_SECRET, "utf8");

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * requireAppToken — reject requests that do not present the correct shared
 * secret in the x-app-token header.
 *
 * Uses crypto.timingSafeEqual so the rejection time is constant regardless of
 * how much of the token matches, preventing timing-oracle attacks.
 */
export function requireAppToken(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const provided = req.headers[TOKEN_HEADER];

  if (typeof provided !== "string" || provided.length === 0) {
    res.status(401).json({ error: "Missing x-app-token header" });
    return;
  }

  const providedBuf = Buffer.from(provided, "utf8");

  // timingSafeEqual requires equal-length buffers.  If lengths differ, the
  // token is wrong — short-circuit with a constant-time path that still
  // returns false rather than throwing.
  const valid =
    providedBuf.length === secretBuf.length &&
    crypto.timingSafeEqual(providedBuf, secretBuf);

  if (!valid) {
    res.status(401).json({ error: "Invalid x-app-token" });
    return;
  }

  next();
}

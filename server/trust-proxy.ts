/**
 * TRUST_PROXY_HOPS resolution for Express's `trust proxy` setting.
 *
 * FSE#5 (2026-07-21 audit): no `trust proxy` was set anywhere in server/, but
 * README documents a reverse-proxy deployment mode (see the CORS_ORIGIN
 * section) and the Dockerfile's runtime stage sets HOST=0.0.0.0 for exactly
 * that mode. Behind a reverse proxy, every inbound request's socket-level
 * source is the PROXY itself — without `trust proxy`, Express's `req.ip`
 * (and therefore every express-rate-limit keyGenerator built on it, e.g.
 * readRouteLimiter/scenarioRateLimit in server/routes.ts) resolves to the
 * proxy's own address for every request, so every distinct client behind the
 * proxy shares ONE rate-limit bucket — one abusive client can exhaust the
 * budget for everyone else on that path.
 *
 * Extracted into its own module (mirroring server/ssrf.ts's pattern) so the
 * parsing logic server/index.ts wires into `app.set("trust proxy", …)` is the
 * SAME implementation this module's tests exercise — not a hand-copied clone
 * that could silently drift.
 *
 * NEVER set `trust proxy` to `true` (trust the entire chain): the LEFT-MOST
 * entry of X-Forwarded-For is fully attacker-controlled by the calling
 * client (anyone can send `X-Forwarded-For: 1.2.3.4`) — Express only reads
 * a trustworthy entry when told exactly how many hops (reverse proxies it
 * actually sits behind) to trust. express-rate-limit hard-errors with
 * ERR_ERL_PERMISSIVE_TRUST_PROXY specifically to stop `true` from shipping.
 * A fixed hop COUNT (this module's return value) instead makes Express read
 * the correct Nth-from-the-right X-Forwarded-For entry — one that only a
 * proxy hop it was told to trust could have appended.
 *
 * DEFAULT: 0 (no proxy trusted — Express's own out-of-the-box behavior,
 * `req.ip` = the direct socket address). This is deliberately NOT
 * auto-enabled just because HOST=0.0.0.0 is set: binding a non-loopback
 * interface does not by itself prove a trusted reverse proxy sits in front
 * (the process could be directly internet-facing), and defaulting to trust
 * X-Forwarded-For in that case would let ANY client spoof its rate-limit
 * identity. Operators deploying behind exactly one reverse proxy (the mode
 * README's CORS_ORIGIN section documents) must explicitly set
 * TRUST_PROXY_HOPS=1.
 */
export function resolveTrustProxyHops(env: Record<string, string | undefined> = process.env): number {
  const raw = env.TRUST_PROXY_HOPS;
  if (raw === undefined || raw.trim() === "") return 0;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.warn(
      `TRUST_PROXY_HOPS="${raw}" is not a non-negative integer — ignoring and defaulting to 0 (no proxy hop trusted).`
    );
    return 0;
  }
  return parsed;
}

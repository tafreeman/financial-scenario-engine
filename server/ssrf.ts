/**
 * SSRF guard helpers for config endpoint URLs.
 *
 * These functions back the Zod refinements on the writable `endpoint` and
 * `ollama_endpoint` config keys (see routes.ts → CONFIG_WRITABLE_KEYS). They are
 * extracted into their own module so the production router and the security tests
 * exercise the SAME implementation — previously the test re-declared byte-for-byte
 * copies, which could silently drift from the code actually guarding requests.
 *
 * Threat model: a co-located process must not be able to repoint `endpoint` at a
 * loopback/private host and redirect the next scenario request (which carries the
 * GitHub PAT + financial context) to an attacker-controlled server.
 */

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
export function mappedIpv4(hostname: string): string | null {
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
export function isLoopback(hostname: string): boolean {
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
export function isPrivateIp(hostname: string): boolean {
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
export function refineEndpointNoPrivate(url: string): boolean {
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
export function refineOllamaEndpoint(url: string): boolean {
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

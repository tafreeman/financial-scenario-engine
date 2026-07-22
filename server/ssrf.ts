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

import dns from "node:dns/promises";
import net from "node:net";

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

// ─── FSE#4 (2026-07-21 grounded audit): DNS-rebinding-aware SSRF check ───────
//
// Everything above classifies a hostname by its STRING form only. A DOMAIN
// name that RESOLVES to a loopback/private/link-local address (e.g. an
// attacker-controlled DNS record pointing "evil.example.com" at 127.0.0.1, or
// the cloud-metadata address 169.254.169.254) sails straight through every
// check above, because the string "evil.example.com" is itself neither
// loopback nor private-range — only its resolved address is. A domain used
// this way, once stored via PUT /api/config, gets fetched at request time
// with the attacker's PAT/API key attached (see server/ai.ts chatRequest()).
//
// The functions below close that gap by additionally resolving DOMAIN
// hostnames (never literal IPs/"localhost" — those are already fully
// classified synchronously above) via dns.lookup — the SAME resolution path
// Node's fetch/undici actually uses to connect (getaddrinfo), NOT
// dns.resolve4/dns.resolve6 — and rejecting if ANY returned address (A or
// AAAA; `{ all: true }` covers both in one call) is loopback/private/
// link-local (reusing isLoopback/isPrivateIp above, including their
// mapped-IPv4 unwrap).
//
// KNOWN LIMITATION (deliberately out of scope): this is a validate-time check
// only, run once when PUT /api/config writes the hostname. Between that write
// and a later request actually connecting to it, the DNS record can change
// (TOCTOU / "DNS rebinding") — the stronger control is pinning the resolved
// address at request time (e.g. a custom lookup hook on the outbound
// connection) and re-validating on every connect, not just at config-write
// time. Request-time pinning is out of scope for this fix.

/**
 * Shape of Node's `dns.lookup(hostname, { all: true })`. Extracted as an
 * injectable type (default implementation below performs the real lookup) so
 * tests can supply deterministic resolved addresses instead of performing a
 * real DNS lookup — mirrors the fetchImpl/exec injection pattern already used
 * in server/ai.ts (chatRequest's fetchImpl, readGhCliToken's exec).
 */
export type DnsLookupAll = (
  hostname: string,
  options: { all: true }
) => Promise<{ address: string; family: number }[]>;

const defaultDnsLookupAll: DnsLookupAll = (hostname, options) => dns.lookup(hostname, options);

/**
 * True when `hostname` (as it appears in URL.hostname — bracketed for IPv6)
 * is a literal IP address or the "localhost" alias, i.e. a form the
 * synchronous checks above already fully classify without needing a DNS
 * lookup. Anything else is a domain name that must be resolved before it can
 * be classified.
 */
function isLiteralHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost") return true;
  const bare = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  return net.isIP(bare) !== 0;
}

/** Resolve `hostname` and report whether ANY returned address is loopback/private/link-local. */
async function resolvesToPrivateOrLoopback(
  hostname: string,
  dnsLookup: DnsLookupAll
): Promise<boolean> {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  let addresses: { address: string; family: number }[];
  try {
    addresses = await dnsLookup(bare, { all: true });
  } catch {
    // Unresolvable hostname: fail closed. We cannot verify the endpoint is
    // safe, so treat it the same as an unsafe one rather than silently
    // allowing it through.
    return true;
  }
  return addresses.some(({ address }) => isLoopback(address) || isPrivateIp(address));
}

/**
 * Async, DNS-aware version of {@link refineEndpointNoPrivate} for use in an
 * async Zod refinement (see routes.ts CONFIG_WRITABLE_KEYS' `endpoint` /
 * `openrouter_endpoint` keys, validated via `safeParseAsync`). Runs the
 * existing synchronous checks first (protocol + literal-IP/hostname string
 * form — UNCHANGED) and, only when the hostname is a domain name (not a
 * literal IP or the "localhost" alias), additionally resolves it and rejects
 * if any resolved address is loopback/private/link-local.
 *
 * @param dnsLookup - Injectable resolver (defaults to a real `dns.lookup`).
 *   Tests pass a stub so no real DNS lookup happens.
 */
export async function refineEndpointNoPrivateAsync(
  url: string,
  dnsLookup: DnsLookupAll = defaultDnsLookupAll
): Promise<boolean> {
  if (!refineEndpointNoPrivate(url)) return false;
  const { hostname } = new URL(url); // safe: refineEndpointNoPrivate already proved this parses
  if (isLiteralHost(hostname)) return true; // already fully classified above — no DNS needed
  return !(await resolvesToPrivateOrLoopback(hostname, dnsLookup));
}

/**
 * Async, DNS-aware version of {@link refineOllamaEndpoint} — same rationale
 * as {@link refineEndpointNoPrivateAsync} above, applied to ollama_endpoint's
 * non-localhost branch. The `http://localhost` allowance is a literal-hostname
 * alias, already fully covered by the synchronous check, and never reaches
 * the DNS lookup below.
 */
export async function refineOllamaEndpointAsync(
  url: string,
  dnsLookup: DnsLookupAll = defaultDnsLookupAll
): Promise<boolean> {
  if (!refineOllamaEndpoint(url)) return false;
  const { hostname } = new URL(url);
  if (isLiteralHost(hostname)) return true;
  return !(await resolvesToPrivateOrLoopback(hostname, dnsLookup));
}

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

/** Strip surrounding "[" "]" brackets from an IPv6 literal in URL.hostname form. */
function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** Convert two 16-bit hex groups (hi, lo) into a dotted-decimal IPv4 string. */
function hexGroupsToIpv4(hiHex: string, loHex: string): string {
  const hi = parseInt(hiHex, 16);
  const lo = parseInt(loHex, 16);
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join(".");
}

/**
 * If `hostname` is an IPv6 address with an IPv4 address embedded in it, return
 * the embedded dotted-decimal IPv4 string; otherwise return null. Covers three
 * distinct embedding schemes, each with its own well-known prefix:
 *
 *   - IPv4-mapped / IPv4-compatible (::ffff:<ipv4> / ::<ipv4>): the embedded
 *     address sits in the LAST 32 bits.
 *       new URL("https://[::ffff:c0a8:0101]/").hostname === "[::ffff:c0a8:101]"  // 192.168.1.1
 *       new URL("https://[::ffff:7f00:1]/").hostname     === "[::ffff:7f00:1]"   // 127.0.0.1
 *   - NAT64 (64:ff9b::<ipv4>/96, RFC 6052 well-known prefix): same "last 32
 *     bits" embedding, different fixed prefix.
 *       "64:ff9b::a9fe:a9fe" / "64:ff9b::169.254.169.254" -> 169.254.169.254
 *   - 6to4 (2002:<hi>:<lo>::.../16, RFC 3056): the embedded address sits in
 *     the FIRST 32 bits after the fixed "2002:" prefix — anything after (SLA
 *     ID + interface ID) is irrelevant to the embedded-address check.
 *       "2002:a9fe:a9fe::1" -> 169.254.169.254
 *
 * Node preserves all of these forms verbatim (or in Node's own normalized hex
 * form) in URL.hostname, so the plain dotted-decimal range checks below never
 * match them directly. Without extracting and re-checking the embedded IPv4,
 * each scheme slips past the loopback/private filters and reopens the SSRF /
 * PAT-exfiltration path (2026-07-22 security review, PR #49, HIGH).
 *
 * Handles both notations for the "last 32 bits" schemes, with or without
 * surrounding brackets:
 *   - hex embedded:    ::ffff:c0a8:0101 / 64:ff9b::a9fe:a9fe -> 192.168.1.1 / 169.254.169.254
 *   - dotted embedded: ::ffff:192.168.1.1 / ::192.168.1.1 / 64:ff9b::169.254.169.254 -> ...
 */
export function embeddedIpv4(hostname: string): string | null {
  const h = stripBrackets(hostname.toLowerCase());

  // "Last 32 bits" schemes: IPv4-mapped/compatible (::[ffff:]) or NAT64 (64:ff9b::).
  const dotted = h.match(/^(?:::(?:ffff:)?|64:ff9b::)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (dotted?.[1]) return dotted[1];

  const hexSuffix = h.match(/^(?:::(?:ffff:)?|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexSuffix?.[1] && hexSuffix[2]) return hexGroupsToIpv4(hexSuffix[1], hexSuffix[2]);

  // 6to4: embedded address is the FIRST 32 bits after the "2002:" prefix.
  const sixToFour = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/);
  if (sixToFour?.[1] && sixToFour[2]) return hexGroupsToIpv4(sixToFour[1], sixToFour[2]);

  return null;
}

/** Returns true if the hostname is a loopback (or "routes to this host") address. */
export function isLoopback(hostname: string): boolean {
  const h = stripBrackets(hostname.toLowerCase());
  // Embedded IPv4 (mapped/compatible/NAT64/6to4 — see embeddedIpv4 above):
  // re-check the embedded address so it can't bypass this filter.
  const embedded = embeddedIpv4(h);
  if (embedded !== null) return isLoopback(embedded);
  // IPv4 loopback (127.0.0.0/8)
  if (/^127\./.test(h)) return true;
  // IPv4 unspecified ("this host, this network") — used as a client target,
  // most stacks route it to the local host, same threat class as loopback.
  if (h === "0.0.0.0") return true;
  // IPv6 loopback (::1) and unspecified (:: — routes to loopback, same
  // rationale as 0.0.0.0 above).
  if (h === "::1" || h === "::") return true;
  // Hostname aliases
  if (h === "localhost") return true;
  return false;
}

/** Returns true if the hostname falls within an RFC-1918/RFC-4193 or link-local range. */
export function isPrivateIp(hostname: string): boolean {
  const h = stripBrackets(hostname.toLowerCase());
  // Embedded IPv4 (mapped/compatible/NAT64/6to4 — see embeddedIpv4 above):
  // re-check the embedded address so it can't bypass this filter.
  const embedded = embeddedIpv4(h);
  if (embedded !== null) return isPrivateIp(embedded);
  if (/^10\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  // IPv6 unique local address (fc00::/7, RFC 4193) — the IPv6 analogue of
  // RFC-1918 private ranges above. First hex group's first two characters
  // are "fc" or "fd" (top 7 bits fixed at 1111110, 8th bit free).
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  // IPv6 link-local (fe80::/10, RFC 4291) — the IPv6 analogue of the
  // 169.254.0.0/16 IPv4 link-local range above. First hex group matches
  // fe80-febf (top 10 bits fixed at 1111111010).
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
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
 *  - Private-range IPs (10/8, 172.16/12, 192.168/16, 169.254/16, fc00::/7,
 *    fe80::/10) are still rejected — they provide no legitimate use case and
 *    could host hostile servers.
 *  - https is preferred but http is accepted for localhost only (Ollama does not
 *    expose TLS by default on the local loopback).
 */
export function refineOllamaEndpoint(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    if (protocol !== "https:" && protocol !== "http:") return false;
    // Embedded IPv4 (mapped/compatible/NAT64/6to4) has no legitimate Ollama
    // use and must never benefit from the localhost allowance below — reject
    // it outright before the loopback check so an embedded loopback can't
    // slip through.
    if (embeddedIpv4(hostname) !== null) return false;
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
// embedded-IPv4 unwrap).
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
 * Wall-clock cap for a single DNS lookup during SSRF validation (ms). A
 * black-holed or unresponsive resolver must not be able to hold PUT
 * /api/config open indefinitely — once this elapses, the lookup is treated
 * the same as a failed/unresolvable one and fails CLOSED (2026-07-22
 * security review, PR #49, LOW).
 */
const DNS_LOOKUP_TIMEOUT_MS = 5_000;

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
  return net.isIP(stripBrackets(h)) !== 0;
}

/**
 * Resolve `hostname` (bounded by DNS_LOOKUP_TIMEOUT_MS) and report whether
 * ANY returned address is loopback/private/link-local. Fails CLOSED (returns
 * true = "unsafe") on both an unresolvable hostname and a lookup that exceeds
 * the timeout — in both cases the endpoint's safety could not be verified.
 */
async function resolvesToPrivateOrLoopback(
  hostname: string,
  dnsLookup: DnsLookupAll
): Promise<boolean> {
  const bare = stripBrackets(hostname);
  let addresses: { address: string; family: number }[];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    addresses = await Promise.race([
      dnsLookup(bare, { all: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`DNS lookup for "${bare}" exceeded ${DNS_LOOKUP_TIMEOUT_MS}ms`)
            ),
          DNS_LOOKUP_TIMEOUT_MS
        );
      }),
    ]);
  } catch {
    // Unresolvable OR timed-out hostname: fail closed. We cannot verify the
    // endpoint is safe, so treat it the same as an unsafe one rather than
    // silently allowing it through.
    return true;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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

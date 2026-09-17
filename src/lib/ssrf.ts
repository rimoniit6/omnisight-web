// ─── SSRF-safe HTTP client ──────────────────────────────────────────────────
// Hardens all outbound HTTP calls made with user-configured URLs (AI provider
// base URLs, test connections, image fetches). Defends against:
//
//   • Private/loopback/link-local IPv4 & IPv6 (RFC 1918, 4193, 3927, 6890)
//   • Cloud metadata endpoints (169.254.169.254, metadata.*.internal)
//   • Non-canonical IP encodings: decimal (2130706433), octal (0177.0.0.1),
//     hex (0x7f.0.0.1), short form (127.1), IPv4-mapped IPv6 (::ffff:7f00:1)
//   • DNS rebinding: hostnames are resolved and every address is validated
//     immediately before the connection is opened; redirects are never
//     followed (manual mode), so a 3xx cannot pivot to an internal host.

import { lookup } from 'node:dns/promises';

const MAX_RESPONSE_BODY = 10 * 1024 * 1024; // 10 MB cap on read bodies

/**
 * TEST-ONLY escape hatch (never set in production):
 * the DB-backed integration suites run real PostgreSQL servers on loopback and
 * mock Supabase endpoints on 127.0.0.1, so the probes must be allowed to reach
 * private addresses there. Setting OMNISIGHT_ALLOW_PRIVATE_TARGETS=1 disables
 * ONLY the private-address rejection; every other rule (canonical-IP checks,
 * protocol allowlist, no-redirect, DNS re-resolution) stays active.
 * PRODUCTION MUST NOT SET THIS VARIABLE — it disables a core SSRF protection.
 */
function allowPrivateTargetsForTests(): boolean {
  return process.env.OMNISIGHT_ALLOW_PRIVATE_TARGETS === '1';
}

// ─── Strict canonical IPv4 parsing ──────────────────────────────────────────
// Returns the dotted-quad octets only for a *canonical* decimal literal.
// Anything else (octal/hex leading-zero octets, short forms, trailing dots,
// embedded whitespace) returns null so the caller treats it as unsafe.
export function parseCanonicalIPv4(ip: string): number[] | null {
  // Exactly four 1-3 digit groups separated by single dots, no leading zeros.
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return null;
  const octets = ip.split('.');
  for (const oct of octets) {
    // '0' is the only octet allowed to start with 0 (rejects octal '0177').
    if (oct.length > 1 && oct.startsWith('0')) return null;
  }
  const nums = octets.map(Number);
  if (nums.some((n) => n < 0 || n > 255)) return null;
  return nums;
}

export function isPrivateIPv4(ip: string): boolean {
  const octets = parseCanonicalIPv4(ip);
  if (!octets) return true; // non-canonical encodings are treated as unsafe
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true; // 0.0.0.0/8, 10/8, loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 (incl. IETF)
  return false;
}

export function isPrivateIPv6(ip: string): boolean {
  let lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
  // Strip a zone-id suffix (fe80::1%eth0) before comparison.
  const zoneIdx = lower.indexOf('%');
  if (zoneIdx !== -1) lower = lower.slice(0, zoneIdx);

  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local fe80::/10
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
  if (lower.startsWith('fec0')) return true; // deprecated site-local
  if (lower.startsWith('::ffff:')) {
    // IPv4-mapped IPv6 — decode the embedded IPv4 and re-check it.
    const tail = lower.replace(/^::ffff:/, '');
    if (/^[\d.]+$/.test(tail)) {
      return isPrivateIPv4(tail);
    }
    // Hex-encoded mapped address (e.g. ::ffff:7f00:1). The last two groups
    // hold the 32-bit IPv4 address.
    // Hex-encoded mapped address (e.g. ::ffff:7f00:1). Each group is a
    // 16-bit half of the 32-bit IPv4 address.
    const groups = tail.split(':').filter(Boolean);
    if (groups.length <= 2 && groups.every((g) => /^[\da-f]{1,4}$/.test(g))) {
      const hexV4 = groups.map((g) => g.padStart(4, '0')).join('');
      if (/^[\da-f]{1,8}$/.test(hexV4)) {
        const value = parseInt(hexV4, 16);
        const mapped = `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`;
        return isPrivateIPv4(mapped);
      }
    }
    return true; // unknown mapped form — unsafe
  }
  if (lower.startsWith('64:ff9b:')) return true; // NAT64 well-known prefix
  return false;
}

function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === 'metadata.google.internal' || h.endsWith('.metadata.google.internal')) return true;
  if (h === 'metadata.aws.internal' || h.endsWith('.metadata.aws.internal')) return true;
  return false;
}

// ─── Resolve + validate ─────────────────────────────────────────────────────
// Resolves a hostname and rejects the target unless EVERY resolved address is
// public. Returns the list of public addresses for the caller to pin.
async function resolvePublicAddresses(hostname: string): Promise<string[] | null> {
  // Literal IPs bypass DNS (also defeats IP-encoding tricks).
  const bare = hostname.replace(/^\[|\]$/g, '');

  // Test-only bypass — still resolve so callers get usable addresses, but skip
  // every private/reserved rejection (see allowPrivateTargetsForTests()).
  if (allowPrivateTargetsForTests()) {
    try {
      const addresses = await lookup(hostname, { all: true, verbatim: true });
      return addresses.map((a) => a.address);
    } catch {
      return null;
    }
  }

  if (isPrivateHostname(bare)) return null;

  if (bare.includes(':')) {
    return isPrivateIPv6(bare) ? null : [bare];
  }

  // IPv4-family literals and encoded variants (decimal 2130706433,
  // hex 0x7f000001, short form 127.1, octal 0177.0.0.1): anything that is
  // not a canonical public dotted-quad is rejected.
  if (
    parseCanonicalIPv4(bare) ||
    /^\d+$/.test(bare) || // decimal IP
    /^0[xX][0-9a-fA-F]+$/.test(bare) || // hex IP
    /^\d{1,3}(\.\d{1,3}){1,3}$/.test(bare) // short/octal-form IPv4 (127.1 / 0177.0.0.1)
  ) {
    return parseCanonicalIPv4(bare) && !isPrivateIPv4(bare) ? [bare] : null;
  }

  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (addresses.length === 0) return null;
    const publicAddrs: string[] = [];
    for (const addr of addresses) {
      const privateFlag =
        addr.family === 4 ? isPrivateIPv4(addr.address) : isPrivateIPv6(addr.address);
      if (privateFlag) return null; // ANY private address ⇒ reject whole target
      publicAddrs.push(addr.address);
    }
    return publicAddrs;
  } catch {
    return null; // resolution failure ⇒ refuse
  }
}

/**
 * Pure validation: is `url` an http(s) target that resolves exclusively to
 * public addresses? Performs DNS resolution but makes no connection.
 */
export async function isSafeTarget(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const addresses = await resolvePublicAddresses(parsed.hostname);
  return !!addresses && addresses.length > 0;
}

/**
 * Validate that a hostname (or IP literal) resolves exclusively to public
 * addresses. Unlike isSafeTarget, this does NOT require an http(s) URL —
 * it validates bare hostnames for TCP connections (e.g. PostgreSQL).
 *
 * Returns { ok: true } when safe, or { ok: false; reason: string } when the
 * destination is private/reserved/unresolvable.
 */
export async function validateHostIsPublic(
  hostname: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Test-only bypass — see allowPrivateTargetsForTests().
  if (allowPrivateTargetsForTests()) return { ok: true };

  const bare = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!bare) return { ok: false, reason: 'Empty hostname' };

  if (isPrivateHostname(bare)) {
    return { ok: false, reason: `Hostname "${bare}" resolves to a private/internal destination` };
  }

  // IPv6 literal
  if (bare.includes(':')) {
    return isPrivateIPv6(bare)
      ? { ok: false, reason: `IPv6 address "${bare}" is private/reserved` }
      : { ok: true };
  }

  // IPv4 literal or encoded variants — reject all non-canonical forms
  if (
    parseCanonicalIPv4(bare) ||
    /^\d+$/.test(bare) || // pure decimal IP (e.g. 2130706433)
    /^0[xX][0-9a-fA-F]+$/.test(bare) || // hex IP (e.g. 0x7f000001)
    /^\d{1,3}(\.\d{1,3}){1,3}$/.test(bare) || // any dotted-quad (short, octal, etc.)
    /^\d+\.\d+\.\d+\.\d+$/.test(bare) // broader dotted-quad catch (e.g. 0177.0.0.1)
  ) {
    if (!parseCanonicalIPv4(bare) || isPrivateIPv4(bare)) {
      return { ok: false, reason: `IP address "${bare}" is private/reserved/non-canonical` };
    }
    return { ok: true };
  }

  // Hostname: resolve DNS and check every address
  try {
    const addresses = await lookup(bare, { all: true, verbatim: true });
    if (addresses.length === 0) {
      return { ok: false, reason: `Hostname "${bare}" did not resolve to any address` };
    }
    for (const addr of addresses) {
      const isPrivate = addr.family === 4 ? isPrivateIPv4(addr.address) : isPrivateIPv6(addr.address);
      if (isPrivate) {
        return { ok: false, reason: `Hostname "${bare}" resolved to private address ${addr.address}` };
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: `Hostname "${bare}" could not be resolved (DNS failure)` };
  }
}

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  /** Body as text, capped at MAX_RESPONSE_BODY bytes. */
  text: string;
}

/**
 * Fetch `url` with full SSRF protection. Validates the target, resolves DNS,
 * re-validates immediately before connecting, and never follows redirects.
 * Returns null when the target is unsafe or the request cannot be made.
 */
export async function safeFetch(
  url: string,
  init?: RequestInit,
  timeoutMs = 10000
): Promise<SafeFetchResult | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const { hostname } = parsed;
  const bare = hostname.replace(/^\[|\]$/g, '');
  const addresses = await resolvePublicAddresses(bare);
  if (!addresses || addresses.length === 0) return null;

  // Defense-in-depth: re-resolve immediately before connecting to shrink the
  // DNS-rebinding window; reject if the address set now includes private IPs.
  // Only hostnames go through DNS; validated literals are already pinned.
  if (!/^[\d.:]+$/.test(bare)) {
    try {
      const recheck = await lookup(bare, { all: true, verbatim: true });
      for (const addr of recheck) {
        const privateFlag =
          addr.family === 4 ? isPrivateIPv4(addr.address) : isPrivateIPv6(addr.address);
        if (privateFlag) return null;
      }
    } catch {
      return null;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      // Never follow redirects: a 3xx could point at an internal host.
      redirect: 'manual',
    });

    const bodyBuf = Buffer.from(await res.arrayBuffer());
    const text =
      bodyBuf.byteLength > MAX_RESPONSE_BODY
        ? bodyBuf.subarray(0, MAX_RESPONSE_BODY).toString('utf-8')
        : bodyBuf.toString('utf-8');

    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      text,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Convenience: like safeFetch but returns parsed JSON (or null). */
export async function safeFetchJSON<T = unknown>(
  url: string,
  init?: RequestInit,
  timeoutMs?: number
): Promise<T | null> {
  const res = await safeFetch(url, init, timeoutMs);
  if (!res) return null;
  try {
    return JSON.parse(res.text) as T;
  } catch {
    return null;
  }
}

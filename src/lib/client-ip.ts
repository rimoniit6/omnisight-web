// OmniSight — Canonical Client-IP Resolver
//
// THE single place the application decides who the client is for rate
// limiting, audit logging, and device metadata. Every caller (proxy.ts,
// rate-limit.ts, login, agent auth/session, screenshots, device claims, …)
// must resolve client IP through this module — never a local re-implementation
// that picks a different header or a different side of the chain.
//
// ─── Trust model (deployment topology) ───────────────────────────────────────
// The application runs behind a trusted reverse proxy (the repo's reference
// deployment is Caddy; nginx and others are supported).
//
//   - Caddy (repo Caddyfile) OVERWRITES `x-forwarded-for` with the real
//     client IP (`header_up X-Forwarded-For {remote_host}`) and sets
//     `x-real-ip` to the same value.
//   - nginx-style proxies APPEND the real client IP as the LAST entry of
//     `x-forwarded-for` (`$proxy_add_x_forwarded_for`); an attacker can only
//     PREPEND forged entries.
//
// Therefore the RIGHT-MOST non-empty entry of `x-forwarded-for` is the real
// client IP, and `x-real-ip` is trustworthy when a proxy sets it (each hop
// overwrites it — it cannot be appended to). A spoofing client can never
// control the trailing entries added by the proxy chain.
//
// ─── Behavior matrix ─────────────────────────────────────────────────────────
//   - no proxy headers      → 'unknown' (direct connection; there is no
//                             trustworthy signal in this environment)
//   - single trusted proxy  → the single XFF entry (or x-real-ip)
//   - multiple proxy hops   → the RIGHT-MOST non-empty XFF entry
//   - spoofed XFF           → prepended entries are ignored
//   - malformed XFF         → empty/whitespace segments are skipped; falls
//                             through to the next source when nothing is left
//   - missing headers       → 'unknown'
//
// `x-forwarded-for` is NEVER trusted as a whole — only the proxy-appended
// tail. The header is also length-bounded to keep pathological inputs cheap.

export const UNKNOWN_CLIENT_IP = 'unknown';

/** Longest `x-forwarded-for` chain we are willing to inspect (attacker-prefixed
 *  entries beyond a sane proxy count are meaningless; they are only skipped). */
const MAX_XFF_SEGMENTS = 32;

export function getClientIpFromHeaders(headers: Headers): string {
  // x-real-ip is set (and overwritten) per hop by trusted proxies. Prefer it
  // when present: a single value, no chain to parse.
  const realIp = headers.get('x-real-ip');
  if (realIp) return realIp.trim() || UNKNOWN_CLIENT_IP;

  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    // Keep the LAST MAX_XFF_SEGMENTS entries: the proxy-appended tail holds
    // the real client IP; attacker-prepended entries live at the front.
    const segments = forwarded.split(',').slice(-MAX_XFF_SEGMENTS);
    // Right-most non-empty segment = the entry appended by the trusted proxy.
    for (let i = segments.length - 1; i >= 0; i--) {
      const segment = segments[i].trim();
      if (segment) return segment;
    }
  }

  const cf = headers.get('cf-connecting-ip');
  if (cf) return cf.trim() || UNKNOWN_CLIENT_IP;

  return UNKNOWN_CLIENT_IP;
}

/**
 * Domain-only website normalization (privacy-first).
 *
 * The extension NEVER sends a full URL anywhere. Every tab URL is reduced to
 * a bare lowercase domain (e.g. `github.com`, `mail.google.com`) BEFORE it
 * reaches the native messaging host, the desktop agent, or any log. Paths,
 * query strings, fragments, credentials, tokens and document IDs are
 * discarded here — the agent and server re-validate independently.
 *
 * Mirrors: src/lib/domain.ts (server) and omnisight-agent/src/lib/domain.ts
 * (agent). Keep in sync.
 */

const INTERNAL_SCHEME_RE =
  /^(chrome|chrome-extension|edge|edge-extension|about|moz-extension|file|javascript|data|blob|devtools|view-source|vivaldi|opera):/i;

const HOSTNAME_RE = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

/**
 * Normalize a full URL (or bare host) to a bare lowercase domain.
 * Returns null for non-collectable values (internal schemes, localhost, IP
 * literals, malformed hostnames).
 *
 *   https://www.github.com/a/b?token=abc  → github.com
 *   HTTP://WWW.YOUTUBE.COM/watch?v=1      → youtube.com
 *   https://user:pass@example.com/a       → example.com
 *   https://mail.google.com/mail/u/0/     → mail.google.com
 *   chrome://settings                     → null
 *   javascript:alert(1)                   → null
 *   localhost:3000                        → null
 */
export function normalizeWebsiteDomain(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  if (INTERNAL_SCHEME_RE.test(trimmed)) return null;

  let hostname;
  try {
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    hostname = new URL(candidate).hostname.toLowerCase();
  } catch {
    return null;
  }

  let domain = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  if (domain.startsWith('www.')) domain = domain.slice(4);

  if (!domain || domain === 'localhost' || domain.endsWith('.localhost')) return null;
  if (IPV4_RE.test(domain)) return null;
  if (domain === '::1' || domain.startsWith('[')) return null;

  if (!HOSTNAME_RE.test(domain)) return null;
  return domain;
}

/**
 * Strip URL-like tokens from a page title (mirror of the TS helpers). A page
 * can set its title to a full URL — removing any http(s) URL token keeps the
 * domain-only privacy contract literal at every layer that accepts a title.
 */
export function sanitizeWebsiteTitle(input) {
  if (typeof input !== 'string') return null;
  const stripped = input.replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim();
  if (!stripped) return null;
  return stripped.slice(0, 500);
}

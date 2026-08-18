/**
 * Domain-only website normalization (privacy-first).
 *
 * OmniSight website tracking stores ONLY the registrable-ish hostname
 * (e.g. `github.com`, `mail.google.com`). Full URLs — paths, query strings,
 * fragments, credentials, tokens, document IDs — must NEVER reach the
 * database, logs, reports, or AI providers.
 *
 * This module is the server-side enforcement point for the rule "the server
 * never trusts the agent blindly": every incoming `type='website'` activity
 * value is run through `normalizeWebsiteDomain` before persistence. Rows that
 * fail normalization are dropped (never stored).
 *
 * The SAME spec is mirrored in:
 *   - `omnisight-agent/src/lib/domain.ts` (agent-side validation)
 *   - `browser-extension/src/shared/domain.js` (extension-side, emitted first)
 * Keep the three implementations in sync.
 */

const INTERNAL_SCHEME_RE =
  /^(chrome|chrome-extension|edge|edge-extension|about|moz-extension|file|javascript|data|blob|devtools|view-source|vivaldi|opera):/i;

const HOSTNAME_RE = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

/**
 * Normalize an arbitrary website input to a bare lowercase domain.
 *
 * Accepts a full URL (`https://www.github.com/a/b?x=1`) or a bare host
 * (`github.com`). Returns the domain or `null` when the input is not a
 * collectable public website (internal schemes, localhost, IP literals,
 * malformed hostnames).
 *
 * Rules applied (in order):
 *   1. trim; empty → null
 *   2. reject internal/unsupported schemes outright (javascript:, chrome:, …)
 *   3. parse hostname via the URL parser (strips path, query, fragment and
 *      credentials automatically)
 *   4. lowercase, strip a single leading `www.`, strip trailing dot
 *   5. reject `localhost`/`.localhost` and IP literals
 *   6. validate label shape (letters, digits, hyphens — punycode `xn--` ok)
 *
 * Examples:
 *   https://www.github.com/company/project?token=abc  → github.com
 *   HTTP://WWW.YOUTUBE.COM/watch?v=1                 → youtube.com
 *   https://user:pass@example.com/a                  → example.com
 *   https://mail.google.com/mail/u/0/                → mail.google.com
 *   chrome://settings                                → null
 *   javascript:alert(1)                              → null
 *   localhost:3000                                   → null
 *   not a valid hostname                             → null
 */
export function normalizeWebsiteDomain(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 2048) return null;

  // 2. Internal / unsupported schemes are never websites.
  if (INTERNAL_SCHEME_RE.test(trimmed)) return null;

  let hostname: string;
  try {
    // Bare hosts get an https:// prefix so the WHATWG parser can resolve them.
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(candidate);
    hostname = url.hostname.toLowerCase();
  } catch {
    return null;
  }

  // 4. Normalize: strip a single leading `www.` and any trailing dot.
  let domain = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  if (domain.startsWith('www.')) domain = domain.slice(4);

  // 5. Localhost / loopback / internal names are not collectable websites.
  if (!domain || domain === 'localhost' || domain.endsWith('.localhost')) return null;
  if (IPV4_RE.test(domain)) return null; // IP literals are not domains
  if (domain === '::1' || domain.startsWith('[')) return null;

  // 6. Shape check (punycode `xn--` and normal labels pass; junk fails).
  if (!HOSTNAME_RE.test(domain)) return null;

  return domain;
}

/**
 * Strip URL-like tokens from a page title before persistence.
 *
 * Titles are optional display strings, but a page can set its title to a full
 * URL (`https://github.com/user/secret-repo?token=abc`). To keep the
 * "domain-only" privacy contract literal, any http(s) URL token embedded in a
 * title is removed. Applied at every layer that accepts a title (extension,
 * native host, server route).
 */
export function sanitizeWebsiteTitle(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const stripped = input.replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim();
  if (!stripped) return null;
  return stripped.slice(0, 500);
}

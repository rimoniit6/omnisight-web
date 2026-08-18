// OmniSight — Deterministic policy identity normalization.
//
// Windows matching is case-insensitive and path-separator-insensitive. All
// identities are normalized here so that resolver comparisons can never be
// bypassed by trivial case/whitespace/separator tricks. Normalization is pure
// and deterministic — the same input always yields the same output.

/**
 * Normalize an executable name (e.g. "chrome.exe", "CODE.EXE").
 * - trim surrounding whitespace and quotes
 * - lowercase (Windows is case-insensitive)
 * - strip a leading path if one was supplied (the agent may report a full
 *   path in the executable field — the basename is the stable identity)
 */
export function normalizeExecutableName(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = raw.trim().replace(/^["']|["']$/g, '');
  if (!s) return '';
  s = s.replace(/\\/g, '/');
  // Basename: after the last path separator.
  const slash = s.lastIndexOf('/');
  if (slash >= 0) s = s.slice(slash + 1);
  return s.toLowerCase();
}

/**
 * Normalize a process path (e.g. "C:\Program Files\App\app.exe").
 * - trim + strip surrounding quotes
 * - lowercase
 * - unify separators to forward slashes
 * - strip the Windows device prefix `\\?\` (extended-length path form)
 * - strip the `\\?\UNC\` prefix back to `//server/share` form so UNC and
 *   mapped paths compare consistently
 */
export function normalizeProcessPath(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = raw.trim().replace(/^["']|["']$/g, '');
  if (!s) return '';
  s = s.replace(/\\/g, '/');
  // Normalize extended-length prefixes.
  if (s.toLowerCase().startsWith('//?/unc/')) {
    s = s.slice(7); // "//?/unc/" -> "" (leaves "server/share/...")
    s = '//' + s;
  } else if (s.toLowerCase().startsWith('//?/')) {
    s = s.slice(4);
  }
  // Collapse duplicate separators (except the leading "//" UNC marker).
  s = s.replace(/\/{2,}/g, '/').replace(/^\/\//, '//');
  return s.toLowerCase();
}

/**
 * Normalize a publisher string (case-insensitive trim). Publishers are
 * matched exactly (case-insensitively) — no fuzzy matching.
 */
export function normalizePublisher(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.trim().toLowerCase();
}

/**
 * Normalize an executable hash (SHA-256 hex, lowercase). Used verbatim for
 * exact matching — hash identity is the strongest available signal and must
 * not be modified beyond case/whitespace.
 */
export function normalizeSha256(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.trim().toLowerCase();
}

/** True when the value is a well-formed 64-char hex SHA-256. */
export function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/**
 * Derive a deterministic matching key for an executable name. Two entries
 * that differ only by case/whitespace/separators collide — this is the key
 * the policy resolver compares.
 */
export function executableMatchKey(raw: string | null | undefined): string {
  return normalizeExecutableName(raw);
}

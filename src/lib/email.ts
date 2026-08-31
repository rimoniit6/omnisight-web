// OmniSight — Email normalization utility.
//
// Canonical rule: input email → trim → lowercase → use for storage/lookup.
// This prevents silent lookup failures caused by mixed-case emails (e.g.
// "John@Example.com" vs "john@example.com") in PostgreSQL's case-sensitive
// default collation.

/**
 * Normalize an email address for consistent storage and lookup.
 * Returns null if the input is not a non-empty string after trimming.
 */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const normalized = input.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Canonical Audit Action Normalizer
 *
 * Single source of truth for mapping raw AuditLog.action values to
 * human-readable categories used by the Action Distribution chart.
 *
 * Architecture:
 *   raw database action  →  normalizeAuditAction()  →  canonical category
 *                                                        →  display label
 *
 * The raw action is ALWAYS preserved in the AuditLog table. This module
 * only affects the Action Distribution aggregation and display.
 */

// ─── Canonical categories ──────────────────────────────────────────────────
// These are the ONLY categories that appear in the Action Distribution chart.
export type CanonicalAction =
  | 'Create'
  | 'Update'
  | 'Delete'
  | 'Login'
  | 'Logout'
  | 'Export'
  | 'Configure'
  | 'Detect'
  | 'AI Analysis'
  | 'Import'
  | 'Reset'
  | 'Revoke'
  | 'Other';

// ─── Display labels (identical to canonical for now — explicit mapping
//     ensures future label changes don't require renaming the category). ─────
export const ACTION_DISPLAY_LABELS: Record<CanonicalAction, string> = {
  Create: 'Create',
  Update: 'Update',
  Delete: 'Delete',
  Login: 'Login',
  Logout: 'Logout',
  Export: 'Export',
  Configure: 'Configure',
  Detect: 'Detect',
  'AI Analysis': 'AI Analysis',
  Import: 'Import',
  Reset: 'Reset',
  Revoke: 'Revoke',
  Other: 'Other',
};

// ─── Normalization map ─────────────────────────────────────────────────────
// Every known raw action value maps to exactly one canonical category.
// Keys are LOWERCASE for case-insensitive matching.
const NORMALIZATION_MAP: Record<string, CanonicalAction> = {
  // Standard CRUD
  create: 'Create',
  update: 'Update',
  delete: 'Delete',

  // Auth
  login: 'Login',
  logout: 'Logout',

  // Admin operations
  export: 'Export',
  configure: 'Configure',

  // Detection / anomaly
  detect: 'Detect',
  detect_anomaly: 'Detect',
  anomaly_detection: 'Detect',

  // AI Insights (both success and fallback — same canonical category)
  ai_analysis_generated: 'AI Analysis',
  data_summary_generated: 'AI Analysis',

  // Active project tracking
  active_tracking_project_set: 'Create',
  active_tracking_project_changed: 'Update',
  active_tracking_project_cleared: 'Delete',

  // Policy violations
  blocked: 'Other',

  // Data operations
  import: 'Import',

  // Account management
  reset: 'Reset',
  revoke: 'Revoke',
};

/**
 * Prefix-to-category mapping for composite action names.
 * Checked AFTER exact match — ensures 'create' matches exactly while
 * 'CREATE_USER' / 'CREATE_PROJECT' match via prefix.
 */
const PREFIX_MAP: Array<[string, CanonicalAction]> = [
  ['create_', 'Create'],
  ['update_', 'Update'],
  ['delete_', 'Delete'],
  ['login_', 'Login'],
  ['logout_', 'Logout'],
  ['export_', 'Export'],
  ['configure_', 'Configure'],
  ['detect_', 'Detect'],
  ['ai_analysis_', 'AI Analysis'],
  ['data_summary_', 'AI Analysis'],
  ['import_', 'Import'],
  ['reset_', 'Reset'],
  ['revoke_', 'Revoke'],
];

/**
 * Normalize a raw AuditLog.action string to a canonical category.
 *
 * The raw value is never mutated — this is a pure mapping function.
 * Case-insensitive matching prevents duplicates from casing variations.
 * Exact match takes priority; prefix match follows for composite names.
 *
 * Unknown/future action types map to 'Other' deterministically.
 */
export function normalizeAuditAction(rawAction: string): CanonicalAction {
  const key = rawAction.toLowerCase().trim();
  // Exact match first
  if (key in NORMALIZATION_MAP) return NORMALIZATION_MAP[key];
  // Prefix match for composite action names (e.g. CREATE_USER → Create)
  for (const [prefix, category] of PREFIX_MAP) {
    if (key.startsWith(prefix)) return category;
  }
  return 'Other';
}

/**
 * Aggregate a set of raw audit log actions into canonical category counts.
 *
 * Input:  { 'create': 10, 'CREATE_USER': 5, 'update': 3, 'DATA_SUMMARY_GENERATED': 2 }
 * Output: { 'Create': 15, 'Update': 3, 'AI Analysis': 2 }
 *
 * Preserves count integrity — no records are lost or double-counted.
 */
export function aggregateActionDistribution(
  rawDistribution: Record<string, number>,
): Record<string, number> {
  const canonical: Record<string, number> = {};

  for (const [rawAction, count] of Object.entries(rawDistribution)) {
    const category = normalizeAuditAction(rawAction);
    canonical[category] = (canonical[category] ?? 0) + count;
  }

  return canonical;
}

// OmniSight — Demo read-only enforcement rules (Phase 12).
//
// Consumed ONLY by src/proxy.ts. A session whose JWT activeOrganizationId
// resolves to the demo organization is restricted to READS on tenant data.
//
// Design constraints (validated against the repo):
//   • src/proxy.ts already performs DB lookups (isWebSessionActive), so a
//     cached demo-id resolution (getDemoOrgIdCached) fits its runtime.
//   • The demo id is resolved from the Organization.isDemo marker — NEVER
//     from a client flag. Fail-open on lookup errors is deliberate: tenant
//     isolation (per-route organizationId scoping) is unaffected, and a demo
//     mutation that slips through during a DB blip touches only the
//     disposable demo org. The read-only rule is defense-in-depth for UX.
//   • Blocks only MUTATIONS (non-GET/HEAD/OPTIONS); reads must keep working
//     so the demo can showcase every feature, including exports (GET).
//
// ─── Rule shape ─────────────────────────────────────────────────────────────
//
// The demo membership is org_admin (Organization Admin view — the fullest
// showcase surface). org_admin RBAC unlocks every organization mutation
// endpoint; without a guard, a demo visitor could rewrite the SHARED demo
// dataset that every visitor sees (employees, departments, projects, alerts,
// screenshots, consent policies, settings, …). To keep the dataset intact
// ("all demo data must remain") the demo rule is DENY-BY-DEFAULT: every
// non-GET/HEAD/OPTIONS request from a demo session is rejected UNLESS the
// path is explicitly allowlisted below (auth/session lifecycle that never
// mutates tenant data).
//
// Reads (GET/HEAD/OPTIONS) are never consulted by the proxy — they always
// pass through and showcase the full org_admin surface.

// ─── Allowlist ──────────────────────────────────────────────────────────────

/**
 * The ONLY non-GET/HEAD/OPTIONS paths a demo session may use. Everything else
 * is a tenant-data mutation and is blocked (see DEMO_BLOCKED_NOTES below for
 * the categories this covers).
 *
 *   • Auth/session lifecycle: change the demo user's own session/credentials,
 *     never the org's shared data.
 *   • Report PDF exports (/api/reports/pdf/*): pure READ → file generation —
 *     verified to write NOTHING to the database (no create/update/delete;
 *     the saved-report + auditLog writer lives at /api/reports and
 *     /api/reports/daily, which stay blocked). Visitors download a PDF of the
 *     demo data without mutating the shared dataset.
 */
const DEMO_ALLOWED_MUTATION_PREFIXES = [
  '/api/auth/refresh-token', // SPA token refresh (use-auth-fetch)
  '/api/auth/logout',        // SPA logout (banner + header)
  '/api/auth/change-password', // own credentials (never tenant data)
  '/api/reports/pdf',        // PDF exports — read-only generation, no DB writes
];

/**
 * Classification notes for the paths that are now blocked by the deny-by-
 * default rule. Kept as documentation of INTENT, so future maintainers
 * understand why these are covered without an explicit entry.
 * (Note: path examples below avoid the `*` char entirely so this comment
 * never accidentally closes.)
 *
 *   • Agent enrollment / device claiming (device-claims, agent endpoints)
 *   • Customer-database / infrastructure workflows (/api/infrastructure,
 *     the org-scoped settings/database, settings/storage, settings/ai routes)
 *   • AI provider credentials (/api/ai-provider)
 *   • Super Admin control-plane (/api/super-admin, /api/admin)
 *   • Organization switching / membership self-service (/api/me/organization)
 *   • Org config (/api/organization, /api/settings, /api/branding,
 *     /api/import, /api/upload)
 *   • Team and access (/api/auth/users, org-scoped members routes)
 *   • Tenant data CRUD (/api/employees, /api/devices, /api/departments,
 *     /api/projects, /api/alerts, /api/notifications, /api/consent,
 *     /api/policies, /api/screenshots, /api/anomalies, /api/insights,
 *     /api/sentiment, /api/audio, /api/category-rules, /api/app-list,
 *     /api/alert-rules, /api/break-status, /api/self, /api/device-commands,
 *     /api/workday-summaries/rebuild, /api/leads, /api/purchase-requests,
 *     and the saved-report generators /api/reports and /api/reports/daily)
 */

/**
 * Decide whether a demo-session MUTATION to `pathname` is allowed.
 * Pure function over static rules — no DB, no session. Exported for tests.
 * The proxy only consults this for non-GET/HEAD/OPTIONS methods: reads always
 * pass.
 */
export function isDemoMutationAllowed(pathname: string): boolean {
  for (const p of DEMO_ALLOWED_MUTATION_PREFIXES) {
    if (pathname === p || pathname.startsWith(p + '/')) return true;
  }
  return false;
}

/**
 * Backward-compatible predicate: true when a demo-session MUTATION to
 * `pathname` must be rejected. Kept so existing call sites/tests that read
 * "blocked" semantics stay meaningful.
 */
export function isDemoBlockedPath(pathname: string): boolean {
  return !isDemoMutationAllowed(pathname);
}

// ─── Proxy import surface ───────────────────────────────────────────────────

export { isDemoOrgId, getDemoOrgIdCached } from './guards';
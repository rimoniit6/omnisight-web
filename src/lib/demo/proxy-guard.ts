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
// ─── Blocked-path rules ─────────────────────────────────────────────────────

/**
 * Static prefixes blocked for demo sessions regardless of method context.
 * Boundary check: exact match or `prefix/` (never `/api/settingsX`).
 */
const DEMO_STATIC_BLOCKED_PREFIXES = [
  // Agent enrollment / device claiming — must never produce a claimable
  // device or enrollment secret from a public demo session.
  '/api/device-claims',
  // Customer-database / infrastructure workflows.
  '/api/infrastructure',
  // AI provider credentials (org_admin RBAC already blocks manager; the
  // static block keeps the demo guarantee independent of RBAC edits).
  '/api/ai-provider',
  // Super Admin control-plane. A demo user is never super_admin and the
  // proxy RBAC already denies these; the explicit entry documents intent
  // and keeps the demo guarantee independent of role-rule changes.
  '/api/super-admin',
  // Organization switching / membership self-service: a demo session is
  // permanently bound to the demo org (Phase 2).
  '/api/me/organization',
];

/**
 * Org RBAC-gated sections where a demo (manager) session must not write.
 * Reads stay allowed so demo users can view those pages' data.
 */
const DEMO_ORG_ADMIN_WRITE_PREFIXES = [
  '/api/organization',
  '/api/auth/users',
  '/api/settings',
  '/api/branding/organization',
  '/api/import',
];

/**
 * Employee/device rows drive the whole showcase; deleting or rewriting them
 * from a demo session would corrupt the shared dataset for every visitor.
 */
const DEMO_DATA_WRITE_PREFIXES = ['/api/employees', '/api/devices'];

/**
 * Decide whether a demo-session MUTATION to `pathname` must be rejected.
 * Pure function over static rules — no DB, no session. Exported for tests.
 * The proxy only consults this for non-GET/HEAD/OPTIONS methods.
 */
export function isDemoBlockedPath(pathname: string): boolean {
  for (const p of DEMO_STATIC_BLOCKED_PREFIXES) {
    if (pathname === p || pathname.startsWith(p + '/')) return true;
  }
  for (const p of DEMO_ORG_ADMIN_WRITE_PREFIXES) {
    if (pathname === p || pathname.startsWith(p + '/')) return true;
  }
  for (const p of DEMO_DATA_WRITE_PREFIXES) {
    if (pathname === p || pathname.startsWith(p + '/')) return true;
  }
  return false;
}

// ─── Proxy import surface ───────────────────────────────────────────────────

export { isDemoOrgId, getDemoOrgIdCached } from './guards';

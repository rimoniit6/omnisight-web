// OmniSight — Tenant query safety (Phase 1, Step 11).
//
// Reusable server-side organization scope. Tenant-owned resources must NEVER
// be queried by bare id:
//
//   BAD:  db.screenshot.findUnique({ where: { id } })
//   GOOD: db.screenshot.findFirst({ where: withTenantScope({ id }, orgId) })
//
// withTenantScope injects the organization predicate; assertTenantScope lets
// routes that build complex `where` clauses verify the predicate is present
// before executing. A custom ESLint rule for high-risk tenant models is
// tracked as follow-up (see Phase 1 report) — until then, code review +
// these helpers + the cross-org tests are the enforcement layers.

export type TenantScopedWhere = Record<string, unknown> & {
  organizationId: string;
};

/**
 * Inject the organization predicate into a Prisma `where` clause.
 * The organizationId ALWAYS wins over anything already present — a
 * client-influenced value can never widen the scope.
 */
export function withTenantScope<T extends Record<string, unknown>>(
  where: T,
  organizationId: string,
): T & TenantScopedWhere {
  return { ...where, organizationId };
}

/**
 * Verify a `where` clause already carries the expected organizationId.
 * Throws (fail-closed) instead of executing a potentially cross-tenant query.
 */
export function assertTenantScope(
  where: Record<string, unknown>,
  organizationId: string,
): asserts where is TenantScopedWhere {
  if (!organizationId || typeof organizationId !== 'string') {
    throw new Error('assertTenantScope: missing organizationId (fail-closed)');
  }
  if ((where as { organizationId?: unknown }).organizationId !== organizationId) {
    throw new Error('assertTenantScope: where clause lacks the required organizationId (fail-closed)');
  }
}

/**
 * Tenant-owned models that must always be queried with an organization
 * predicate. Used by tests/review checklists and the future lint rule.
 */
export const TENANT_SCOPED_MODELS = [
  'activity',
  'screenshot',
  'employee',
  'device',
  'locationEvent',
  'keyboardActivity',
  'webcamSession',
  'audioRecording',
  'consent',
  'consentLog',
  'usbEvent',
  'policyViolation',
  'appListEntry',
  'project',
  'timeEntry',
  'alert',
  'anomaly',
  'report',
  'aiInsight',
] as const;

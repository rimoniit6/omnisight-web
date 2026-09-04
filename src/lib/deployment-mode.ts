// OmniSight — Authoritative deployment-mode resolver (Phase 1, Step 2).
//
// `Organization.deploymentMode` (MANAGED | CUSTOMER_DB | PRIVATE) is the ONLY
// authority for mode-aware behavior. Legacy indicators below remain for
// backward compatibility and backfill diagnostics ONLY and MUST NOT be used
// for request-time routing decisions:
//
//   - Plan.isSelfHosted        (plan catalog flag, not per-org topology)
//   - SELF_HOSTED env          (instance-level flag, not per-org topology)
//   - OrganizationSettings.useOwnDb (analytics-only credential store)
//
// All future mode-aware behavior (switcher gating, super-admin scoping,
// tenant database resolution) MUST go through getOrganizationDeploymentMode().

import { db } from '@/lib/db';

export type DeploymentMode = 'MANAGED' | 'CUSTOMER_DB' | 'PRIVATE';

export const DEPLOYMENT_MODES: readonly DeploymentMode[] = [
  'MANAGED',
  'CUSTOMER_DB',
  'PRIVATE',
] as const;

export function isDeploymentMode(value: unknown): value is DeploymentMode {
  return (
    typeof value === 'string' &&
    (DEPLOYMENT_MODES as readonly string[]).includes(value)
  );
}

/**
 * Authoritative per-organization deployment mode.
 *
 * Reads ONLY the `Organization.deploymentMode` column. FAILS CLOSED: unknown
 * organization or unreadable row throws instead of guessing a mode, so callers
 * can never silently fall back to a default/shared database (Phase 1 Step 6).
 */
export async function getOrganizationDeploymentMode(
  organizationId: string,
): Promise<DeploymentMode> {
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { deploymentMode: true },
  });
  if (!org) {
    throw new Error(
      `Deployment mode resolution failed: organization ${organizationId} not found (fail-closed, no fallback)`,
    );
  }
  if (!isDeploymentMode(org.deploymentMode)) {
    throw new Error(
      `Deployment mode resolution failed: organization ${organizationId} has unexpected mode value (fail-closed, no fallback)`,
    );
  }
  return org.deploymentMode;
}

/**
 * Batch variant for list endpoints (e.g. super-admin organization lists).
 * Returns a Map of organizationId -> mode; throws fail-closed on DB errors.
 */
export async function getDeploymentModes(
  organizationIds: string[],
): Promise<Map<string, DeploymentMode>> {
  if (organizationIds.length === 0) return new Map();
  const rows = await db.organization.findMany({
    where: { id: { in: organizationIds } },
    select: { id: true, deploymentMode: true },
  });
  const found = new Set(rows.map((r) => r.id));
  const missing = organizationIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error(
      `Deployment mode resolution failed for ${missing.length} organization(s) (fail-closed, no fallback)`,
    );
  }
  const map = new Map<string, DeploymentMode>();
  for (const row of rows) {
    if (!isDeploymentMode(row.deploymentMode)) {
      throw new Error(
        `Deployment mode resolution failed: organization ${row.id} has unexpected mode value (fail-closed)`,
      );
    }
    map.set(row.id, row.deploymentMode);
  }
  return map;
}

// --- Control-plane / data-plane classification (Phase 1, Step 4) ---

/** Super Admin may access ONLY these fields for CUSTOMER_DB / PRIVATE orgs. */
export const CONTROL_PLANE_ORG_FIELDS = [
  'id',
  'name',
  'slug',
  'status',
  'deploymentMode',
  'deploymentModeUnresolved',
  'subscriptionId',
  'licenseKeyId',
  'trialEndsAt',
  'createdAt',
  'updatedAt',
] as const;

/** Super Admin may NEVER access these via platform routes for CUSTOMER_DB / PRIVATE orgs. */
export const DATA_PLANE_MODELS = [
  'employee',
  'device',
  'activity',
  'screenshot',
  'locationEvent',
  'keyboardActivity',
  'webcamSession',
  'audioRecording',
  'project',
  'alert',
  'report',
  'aiInsight',
] as const;

/** True when the mode permits Super Admin operational-dashboard access. */
export function allowsSuperAdminTenantAccess(mode: DeploymentMode): boolean {
  return mode === 'MANAGED';
}

// --- Deployment-mode change safety (Phase 2, §22-23) ---
//
// Changing modes is high-risk: it alters data-routing and privacy boundaries.
// Rules (server-side, no silent fallback):
//   - same mode            -> ok (no-op, handled by caller)
//   - * -> CUSTOMER_DB     -> REJECTED: no primary-database datasource
//     mechanism exists in Phase 2 (control-plane shows "Configuration:
//     Pending"). Never change first and hope the system recovers later.
//   - MANAGED -> PRIVATE   -> ok (metadata only, no data movement)
//   - CUSTOMER_DB -> PRIVATE -> ok (metadata only, audited)
//   - CUSTOMER_DB/PRIVATE -> MANAGED -> ok ONLY with explicit
//     confirmDataResidency (human acknowledges existing customer data stays
//     where it is — Phase 2 performs NO automatic DB-to-DB migration).
// A successful change clears deploymentModeUnresolved (a human resolved it).

export type ModeChangeValidation =
  | { ok: true }
  | { ok: false; code: 'CUSTOMER_DB_NOT_CONFIGURED' | 'CONFIRMATION_REQUIRED'; message: string };

export function validateDeploymentModeChange(
  from: DeploymentMode,
  to: DeploymentMode,
  opts: { confirmDataResidency?: boolean } = {},
): ModeChangeValidation {
  if (from === to) return { ok: true };
  if (to === 'CUSTOMER_DB') {
    return {
      ok: false,
      code: 'CUSTOMER_DB_NOT_CONFIGURED',
      message:
        'CUSTOMER_DB requires a configured customer primary database (Configuration: Pending). Mode not changed.',
    };
  }
  if ((from === 'CUSTOMER_DB' || from === 'PRIVATE') && to === 'MANAGED') {
    if (!opts.confirmDataResidency) {
      return {
        ok: false,
        code: 'CONFIRMATION_REQUIRED',
        message:
          'Moving to MANAGED requires explicit data-residency confirmation (no automatic data migration is performed). Mode not changed.',
      };
    }
    return { ok: true };
  }
  // MANAGED -> PRIVATE and CUSTOMER_DB -> PRIVATE are metadata-only.
  return { ok: true };
}

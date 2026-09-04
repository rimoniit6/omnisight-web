// OmniSight — Control-plane / data-plane authorization (Phase 1, Steps 4+9).
//
// Concepts:
//   CONTROL PLANE — organization identity, package/plan, subscription, invoice,
//     payment metadata, license, deployment mode/status, domain, version,
//     connection status, platform configuration. Super Admin may access this
//     for EVERY organization regardless of deployment mode.
//   DATA PLANE — employees, devices, activities, screenshots, locations,
//     webcam, audio, projects, alerts, reports, AI operational data and all
//     other employee monitoring data. Super Admin may access this ONLY for
//     MANAGED organizations.
//
// Super Admin NEVER receives tenant data access merely because
// role === 'super_admin'. Every data-plane entry point must resolve the
// target org's deployment mode and use one of the guards below. This module
// establishes the shared infrastructure; Phase 2 applies the final
// per-route privacy policy on top of it.

import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import {
  authenticateRequest,
  requireActiveSessionOrg,
  type ActiveSessionOrgResult,
} from '@/lib/api';
import {
  getOrganizationDeploymentMode,
  allowsSuperAdminTenantAccess,
  type DeploymentMode,
} from '@/lib/deployment-mode';

export type ControlPlaneResult =
  | { ok: true; userId: string; email: string; role: string }
  | { ok: false; status: 401 | 403; code: string };

export type ManagedTenantResult =
  | { ok: true; userId: string; email: string; organizationId: string; mode: DeploymentMode }
  | { ok: false; status: 401 | 403 | 503; code: string };

export type TenantDataResult =
  | { ok: true; userId: string; email: string; organizationId: string; mode: DeploymentMode; via: 'membership' | 'managed_super_admin' }
  | { ok: false; status: 401 | 403 | 503; code: string };

/**
 * requireControlPlaneAccess — metadata operations (org identity, plan,
 * subscription, invoice, license, deployment mode/status). DB-verified
 * super_admin only. Valid for ALL deployment modes.
 */
export async function requireControlPlaneAccess(
  req: NextRequest,
): Promise<ControlPlaneResult> {
  const auth = await authenticateRequest(req);
  if (!auth) return { ok: false, status: 401, code: 'UNAUTHENTICATED' };
  const dbUser = await db.appUser.findUnique({
    where: { id: auth.userId },
    select: { id: true, email: true, role: true, isActive: true },
  });
  if (!dbUser || !dbUser.isActive)
    return { ok: false, status: 401, code: 'UNAUTHENTICATED' };
  if (dbUser.role !== 'super_admin')
    return { ok: false, status: 403, code: 'CONTROL_PLANE_DENIED' };
  return { ok: true, userId: dbUser.id, email: dbUser.email, role: dbUser.role };
}

/**
 * requireManagedTenantAccess — Super Admin operational-dashboard access to ONE
 * organization. Allowed ONLY when that org's authoritative deployment mode is
 * MANAGED. CUSTOMER_DB / PRIVATE orgs are rejected with 403 even for a valid
 * super_admin (control-plane metadata remains available via
 * requireControlPlaneAccess).
 */
export async function requireManagedTenantAccess(
  req: NextRequest,
  organizationId: string,
): Promise<ManagedTenantResult> {
  const control = await requireControlPlaneAccess(req);
  if (!control.ok) return control;
  let mode: DeploymentMode;
  try {
    mode = await getOrganizationDeploymentMode(organizationId);
  } catch {
    // Fail-closed: unresolvable mode (incl. DB outage) never grants access.
    return { ok: false, status: 503, code: 'MODE_UNRESOLVABLE' };
  }
  if (!allowsSuperAdminTenantAccess(mode)) {
    return { ok: false, status: 403, code: 'TENANT_ACCESS_DENIED_FOR_MODE' };
  }
  return { ok: true, userId: control.userId, email: control.email, organizationId, mode };
}

/**
 * requireTenantDataAccess — the single choke point for data-plane reads/
 * writes on behalf of web sessions. Grants access when EITHER:
 *   (a) the caller has an active session scoped to the target org
 *       (membership path — any deployment mode), OR
 *   (b) the caller is a DB-verified super_admin AND the target org is MANAGED
 *       (managed_super_admin path).
 * Everything else is denied. Organization identity comes from the verified
 * session or the explicit target id — never from client-supplied org claims.
 */
export async function requireTenantDataAccess(
  req: NextRequest,
  organizationId: string,
): Promise<TenantDataResult> {
  const scope: ActiveSessionOrgResult = await requireActiveSessionOrg(req, {
    allowGlobal: true,
  }).catch(() => ({ ok: false, status: 401 }) as const);
  if (!scope.ok) return { ok: false, status: scope.status, code: 'UNAUTHENTICATED' };

  // Path (a): session already scoped to the target org.
  if (scope.organizationId !== null && scope.organizationId === organizationId) {
    let mode: DeploymentMode;
    try {
      mode = await getOrganizationDeploymentMode(organizationId);
    } catch {
      return { ok: false, status: 503, code: 'MODE_UNRESOLVABLE' };
    }
    return {
      ok: true,
      userId: scope.userId,
      email: scope.email,
      organizationId,
      mode,
      via: 'membership',
    };
  }

  // Path (b): org-less super_admin global scope — MANAGED tenants only.
  if (scope.organizationId === null && scope.role === 'super_admin') {
    const managed = await requireManagedTenantAccess(req, organizationId);
    if (!managed.ok) return managed;
    return {
      ok: true,
      userId: managed.userId,
      email: managed.email,
      organizationId,
      mode: managed.mode,
      via: 'managed_super_admin',
    };
  }

  return { ok: false, status: 403, code: 'TENANT_ACCESS_DENIED' };
}

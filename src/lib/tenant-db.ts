// OmniSight — Tenant database resolution (Phase 1, Steps 5-7).
//
// Architecture (Agent NEVER touches PostgreSQL directly):
//   CUSTOMER_DB: Agent -> OmniSight API -> customer database
//   MANAGED:     Agent -> OmniSight API -> OmniSight managed database
//
// Database credentials are NEVER placed in the Agent, NEVER sent to the
// browser, and NEVER logged. Resolution failures FAIL CLOSED: no silent
// fallback to the default/shared database is permitted anywhere.
//
// Phase 1 scope: the abstraction, the choke points (resolveTenantDatabase,
// getTenantDb, resolveRequestTenant) and fail-closed behavior exist and are
// used by all NEW mode-aware code. MANAGED resolves to the shared pooled
// Prisma client. CUSTOMER_DB has no primary-database connection infrastructure
// yet, so data-plane resolution throws TenantDatabaseError instead of guessing.
// Migrating the 213 existing routes onto getTenantDb is explicitly out of
// scope for Phase 1 (tracked as follow-up); the guards in control-plane.ts
// already enforce mode-correct ACCESS on new paths.
//
// NOTE: the legacy PRIVATE mode was removed (migration
// 20260916000000_remove_private_deployment_mode); MANAGED | CUSTOMER_DB are
// the only deployment modes.
//
// Connection strategy (documented, Phase 1 Step 6):
//   - MANAGED: single shared PrismaClient (src/lib/db.ts, global singleton,
//     transaction pooler with connection_limit=1 on Supabase). Reused for all
//     requests — never one client per request.
//   - Future customer pools: one cached PrismaClient per organizationId+
//     database-fingerprint, bounded by MAX_TENANT_POOLS (evict least-recently
//     used). Pool parameters come from server-side configuration only.
//     NOT YET IMPLEMENTED — getTenantDb throws until it is.

import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { authenticateRequest } from '@/lib/api';
import {
  getOrganizationDeploymentMode,
  type DeploymentMode,
} from '@/lib/deployment-mode';

export type TenantDatabaseDescriptor =
  | { kind: 'managed'; organizationId: string; mode: DeploymentMode }
  | { kind: 'customer'; organizationId: string; mode: 'CUSTOMER_DB' };

export class TenantDatabaseError extends Error {
  readonly code: 'MODE_UNRESOLVABLE' | 'CUSTOMER_DB_NOT_CONFIGURED';
  constructor(
    code: TenantDatabaseError['code'],
    organizationId: string,
    detail?: string,
  ) {
    super(
      `Tenant database resolution failed for organization ${organizationId} [${code}]${detail ? `: ${detail}` : ''} (fail-closed, no fallback)`,
    );
    this.name = 'TenantDatabaseError';
    this.code = code;
  }
}

/**
 * resolveTenantDatabase — conceptual API required by Phase 1 Step 5.
 * Distinguishes MANAGED -> managed DB, CUSTOMER_DB -> customer DB. Pure
 * resolution (no connections): throws fail-closed when the mode cannot be
 * resolved. The switch is exhaustive over DeploymentMode; TypeScript rejects
 * a new enum member without a case here.
 */
export async function resolveTenantDatabase(
  organizationId: string,
): Promise<TenantDatabaseDescriptor> {
  let mode: DeploymentMode;
  try {
    mode = await getOrganizationDeploymentMode(organizationId);
  } catch {
    throw new TenantDatabaseError('MODE_UNRESOLVABLE', organizationId);
  }
  switch (mode) {
    case 'MANAGED':
      return { kind: 'managed', organizationId, mode };
    case 'CUSTOMER_DB':
      return { kind: 'customer', organizationId, mode };
    default: {
      // Exhaustive guard: unreachable while the switch covers every
      // DeploymentMode member; any future mode must be handled explicitly
      // above (fail-closed, never routed to the shared database).
      const exhaustive: never = mode;
      throw new TenantDatabaseError(
        'MODE_UNRESOLVABLE',
        organizationId,
        `unhandled deployment mode: ${String(exhaustive)}`,
      );
    }
  }
}

export type TenantDbHandle =
  | { kind: 'managed'; prisma: typeof db }
  | { kind: 'customer'; prisma: typeof db };

/**
 * getTenantDb — the single choke point for data-plane Prisma access in new
 * mode-aware code. MANAGED returns the shared pooled client. CUSTOMER_DB
 * throws TenantDatabaseError (fail-closed) until per-tenant pool
 * infrastructure lands. Callers MUST surface this as an explicit operational
 * error (503), never retry against the managed database.
 */
export async function getTenantDb(
  organizationId: string,
): Promise<TenantDbHandle> {
  const target = await resolveTenantDatabase(organizationId);
  if (target.kind === 'managed') {
    return { kind: 'managed', prisma: db };
  }
  // No primary-database connection infrastructure in Phase 1. The
  // analytics-only OrganizationSettings.useOwnDb credentials MUST NOT be
  // treated as a primary database (different schema/purpose).
  throw new TenantDatabaseError(
    'CUSTOMER_DB_NOT_CONFIGURED',
    organizationId,
    'customer primary-database pools are not implemented in Phase 1',
  );
}

// --- Step 7: authoritative organization/deployment context resolver ---
//
//   request -> authenticated user/agent -> organization -> deployment mode
//             -> data source -> authorized query
//
// No API route should invent its own tenant routing logic — resolve the full
// context here and branch on `descriptor` + `mode`.

export type RequestTenantContext = {
  userId: string;
  email: string;
  organizationId: string;
  mode: DeploymentMode;
  descriptor: TenantDatabaseDescriptor;
};

export async function resolveRequestTenant(
  req: NextRequest,
  organizationId: string,
): Promise<RequestTenantContext> {
  const auth = await authenticateRequest(req);
  if (!auth) {
    throw new TenantDatabaseError('MODE_UNRESOLVABLE', organizationId, 'unauthenticated request');
  }
  const sessionOrg = auth.activeOrganizationId || auth.organizationId;
  const isSuperAdmin = auth.role === 'super_admin';
  // Organization users: only their own active session org. Super Admin: any
  // org (access policy itself is enforced downstream by control-plane.ts —
  // this resolver establishes identity + routing, not data permission).
  if (!isSuperAdmin && sessionOrg !== organizationId) {
    throw new TenantDatabaseError('MODE_UNRESOLVABLE', organizationId, 'session org mismatch');
  }
  const descriptor = await resolveTenantDatabase(organizationId);
  return {
    userId: auth.userId,
    email: auth.email,
    organizationId,
    mode: descriptor.mode,
    descriptor,
  };
}

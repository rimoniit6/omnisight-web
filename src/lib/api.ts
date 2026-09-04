// OmniSight API Middleware Helper
// Provides authentication & authorization helpers for API routes

import { NextRequest, NextResponse } from 'next/server';
import { extractToken, hasRolePermission, SESSION_COOKIE_NAME } from '@/lib/auth';
import { verifySessionToken } from '@/lib/session';
import { db } from '@/lib/db';
import { getRolesWithPermission, getRoleLabelFromPermissions } from '@/lib/permissions';
import { getActiveSubscription, hasValidTrial } from '@/lib/subscription';
import { isSelfHosted } from '@/lib/config';

// ─── Safe employee projection (approval lists / responses) ─────────────────
// Employee rows carry credential material (`agentPassword`) that must never be
// serialized. The approval list/response paths (device-claims) whitelist
// exactly the display fields the UI needs instead of
// including the full row — mirroring the `agentPassword` strip already done in
// the employees API. Any future employee serialization must use a select/
// destructure that excludes credential fields.
export const SAFE_EMPLOYEE_SELECT = {
  id: true,
  employeeId: true,
  firstName: true,
  lastName: true,
  email: true,
  designation: true,
  avatar: true,
  status: true,
  type: true,
  departmentId: true,
  department: { select: { id: true, name: true } },
} as const;

// ─── Authenticated Request Context ─────────────────────────────────────────

export interface AuthContext {
  userId: string;
  email: string;
  role: string;
  organizationId?: string;
  activeOrganizationId?: string;
}

// ─── Response Helpers ──────────────────────────────────────────────────────

export function apiError(message: string, status: number = 400) {
  return NextResponse.json({ error: message }, { status });
}

export function apiSuccess<T>(data: T, status: number = 200) {
  return NextResponse.json(data, { status });
}

// ─── Auth Middleware ───────────────────────────────────────────────────────

/**
 * Authenticate a request and return the auth context.
 * Accepts a Bearer token or the httpOnly session cookie (matching the
 * middleware's getToken fallback). Returns null if authentication fails
 * (caller should send 401).
 */
// Phase 2 §19: first-login password enforcement is API-complete, not just
// UI-complete. Sessions flagged mustChangePassword may ONLY reach the
// allowlisted self-service auth endpoints below; every other authenticated
// API returns 401 until the password is changed. The flag is read from the
// database (PK lookup) so a password change takes effect immediately without
// waiting for token expiry.
const PASSWORD_CHANGE_ALLOWED_PATHS = [
  '/api/auth/change-password',
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/refresh-token',
];

export async function authenticateRequest(req: NextRequest): Promise<AuthContext | null> {
  try {
    const token = extractToken(req) || req.cookies.get(SESSION_COOKIE_NAME)?.value;
    if (!token) return null;

    // verifySessionToken = JWT verification + server-side session re-check
    // (S-04): a revoked/expired session row rejects the token even though its
    // signature is still valid. Handler-level enforcement — never proxy-only.
    const payload = await verifySessionToken(token);
    if (!payload) return null;

    // Phase 2 §19: enforce mustChangePassword server-side.
    const pathname = req.nextUrl?.pathname ?? '';
    if (!PASSWORD_CHANGE_ALLOWED_PATHS.includes(pathname)) {
      const flagged = await db.appUser.findUnique({
        where: { id: payload.userId },
        select: { mustChangePassword: true },
      });
      if (flagged?.mustChangePassword) return null;
    }

    return {
      userId: payload.userId,
      email: payload.email,
      role: payload.role,
      organizationId: payload.organizationId,
      activeOrganizationId: payload.activeOrganizationId,
    };
  } catch {
    return null;
  }
}

// ─── Query Helpers ─────────────────────────────────────────────────────────

/**
 * STRICT pagination validation for list endpoints.
 *
 * Malformed, negative, zero or non-integer page/pageSize values are rejected
 * (4xx) instead of silently producing NaN/Infinity that crashes Prisma with a
 * 500. Absent params fall back to safe defaults (page=1, pageSize=default).
 * Only whole numbers >= 1 are accepted; pageSize above `maxPageSize` is
 * rejected rather than clamped so the contract stays explicit.
 */
export function validatePagination(
  searchParams: URLSearchParams,
  opts: { defaultPageSize?: number; maxPageSize?: number } = {}
): { ok: true; page: number; pageSize: number; skip: number } | { ok: false; status: 400 | 422; error: string } {
  const defaultPageSize = opts.defaultPageSize ?? 20;
  const maxPageSize = opts.maxPageSize ?? 200;

  const rawPage = searchParams.get('page');
  const rawPageSize = searchParams.get('pageSize');

  const page = rawPage === null ? 1 : Number(rawPage);
  if (rawPage !== null && (!Number.isInteger(page) || page < 1)) {
    return { ok: false, status: 422, error: 'page must be a positive integer' };
  }

  const pageSize = rawPageSize === null ? defaultPageSize : Number(rawPageSize);
  if (rawPageSize !== null && (!Number.isInteger(pageSize) || pageSize < 1)) {
    return { ok: false, status: 422, error: 'pageSize must be a positive integer' };
  }
  if (pageSize > maxPageSize) {
    return { ok: false, status: 422, error: `pageSize must be at most ${maxPageSize}` };
  }

  return { ok: true, page, pageSize, skip: (page - 1) * pageSize };
}

/**
 * Resolve the caller's organization from the authenticated session only.
 *
 * SECURITY (tenant isolation): organization identity must come from the
 * verified JWT (cookie or bearer), never from a findFirst() over all
 * organizations and never from client-supplied input.
 *
 * Multi-org: prefers activeOrganizationId (set via /api/me/organization/switch),
 * falls back to organizationId for single-org or legacy tokens.
 */
export async function getSessionOrg(
  req: NextRequest
): Promise<{ id: string } | null> {
  // Route through authenticateRequest so the server-side session re-check
  // (S-04) applies here too — a revoked session no longer resolves an org.
  const auth = await authenticateRequest(req);
  // Prefer active org (multi-org), fall back to legacy organizationId
  const orgId = auth?.activeOrganizationId || auth?.organizationId;
  if (!orgId) return null;
  return { id: orgId };
}

// ─── Organization Scope Helpers ─────────────────────────────────────────────

export type OrgScopeResult =
  | { ok: true; organizationId: string | null } // null => global (org-less super_admin)
  | { ok: false; status: 401 | 403; requiredPermission?: string; userRole?: string };

/**
 * Canonical authorization helper (P0). Authenticate, derive the organization
 * STRICTLY from the verified session/JWT (never client input), load the
 * Organization row, and enforce `status === 'active'`. Rejects
 * suspended/archived orgs with 403 even for an already-authenticated session —
 * this is what stops a retained web-admin session from keeping access after the
 * organization is suspended or archived.
 *
 * SECURITY: organization identity is taken only from `auth.activeOrganizationId`
 * or `auth.organizationId` (both HMAC-signed claims). Query params, request
 * bodies, Zustand state, localStorage and URL values are NEVER consulted.
 *
 * The only exception is the org-less super_admin global scope (`allowGlobal`),
 * which must stay usable so Super Admin can still manage suspended/archived
 * orgs via the super-admin API.
 */
export type ActiveSessionOrgResult =
  | { ok: true; organizationId: string; userId: string; email: string; role: string }
  | { ok: true; organizationId: null; userId: string; email: string; role: string } // global super_admin
  | { ok: false; status: 401 | 403; requiredPermission?: string; userRole?: string };

export async function requireActiveSessionOrg(
  req: NextRequest,
  opts: { allowGlobal?: boolean; minRole?: string } = {}
): Promise<ActiveSessionOrgResult> {
  const auth = await authenticateRequest(req);
  if (!auth) return { ok: false, status: 401 };

  const orgId = auth.activeOrganizationId || auth.organizationId;

  // Org-less super_admin in a global context (listing all orgs, the employees
  // global branch) — no single org to validate, allowed through.
  if (!orgId) {
    if (opts.allowGlobal && auth.role === 'super_admin') {
      return { ok: true, organizationId: null, userId: auth.userId, email: auth.email, role: auth.role };
    }
    return { ok: false, status: 403, userRole: auth.role };
  }

  // Load the Organization from the DB and verify it is ACTIVE. Suspended and
  // archived orgs are rejected for every org-scoped web-admin request.
  const org = await db.organization.findUnique({
    where: { id: orgId },
    select: { id: true, status: true },
  });
  if (!org || org.status !== 'active') {
    return { ok: false, status: 403, userRole: auth.role };
  }

  // Enforce an ACTIVE membership for the requested org (spec C: removing a
  // membership must instantly revoke that org's access). This is applied only
  // once the user has been migrated to the membership model — a user with no
  // memberships at all keeps working via the legacy AppUser.organizationId
  // field until the migration script backfills them, so existing single-org
  // accounts are never locked out mid-migration.
  if (auth.role !== 'super_admin') {
    const hasAnyMembership = await db.organizationMembership.findFirst({
      where: { userId: auth.userId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (hasAnyMembership) {
      const membership = await db.organizationMembership.findUnique({
        where: { userId_organizationId: { userId: auth.userId, organizationId: orgId } },
        select: { status: true },
      });
      if (!membership || membership.status !== 'ACTIVE') {
        return { ok: false, status: 403, userRole: auth.role };
      }
    }
  }

  // Optional minimum-role gate (manager+/admin+).
  if (opts.minRole && !hasRolePermission(auth.role, opts.minRole)) {
    // Map minRole to a representative permission
    const roleToPermission: Record<string, string> = {
      manager: 'reports.create',
      admin: 'organization.settings.update',
      org_admin: 'organization.members.create',
      super_admin: 'platform.organizations.read',
    };
    return { ok: false, status: 403, requiredPermission: roleToPermission[opts.minRole], userRole: auth.role };
  }

  return { ok: true, organizationId: orgId, userId: auth.userId, email: auth.email, role: auth.role };
}

/**
 * Authenticate a request and resolve its organization scope for a route.
 * Org status (`active`) is enforced via requireActiveSessionOrg.
 *
 * - No valid token          -> 401
 * - Valid token with org    -> ok(scoped)
 * - Org-less super_admin    -> ok(null) when `allowGlobal` (global read scope)
 * - Valid token without org -> 403
 */
export async function requireSessionOrg(
  req: NextRequest,
  opts: { allowGlobal?: boolean } = {}
): Promise<OrgScopeResult> {
  const r = await requireActiveSessionOrg(req, { allowGlobal: opts.allowGlobal });
  if (!r.ok) return { ok: false, status: r.status, requiredPermission: r.requiredPermission, userRole: r.userRole };
  return { ok: true, organizationId: r.organizationId };
}

export type AdminOrgResult =
  | { ok: true; organizationId: string; userId: string; email: string }
  | { ok: false; status: 401 | 403; requiredPermission?: string; userRole?: string };

export type ManagerOrgResult =
  | { ok: true; organizationId: string; userId: string; email: string }
  | { ok: false; status: 401 | 403; requiredPermission?: string; userRole?: string };

/**
 * Authenticate a request and require an ORG-BOUND manager-or-above session
 * (report generation/export S-3). Organization identity is always derived
 * from the verified session — never from client-supplied input. Org status is
 * enforced (suspended/archived -> 403).
 */
export async function requireManagerOrg(
  req: NextRequest
): Promise<ManagerOrgResult> {
  const r = await requireActiveSessionOrg(req, { minRole: 'manager' });
  if (!r.ok) return { ok: false, status: r.status, requiredPermission: r.requiredPermission, userRole: r.userRole };
  return { ok: true, organizationId: r.organizationId as string, userId: r.userId, email: r.email };
}

/**
 * Authenticate a request and require an ORG-BOUND admin-or-above session
 * (used for mutations). Organization identity is always derived from the
 * verified session — never from client-supplied input. Org status is enforced.
 */
export async function requireAdminOrg(
  req: NextRequest
): Promise<AdminOrgResult> {
  const r = await requireActiveSessionOrg(req, { minRole: 'admin' });
  if (!r.ok) return { ok: false, status: r.status, requiredPermission: r.requiredPermission, userRole: r.userRole };
  return { ok: true, organizationId: r.organizationId as string, userId: r.userId, email: r.email };
}

export type OrgAdminResult =
  | { ok: true; userId: string; email: string; role: string; isSuperAdmin: boolean }
  | { ok: false; status: 401 | 403; requiredPermission?: string; userRole?: string };

/**
 * Authorize management of a SPECIFIC organization's members/resources.
 *
 * The caller must be a super_admin (global platform admin) OR an active,
 * org-bound admin/owner whose active organization equals `targetOrgId`.
 *
 * SECURITY: `targetOrgId` is taken from the URL, but the caller's own
 * authority is derived ONLY from the verified session — we never trust a
 * client-supplied organization id for the caller's identity. For non-super-admins
 * the target org must be ACTIVE (suspended/archived orgs are locked for normal
 * admins; super_admin may still manage them).
 */
export async function requireOrgAdmin(
  req: NextRequest,
  targetOrgId: string,
  minRole: string = 'admin'
): Promise<OrgAdminResult> {
  const auth = await authenticateRequest(req);
  if (!auth) return { ok: false, status: 401, userRole: undefined };

  if (auth.role === 'super_admin') {
    return { ok: true, userId: auth.userId, email: auth.email, role: auth.role, isSuperAdmin: true };
  }

  const callerOrg = auth.activeOrganizationId || auth.organizationId;
  if (!callerOrg || callerOrg !== targetOrgId) return { ok: false, status: 403, requiredPermission: 'organization.members.create', userRole: auth.role };
  if (!hasRolePermission(auth.role, minRole)) return { ok: false, status: 403, requiredPermission: 'organization.members.create', userRole: auth.role };

  const org = await db.organization.findUnique({
    where: { id: targetOrgId },
    select: { status: true },
  });
  if (!org || org.status !== 'active') return { ok: false, status: 403, userRole: auth.role };

  return { ok: true, userId: auth.userId, email: auth.email, role: auth.role, isSuperAdmin: false };
}

// ─── Subscription Helpers ───────────────────────────────────────────────────

export type SubscriptionCheckResult =
  | { ok: true; organizationId: string; userId: string; email: string; role: string; isTrial: boolean; isSubscribed: boolean }
  | { ok: false; status: 401 | 403; requiredPermission?: string; userRole?: string };

/**
 * Authenticate, resolve org, and verify an active subscription (or valid trial).
 * Super Admin users bypass the subscription check entirely.
 *
 * When the org is on a valid trial, the UI should display a trial banner.
 * The caller can check `result.isTrial` to conditionally add the
 * `x-trial-active: true` header on the response.
 */
export async function requireActiveSubscription(
  req: NextRequest,
  opts: { allowGlobal?: boolean } = {},
): Promise<SubscriptionCheckResult> {
  // Step 1: standard org-scope + membership check
  const sessionResult = await requireActiveSessionOrg(req, { allowGlobal: opts.allowGlobal });
  if (!sessionResult.ok) {
    return { ok: false, status: sessionResult.status, requiredPermission: sessionResult.requiredPermission, userRole: sessionResult.userRole };
  }

  // Super Admin bypasses subscription checks
  if (sessionResult.role === 'super_admin') {
    return {
      ok: true,
      organizationId: sessionResult.organizationId as string,
      userId: sessionResult.userId,
      email: sessionResult.email,
      role: sessionResult.role,
      isTrial: false,
      isSubscribed: false,
    };
  }

  // No org (global super_admin) — subscription check doesn't apply
  if (!sessionResult.organizationId) {
    return {
      ok: true,
      organizationId: null as unknown as string,
      userId: sessionResult.userId,
      email: sessionResult.email,
      role: sessionResult.role,
      isTrial: false,
      isSubscribed: false,
    };
  }

  // Step 2: check trial
  const org = await db.organization.findUnique({
    where: { id: sessionResult.organizationId },
    select: { trialEndsAt: true },
  });

  if (org && hasValidTrial(org)) {
    return {
      ok: true,
      organizationId: sessionResult.organizationId,
      userId: sessionResult.userId,
      email: sessionResult.email,
      role: sessionResult.role,
      isTrial: true,
      isSubscribed: false,
    };
  }

  // Step 3: check active subscription
  const sub = await getActiveSubscription(sessionResult.organizationId);
  if (sub) {
    return {
      ok: true,
      organizationId: sessionResult.organizationId,
      userId: sessionResult.userId,
      email: sessionResult.email,
      role: sessionResult.role,
      isTrial: false,
      isSubscribed: true,
    };
  }

  // No subscription and no trial — deny access
  return {
    ok: false,
    status: 403,
    requiredPermission: 'organization.read',
    userRole: sessionResult.role,
  };
}

/**
 * Turn a scope/auth result into a NextResponse error using the project's
 * error semantics: 401 = no valid session, 403 = insufficient scope/permission.
 * Optionally includes structured authorization error information.
 */
export function authError(
  result: { ok: false; status: 401 | 403 },
  opts?: { permission?: string; userRole?: string }
) {
  if (result.status === 401) {
    return apiError('Unauthorized. Please sign in.', 401);
  }

  // 403 - structured authorization error
  const permission = opts?.permission;
  const userRole = opts?.userRole;

if (permission) {
    const allowedRoles = getRolesWithPermission(permission as any);
    const allowedRoleLabels = allowedRoles.map(getRoleLabelFromPermissions).join(', ');
    const userRoleLabel = userRole ? getRoleLabelFromPermissions(userRole) : 'Unknown';

    const body = {
      error: 'FORBIDDEN',
      code: 'INSUFFICIENT_PERMISSION',
      message: 'Insufficient permissions',
      requiredPermission: permission,
      requiredRoles: allowedRoles,
      allowedRoleLabels,
      userRole,
      userRoleLabel,
    };
    return NextResponse.json(body, { status: 403 });
}

  // Fallback for calls without permission info
  return apiError('Insufficient permissions', 403);
}

export type SuperAdminResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; status: 401 | 403; requiredPermission?: string; userRole?: string };

/**
 * Authenticate a request and require a super_admin session. Used for
 * instance-global configuration writes (SystemSetting) that must NOT be
 * reachable by org-bound admins — org scopes never grant global writes.
 */
export async function requireSuperAdmin(
  req: NextRequest
): Promise<SuperAdminResult> {
  const auth = await authenticateRequest(req);
  if (!auth) return { ok: false, status: 401 };
  if (auth.role !== 'super_admin') return { ok: false, status: 403, requiredPermission: 'platform.organizations.read', userRole: auth.role };
  return { ok: true, userId: auth.userId, email: auth.email };
}

// ─── DB-Verified Role (P2/P3 #11) ─────────────────────────────────────────

export type DbVerifiedRoleResult =
  | { ok: true; userId: string; email: string; role: string; organizationId: string | null }
  | { ok: false; status: 401 | 403; requiredPermission?: string; userRole?: string };

/**
 * For highly privileged operations (super_admin check, membership management,
 * role changes), verify the user's role from the DATABASE, not from the JWT.
 * This closes the window where a revoked role in the DB is still accepted
 * because the JWT hasn't expired yet.
 *
 * Use this instead of requireSuperAdmin or requireOrgAdmin for the most
 * sensitive mutations (role assignment, org status changes, membership removal).
 * Low-risk read operations should continue using the JWT for performance.
 */
export async function requireDbVerifiedRole(
  req: NextRequest,
  opts: { requireSuperAdmin?: boolean; minRole?: string; orgId?: string } = {}
): Promise<DbVerifiedRoleResult> {
  const auth = await authenticateRequest(req);
  if (!auth) return { ok: false, status: 401, userRole: undefined };

  // Load the actual role from the DB
  const dbUser = await db.appUser.findUnique({
    where: { id: auth.userId },
    select: { id: true, email: true, role: true, isActive: true },
  });
  if (!dbUser || !dbUser.isActive) return { ok: false, status: 401, userRole: auth?.role };

  // Reject if the DB role is weaker than what the JWT claims.
  // Use 403 (forbidden) — the user IS authenticated but lacks permission.
  if (opts.requireSuperAdmin && dbUser.role !== 'super_admin') {
    return { ok: false, status: 403, requiredPermission: 'platform.organizations.read', userRole: dbUser.role };
  }
  if (opts.minRole && !hasRolePermission(dbUser.role, opts.minRole)) {
    const roleToPermission: Record<string, string> = {
      manager: 'reports.create',
      admin: 'organization.settings.update',
      org_admin: 'organization.members.create',
      super_admin: 'platform.organizations.read',
    };
    return { ok: false, status: 403, requiredPermission: roleToPermission[opts.minRole], userRole: dbUser.role };
  }

  return { ok: true, userId: dbUser.id, email: dbUser.email, role: dbUser.role, organizationId: auth.organizationId || auth.activeOrganizationId || null };
}

export type MembershipAdminResult =
  | { ok: true; userId: string; email: string; role: string; organizationId: string; isSuperAdmin: boolean }
  | { ok: false; status: 401 | 403; requiredPermission?: string; userRole?: string };

/**
 * Authorize membership management operations with DB-verified role.
 * For mutations that change membership roles, status, or remove members —
 * the role is verified from the DB, not the JWT.
 */
export async function requireMembershipAdmin(
  req: NextRequest,
  targetOrgId: string
): Promise<MembershipAdminResult> {
  const auth = await authenticateRequest(req);
  if (!auth) return { ok: false, status: 401, userRole: undefined };

  const dbUser = await db.appUser.findUnique({
    where: { id: auth.userId },
    select: { id: true, email: true, role: true, isActive: true },
  });
  if (!dbUser || !dbUser.isActive) return { ok: false, status: 401, userRole: undefined };

  if (dbUser.role === 'super_admin') {
    return { ok: true, userId: dbUser.id, email: dbUser.email, role: dbUser.role, organizationId: targetOrgId, isSuperAdmin: true };
  }

  const callerOrg = auth.activeOrganizationId || auth.organizationId;
  if (!callerOrg || callerOrg !== targetOrgId) return { ok: false, status: 403, requiredPermission: 'organization.members.create', userRole: dbUser.role };
  if (!hasRolePermission(dbUser.role, 'admin')) return { ok: false, status: 403, requiredPermission: 'organization.members.create', userRole: dbUser.role };

  const org = await db.organization.findUnique({
    where: { id: targetOrgId },
    select: { status: true },
  });
  if (!org || org.status !== 'active') return { ok: false, status: 403, userRole: dbUser.role };

  return { ok: true, userId: dbUser.id, email: dbUser.email, role: dbUser.role, organizationId: targetOrgId, isSuperAdmin: false };
}

// ─── Self-Hosted License Check ─────────────────────────────────────────────

export type LicenseCheckResult =
  | { ok: true; license: { id: string; key: string; validUntil: string; plan: { name: string; maxDevices: number; retentionDays: number } } }
  | { ok: false; reason: 'no_license' | 'revoked' | 'inactive' | 'expired' };

/**
 * Require a valid, current license for an organization in SELF-HOSTED mode.
 *
 * Cloud mode (SELF_HOSTED unset/false) ALWAYS passes — this mirrors the
 * subscription-gate behaviour but for the on-prem license, so self-hosted
 * installs are locked to their license while cloud tenants are unaffected.
 *
 * The license is read from the org's current pointer (Organization.licenseKeyId).
 * A revoked / deactivated / expired license, or a missing one, fails closed.
 * Super admins and the public validate endpoint are handled separately and are
 * not routed through this middleware.
 */
export async function requireValidLicense(
  organizationId: string
): Promise<LicenseCheckResult> {
  if (!isSelfHosted) return { ok: true, license: { id: '', key: '[cloud]', validUntil: '', plan: { name: 'Cloud', maxDevices: -1, retentionDays: 0 } } };

  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: {
      licenseKey: {
        select: {
          id: true,
          key: true,
          isActive: true,
          isRevoked: true,
          validUntil: true,
          plan: { select: { name: true, maxDevices: true, retentionDays: true } },
        },
      },
    },
  });

  const license = org?.licenseKey;
  if (!license) return { ok: false, reason: 'no_license' };
  if (license.isRevoked) return { ok: false, reason: 'revoked' };
  if (!license.isActive) return { ok: false, reason: 'inactive' };
  if (license.validUntil.getTime() <= Date.now()) return { ok: false, reason: 'expired' };

  return {
    ok: true,
    license: {
      id: license.id,
      key: license.key,
      validUntil: license.validUntil.toISOString(),
      plan: license.plan,
    },
  };
}

/**
 * Safely parse a JSON request body. Malformed/empty bodies are a CLIENT
 * error (400), never a 500.
 */
export async function parseJsonBody(
  req: NextRequest
): Promise<Record<string, unknown>> {
  try {
    const parsed = await req.json();
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new BodyParseError();
  }
}

/** Sentinel error so callers can distinguish "invalid body" from other errors. */
export class BodyParseError extends Error {}

/** True when a Date object holds a valid instant (NaN-free). */
export function isValidDate(d: Date): boolean {
  return !Number.isNaN(d.getTime());
}

/**
 * Parse an optional date string into a Date. Returns null when absent,
 * `invalid` when present but unparseable. Callers must map `invalid` to 422.
 */
export function parseOptionalDate(value: string | undefined): Date | 'invalid' | null {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value);
  return isValidDate(d) ? d : 'invalid';
}

// ─── Runtime analytics-DB switching (per-org OPT-IN) ────────────────────────
// Re-exported here for convenience. See org-db.ts for the design and for
// getPrismaForOrg, which returns { mode: 'cloud'|'own', client }.
export { getPrismaForOrg, invalidateOrgDbCache } from '@/lib/org-db';


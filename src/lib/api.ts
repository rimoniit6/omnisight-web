// OmniSight API Middleware Helper
// Provides authentication & authorization helpers for API routes

import { NextRequest, NextResponse } from 'next/server';
import { extractToken, hasRolePermission, SESSION_COOKIE_NAME } from '@/lib/auth';
import { verifySessionToken } from '@/lib/session';

// ─── Safe employee projection (approval lists / responses) ─────────────────
// Employee rows carry credential material (`agentPassword`) that must never be
// serialized. The approval list/response paths (agent-registrations,
// device-claims) whitelist exactly the display fields the UI needs instead of
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
}

// ─── Response Helpers ──────────────────────────────────────────────────────

export function apiError(message: string, status: number = 400) {
  return NextResponse.json({ error: message }, { status });
}

export function apiSuccess<T>(data: T, status: number = 200) {
  return NextResponse.json(data, { status });
}

export function apiCreated<T>(data: T) {
  return NextResponse.json(data, { status: 201 });
}

export function apiNoContent() {
  return new NextResponse(null, { status: 204 });
}

// ─── Auth Middleware ───────────────────────────────────────────────────────

/**
 * Authenticate a request and return the auth context.
 * Accepts a Bearer token or the httpOnly session cookie (matching the
 * middleware's getToken fallback). Returns null if authentication fails
 * (caller should send 401).
 */
export async function authenticateRequest(req: NextRequest): Promise<AuthContext | null> {
  try {
    const token = extractToken(req) || req.cookies.get(SESSION_COOKIE_NAME)?.value;
    if (!token) return null;

    // verifySessionToken = JWT verification + server-side session re-check
    // (S-04): a revoked/expired session row rejects the token even though its
    // signature is still valid. Handler-level enforcement — never proxy-only.
    const payload = await verifySessionToken(token);
    if (!payload) return null;

    return {
      userId: payload.userId,
      email: payload.email,
      role: payload.role,
      organizationId: payload.organizationId,
    };
  } catch {
    return null;
  }
}

/**
 * Higher-order function: wraps a handler with JWT authentication.
 * If auth fails, returns 401 automatically.
 */
export function withAuth(
  handler: (req: NextRequest, auth: AuthContext) => Promise<NextResponse>
) {
  return async (req: NextRequest): Promise<NextResponse> => {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return apiError('Unauthorized. Please sign in.', 401);
    }
    return handler(req, auth);
  };
}

/**
 * Higher-order function: wraps a handler with JWT auth + role check.
 * If auth fails or role is insufficient, returns 401/403.
 */
export function withAuthAndRole(
  requiredRole: string,
  handler: (req: NextRequest, auth: AuthContext) => Promise<NextResponse>
) {
  return async (req: NextRequest): Promise<NextResponse> => {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return apiError('Unauthorized. Please sign in.', 401);
    }

    if (!hasRolePermission(auth.role, requiredRole)) {
      return apiError('Insufficient permissions', 403);
    }

    return handler(req, auth);
  };
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
 * Get search query from URL search params
 */
export function getSearchQuery(req: NextRequest): string {
  const url = new URL(req.url);
  return url.searchParams.get('search') || '';
}

/**
 * Get organization ID from auth context or query param
 */
export function getOrgId(req: NextRequest, auth: AuthContext): string {
  const url = new URL(req.url);
  return url.searchParams.get('organizationId') || auth.organizationId || '';
}

/**
 * Resolve the caller's organization from the authenticated session only.
 *
 * SECURITY (tenant isolation): organization identity must come from the
 * verified JWT (cookie or bearer), never from a findFirst() over all
 * organizations and never from client-supplied input.
 */
export async function getSessionOrg(
  req: NextRequest
): Promise<{ id: string } | null> {
  // Route through authenticateRequest so the server-side session re-check
  // (S-04) applies here too — a revoked session no longer resolves an org.
  const auth = await authenticateRequest(req);
  if (!auth?.organizationId) return null;
  return { id: auth.organizationId };
}

// ─── Organization Scope Helpers ─────────────────────────────────────────────

export type OrgScopeResult =
  | { ok: true; organizationId: string | null } // null => global (org-less super_admin)
  | { ok: false; status: 401 | 403 };

/**
 * Authenticate a request and resolve its organization scope for a route.
 *
 * - No valid token          -> 401
 * - Valid token with org    -> ok(scoped)
 * - Org-less super_admin    -> ok(null) when `allowGlobal` (global read scope,
 *                             mirroring the self-portal guard convention)
 * - Valid token without org -> 403
 */
export async function requireSessionOrg(
  req: NextRequest,
  opts: { allowGlobal?: boolean } = {}
): Promise<OrgScopeResult> {
  const auth = await authenticateRequest(req);
  if (!auth) return { ok: false, status: 401 };
  if (auth.organizationId) return { ok: true, organizationId: auth.organizationId };
  if (opts.allowGlobal && auth.role === 'super_admin') {
    return { ok: true, organizationId: null };
  }
  return { ok: false, status: 403 };
}

export type AdminOrgResult =
  | { ok: true; organizationId: string; userId: string; email: string }
  | { ok: false; status: 401 | 403 };

export type ManagerOrgResult =
  | { ok: true; organizationId: string; userId: string; email: string }
  | { ok: false; status: 401 | 403 };

/**
 * Authenticate a request and require an ORG-BOUND manager-or-above session
 * (report generation/export S-3). Organization identity is always derived
 * from the verified session — never from client-supplied input.
 */
export async function requireManagerOrg(
  req: NextRequest
): Promise<ManagerOrgResult> {
  const auth = await authenticateRequest(req);
  if (!auth) return { ok: false, status: 401 };
  if (!auth.organizationId || !hasRolePermission(auth.role, 'manager')) {
    return { ok: false, status: 403 };
  }
  return { ok: true, organizationId: auth.organizationId, userId: auth.userId, email: auth.email };
}

/**
 * Authenticate a request and require an ORG-BOUND admin-or-above session
 * (used for mutations). Organization identity is always derived from the
 * verified session — never from client-supplied input.
 */
export async function requireAdminOrg(
  req: NextRequest
): Promise<AdminOrgResult> {
  const auth = await authenticateRequest(req);
  if (!auth) return { ok: false, status: 401 };
  if (!auth.organizationId || !hasRolePermission(auth.role, 'admin')) {
    return { ok: false, status: 403 };
  }
  return { ok: true, organizationId: auth.organizationId, userId: auth.userId, email: auth.email };
}

/**
 * Turn a scope/auth result into a NextResponse error using the project's
 * error semantics: 401 = no valid session, 403 = insufficient scope/permission.
 */
export function authError(result: { ok: false; status: 401 | 403 }) {
  return apiError(
    result.status === 401 ? 'Unauthorized. Please sign in.' : 'Insufficient permissions',
    result.status
  );
}

export type SuperAdminResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; status: 401 | 403 };

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
  if (auth.role !== 'super_admin') return { ok: false, status: 403 };
  return { ok: true, userId: auth.userId, email: auth.email };
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

import { NextRequest } from 'next/server';
import { db as prisma } from '@/lib/db';
import { authenticateRequest, apiError, apiSuccess, parseJsonBody } from '@/lib/api';
import { signJWT, SESSION_COOKIE_NAME, extractToken, verifyJWT } from '@/lib/auth';

/**
 * POST /api/me/organization/switch
 *
 * Switch the authenticated user's active organization.
 * The server verifies the user has an ACTIVE membership for the requested org.
 * A new JWT is issued with the updated activeOrganizationId.
 *
 * Auth: Any authenticated user with at least one membership.
 * Body: { organizationId: string }
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth) return apiError('Unauthorized', 401);

  let body: Record<string, unknown>;
  try {
    body = await parseJsonBody(req);
  } catch {
    return apiError('Invalid request body', 400);
  }

  const requestedOrgId = body.organizationId as string | undefined;
  if (!requestedOrgId || typeof requestedOrgId !== 'string') {
    return apiError('organizationId is required', 422);
  }

  // SECURITY: Verify access.
  // Super Admin has global access to any organization (no membership required).
  // Normal users must have an ACTIVE membership for the requested org.
  let jwtRole: string;
  let orgName: string;

  if (auth.role === 'super_admin') {
    // Super Admin: verify the organization exists and is active.
    const org = await prisma.organization.findUnique({
      where: { id: requestedOrgId },
      select: { id: true, name: true, status: true },
    });
    if (!org) {
      return apiError('Organization not found', 403);
    }
    if (org.status !== 'active') {
      return apiError('Organization is not active', 403);
    }
    jwtRole = 'super_admin'; // Super Admin keeps global role, not membership role
    orgName = org.name;
  } else {
    // Normal user: verify ACTIVE membership for the requested org.
    const membership = await prisma.organizationMembership.findUnique({
      where: {
        userId_organizationId: {
          userId: auth.userId,
          organizationId: requestedOrgId,
        },
      },
      include: {
        organization: {
          select: { id: true, name: true, status: true },
        },
      },
    });

    if (!membership || membership.status !== 'ACTIVE') {
      return apiError('Not a member of that organization', 403);
    }

    if (membership.organization.status !== 'active') {
      return apiError('Organization is not active', 403);
    }

    // Use membership role from DB (source of truth, not JWT)
    jwtRole = membership.role;
    orgName = membership.organization.name;
  }

  // CRITICAL (P0-01): The sessionId MUST be preserved from the current token.
  const currentToken = extractToken(req) || req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const currentPayload = currentToken ? await verifyJWT(currentToken) : null;
  const sessionId = currentPayload?.sessionId;

  const newToken = await signJWT({
    userId: auth.userId,
    email: auth.email,
    role: jwtRole,
    organizationId: requestedOrgId,
    activeOrganizationId: requestedOrgId,
    sessionId,
  });

  // P2-01: Update the session's server-authoritative activeOrganizationId.
  if (sessionId) {
    await prisma.userSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { activeOrganizationId: requestedOrgId },
    });
  }

  const response = apiSuccess({
    activeOrganizationId: requestedOrgId,
    role: jwtRole,
    organization: {
      id: requestedOrgId,
      name: orgName,
    },
  });

  // Set the new JWT in the session cookie
  const maxAge = 7 * 24 * 60 * 60; // 7 days
  response.cookies.set(SESSION_COOKIE_NAME, newToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  });

  return response;
}

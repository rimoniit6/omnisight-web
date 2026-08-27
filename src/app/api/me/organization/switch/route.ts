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

  // SECURITY: Verify the user has an ACTIVE membership for the requested org.
  // Never trust client-supplied organizationId without membership verification.
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
    // Uniform denial — don't reveal whether the org exists
    return apiError('Not a member of that organization', 403);
  }

  if (membership.organization.status !== 'active') {
    return apiError('Organization is not active', 403);
  }

  // Issue a new JWT with the updated activeOrganizationId.
  // The role is read from the membership (DB source of truth), not from the
  // JWT-claimed role — this ensures a role change takes effect on the next
  // switch even if the old JWT hasn't expired (P2/P3 #11).
  //
  // CRITICAL (P0-01): The sessionId MUST be preserved from the current token.
  // Without it, the switched session becomes unrevocable — logout, force-logout,
  // password change, and account disable all fail to revoke the new token.
  const currentToken = extractToken(req) || req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const currentPayload = currentToken ? await verifyJWT(currentToken) : null;
  const sessionId = currentPayload?.sessionId;

  const newToken = await signJWT({
    userId: auth.userId,
    email: auth.email,
    role: membership.role,
    organizationId: requestedOrgId,
    activeOrganizationId: requestedOrgId,
    sessionId,
  });

  // P2-01: Update the session's server-authoritative activeOrganizationId.
  // Old tokens with the previous org will be rejected by verifySessionActiveOrg().
  if (sessionId) {
    await prisma.userSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { activeOrganizationId: requestedOrgId },
    });
  }

  const response = apiSuccess({
    activeOrganizationId: requestedOrgId,
    role: membership.role,
    organization: {
      id: membership.organization.id,
      name: membership.organization.name,
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

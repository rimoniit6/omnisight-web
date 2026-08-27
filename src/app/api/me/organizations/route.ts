import { NextRequest } from 'next/server';
import { db as prisma } from '@/lib/db';
import { authenticateRequest, apiError, apiSuccess } from '@/lib/api';

/**
 * GET /api/me/organizations
 *
 * Returns all organizations the authenticated user has an ACTIVE membership in.
 * Used by the org-switcher dropdown in the admin UI.
 *
 * Auth: Any authenticated user.
 * Scope: User's own memberships (never cross-tenant).
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth) return apiError('Unauthorized', 401);

  const memberships = await prisma.organizationMembership.findMany({
    where: {
      userId: auth.userId,
      status: 'ACTIVE',
    },
    include: {
      organization: {
        select: {
          id: true,
          name: true,
          slug: true,
          logo: true,
          status: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  return apiSuccess({
    organizations: memberships.map((m) => ({
      id: m.organization.id,
      name: m.organization.name,
      slug: m.organization.slug,
      logo: m.organization.logo,
      status: m.organization.status,
      role: m.role,
      membershipId: m.id,
    })),
    activeOrganizationId: auth.activeOrganizationId || auth.organizationId || null,
  });
}

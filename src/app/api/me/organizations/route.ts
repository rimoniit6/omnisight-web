import { NextRequest } from 'next/server';
import { db as prisma } from '@/lib/db';
import { authenticateRequest, apiError, apiSuccess } from '@/lib/api';

/**
 * GET /api/me/organizations
 *
 * Returns organizations available to the authenticated user.
 * - Super Admin: ALL organizations (global access, no membership required)
 * - Normal users: only organizations where the user has ACTIVE membership
 *
 * Used by the org-switcher dropdown in the admin UI.
 *
 * Auth: Any authenticated user.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth) return apiError('Unauthorized', 401);

  let organizations: {
    id: string;
    name: string;
    slug: string;
    logo: string | null;
    status: string;
    deploymentMode: string;
    role: string;
    membershipId: string | null;
  }[];

  if (auth.role === 'super_admin') {
    // Phase 1 Step 8: Super Admin lists MANAGED organizations ONLY.
    // CUSTOMER_DB / PRIVATE orgs are invisible here (control-plane metadata
    // for those modes lives in the super-admin metadata APIs, not the
    // switcher). Enforced server-side — never UI filtering.
    // The role shown is the Super Admin's global role, not a membership role.
    const allOrgs = await prisma.organization.findMany({
      where: { deploymentMode: 'MANAGED' },
      select: {
        id: true,
        name: true,
        slug: true,
        logo: true,
        status: true,
        deploymentMode: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    // Check if Super Admin has any memberships to show the correct role label
    const memberships = await prisma.organizationMembership.findMany({
      where: { userId: auth.userId, status: 'ACTIVE' },
      select: { organizationId: true, role: true, id: true },
    });

    const membershipMap = new Map(
      memberships.map((m) => [m.organizationId, { role: m.role, id: m.id }])
    );

    organizations = allOrgs.map((org) => {
      const membership = membershipMap.get(org.id);
      return {
        ...org,
        role: membership?.role || 'super_admin',
        membershipId: membership?.id || null,
      };
    });
  } else {
    // Normal user: only organizations where the user has ACTIVE membership
    // (any deployment mode — membership is the authority for org users).
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
            deploymentMode: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    organizations = memberships.map((m) => ({
      id: m.organization.id,
      name: m.organization.name,
      slug: m.organization.slug,
      logo: m.organization.logo,
      status: m.organization.status,
      deploymentMode: m.organization.deploymentMode,
      role: m.role,
      membershipId: m.id,
    }));
  }

  return apiSuccess({
    organizations,
    activeOrganizationId: auth.activeOrganizationId || auth.organizationId || null,
  });
}

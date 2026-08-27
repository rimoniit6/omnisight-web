import { db } from '@/lib/db';

export interface ResolvedMembership {
  organizationId: string;
  role: string;
}

/**
 * Determine the user's effective active organization from their ACTIVE
 * OrganizationMembership rows (the authoritative membership layer).
 *
 * Selection is deterministic and server-authoritative; the client NEVER
 * chooses the organization:
 *   1. A membership matching the user's legacy AppUser.organizationId (if any)
 *      whose organization is still active.
 *   2. Exactly one active membership.
 *   3. Otherwise the first active membership by createdAt (stable ordering).
 *
 * Returns null when the user has no active membership (e.g. a global
 * super_admin, or a pre-migration user with only the legacy field).
 */
export async function resolveActiveMembership(
  userId: string,
  legacyOrgId?: string | null
): Promise<ResolvedMembership | null> {
  const memberships = await db.organizationMembership.findMany({
    where: { userId, status: 'ACTIVE' },
    include: { organization: { select: { id: true, status: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const active = memberships.filter((m) => m.organization.status === 'active');
  if (active.length === 0) return null;

  if (legacyOrgId) {
    const match = active.find((m) => m.organizationId === legacyOrgId);
    if (match) return { organizationId: match.organizationId, role: match.role };
  }

  const chosen = active[0];
  return { organizationId: chosen.organizationId, role: chosen.role };
}

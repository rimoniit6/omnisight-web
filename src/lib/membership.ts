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

/**
 * Restore the organization a user last operated in, from their most recent
 * previous UserSession with an activeOrganizationId.
 *
 * Purpose: a membership-less super_admin (global operator with no
 * OrganizationMembership rows) logs in org-less every time — resolveActiveMembership
 * returns null for them — so org-scoped surfaces (dashboard, global search,
 * screenshots, …) come up empty until they manually re-pick an org in the
 * switcher. Restoring the last-used org (when it still exists and is active)
 * makes the operator's context survive re-login, matching the org-bound user
 * experience.
 *
 * Security: this is a UX-only fallback for a role that already holds GLOBAL
 * access (the switch endpoint lets a super_admin operate in ANY org). The org
 * is derived from the server's own session history — never from client input —
 * and is re-validated as existing + active before adoption.
 */
export async function restoreLastActiveOrg(userId: string): Promise<string | null> {
  const last = await db.userSession.findFirst({
    where: { userId, activeOrganizationId: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { activeOrganizationId: true },
  });
  const orgId = last?.activeOrganizationId;
  if (!orgId) return null;
  const org = await db.organization.findUnique({
    where: { id: orgId },
    select: { status: true },
  });
  return org && org.status === 'active' ? orgId : null;
}

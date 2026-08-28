// OmniSight — Organization membership role + privilege-elevation helpers.
//
// SINGLE SOURCE OF TRUTH for the set of assignable per-organization membership
// roles and the "can an actor grant/assign this target role?" rule.
//
// Roles are strings (not a Prisma enum) — this module is the enforcement
// point. It is intentionally separated so the Guest→Employee conversion, the
// member-add route and the member role-change route all share the SAME
// authorization semantics instead of duplicating ad-hoc checks.
//
// Security model (Section 7 + 14 of the Guest→Employee spec):
//   - server-authoritative: the actor's level comes from the DATABASE
//     membership, never from the JWT (closes the stale-role window).
//   - no privilege escalation: an actor may only assign a role whose level is
//     <= their own. Global super_admin may assign any non-super_admin role.
//   - super_admin is a platform role and is never a per-org membership value.
import { db } from '@/lib/db';
import { authenticateRequest } from '@/lib/api';
import type { NextRequest } from 'next/server';

/** Roles assignable as a per-organization membership (never global super_admin). */
export const ORG_ROLES = ['owner', 'admin', 'manager', 'viewer'] as const;

export type OrgRole = (typeof ORG_ROLES)[number];

/** Role hierarchy levels — higher means more privileged. */
export const ROLE_LEVELS: Record<string, number> = {
  super_admin: 50,
  owner: 40,
  admin: 30,
  manager: 20,
  viewer: 10,
};

export function isOrgRole(role: string): role is OrgRole {
  return (ORG_ROLES as readonly string[]).includes(role);
}

export function roleLevel(role: string): number {
  return ROLE_LEVELS[role] ?? 0;
}

/**
 * Can an actor with `actorRole` assign `targetRole` as a membership role?
 * - super_admin may assign any non-super_admin role.
 * - Otherwise the actor's level must be >= the target's level (no elevation).
 */
export function canAssignRole(actorRole: string, targetRole: string): boolean {
  if (actorRole === 'super_admin') return targetRole !== 'super_admin';
  return roleLevel(actorRole) >= roleLevel(targetRole);
}

/**
 * Resolve the authenticated actor's effective role for `orgId` from the
 * DATABASE membership (never from the JWT). Returns null when the actor is not
 * authenticated or has no membership role to act under. A global super_admin
 * with no membership still resolves to 'super_admin' (platform authority).
 */
export async function resolveActorDbRole(
  req: NextRequest,
  orgId: string
): Promise<string | null> {
  const auth = await authenticateRequest(req);
  if (!auth) return null;

  // Super Admin is platform authority — they may manage any org's members.
  if (auth.role === 'super_admin') return 'super_admin';

  const membership = await db.organizationMembership.findUnique({
    where: { userId_organizationId: { userId: auth.userId, organizationId: orgId } },
    select: { status: true, role: true },
  });
  if (!membership || membership.status !== 'ACTIVE') return null;
  return membership.role;
}

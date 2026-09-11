// ─── V1 Subscription Activation (shared helper) ────────────────────────────
// Wraps the EXISTING subscription lifecycle — this is NOT a second
// subscription system. PATCH /api/super-admin/subscriptions/[id] (activate)
// and the subscription-sweep job remain the authoritative paths; this helper
// exists so the Purchase Request flow and the direct subscription PATCH share
// one implementation of "PENDING → ACTIVE + org pointer + audit".
//
// Consumers:
//   - src/app/api/super-admin/subscriptions/[id]/route.ts (direct activation)
//   - src/app/api/super-admin/purchase-requests/[id]/route.ts (activate action)
// Both are Super Admin-only (requireDbVerifiedRole), transactional, audited.

import { db } from '@/lib/db';

export type ActivationResult =
  | { ok: true; subscriptionId: string }
  | { ok: false; code: 'NOT_FOUND' | 'NOT_PENDING'; message: string };

/**
 * Atomically activate a PENDING subscription: status → ACTIVE, point the
 * organization's current-subscription pointer at it, clear the trial window,
 * and write the audit record. Mirrors the semantics of the existing
 * `activate` action in PATCH /api/super-admin/subscriptions/[id].
 */
export async function activatePendingSubscription(
  subscriptionId: string,
  actor: { userId: string; email: string },
  note?: string | null,
): Promise<ActivationResult> {
  const sub = await db.subscription.findUnique({
    where: { id: subscriptionId },
    include: {
      plan: { select: { name: true } },
      organization: { select: { id: true, name: true, subscriptionId: true } },
    },
  });
  if (!sub) return { ok: false, code: 'NOT_FOUND', message: 'Subscription not found' };
  if (sub.status !== 'PENDING') {
    return { ok: false, code: 'NOT_PENDING', message: `Only PENDING subscriptions can be activated (current: ${sub.status})` };
  }

  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.subscription.update({
      where: { id: subscriptionId },
      data: { status: 'ACTIVE', startDate: sub.startDate ?? now, notes: note ?? sub.notes, updatedAt: now },
    });
    await tx.organization.update({
      where: { id: sub.organizationId },
      data: { status: 'active', subscriptionId, trialEndsAt: null, updatedAt: now },
    });
    await tx.auditLog.create({
      data: {
        action: 'update',
        resource: 'subscription',
        resourceId: subscriptionId,
        description: `Super admin (${actor.email}) activated subscription for org "${sub.organization.name}" (package ${sub.plan.name})${note ? `: ${note}` : ''}`,
        userId: actor.userId,
        organizationId: sub.organizationId,
      },
    });
  });

  return { ok: true, subscriptionId };
}

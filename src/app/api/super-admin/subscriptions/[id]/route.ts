import { NextRequest } from 'next/server';
import { db as prisma } from '@/lib/db';
import { requireDbVerifiedRole, apiError, apiSuccess, authError, parseJsonBody, BodyParseError } from '@/lib/api';

// PATCH /api/super-admin/subscriptions/[id]
// Body: { action: 'activate' | 'cancel' | 'expire', notes? }
//   activate: PENDING -> ACTIVE (+ org active + subscription pointer)
//   cancel:   PENDING/ACTIVE -> CANCELLED (+ clear org pointer when pointing
//             here; org status left for the subscription sweep to reconcile)
//   expire:   ACTIVE -> EXPIRED (manual early expiry; natural expiry is the sweep)
// All transitions are transactional with an audit record. No silent fallback.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireDbVerifiedRole(req, { requireSuperAdmin: true });
  if (!admin.ok) return authError(admin);
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = await parseJsonBody(req);
  } catch (e) {
    if (e instanceof BodyParseError) return apiError('Invalid request body', 400);
    return apiError('Invalid request body', 400);
  }

  const action = body.action as string | undefined;
  if (!['activate', 'cancel', 'expire'].includes(action ?? '')) {
    return apiError("action must be 'activate', 'cancel', or 'expire'", 422);
  }

  const sub = await prisma.subscription.findUnique({
    where: { id },
    include: {
      plan: { select: { name: true } },
      organization: { select: { id: true, name: true, subscriptionId: true } },
    },
  });
  if (!sub) return apiError('Subscription not found', 404);

  const now = new Date();
  const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim().slice(0, 500) : null;

  if (action === 'activate') {
    if (sub.status === 'ACTIVE') return apiError('Subscription is already active', 409);
    if (sub.status !== 'PENDING') return apiError(`Only PENDING subscriptions can be activated (current: ${sub.status})`, 422);
    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.subscription.update({
        where: { id },
        data: { status: 'ACTIVE', startDate: sub.startDate ?? now, notes: notes ?? sub.notes, updatedAt: now },
      });
      await tx.organization.update({
        where: { id: sub.organizationId },
        data: { status: 'active', subscriptionId: id, trialEndsAt: null, updatedAt: now },
      });
      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'subscription',
          resourceId: id,
          description: `Super admin (${admin.email}) activated subscription for org "${sub.organization.name}" (package ${sub.plan.name})${notes ? `: ${notes}` : ''}`,
          userId: admin.userId,
          organizationId: sub.organizationId,
        },
      });
      return u;
    });
    return apiSuccess(updated);
  }

  if (action === 'cancel') {
    if (sub.status === 'CANCELLED') return apiError('Subscription is already cancelled', 409);
    if (sub.status === 'EXPIRED') return apiError('Expired subscriptions cannot be cancelled', 422);
    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.subscription.update({
        where: { id },
        data: { status: 'CANCELLED', notes: notes ?? sub.notes, updatedAt: now },
      });
      if (sub.organization.subscriptionId === id) {
        await tx.organization.update({ where: { id: sub.organizationId }, data: { subscriptionId: null, updatedAt: now } });
      }
      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'subscription',
          resourceId: id,
          description: `Super admin (${admin.email}) cancelled subscription for org "${sub.organization.name}" (package ${sub.plan.name})${notes ? `: ${notes}` : ''}`,
          userId: admin.userId,
          organizationId: sub.organizationId,
        },
      });
      return u;
    });
    return apiSuccess(updated);
  }

  // expire
  if (sub.status !== 'ACTIVE') return apiError(`Only ACTIVE subscriptions can be expired (current: ${sub.status})`, 422);
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.subscription.update({
      where: { id },
      data: { status: 'EXPIRED', endDate: sub.endDate ?? now, notes: notes ?? sub.notes, updatedAt: now },
    });
    await tx.auditLog.create({
      data: {
        action: 'update',
        resource: 'subscription',
        resourceId: id,
        description: `Super admin (${admin.email}) expired subscription for org "${sub.organization.name}" (package ${sub.plan.name})${notes ? `: ${notes}` : ''}`,
        userId: admin.userId,
        organizationId: sub.organizationId,
      },
    });
    return u;
  });
  return apiSuccess(updated);
}

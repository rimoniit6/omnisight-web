import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireDbVerifiedRole, apiError, apiSuccess, authError, parseJsonBody, BodyParseError } from '@/lib/api';

// PATCH /api/super-admin/offers/[id] — update / activate / deactivate an
// offer (Super Admin only). Audited. Scope fields (plan/mode/period) are
// editable; the resolver re-validates scopes at price time, so edits here
// affect only FUTURE calculations — existing snapshots are immutable.

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
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

  const existing = await db.offer.findUnique({ where: { id } });
  if (!existing) return apiError('Offer not found', 404);

  const data: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return apiError('name must be a non-empty string', 422);
    data.name = name.slice(0, 200);
  }
  if (body.description !== undefined) {
    data.description = typeof body.description === 'string' ? body.description.trim().slice(0, 1000) || null : null;
  }
  if (body.isActive !== undefined) data.isActive = body.isActive === true;
  if (body.isFree !== undefined) data.isFree = body.isFree === true;

  if (body.discountType !== undefined) {
    if (body.discountType !== 'PERCENTAGE' && body.discountType !== 'FIXED') {
      return apiError("discountType must be 'PERCENTAGE' or 'FIXED'", 422);
    }
    data.discountType = body.discountType;
  }
  if (body.discountValue !== undefined) {
    const n = Number(body.discountValue);
    if (!Number.isFinite(n) || n < 0) return apiError('discountValue must be a non-negative number', 422);
    const type = (data.discountType as string | undefined) ?? existing.discountType;
    if (type === 'PERCENTAGE' && n > 100) return apiError('percentage discountValue must be 0-100', 422);
    data.discountValue = n;
  }
  if (body.freeTrialDays !== undefined) {
    if (body.freeTrialDays === null) data.freeTrialDays = null;
    else {
      const n = Number(body.freeTrialDays);
      if (!Number.isInteger(n) || n < 0) return apiError('freeTrialDays must be a non-negative integer', 422);
      data.freeTrialDays = n;
    }
  }
  if (body.startsAt !== undefined) {
    if (body.startsAt === null || body.startsAt === '') data.startsAt = null;
    else {
      const d = new Date(String(body.startsAt));
      if (Number.isNaN(d.getTime())) return apiError('startsAt must be a valid date', 422);
      data.startsAt = d;
    }
  }
  if (body.endsAt !== undefined) {
    if (body.endsAt === null || body.endsAt === '') data.endsAt = null;
    else {
      const d = new Date(String(body.endsAt));
      if (Number.isNaN(d.getTime())) return apiError('endsAt must be a valid date', 422);
      data.endsAt = d;
    }
  }
  if (body.planId !== undefined) {
    if (body.planId === null || body.planId === '') data.planId = null;
    else {
      const plan = await db.plan.findUnique({ where: { id: String(body.planId) }, select: { id: true } });
      if (!plan) return apiError('Scoped plan not found', 404);
      data.planId = body.planId;
    }
  }
  if (body.deploymentMode !== undefined) {
    if (body.deploymentMode === null || body.deploymentMode === '') data.deploymentMode = null;
    else if (body.deploymentMode !== 'MANAGED' && body.deploymentMode !== 'CUSTOMER_DB') {
      return apiError("deploymentMode scope must be 'MANAGED' or 'CUSTOMER_DB'", 422);
    } else data.deploymentMode = body.deploymentMode;
  }
  if (body.billingPeriod !== undefined) {
    if (body.billingPeriod === null || body.billingPeriod === '') data.billingPeriod = null;
    else if (body.billingPeriod !== 'MONTHLY' && body.billingPeriod !== 'YEARLY') {
      return apiError("billingPeriod scope must be 'MONTHLY' or 'YEARLY'", 422);
    } else data.billingPeriod = body.billingPeriod;
  }

  if (Object.keys(data).length === 0) return apiError('No updatable fields provided', 422);

  const offer = await db.$transaction(async (tx) => {
    const updated = await tx.offer.update({ where: { id }, data });
    await tx.auditLog.create({
      data: {
        action: 'update',
        resource: 'offer',
        resourceId: id,
        description: `Super admin (${admin.email}) updated offer "${updated.name}": ${JSON.stringify(data)}`,
        userId: admin.userId,
        organizationId: null,
      },
    });
    return updated;
  });

  return apiSuccess(offer);
}

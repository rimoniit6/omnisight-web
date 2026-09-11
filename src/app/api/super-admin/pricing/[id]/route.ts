import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireDbVerifiedRole, apiError, apiSuccess, authError, parseJsonBody, BodyParseError } from '@/lib/api';

// PATCH /api/super-admin/pricing/[id] — update / activate / deactivate one
// PlanPricing row (Super Admin only). Audited.
// DELETE — remove an unreferenced pricing row. Blocked if any PurchaseRequest
// references the same (plan, mode, period).

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

  const existing = await db.planPricing.findUnique({ where: { id }, include: { plan: { select: { name: true } } } });
  if (!existing) return apiError('Pricing row not found', 404);

  const data: {
    basePrice?: number;
    currency?: string;
    includedDevices?: number;
    additionalDevicePrice?: number;
    isActive?: boolean;
  } = {};

  if (body.basePrice !== undefined) {
    const n = Number(body.basePrice);
    if (!Number.isFinite(n) || n < 0) return apiError('basePrice must be a non-negative number', 422);
    data.basePrice = n;
  }
  if (body.currency !== undefined) {
    if (typeof body.currency !== 'string' || !body.currency.trim()) return apiError('currency must be a non-empty string', 422);
    data.currency = body.currency.trim().slice(0, 8);
  }
  if (body.includedDevices !== undefined) {
    const n = Number(body.includedDevices);
    if (!Number.isInteger(n) || n < 0) return apiError('includedDevices must be a non-negative integer', 422);
    data.includedDevices = n;
  }
  if (body.additionalDevicePrice !== undefined) {
    const n = Number(body.additionalDevicePrice);
    if (!Number.isFinite(n) || n < 0) return apiError('additionalDevicePrice must be a non-negative number', 422);
    data.additionalDevicePrice = n;
  }
  if (body.isActive !== undefined) {
    data.isActive = body.isActive === true;
  }

  if (Object.keys(data).length === 0) return apiError('No updatable fields provided', 422);

  const row = await db.$transaction(async (tx) => {
    const updated = await tx.planPricing.update({ where: { id }, data });
    await tx.auditLog.create({
      data: {
        action: 'update',
        resource: 'plan_pricing',
        resourceId: id,
        description: `Super admin (${admin.email}) updated pricing for "${existing.plan.name}" (${existing.deploymentMode}/${existing.billingPeriod}): ${JSON.stringify(data)}`,
        userId: admin.userId,
        organizationId: null,
      },
    });
    return updated;
  });

  return apiSuccess(row);
}

// DELETE /api/super-admin/pricing/[id] — delete a PlanPricing row.
// Blocked if any PurchaseRequest references the same (plan, mode, period).
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireDbVerifiedRole(req, { requireSuperAdmin: true });
  if (!admin.ok) return authError(admin);

  const { id } = await params;

  const existing = await db.planPricing.findUnique({
    where: { id },
    include: { plan: { select: { id: true, name: true } } },
  });
  if (!existing) return apiError('Pricing row not found', 404);

  // Check if any PurchaseRequest references this (plan, mode, period).
  const refCount = await db.purchaseRequest.count({
    where: {
      planId: existing.planId,
      deploymentMode: existing.deploymentMode,
      billingPeriod: existing.billingPeriod,
    },
  });
  if (refCount > 0) {
    return apiError(
      `This pricing configuration is referenced by ${refCount} purchase request(s). ` +
      `Deactivate it (isActive=false) instead of deleting to preserve historical records.`,
      409,
    );
  }

  // Prevent deleting the last row for a (plan, deploymentMode) pair.
  // The Landing Page needs at least one row per combo to show "Not configured"
  // or actual pricing. Deletion should never remove the placeholder entirely.
  const sameModeCount = await db.planPricing.count({
    where: {
      planId: existing.planId,
      deploymentMode: existing.deploymentMode,
    },
  });
  if (sameModeCount <= 1) {
    return apiError(
      `Cannot delete the last ${existing.deploymentMode} pricing row for "${existing.plan.name}". ` +
      `Deactivate it (isActive=false) instead — the landing page needs at least one row per deployment mode.`,
      409,
    );
  }

  await db.$transaction(async (tx) => {
    await tx.planPricing.delete({ where: { id } });
    await tx.auditLog.create({
      data: {
        action: 'delete',
        resource: 'plan_pricing',
        resourceId: id,
        description: `Super admin (${admin.email}) deleted pricing for "${existing.plan.name}" (${existing.deploymentMode}/${existing.billingPeriod})`,
        userId: admin.userId,
        organizationId: null,
      },
    });
  });

  return apiSuccess({ deleted: true });
}

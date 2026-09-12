import { NextRequest } from 'next/server';
import { db as prisma } from '@/lib/db';
import { requireSuperAdmin, requireDbVerifiedRole, apiError, apiSuccess, authError, parseJsonBody, BodyParseError } from '@/lib/api';

// GET /api/super-admin/packages/[id] — single package with usage counts.
// PATCH — update (name/prices/limits/features/isActive). Deactivation
// (isActive=false) is the safe archival path; DELETE is blocked while any
// subscription or license references the package.

function parsePlanPatch(body: Record<string, unknown>) {
  const errors: string[] = [];
  const data: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) errors.push('name must be a non-empty string');
    else data.name = name;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string' && body.description !== null) errors.push('description must be a string or null');
    else data.description = body.description;
  }
  for (const key of ['priceMonthly', 'priceYearly', 'maxDevices', 'retentionDays'] as const) {
    if (body[key] !== undefined && body[key] !== null) {
      const n = Number(body[key]);
      if (!Number.isFinite(n) || n < 0 || ((key === 'maxDevices' || key === 'retentionDays') && !Number.isInteger(n))) {
        errors.push(`${key} must be a valid non-negative number`);
      } else data[key] = n;
    }
  }
  if (body.priceYearly === null) data.priceYearly = null;
  if (body.currency !== undefined) {
    if (typeof body.currency !== 'string' || !body.currency) errors.push('currency must be a non-empty string');
    else data.currency = body.currency;
  }
  if (body.features !== undefined) {
    if (!Array.isArray(body.features) || !body.features.every((f) => typeof f === 'string')) errors.push('features must be an array of strings');
    else data.features = body.features;
  }
  // NOTE: `isSelfHosted` is no longer accepted — self-hosted plans were removed
  // with the LicenseKey architecture and are not a V1 service model.
  if (body.isActive !== undefined) data.isActive = body.isActive === true;
  return { errors, data };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireSuperAdmin(req);
  if (!admin.ok) return authError(admin);
  const { id } = await params;

  const plan = await prisma.plan.findUnique({
    where: { id },
    include: { _count: { select: { subscriptions: true } } },
  });
  if (!plan) return apiError('Package not found', 404);
  return apiSuccess({
    ...plan,
    subscriptionCount: plan._count.subscriptions,
    _count: undefined,
  });
}

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

  const { errors, data } = parsePlanPatch(body);
  if (errors.length > 0) return apiError(errors.join('; '), 422);
  if (Object.keys(data).length === 0) return apiError('Nothing to update', 422);

  const existing = await prisma.plan.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!existing) return apiError('Package not found', 404);
  if (typeof data.name === 'string' && data.name !== existing.name) {
    const clash = await prisma.plan.findUnique({ where: { name: data.name }, select: { id: true } });
    if (clash) return apiError('A package with that name already exists', 409);
  }

  const updated = await prisma.plan.update({ where: { id }, data });
  await prisma.auditLog.create({
    data: {
      action: 'update',
      resource: 'package',
      resourceId: id,
      description: `Super admin (${admin.email}) updated package "${existing.name}": ${Object.keys(data).join(', ')}`,
      userId: admin.userId,
      organizationId: null,
    },
  });

  return apiSuccess(updated);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireDbVerifiedRole(req, { requireSuperAdmin: true });
  if (!admin.ok) return authError(admin);
  const { id } = await params;

  const plan = await prisma.plan.findUnique({
    where: { id },
    select: { id: true, name: true, _count: { select: { subscriptions: true } } },
  });
  if (!plan) return apiError('Package not found', 404);

  // Check PurchaseRequest references (historical commercial records).
  const purchaseRequestCount = await prisma.purchaseRequest.count({ where: { planId: id } });

  const reasons: string[] = [];
  if (plan._count.subscriptions > 0) reasons.push(`${plan._count.subscriptions} subscription(s)`);
  if (purchaseRequestCount > 0) reasons.push(`${purchaseRequestCount} purchase request(s)`);

  if (reasons.length > 0) {
    return apiError(
      `Plan "${plan.name}" cannot be deleted — it is referenced by ${reasons.join(', ')}. ` +
      `Deactivate it (isActive=false) instead to preserve historical records.`,
      409,
    );
  }

  await prisma.plan.delete({ where: { id } });
  await prisma.auditLog.create({
    data: {
      action: 'delete',
      resource: 'package',
      resourceId: id,
      description: `Super admin (${admin.email}) deleted unreferenced plan "${plan.name}"`,
      userId: admin.userId,
      organizationId: null,
    },
  });

  return apiSuccess({ deleted: true });
}

import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin, requireDbVerifiedRole, apiError, apiSuccess, authError, parseJsonBody, BodyParseError } from '@/lib/api';
import { isPricingMode, isPricingPeriod } from '@/lib/pricing';
import { log, requestContext } from '@/lib/logger';

// Super Admin commercial pricing configuration (V1).
//
// PlanPricing is control-plane data: plan × deploymentMode × billingPeriod →
// base price + device entitlement terms. Both MANAGED and CUSTOMER_DB
// require includedDevices + additionalDevicePrice. There are no "unlimited
// devices" in the V1 commercial model.

function validateBody(body: Record<string, unknown>) {
  const errors: string[] = [];
  const planId = typeof body.planId === 'string' ? body.planId : '';
  if (!planId) errors.push('planId is required');

  const deploymentMode = body.deploymentMode;
  if (!isPricingMode(deploymentMode)) errors.push("deploymentMode must be 'MANAGED' or 'CUSTOMER_DB'");

  const billingPeriod = body.billingPeriod;
  if (!isPricingPeriod(billingPeriod)) errors.push("billingPeriod must be 'MONTHLY' or 'YEARLY'");

  const basePrice = Number(body.basePrice);
  if (!Number.isFinite(basePrice) || basePrice < 0) errors.push('basePrice must be a non-negative number');

  const currency = typeof body.currency === 'string' && body.currency.trim() ? body.currency.trim().slice(0, 8) : 'BDT';

  const includedDevices = body.includedDevices === undefined || body.includedDevices === null ? null : Number(body.includedDevices);
  if (includedDevices === null || !Number.isInteger(includedDevices) || includedDevices < 0) {
    errors.push('includedDevices is required and must be a non-negative integer for both MANAGED and CUSTOMER_DB');
  }
  const additionalDevicePrice = body.additionalDevicePrice === undefined || body.additionalDevicePrice === null ? 0 : Number(body.additionalDevicePrice);
  if (!Number.isFinite(additionalDevicePrice) || additionalDevicePrice < 0) {
    errors.push('additionalDevicePrice must be a non-negative number');
  }

  return {
    errors,
    data: {
      planId,
      deploymentMode: deploymentMode as 'MANAGED' | 'CUSTOMER_DB',
      billingPeriod: billingPeriod as 'MONTHLY' | 'YEARLY',
      basePrice,
      currency,
      includedDevices,
      additionalDevicePrice,
      isActive: body.isActive === undefined ? true : body.isActive === true,
    },
  };
}

// GET /api/super-admin/pricing — full pricing matrix (all plans, incl. inactive).
export async function GET(req: NextRequest) {
  const admin = await requireSuperAdmin(req);
  if (!admin.ok) return authError(admin);

  const rows = await db.planPricing.findMany({
    include: { plan: { select: { id: true, name: true, isActive: true } } },
    orderBy: [{ planId: 'asc' }, { deploymentMode: 'asc' }, { billingPeriod: 'asc' }],
  });

  return apiSuccess({ data: rows });
}

// POST /api/super-admin/pricing — upsert one (plan, mode, period) price.
export async function POST(req: NextRequest) {
  const admin = await requireDbVerifiedRole(req, { requireSuperAdmin: true });
  if (!admin.ok) return authError(admin);

  let body: Record<string, unknown>;
  try {
    body = await parseJsonBody(req);
  } catch (e) {
    if (e instanceof BodyParseError) return apiError('Invalid request body', 400);
    return apiError('Invalid request body', 400);
  }

  const { errors, data } = validateBody(body);
  if (errors.length > 0) return apiError(errors.join('; '), 422);

  const plan = await db.plan.findUnique({ where: { id: data.planId }, select: { id: true, name: true } });
  if (!plan) return apiError('Plan not found', 404);

  const includedDevices = data.includedDevices ?? 0;
  const additionalDevicePrice = data.additionalDevicePrice ?? 0;

  const row = await db.planPricing.upsert({
    where: {
      planId_deploymentMode_billingPeriod: {
        planId: data.planId,
        deploymentMode: data.deploymentMode,
        billingPeriod: data.billingPeriod,
      },
    },
    update: {
      basePrice: data.basePrice,
      currency: data.currency,
      includedDevices,
      additionalDevicePrice: data.additionalDevicePrice,
      isActive: data.isActive,
    },
    create: {
      planId: data.planId,
      deploymentMode: data.deploymentMode,
      billingPeriod: data.billingPeriod,
      basePrice: data.basePrice,
      currency: data.currency,
      includedDevices,
      additionalDevicePrice: data.additionalDevicePrice,
      isActive: data.isActive,
    },
  });

  await db.auditLog.create({
    data: {
      action: 'create',
      resource: 'plan_pricing',
      resourceId: row.id,
      description: `Super admin (${admin.email}) configured ${data.billingPeriod} pricing for "${plan.name}" (${data.deploymentMode}): ${data.currency} ${data.basePrice}, included ${includedDevices} devices @ ${additionalDevicePrice}/extra`,
      userId: admin.userId,
      organizationId: null,
    },
  });

  log.info('api.super-admin.pricing.upsert', { pricingId: row.id, planId: data.planId }, requestContext(req));
  return apiSuccess(row, 201);
}

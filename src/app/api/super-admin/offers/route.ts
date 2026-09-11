import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin, requireDbVerifiedRole, apiError, apiSuccess, authError, parseJsonBody, BodyParseError, validatePagination } from '@/lib/api';
import { isPricingMode, isPricingPeriod } from '@/lib/pricing';
import { log, requestContext } from '@/lib/logger';

// Super Admin Offer/Promotion configuration (V1).
//
// Discount types: PERCENTAGE (0-100) | FIXED (absolute amount). isFree marks
// a free offer/trial (final price 0). Scoping: optional plan, deploymentMode,
// billingPeriod, or a specific PlanPricing row; null scope = applies to all.
// The pricing resolver applies AT MOST ONE offer deterministically (largest
// effective discount wins, ties by earliest createdAt then id) — multiple
// offers can never stack into ambiguous pricing.

function validateBody(body: Record<string, unknown>) {
  const errors: string[] = [];
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) errors.push('name is required');

  const discountType = body.discountType;
  if (discountType !== 'PERCENTAGE' && discountType !== 'FIXED') {
    errors.push("discountType must be 'PERCENTAGE' or 'FIXED'");
  }
  const discountValue = Number(body.discountValue);
  if (!Number.isFinite(discountValue) || discountValue < 0) {
    errors.push('discountValue must be a non-negative number');
  } else if (discountType === 'PERCENTAGE' && discountValue > 100) {
    errors.push('percentage discountValue must be 0-100');
  }

  const isFree = body.isFree === true;
  let freeTrialDays: number | null = null;
  if (body.freeTrialDays !== undefined && body.freeTrialDays !== null) {
    const n = Number(body.freeTrialDays);
    if (!Number.isInteger(n) || n < 0) errors.push('freeTrialDays must be a non-negative integer');
    else freeTrialDays = n;
  }

  const startsAt = body.startsAt ? new Date(String(body.startsAt)) : null;
  if (body.startsAt && Number.isNaN(startsAt!.getTime())) errors.push('startsAt must be a valid date');
  const endsAt = body.endsAt ? new Date(String(body.endsAt)) : null;
  if (body.endsAt && Number.isNaN(endsAt!.getTime())) errors.push('endsAt must be a valid date');
  if (startsAt && endsAt && startsAt >= endsAt) errors.push('endsAt must be after startsAt');

  const planId = typeof body.planId === 'string' && body.planId ? body.planId : null;
  const deploymentMode = body.deploymentMode === null || body.deploymentMode === undefined || body.deploymentMode === ''
    ? null
    : body.deploymentMode;
  if (deploymentMode !== null && !isPricingMode(deploymentMode)) {
    errors.push("deploymentMode scope must be 'MANAGED' or 'CUSTOMER_DB'");
  }
  const billingPeriod = body.billingPeriod === null || body.billingPeriod === undefined || body.billingPeriod === ''
    ? null
    : body.billingPeriod;
  if (billingPeriod !== null && !isPricingPeriod(billingPeriod)) {
    errors.push("billingPeriod scope must be 'MONTHLY' or 'YEARLY'");
  }

  return {
    errors,
    data: {
      name: name.slice(0, 200),
      description: typeof body.description === 'string' ? body.description.trim().slice(0, 1000) || null : null,
      isActive: body.isActive === undefined ? true : body.isActive === true,
      discountType: discountType as 'PERCENTAGE' | 'FIXED',
      discountValue,
      isFree,
      freeTrialDays,
      currency: typeof body.currency === 'string' && body.currency.trim() ? body.currency.trim().slice(0, 8) : 'BDT',
      startsAt,
      endsAt,
      planId,
      deploymentMode: deploymentMode as 'MANAGED' | 'CUSTOMER_DB' | null,
      billingPeriod: billingPeriod as 'MONTHLY' | 'YEARLY' | null,
    },
  };
}

// GET /api/super-admin/offers — full offer list (incl. inactive).
export async function GET(req: NextRequest) {
  const admin = await requireSuperAdmin(req);
  if (!admin.ok) return authError(admin);

  const { searchParams } = new URL(req.url);
  const pagination = validatePagination(searchParams, { defaultPageSize: 50, maxPageSize: 200 });
  if (!pagination.ok) return apiError(pagination.error, pagination.status);
  const includeInactive = searchParams.get('includeInactive') !== 'false';

  const where = includeInactive ? {} : { isActive: true };
  const [offers, total] = await Promise.all([
    db.offer.findMany({
      where,
      include: { plan: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      skip: pagination.skip,
      take: pagination.pageSize,
    }),
    db.offer.count({ where }),
  ]);

  return apiSuccess({
    data: offers,
    pagination: { page: pagination.page, pageSize: pagination.pageSize, total, pages: Math.ceil(total / pagination.pageSize) },
  });
}

// POST /api/super-admin/offers — create an offer.
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

  if (data.planId) {
    const plan = await db.plan.findUnique({ where: { id: data.planId }, select: { id: true } });
    if (!plan) return apiError('Scoped plan not found', 404);
  }

  const offer = await db.offer.create({ data });
  await db.auditLog.create({
    data: {
      action: 'create',
      resource: 'offer',
      resourceId: offer.id,
      description: `Super admin (${admin.email}) created offer "${offer.name}" (${offer.discountType} ${offer.discountValue}${offer.isFree ? ', free/trial' : ''})`,
      userId: admin.userId,
      organizationId: null,
    },
  });

  log.info('api.super-admin.offers.create', { offerId: offer.id }, requestContext(req));
  return apiSuccess(offer, 201);
}

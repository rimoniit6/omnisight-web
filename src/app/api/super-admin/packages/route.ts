import { NextRequest } from 'next/server';
import { db as prisma } from '@/lib/db';
import { requireSuperAdmin, requireDbVerifiedRole, apiError, apiSuccess, authError, parseJsonBody, BodyParseError, validatePagination } from '@/lib/api';

// Packages are the database-driven Plan catalog (Phase 2 §12-13). Prices,
// limits and feature flags are NEVER hardcoded in components — the pricing,
// checkout and billing UIs read GET /api/plans. Super Admin manages the
// catalog here; deletion is blocked while history references a package
// (deactivate instead — active=false archival semantics).

function parsePlanBody(body: Record<string, unknown>) {
  const errors: string[] = [];
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) errors.push('name is required');
  const priceMonthly = body.priceMonthly === undefined ? 0 : Number(body.priceMonthly);
  if (!Number.isFinite(priceMonthly) || priceMonthly < 0) errors.push('priceMonthly must be a non-negative number');
  const priceYearly = body.priceYearly === undefined || body.priceYearly === null ? null : Number(body.priceYearly);
  if (priceYearly !== null && (!Number.isFinite(priceYearly) || priceYearly < 0)) errors.push('priceYearly must be a non-negative number or null');
  const maxDevices = body.maxDevices === undefined ? 5 : Number(body.maxDevices);
  if (!Number.isInteger(maxDevices)) errors.push('maxDevices must be an integer (0 or -1 = unlimited)');
  const retentionDays = body.retentionDays === undefined ? 90 : Number(body.retentionDays);
  if (!Number.isInteger(retentionDays) || retentionDays < 0) errors.push('retentionDays must be an integer >= 0 (0 = unlimited)');
  const features: string[] = body.features === undefined ? [] : (body.features as string[]);
  if (!Array.isArray(features) || !features.every((f) => typeof f === 'string')) errors.push('features must be an array of strings');
  return {
    errors,
    data: {
      name,
      description: typeof body.description === 'string' ? body.description : null,
      priceMonthly,
      priceYearly,
      currency: typeof body.currency === 'string' && body.currency ? body.currency : 'BDT',
      maxDevices,
      retentionDays,
      isSelfHosted: body.isSelfHosted === true,
      features,
      isActive: body.isActive === undefined ? true : body.isActive === true,
    },
  };
}

/**
 * GET /api/super-admin/packages — full catalog incl. inactive (Super Admin only).
 */
export async function GET(req: NextRequest) {
  const admin = await requireSuperAdmin(req);
  if (!admin.ok) return authError(admin);

  const { searchParams } = new URL(req.url);
  const pagination = validatePagination(searchParams, { defaultPageSize: 50, maxPageSize: 200 });
  if (!pagination.ok) return apiError(pagination.error, pagination.status);
  const includeInactive = searchParams.get('includeInactive') === 'true';

  const where = includeInactive ? {} : { isActive: true };
  const [plans, total] = await Promise.all([
    prisma.plan.findMany({
      where,
      include: { _count: { select: { subscriptions: true, licenseKeys: true } } },
      orderBy: { priceMonthly: 'asc' },
      skip: pagination.skip,
      take: pagination.pageSize,
    }),
    prisma.plan.count({ where }),
  ]);

  return apiSuccess({
    data: plans.map((p) => ({
      ...p,
      subscriptionCount: p._count.subscriptions,
      licenseKeyCount: p._count.licenseKeys,
      _count: undefined,
    })),
    pagination: { page: pagination.page, pageSize: pagination.pageSize, total, pages: Math.ceil(total / pagination.pageSize) },
  });
}

/**
 * POST /api/super-admin/packages — create a package (DB-verified Super Admin).
 */
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

  const { errors, data } = parsePlanBody(body);
  if (errors.length > 0) return apiError(errors.join('; '), 422);

  const existing = await prisma.plan.findUnique({ where: { name: data.name }, select: { id: true } });
  if (existing) return apiError('A package with that name already exists', 409);

  const plan = await prisma.plan.create({ data });
  await prisma.auditLog.create({
    data: {
      action: 'create',
      resource: 'package',
      resourceId: plan.id,
      description: `Super admin (${admin.email}) created package "${plan.name}"`,
      userId: admin.userId,
      organizationId: null,
    },
  });

  return apiSuccess(plan, 201);
}

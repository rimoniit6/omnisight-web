import { NextRequest } from 'next/server';
import { db as prisma } from '@/lib/db';
import { requireSuperAdmin, requireDbVerifiedRole, apiError, apiSuccess, authError, parseJsonBody, BodyParseError, validatePagination } from '@/lib/api';

// GET /api/super-admin/subscriptions — cross-org subscription list (control plane).
export async function GET(req: NextRequest) {
  const admin = await requireSuperAdmin(req);
  if (!admin.ok) return authError(admin);

  const { searchParams } = new URL(req.url);
  const pagination = validatePagination(searchParams, { defaultPageSize: 50, maxPageSize: 200 });
  if (!pagination.ok) return apiError(pagination.error, pagination.status);
  const status = searchParams.get('status') || '';
  const organizationId = searchParams.get('organizationId') || '';

  const where: Record<string, unknown> = {};
  if (status && ['PENDING', 'ACTIVE', 'EXPIRED', 'CANCELLED'].includes(status)) where.status = status;
  if (organizationId) where.organizationId = organizationId;

  const [subs, total] = await Promise.all([
    prisma.subscription.findMany({
      where,
      include: {
        plan: { select: { id: true, name: true, priceMonthly: true, currency: true } },
        organization: { select: { id: true, name: true, slug: true, status: true, deploymentMode: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: pagination.skip,
      take: pagination.pageSize,
    }),
    prisma.subscription.count({ where }),
  ]);

  return apiSuccess({
    data: subs,
    pagination: { page: pagination.page, pageSize: pagination.pageSize, total, pages: Math.ceil(total / pagination.pageSize) },
  });
}

// POST /api/super-admin/subscriptions — create a subscription directly
// (manual sales: SA assigns a package outside the org self-serve flow).
// Body: { organizationId, planId, status?: 'PENDING'|'ACTIVE', startDate?, endDate?, notes? }
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

  const organizationId = typeof body.organizationId === 'string' ? body.organizationId : '';
  const planId = typeof body.planId === 'string' ? body.planId : '';
  const status = typeof body.status === 'string' ? body.status : 'PENDING';
  if (!organizationId || !planId) return apiError('organizationId and planId are required', 422);
  if (!['PENDING', 'ACTIVE'].includes(status)) return apiError('status must be PENDING or ACTIVE', 422);

  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true, name: true, status: true } });
  if (!org) return apiError('Organization not found', 404);
  const plan = await prisma.plan.findUnique({ where: { id: planId }, select: { id: true, name: true, isActive: true } });
  if (!plan) return apiError('Package not found', 404);
  if (!plan.isActive) return apiError('Package is deactivated', 422);

  const startDate = body.startDate ? new Date(String(body.startDate)) : new Date();
  if (Number.isNaN(startDate.getTime())) return apiError('startDate must be a valid date', 422);
  let endDate: Date | null = null;
  if (body.endDate !== undefined && body.endDate !== null && body.endDate !== '') {
    endDate = new Date(String(body.endDate));
    if (Number.isNaN(endDate.getTime())) return apiError('endDate must be a valid date', 422);
  }

  const sub = await prisma.$transaction(async (tx) => {
    const created = await tx.subscription.create({
      data: {
        organizationId,
        planId,
        status: status as 'PENDING' | 'ACTIVE',
        startDate,
        endDate,
        notes: typeof body.notes === 'string' ? body.notes : null,
      },
    });
    if (status === 'ACTIVE') {
      await tx.organization.update({
        where: { id: organizationId },
        data: { subscriptionId: created.id, status: 'active', trialEndsAt: null },
      });
    }
    await tx.auditLog.create({
      data: {
        action: 'create',
        resource: 'subscription',
        resourceId: created.id,
        description: `Super admin (${admin.email}) created ${status} subscription for org "${org.name}" (package ${plan.name})`,
        userId: admin.userId,
        organizationId,
      },
    });
    return created;
  });

  return apiSuccess(sub, 201);
}

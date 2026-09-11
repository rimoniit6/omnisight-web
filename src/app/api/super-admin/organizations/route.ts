import { NextRequest } from 'next/server';
import { db as prisma } from '@/lib/db';
import { requireSuperAdmin, requireDbVerifiedRole, apiError, apiSuccess, authError, parseJsonBody, BodyParseError } from '@/lib/api';

/**
 * GET /api/super-admin/organizations
 *
 * List organizations with server-side search, pagination, and status filter.
 * Super Admin only.
 *
 * Query params:
 *   ?search=         — search by name or slug (case-insensitive)
 *   ?status=         — filter by status (active, pending, paused, archived)
 *   ?deploymentMode= — filter by mode (MANAGED, CUSTOMER_DB, PRIVATE)
 *   ?page=           — page number (default: 1)
 *   ?pageSize=       — results per page (default: 20, max: 200)
 *
 * Control-plane listing: identity + mode + package/subscription/license
 * metadata for ALL modes. No operational data is returned here.
 */
export async function GET(req: NextRequest) {
  const adminResult = await requireSuperAdmin(req);
  if (!adminResult.ok) return authError(adminResult);

  const url = new URL(req.url);
  const search = url.searchParams.get('search') || '';
  const status = url.searchParams.get('status') || '';
  const deploymentMode = url.searchParams.get('deploymentMode') || '';
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const pageSize = Math.min(200, Math.max(1, parseInt(url.searchParams.get('pageSize') || '20', 10)));
  const skip = (page - 1) * pageSize;

  // Build where clause
  const where: Record<string, unknown> = {};
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { slug: { contains: search, mode: 'insensitive' } },
    ];
  }
  if (status && ['active', 'pending', 'paused', 'archived'].includes(status)) {
    where.status = status;
  }
  if (deploymentMode && ['MANAGED', 'CUSTOMER_DB', 'PRIVATE'].includes(deploymentMode)) {
    where.deploymentMode = deploymentMode;
  }

  const [organizations, total] = await Promise.all([
    prisma.organization.findMany({
      where,
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        deploymentMode: true,
        deploymentModeUnresolved: true,
        trialEndsAt: true,
        activeDeviceCount: true,
        createdAt: true,
        updatedAt: true,
        subscription: {
          select: {
            id: true,
            status: true,
            startDate: true,
            endDate: true,
            billingPeriod: true,
            deviceQuantity: true,
            plan: { select: { id: true, name: true, priceMonthly: true, currency: true, maxDevices: true } },
            planId: true,
            // Manual-payment ledger — newest invoice only (list view).
            invoices: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { id: true, status: true, amount: true, currency: true, paymentMethod: true, paidAt: true },
            },
          },
        },
        licenseKey: {
          select: { id: true, isActive: true, isRevoked: true, validUntil: true },
        },
        _count: {
          select: {
            employees: true,
            devices: true,
            memberships: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.organization.count({ where }),
  ]);

  // Enrich with device entitlement + outstanding dues per org.
  const enriched = await Promise.all(organizations.map(async (o) => {
    const deviceCount = o.activeDeviceCount;

    // Resolve included devices from subscription → PlanPricing → Plan.maxDevices.
    let includedDevices = o.subscription?.plan.maxDevices ?? 0;
    if (o.subscription?.id && o.subscription.billingPeriod) {
      const pricing = await prisma.planPricing.findUnique({
        where: {
          planId_deploymentMode_billingPeriod: {
            planId: o.subscription.planId,
            deploymentMode: o.deploymentMode,
            billingPeriod: o.subscription.billingPeriod as 'MONTHLY' | 'YEARLY',
          },
        },
        select: { includedDevices: true, additionalDevicePrice: true },
      });
      if (pricing) {
        includedDevices = pricing.includedDevices;
      }
    }

    const extraDevices = Math.max(0, deviceCount - includedDevices);

    // Outstanding dues from unpaid invoices.
    const unpaidInvoices = await prisma.invoice.findMany({
      where: { organizationId: o.id, status: { in: ['PENDING', 'OVERDUE'] } },
      select: { amount: true, currency: true },
    });
    const outstandingAmount = unpaidInvoices.reduce((sum, inv) => sum + inv.amount, 0);
    const outstandingCurrency = unpaidInvoices[0]?.currency ?? o.subscription?.plan.currency ?? 'BDT';

    // Days remaining.
    const daysRemaining = o.subscription?.endDate
      ? Math.max(0, Math.ceil((o.subscription.endDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
      : null;

    return {
      ...o,
      memberCount: o._count.memberships,
      employeeCount: o._count.employees,
      deviceCount,
      includedDevices,
      extraDevices,
      outstandingAmount,
      outstandingCurrency,
      daysRemaining,
      _count: undefined,
    };
  }));

  return apiSuccess({
    data: enriched,
    pagination: {
      page,
      pageSize,
      total,
      pages: Math.ceil(total / pageSize),
    },
  });
}

/**
 * POST /api/super-admin/organizations
 *
 * Create a new organization. Super Admin only.
 * Body: { name: string, slug?: string, email?: string, timezone?: string }
 */
export async function POST(req: NextRequest) {
  // P2/P3 #11: DB-verified role for org creation (privileged mutation).
  const adminResult = await requireDbVerifiedRole(req, { requireSuperAdmin: true });
  if (!adminResult.ok) return authError(adminResult);
  const admin = adminResult;

  let body: Record<string, unknown>;
  try {
    body = await parseJsonBody(req);
  } catch (e) {
    if (e instanceof BodyParseError) return apiError('Invalid request body', 400);
    return apiError('Invalid request body', 400);
  }

  const name = body.name as string | undefined;
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return apiError('Organization name is required (min 2 characters)', 422);
  }

  // Generate slug from name if not provided
  const slug = (body.slug as string || name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  // Check slug uniqueness
  const existing = await prisma.organization.findUnique({ where: { slug } });
  if (existing) {
    return apiError('An organization with that slug already exists', 409);
  }

  const organization = await prisma.organization.create({
    data: {
      name: name.trim(),
      slug,
      email: (body.email as string) || null,
      timezone: (body.timezone as string) || 'Asia/Dhaka',
      status: 'active',
    },
    select: { id: true, name: true, slug: true, status: true, createdAt: true },
  });

  // P1-01: Super Admin uses platform-level authority, NOT per-org membership.
  // Do NOT create an OrganizationMembership for the Super Admin — they manage
  // organizations through requireSuperAdmin() / requireDbVerifiedRole(), not
  // through org-scoped membership. This prevents ambiguity between
  // platform-level authority and organization membership.

  // Audit log
  await prisma.auditLog.create({
    data: {
      action: 'create',
      resource: 'organization',
      resourceId: organization.id,
      description: `Organization "${organization.name}" created`,
      userId: admin.userId,
      organizationId: organization.id,
    },
  });

  return apiSuccess(organization, 201);
}

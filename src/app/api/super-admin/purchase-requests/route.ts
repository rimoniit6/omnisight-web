import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin, apiError, apiSuccess, authError, validatePagination } from '@/lib/api';

// GET /api/super-admin/purchase-requests — Super Admin review queue (V1).
// Lists purchase requests newest-first with plan, offer, and snapshot data.
// Status lifecycle: SUBMITTED → REVIEWED → PAYMENT_VERIFIED → ACTIVATED
// (+ REJECTED / CANCELLED). Actions live on /[id] (PATCH).

const STATUSES = ['SUBMITTED', 'REVIEWED', 'PAYMENT_VERIFIED', 'ACTIVATED', 'REJECTED', 'CANCELLED'] as const;

export async function GET(req: NextRequest) {
  const admin = await requireSuperAdmin(req);
  if (!admin.ok) return authError(admin);

  const { searchParams } = new URL(req.url);
  const pagination = validatePagination(searchParams, { defaultPageSize: 50, maxPageSize: 200 });
  if (!pagination.ok) return apiError(pagination.error, pagination.status);

  const status = searchParams.get('status') || '';
  if (status && !(STATUSES as readonly string[]).includes(status)) {
    return apiError(`status must be one of: ${STATUSES.join(', ')}`, 422);
  }

  const where = status ? { status } : {};
  const [requests, total] = await Promise.all([
    db.purchaseRequest.findMany({
      where,
      include: {
        plan: { select: { id: true, name: true } },
        offer: { select: { id: true, name: true } },
        // Linked commercial record after activation (§9: the queue must show
        // the activation state — organization + subscription it produced).
        activatedSubscription: {
          select: {
            id: true,
            status: true,
            organization: { select: { id: true, name: true, slug: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: pagination.skip,
      take: pagination.pageSize,
    }),
    db.purchaseRequest.count({ where }),
  ]);

  return apiSuccess({
    data: requests,
    pagination: { page: pagination.page, pageSize: pagination.pageSize, total, pages: Math.ceil(total / pagination.pageSize) },
  });
}

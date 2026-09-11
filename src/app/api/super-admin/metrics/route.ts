import { NextRequest } from 'next/server';
import { db as prisma } from '@/lib/db';
import { requireSuperAdmin, apiSuccess, authError } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

// GET /api/super-admin/metrics — control-plane dashboard metrics (Phase 2 §27).
// Aggregate metadata ONLY: organization counts by mode/status, subscription
// states, license states, pending deployments. NEVER cross-customer
// data-plane metrics (no screenshots/keystrokes/activity totals).
export async function GET(req: NextRequest) {
  const admin = await requireSuperAdmin(req);
  if (!admin.ok) return authError(admin);

  try {
    const now = new Date();
    const expiringSoon = new Date(now.getTime() + 30 * 86_400_000);

    const [
      orgsByMode,
      orgsByStatus,
      unresolvedModes,
      subsByStatus,
      expiringSubs,
      activeLicenses,
      pendingInvoices,
    ] = await Promise.all([
      prisma.organization.groupBy({ by: ['deploymentMode'], _count: { id: true } }),
      prisma.organization.groupBy({ by: ['status'], _count: { id: true } }),
      prisma.organization.count({ where: { deploymentModeUnresolved: true } }),
      prisma.subscription.groupBy({ by: ['status'], _count: { id: true } }),
      prisma.subscription.count({
        where: { status: 'ACTIVE', endDate: { gt: now, lte: expiringSoon } },
      }),
      prisma.licenseKey.count({ where: { isActive: true, isRevoked: false, validUntil: { gt: now } } }),
      prisma.invoice.count({ where: { status: { in: ['PENDING', 'OVERDUE'] } } }),
    ]);

    const byMode: Record<string, number> = {};
    for (const row of orgsByMode) byMode[row.deploymentMode] = row._count.id;
    const byStatus: Record<string, number> = {};
    for (const row of orgsByStatus) byStatus[row.status] = row._count.id;
    const subs: Record<string, number> = {};
    for (const row of subsByStatus) subs[row.status] = row._count.id;

    const totalOrgs = Object.values(byMode).reduce((a, b) => a + b, 0);

    return apiSuccess({
      organizations: {
        total: totalOrgs,
        managed: byMode.MANAGED ?? 0,
        customerDb: byMode.CUSTOMER_DB ?? 0,
        private: byMode.PRIVATE ?? 0,
        byStatus,
        unresolvedModes,
        // Pending deployments: customer-owned orgs whose mode needs review.
        pendingDeployments: (byMode.CUSTOMER_DB ?? 0) + (byMode.PRIVATE ?? 0) + unresolvedModes,
      },
      subscriptions: {
        byStatus: subs,
        active: subs.ACTIVE ?? 0,
        expiringSoon: expiringSubs,
        paused: byStatus.paused ?? 0,
      },
      licenses: { active: activeLicenses },
      billing: { pendingInvoices },
    });
  } catch (error) {
    log.error('api.super-admin.metrics.get', { error: String(error) }, requestContext(req));
    return apiSuccess({
      organizations: { total: 0, managed: 0, customerDb: 0, private: 0, byStatus: {}, unresolvedModes: 0, pendingDeployments: 0 },
      subscriptions: { byStatus: {}, active: 0, expiringSoon: 0, paused: 0 },
      licenses: { active: 0 },
      billing: { pendingInvoices: 0 },
    });
  }
}

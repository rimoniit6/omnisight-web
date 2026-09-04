import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin, apiError } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

// GET /api/admin/invoices
// Super Admin: list all invoices (optionally filtered by status), newest first.
export async function GET(req: NextRequest) {
  try {
    const admin = await requireSuperAdmin(req);
    if (!admin.ok) return apiError(admin.status === 401 ? 'Unauthorized' : 'Super admin access required', admin.status);

    const statusFilter = req.nextUrl.searchParams.get('status');
    const statuses = ['PENDING', 'PAID', 'OVERDUE', 'CANCELLED'];
    const status = statusFilter && statuses.includes(statusFilter.toUpperCase()) ? statusFilter.toUpperCase() : undefined;

    const invoices = await db.invoice.findMany({
      where: status ? { status: status as 'PENDING' | 'PAID' | 'OVERDUE' | 'CANCELLED' } : {},
      include: {
        organization: { select: { id: true, name: true, email: true } },
        subscription: { include: { plan: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return NextResponse.json({
      invoices: invoices.map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        amount: inv.amount,
        currency: inv.currency,
        status: inv.status,
        dueDate: inv.dueDate.toISOString(),
        paidAt: inv.paidAt ? inv.paidAt.toISOString() : null,
        paymentMethod: inv.paymentMethod,
        transactionId: inv.transactionId,
        notes: inv.notes,
        createdAt: inv.createdAt.toISOString(),
        organization: {
          id: inv.organization.id,
          name: inv.organization.name,
          email: inv.organization.email,
        },
        planName: inv.subscription?.plan?.name ?? null,
      })),
    });
  } catch (error) {
    log.error('api.admin.invoices.get', { error: String(error) }, requestContext(req));
    return apiError('Failed to fetch invoices', 500);
  }
}

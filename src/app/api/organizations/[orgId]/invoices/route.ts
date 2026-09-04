import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireActiveSessionOrg, apiError } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

// GET /api/organizations/[orgId]/invoices
// List the org's invoices, newest first. Org-bound session required.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const { orgId } = await params;

    const session = await requireActiveSessionOrg(req, { allowGlobal: true });
    if (!session.ok) {
      return apiError(session.status === 401 ? 'Unauthorized. Please sign in.' : 'Insufficient permissions', session.status);
    }
    if (session.organizationId !== null && session.organizationId !== orgId) {
      return apiError('Forbidden', 403);
    }

    const invoices = await db.invoice.findMany({
      where: { organizationId: orgId },
      include: {
        subscription: { include: { plan: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json({
      invoices: invoices.map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        amount: inv.amount,
        currency: inv.currency,
        status: inv.status,
        dueDate: inv.dueDate ? inv.dueDate.toISOString() : null,
        paidAt: inv.paidAt ? inv.paidAt.toISOString() : null,
        paymentMethod: inv.paymentMethod,
        transactionId: inv.transactionId,
        notes: inv.notes,
        planName: inv.subscription?.plan?.name ?? null,
        createdAt: inv.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    log.error('api.org.invoices.get', { error: String(error) }, requestContext(req));
    return apiError('Failed to fetch invoices', 500);
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireActiveSessionOrg, apiError } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

// GET /api/invoices/[invoiceId]
// Fetch a single invoice with its subscription/plan. Accessible to any
// authenticated member of the owning org (or super_admin).
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> }
) {
  try {
    const { invoiceId } = await params;

    const session = await requireActiveSessionOrg(req, { allowGlobal: true });
    if (!session.ok) {
      return apiError(session.status === 401 ? 'Unauthorized. Please sign in.' : 'Insufficient permissions', session.status);
    }

    const invoice = await db.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        subscription: {
          include: { plan: true },
        },
        organization: { select: { id: true, name: true } },
      },
    });

    if (!invoice) return apiError('Invoice not found', 404);

    // Org-bound members may only see their own org's invoices. Global
    // super_admin (null orgId) may see anything.
    if (session.organizationId !== null && session.organizationId !== invoice.organizationId) {
      return apiError('Forbidden', 403);
    }

    return NextResponse.json({
      invoice: {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        amount: invoice.amount,
        currency: invoice.currency,
        status: invoice.status,
        dueDate: invoice.dueDate.toISOString(),
        paidAt: invoice.paidAt ? invoice.paidAt.toISOString() : null,
        paymentMethod: invoice.paymentMethod,
        transactionId: invoice.transactionId,
        notes: invoice.notes,
        createdAt: invoice.createdAt.toISOString(),
        organization: {
          id: invoice.organization.id,
          name: invoice.organization.name,
        },
        subscription: {
          id: invoice.subscription.id,
          status: invoice.subscription.status,
          startDate: invoice.subscription.startDate.toISOString(),
          endDate: invoice.subscription.endDate ? invoice.subscription.endDate.toISOString() : null,
        },
        plan: invoice.subscription.plan
          ? {
              id: invoice.subscription.plan.id,
              name: invoice.subscription.plan.name,
              description: invoice.subscription.plan.description,
            }
          : null,
      },
    });
  } catch (error) {
    log.error('api.invoice.get', { error: String(error) }, requestContext(req));
    return apiError('Failed to fetch invoice', 500);
  }
}

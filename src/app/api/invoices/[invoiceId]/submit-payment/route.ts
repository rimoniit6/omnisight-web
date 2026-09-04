import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireActiveSessionOrg, apiError } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

export const PAYMENT_METHODS = ['Bank_Transfer', 'bKash', 'Nagad', 'Rocket'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

// POST /api/invoices/[invoiceId]/submit-payment
// Submit manual payment details (payment method + transaction reference).
// No file upload — transactionId doubles as the reference for manual
// verification. Keeps invoice PENDING until an admin verifies payment.
// Any member of the owning org may submit (payment is non-privileged).
export async function POST(
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
      select: { id: true, organizationId: true, status: true },
    });
    if (!invoice) return apiError('Invoice not found', 404);

    if (session.organizationId !== null && session.organizationId !== invoice.organizationId) {
      return apiError('Forbidden', 403);
    }

    if (invoice.status === 'PAID') {
      return NextResponse.json({ error: 'This invoice is already paid', code: 'ALREADY_PAID' }, { status: 409 });
    }
    if (invoice.status === 'CANCELLED') {
      return apiError('This invoice was cancelled', 400);
    }

    const body = (await req.json().catch(() => ({}))) as {
      paymentMethod?: unknown;
      transactionId?: unknown;
      notes?: unknown;
    };

    const paymentMethod = body.paymentMethod;
    if (typeof paymentMethod !== 'string' || !(PAYMENT_METHODS as readonly string[]).includes(paymentMethod)) {
      return apiError(`paymentMethod must be one of: ${PAYMENT_METHODS.join(', ')}`, 400);
    }
    const transactionId = typeof body.transactionId === 'string' ? body.transactionId.trim() : '';
    if (!transactionId) return apiError('transactionId (transaction reference) is required', 400);
    const notes = typeof body.notes === 'string' ? body.notes.trim() : '';

    // Phase 2 §21: audit the payment submission (was missing). Only the
    // method + reference are recorded — never secrets (none are collected).
    const updated = await db.$transaction(async (tx) => {
      const u = await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          paymentMethod: paymentMethod as PaymentMethod,
          transactionId,
          notes: notes || undefined,
          status: 'PENDING', // stays PENDING until admin verification
        },
      });
      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'invoice',
          resourceId: invoiceId,
          description: `Payment submitted for invoice (${paymentMethod}, ref ${transactionId})`,
          userId: session.userId,
          organizationId: invoice.organizationId,
        },
      });
      return u;
    });

    return NextResponse.json({
      success: true,
      invoiceId: updated.id,
      invoiceNumber: updated.invoiceNumber,
      status: updated.status,
    });
  } catch (error) {
    log.error('api.invoice.submit-payment', { error: String(error) }, requestContext(req));
    return apiError('Failed to submit payment', 500);
  }
}

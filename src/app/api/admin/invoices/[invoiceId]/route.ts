import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin, apiError, apiSuccess, authError, parseJsonBody, BodyParseError } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

const PAYMENT_METHODS = ['Bank_Transfer', 'bKash', 'Nagad', 'Rocket', 'Cash', 'Other'] as const;
const PAYMENT_STATUSES = ['PENDING', 'PAID'] as const;

/**
 * Manual payment record — part of the organization's control-plane record
 * (manual sales model). The single Super Admin maintains this from the
 * Organization; there is no customer payment-verification workflow.
 *
 * GET  — super_admin read of one invoice.
 * PATCH — super_admin update of the manual payment fields on an invoice
 *         (paymentStatus PENDING|PAID, paymentMethod, transactionId, paidAt,
 *         notes). Amount/currency come from the plan at provisioning and are
 *         not mutable here. Audited. Idempotent for repeated identical writes.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> },
) {
  const admin = await requireSuperAdmin(req);
  if (!admin.ok) return authError(admin);
  const { invoiceId } = await params;
  const invoice = await db.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      organization: { select: { id: true, name: true } },
      subscription: { select: { id: true, status: true, plan: { select: { name: true } } } },
    },
  });
  if (!invoice) return apiError('Invoice not found', 404);
  return apiSuccess({ invoice });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> },
) {
  const admin = await requireSuperAdmin(req);
  if (!admin.ok) return authError(admin);
  const { invoiceId } = await params;

  let body: Record<string, unknown>;
  try {
    body = await parseJsonBody(req);
  } catch (e) {
    if (e instanceof BodyParseError) return apiError('Invalid request body', 400);
    return apiError('Invalid request body', 400);
  }

  const invoice = await db.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) return apiError('Invoice not found', 404);

  const data: {
    status?: 'PENDING' | 'PAID';
    paidAt?: Date | null;
    paymentMethod?: string | null;
    transactionId?: string | null;
    notes?: string | null;
  } = {};

  if (body.status !== undefined) {
    const status = String(body.status);
    if (!(PAYMENT_STATUSES as readonly string[]).includes(status)) {
      return apiError(`status must be one of: ${PAYMENT_STATUSES.join(', ')}`, 422);
    }
    data.status = status as 'PENDING' | 'PAID';
  }

  if (body.paymentMethod !== undefined) {
    if (body.paymentMethod === null || body.paymentMethod === '') {
      data.paymentMethod = null;
    } else {
      const method = String(body.paymentMethod);
      if (!(PAYMENT_METHODS as readonly string[]).includes(method)) {
        return apiError(`paymentMethod must be one of: ${PAYMENT_METHODS.join(', ')}`, 422);
      }
      data.paymentMethod = method;
    }
  }

  if (body.transactionId !== undefined) {
    const txn = typeof body.transactionId === 'string' ? body.transactionId.trim() : '';
    if (txn.length > 120) return apiError('transactionId must be at most 120 characters', 422);
    data.transactionId = txn || null;
  }

  if (body.paidAt !== undefined) {
    if (body.paidAt === null || body.paidAt === '') {
      data.paidAt = null;
    } else {
      const parsed = new Date(String(body.paidAt));
      if (Number.isNaN(parsed.getTime())) return apiError('paidAt must be a valid date', 422);
      data.paidAt = parsed;
    }
  }

  if (body.notes !== undefined) {
    const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
    data.notes = notes ? notes.slice(0, 500) : null;
  }

  if (Object.keys(data).length === 0) {
    return apiError('No updatable fields provided', 422);
  }

  // A PAID record without an explicit date stamps now; a PENDING record has no
  // payment date unless one was explicitly provided.
  if (data.status === 'PAID' && data.paidAt === undefined) data.paidAt = new Date();
  if (data.status === 'PENDING' && data.paidAt === undefined && invoice.paidAt) data.paidAt = null;

  const updated = await db.$transaction(async (tx) => {
    const row = await tx.invoice.update({ where: { id: invoiceId }, data });
    await tx.auditLog.create({
      data: {
        action: 'update',
        resource: 'invoice',
        resourceId: invoiceId,
        description: `Super admin (${admin.email}) updated manual payment record ${row.invoiceNumber} (status ${row.status}${row.paymentMethod ? ` via ${row.paymentMethod}` : ''}${row.transactionId ? `, ref ${row.transactionId}` : ''})`,
        userId: admin.userId,
        organizationId: row.organizationId,
      },
    });
    return row;
  });

  log.info('api.admin.invoice.patch', { invoiceId, status: updated.status }, requestContext(req));
  return apiSuccess({ invoice: updated });
}

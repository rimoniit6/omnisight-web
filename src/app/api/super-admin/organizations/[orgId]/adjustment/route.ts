import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireDbVerifiedRole, apiError, apiSuccess, authError, parseJsonBody, BodyParseError } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

// POST /api/super-admin/organizations/[orgId]/adjustment
// Record a manual payment or waiver for an organization's outstanding dues.
// Super Admin only. Creates an audit trail entry.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  const admin = await requireDbVerifiedRole(req, { requireSuperAdmin: true });
  if (!admin.ok) return authError(admin);

  const { orgId } = await params;

  let body: Record<string, unknown>;
  try {
    body = await parseJsonBody(req);
  } catch (e) {
    if (e instanceof BodyParseError) return apiError('Invalid request body', 400);
    return apiError('Invalid request body', 400);
  }

  const type = body.type as string;
  if (type !== 'PAYMENT' && type !== 'WAIVER') {
    return apiError('type must be PAYMENT or WAIVER', 422);
  }

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return apiError('amount must be a positive number', 422);
  }

  const invoiceId = body.invoiceId as string | undefined;
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : null;

  // Verify the organization exists.
  const org = await db.organization.findUnique({
    where: { id: orgId },
    select: { id: true, name: true, subscriptionId: true },
  });
  if (!org) return apiError('Organization not found', 404);

  if (type === 'PAYMENT') {
    // Mark the invoice as PAID.
    if (!invoiceId) return apiError('invoiceId is required for PAYMENT type', 422);

    const invoice = await db.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, organizationId: true, status: true, amount: true, currency: true, invoiceNumber: true },
    });
    if (!invoice) return apiError('Invoice not found', 404);
    if (invoice.organizationId !== orgId) return apiError('Invoice does not belong to this organization', 403);
    if (invoice.status === 'PAID') return apiError('Invoice is already paid', 409);

    const effectiveAmount = Math.min(amount, invoice.amount);

    await db.$transaction(async (tx) => {
      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          status: 'PAID',
          paidAt: new Date(),
          paymentMethod: 'Bank_Transfer',
          notes: note ?? `Manual payment recorded by Super Admin`,
        },
      });

      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'invoice',
          resourceId: invoiceId,
          description: `Super admin (${admin.email}) recorded ${invoice.currency} ${effectiveAmount.toLocaleString()} payment for invoice ${invoice.invoiceNumber} (${org.name}): ${note ?? 'no note'}`,
          userId: admin.userId,
          organizationId: orgId,
        },
      });
    });

    log.info('api.super-admin.adjustment.payment', { orgId, invoiceId, amount: effectiveAmount }, requestContext(req));
    return apiSuccess({ success: true, type: 'PAYMENT', amount: effectiveAmount, invoiceId });
  }

  // WAIVER type — create a zero-amount PAID invoice to clear the outstanding.
  if (!invoiceId) return apiError('invoiceId is required for WAIVER type', 422);

  const invoice = await db.invoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, organizationId: true, status: true, amount: true, currency: true, invoiceNumber: true },
  });
  if (!invoice) return apiError('Invoice not found', 404);
  if (invoice.organizationId !== orgId) return apiError('Invoice does not belong to this organization', 403);
  if (invoice.status === 'PAID') return apiError('Invoice is already paid', 409);

  await db.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        notes: note ?? `Waived by Super Admin`,
      },
    });

    await tx.auditLog.create({
      data: {
        action: 'update',
        resource: 'invoice',
        resourceId: invoiceId,
        description: `Super admin (${admin.email}) waived ${invoice.currency} ${invoice.amount.toLocaleString()} for invoice ${invoice.invoiceNumber} (${org.name}): ${note ?? 'no note'}`,
        userId: admin.userId,
        organizationId: orgId,
      },
    });
  });

  log.info('api.super-admin.adjustment.waiver', { orgId, invoiceId, amount: invoice.amount }, requestContext(req));
  return apiSuccess({ success: true, type: 'WAIVER', amount: invoice.amount, invoiceId });
}

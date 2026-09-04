import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin, apiError } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

// PUT /api/admin/invoices/[invoiceId]/verify  → mark PAID + activate subscription
// PUT /api/admin/invoices/[invoiceId]/reject  → reject payment (invoice back to PENDING w/ reason)
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ invoiceId: string; action: string }> }
) {
  try {
    const { invoiceId, action } = await params;
    if (action !== 'verify' && action !== 'reject') {
      return apiError("action must be 'verify' or 'reject'", 400);
    }

    const admin = await requireSuperAdmin(req);
    if (!admin.ok) return apiError(admin.status === 401 ? 'Unauthorized' : 'Super admin access required', admin.status);

    const invoice = await db.invoice.findUnique({
      where: { id: invoiceId },
      include: { subscription: true },
    });
    if (!invoice) return apiError('Invoice not found', 404);

    if (action === 'verify') {
      if (invoice.status === 'PAID') {
        return NextResponse.json({ error: 'Invoice already paid', code: 'ALREADY_PAID' }, { status: 409 });
      }

      // Phase 2 §16: manual payment recording. Optional body fields let Super
      // Admin correct the payment record at verify time (method/reference/date
      // as reported by the customer). No card/bank secrets are ever accepted.
      const vbody = (await req.json().catch(() => ({}))) as {
        paidAt?: unknown; paymentMethod?: unknown; transactionId?: unknown; notes?: unknown;
      };
      const PAYMENT_METHODS = ['Bank_Transfer', 'bKash', 'Nagad', 'Rocket', 'Cash', 'Other'];
      let paidAt = new Date();
      if (vbody.paidAt !== undefined) {
        const parsed = new Date(String(vbody.paidAt));
        if (Number.isNaN(parsed.getTime())) return apiError('paidAt must be a valid date', 422);
        if (parsed.getTime() > Date.now() + 86_400_000) return apiError('paidAt cannot be in the future', 422);
        paidAt = parsed;
      }
      let paymentMethod: string | undefined;
      if (vbody.paymentMethod !== undefined) {
        if (typeof vbody.paymentMethod !== 'string' || !PAYMENT_METHODS.includes(vbody.paymentMethod)) {
          return apiError(`paymentMethod must be one of: ${PAYMENT_METHODS.join(', ')}`, 422);
        }
        paymentMethod = vbody.paymentMethod;
      }
      let transactionId: string | undefined;
      if (vbody.transactionId !== undefined) {
        if (typeof vbody.transactionId !== 'string' || !vbody.transactionId.trim() || vbody.transactionId.length > 120) {
          return apiError('transactionId must be a non-empty string (max 120 chars)', 422);
        }
        transactionId = vbody.transactionId.trim();
      }
      const extraNotes = typeof vbody.notes === 'string' && vbody.notes.trim() ? vbody.notes.trim().slice(0, 500) : null;

      const result = await db.$transaction(async (tx) => {
        const paid = await tx.invoice.update({
          where: { id: invoiceId },
          data: {
            status: 'PAID',
            paidAt,
            ...(paymentMethod ? { paymentMethod } : {}),
            ...(transactionId ? { transactionId } : {}),
            notes: [invoice.notes, extraNotes, `Verified by super admin (${admin.email}).`].filter(Boolean).join('\n'),
          },
        });

        // Activate the linked subscription (also cover the case where the
        // linked subscription is missing / was already active).
        await tx.subscription.updateMany({
          where: { id: invoice.subscriptionId },
          data: { status: 'ACTIVE', startDate: invoice.subscription?.startDate ?? paidAt, endDate: invoice.subscription?.endDate ?? undefined, updatedAt: paidAt },
        });

        // Reflect on the org: reactivate, point at the current subscription,
        // clear trial (paid subscription supersedes trial).
        await tx.organization.update({
          where: { id: invoice.organizationId },
          data: { status: 'active', subscriptionId: invoice.subscriptionId, trialEndsAt: null, updatedAt: paidAt },
        });

        // Phase 2 §21: the money-activation step is audited (was missing).
        await tx.auditLog.create({
          data: {
            action: 'update',
            resource: 'invoice',
            resourceId: invoiceId,
            description: `Super admin (${admin.email}) verified payment ${invoice.invoiceNumber} (${paid.amount} ${paid.currency}${paymentMethod ? ` via ${paymentMethod}` : ''})`,
            userId: admin.userId,
            organizationId: invoice.organizationId,
          },
        });

        return { paid };
      });

      return NextResponse.json({ success: true, action, invoiceId, status: result.paid.status });
    }

    // ─── reject ──────────────────────────────────────────────────────────────
    const body = (await req.json().catch(() => ({}))) as { reason?: unknown };
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null;

    if (invoice.status === 'PAID') {
      // A paid invoice cannot be rejected — must go through cancellation/dispute.
      return apiError('A paid invoice cannot be rejected', 400);
    }

    const result = await db.$transaction(async (tx) => {
      const updated = await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          status: 'PENDING',
          notes: reason
            ? `${invoice.notes ? invoice.notes + '\n' : ''}Rejected by super admin (${admin.email}): ${reason}`
            : invoice.notes,
        },
      });
      // Ensure the linked subscription stays PENDING on rejection.
      await tx.subscription.updateMany({
        where: { id: invoice.subscriptionId, status: { not: 'ACTIVE' } },
        data: { status: 'PENDING', updatedAt: new Date() },
      });
      // Phase 2 §21: audit the rejection (was missing).
      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'invoice',
          resourceId: invoiceId,
          description: `Super admin (${admin.email}) rejected payment ${invoice.invoiceNumber}${reason ? `: ${reason}` : ''}`,
          userId: admin.userId,
          organizationId: invoice.organizationId,
        },
      });
      return { updated };
    });

    return NextResponse.json({ success: true, action, invoiceId, status: result.updated.status });
  } catch (error) {
    log.error('api.admin.invoice.action', { error: String(error) }, requestContext(req));
    return apiError('Failed to update invoice', 500);
  }
}

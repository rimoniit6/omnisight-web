import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin, apiError, parseJsonBody, BodyParseError } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

const PAYMENT_METHODS = ['Bank_Transfer', 'bKash', 'Nagad', 'Rocket', 'Cash', 'Other'] as const;
const PAYMENT_STATUSES = ['PENDING', 'PAID', 'OVERDUE', 'CANCELLED'] as const;

// GET /api/admin/invoices
// Super Admin: list all invoices (optionally filtered by status), newest first.
// ?organizationId=<id> scopes the list to one organization (control-plane
// payment history for the Organization Detail page).
export async function GET(req: NextRequest) {
  try {
    const admin = await requireSuperAdmin(req);
    if (!admin.ok) return apiError(admin.status === 401 ? 'Unauthorized' : 'Super admin access required', admin.status);

    const statusFilter = req.nextUrl.searchParams.get('status');
    const statuses = ['PENDING', 'PAID', 'OVERDUE', 'CANCELLED'];
    const status = statusFilter && statuses.includes(statusFilter.toUpperCase()) ? statusFilter.toUpperCase() : undefined;
    const organizationId = req.nextUrl.searchParams.get('organizationId') || undefined;

    const where: Record<string, unknown> = {};
    if (status) where.status = status as 'PENDING' | 'PAID' | 'OVERDUE' | 'CANCELLED';
    if (organizationId) where.organizationId = organizationId;

    const invoices = await db.invoice.findMany({
      where,
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

/**
 * POST /api/admin/invoices — record a NEW manual payment for an organization.
 *
 * MANUAL PAYMENT HISTORY CONTRACT: every call creates a NEW Invoice row.
 * Existing payment records are NEVER modified by this endpoint — the
 * Organization → Manual Payments → [+ Add Payment] workflow appends to the
 * organization's payment history.
 *
 * Body: { organizationId, amount, currency?, paidAt?, status?, paymentMethod?,
 *         transactionId?, notes? }
 *
 * The invoice is attached to the organization's current subscription when one
 * exists (Invoice.subscriptionId is required by the schema); otherwise the
 * endpoint requires a standalone subscription to attach to. Server resolves
 * everything (organization, subscription, invoice number) authoritatively —
 * nothing is trusted from the browser. Audited.
 */
export async function POST(req: NextRequest) {
  try {
    const admin = await requireSuperAdmin(req);
    if (!admin.ok) return apiError(admin.status === 401 ? 'Unauthorized' : 'Super admin access required', admin.status);

    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      if (e instanceof BodyParseError) return apiError('Invalid request body', 400);
      return apiError('Invalid request body', 400);
    }

    const organizationId = typeof body.organizationId === 'string' ? body.organizationId : '';
    if (!organizationId) return apiError('organizationId is required', 422);

    // Amount: strict positive-number validation (zero/negative/NaN rejected).
    const amountNum = typeof body.amount === 'number' ? body.amount : Number(String(body.amount ?? ''));
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return apiError('amount must be a positive number', 422);
    }
    if (amountNum > 1_000_000_000) return apiError('amount is unreasonably large', 422);

    // Currency: ISO-ish 3-letter code, default BDT.
    const currency = typeof body.currency === 'string' && /^[A-Za-z]{3}$/.test(body.currency.trim())
      ? body.currency.trim().toUpperCase()
      : 'BDT';

    // Status: reuse the existing InvoiceStatus enum. Unknown values are
    // rejected (never silently coerced to a default).
    let status: (typeof PAYMENT_STATUSES)[number] = 'PAID';
    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !(PAYMENT_STATUSES as readonly string[]).includes(body.status)) {
        return apiError(`status must be one of: ${PAYMENT_STATUSES.join(', ')}`, 422);
      }
      status = body.status as (typeof PAYMENT_STATUSES)[number];
    }

    // Payment method: reuse the existing manual-method set.
    let paymentMethod: string | null = null;
    if (typeof body.paymentMethod === 'string' && body.paymentMethod) {
      if (!(PAYMENT_METHODS as readonly string[]).includes(body.paymentMethod)) {
        return apiError(`paymentMethod must be one of: ${PAYMENT_METHODS.join(', ')}`, 422);
      }
      paymentMethod = body.paymentMethod;
    }

    // Payment date: optional ISO date; PAID defaults to now.
    let paidAt: Date | null = null;
    if (typeof body.paidAt === 'string' && body.paidAt) {
      const parsed = new Date(body.paidAt);
      if (Number.isNaN(parsed.getTime())) return apiError('paidAt must be a valid date', 422);
      paidAt = parsed;
    }
    if (status === 'PAID' && !paidAt) paidAt = new Date();

    // Reference: trimmed, bounded.
    const transactionId = typeof body.transactionId === 'string' && body.transactionId.trim()
      ? body.transactionId.trim().slice(0, 120)
      : null;
    const notes = typeof body.notes === 'string' && body.notes.trim()
      ? body.notes.trim().slice(0, 500)
      : null;

    // Resolve the organization and its current subscription server-side.
    const org = await db.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true, subscriptionId: true },
    });
    if (!org) return apiError('Organization not found', 404);

    const subscriptionId = org.subscriptionId
      ?? (await db.subscription.findFirst({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      }))?.id
      ?? null;
    if (!subscriptionId) {
      return apiError('Organization has no subscription to attach the payment to', 422);
    }

    // Sequential invoice number, same convention as provisioning: INV-<year>-<seq>.
    const year = new Date().getFullYear();
    const last = await db.invoice.findFirst({
      where: { invoiceNumber: { startsWith: `INV-${year}-` } },
      orderBy: { createdAt: 'desc' },
      select: { invoiceNumber: true },
    });
    const lastSeq = last ? parseInt(last.invoiceNumber.split('-').pop() ?? '0', 10) || 0 : 0;
    const invoiceNumber = `INV-${year}-${String(lastSeq + 1).padStart(4, '0')}`;

    const created = await db.$transaction(async (tx) => {
      const invoice = await tx.invoice.create({
        data: {
          subscriptionId,
          organizationId,
          invoiceNumber,
          amount: amountNum,
          currency,
          status,
          dueDate: paidAt ?? new Date(),
          paidAt,
          ...(paymentMethod ? { paymentMethod } : {}),
          ...(transactionId ? { transactionId } : {}),
          ...(notes ? { notes } : {}),
        },
      });

      await tx.auditLog.create({
        data: {
          action: 'create',
          resource: 'invoice',
          resourceId: invoice.id,
          description: `Super admin (${admin.email}) recorded manual payment ${invoice.invoiceNumber} (${invoice.currency} ${invoice.amount}) for org "${org.name}"`,
          userId: admin.userId,
          organizationId,
        },
      });

      return invoice;
    });

    log.info('api.admin.invoices.create', { invoiceId: created.id, organizationId }, requestContext(req));
    return NextResponse.json({ success: true, invoice: created }, { status: 201 });
  } catch (error) {
    log.error('api.admin.invoices.create', { error: String(error) }, requestContext(req));
    return apiError('Failed to record payment', 500);
  }
}

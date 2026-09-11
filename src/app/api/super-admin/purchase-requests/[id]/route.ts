import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin, requireDbVerifiedRole, apiError, apiSuccess, authError, parseJsonBody, BodyParseError } from '@/lib/api';
import { activatePendingSubscription } from '@/lib/subscription-activation';
import { Prisma } from '@prisma/client';
import { log, requestContext } from '@/lib/logger';

// PATCH /api/super-admin/purchase-requests/[id] — Super Admin review actions.
//
//   action: 'review'            SUBMITTED → REVIEWED (notes optional)
//   action: 'verify_payment'    REVIEWED → PAYMENT_VERIFIED (records the manual
//                               payment on the linked invoice — reuses the
//                               existing manual-payment system, no second
//                               payment system)
//   action: 'activate'          PAYMENT_VERIFIED → ACTIVATED. Creates the
//                               organization (if needed) + PENDING subscription
//                               carrying the snapshot terms, then activates it
//                               through the EXISTING lifecycle helper (same
//                               path as PATCH /api/super-admin/subscriptions/[id]
//                               action 'activate'). No lifecycle fork.
//   action: 'reject'            open → REJECTED (reason required)
//
// Idempotent via explicit status guards. Every transition is audited.

const TRANSITIONS: Record<string, { from: string[]; next: string }> = {
  review: { from: ['SUBMITTED'], next: 'REVIEWED' },
  verify_payment: { from: ['REVIEWED'], next: 'PAYMENT_VERIFIED' },
  activate: { from: ['PAYMENT_VERIFIED'], next: 'ACTIVATED' },
  reject: { from: ['SUBMITTED', 'REVIEWED', 'PAYMENT_VERIFIED'], next: 'REJECTED' },
};

/** Append an entry to the request's status history (Prisma Json-safe). */
function withHistory(current: unknown, entry: Record<string, unknown>): Prisma.InputJsonValue {
  const list = Array.isArray(current) ? current : [];
  return [...list, entry] as unknown as Prisma.InputJsonValue;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireSuperAdmin(req);
  if (!admin.ok) return authError(admin);
  const { id } = await params;

  const request = await db.purchaseRequest.findUnique({
    where: { id },
    include: {
      plan: { select: { id: true, name: true } },
      offer: { select: { id: true, name: true } },
    },
  });
  if (!request) return apiError('Purchase request not found', 404);
  return apiSuccess({ data: request });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireDbVerifiedRole(req, { requireSuperAdmin: true });
  if (!admin.ok) return authError(admin);
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = await parseJsonBody(req);
  } catch (e) {
    if (e instanceof BodyParseError) return apiError('Invalid request body', 400);
    return apiError('Invalid request body', 400);
  }

  const action = typeof body.action === 'string' ? body.action : '';
  const transition = TRANSITIONS[action];
  if (!transition) {
    return apiError("action must be 'review', 'verify_payment', 'activate', or 'reject'", 422);
  }

  const request = await db.purchaseRequest.findUnique({ where: { id } });
  if (!request) return apiError('Purchase request not found', 404);

  if (!transition.from.includes(request.status)) {
    return apiError(`Cannot ${action} a request in status ${request.status} (expected one of: ${transition.from.join(', ')})`, 409);
  }

  const now = new Date();
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) || null : null;

  // ── review ──────────────────────────────────────────────────────────────
  if (action === 'review') {
    const updated = await db.$transaction(async (tx) => {
      const u = await tx.purchaseRequest.update({
        where: { id },
        data: {
          status: 'REVIEWED',
          reviewedById: admin.userId,
          reviewedAt: now,
          reviewNote: note,
          statusHistory: withHistory(request.statusHistory, { status: 'REVIEWED', at: now.toISOString(), by: admin.email, note }),
        },
      });
      await tx.auditLog.create({
        data: { action: 'update', resource: 'purchase_request', resourceId: id, description: `Super admin (${admin.email}) reviewed purchase request ${request.requestNumber}${note ? `: ${note}` : ''}`, userId: admin.userId, organizationId: null },
      });
      return u;
    });
    return apiSuccess(updated);
  }

  // ── verify_payment ──────────────────────────────────────────────────────
  if (action === 'verify_payment') {
    // Full manual payment record (§10): payment is recorded explicitly —
    // never inferred from activation. The purchase price snapshot is NOT
    // touched; the amount received is stored alongside it on the request and
    // copied onto the invoice at activation.
    const paymentReference = typeof body.paymentReference === 'string' ? body.paymentReference.trim().slice(0, 120) || null : null;
    const paymentMethod = typeof body.paymentMethod === 'string' && body.paymentMethod.trim()
      ? body.paymentMethod.trim().slice(0, 40)
      : null;
    const paymentAmount = body.paymentAmount === undefined || body.paymentAmount === null || body.paymentAmount === ''
      ? null
      : Number(body.paymentAmount);
    if (paymentAmount !== null && (!Number.isFinite(paymentAmount) || paymentAmount < 0)) {
      return apiError('paymentAmount must be a non-negative number', 422);
    }
    let paymentDate: Date | null = null;
    if (typeof body.paymentDate === 'string' && body.paymentDate.trim()) {
      const parsed = new Date(body.paymentDate);
      if (Number.isNaN(parsed.getTime())) return apiError('paymentDate must be a valid date', 422);
      paymentDate = parsed;
    }
    const paymentNote = typeof body.paymentNote === 'string' ? body.paymentNote.trim().slice(0, 500) || null : null;
    const verifiedAmount = paymentAmount ?? request.finalPrice;
    const verifiedMethod = paymentMethod ?? 'Other';
    const verifiedDate = paymentDate ?? now;
    const historyNote = [
      paymentReference ? `ref ${paymentReference}` : null,
      `${verifiedMethod}${paymentAmount !== null ? ` · ${request.currency} ${verifiedAmount.toLocaleString()}` : ''}`,
      paymentDate ? `paid ${paymentDate.toISOString().slice(0, 10)}` : null,
      paymentNote,
    ].filter(Boolean).join(' — ');
    const updated = await db.$transaction(async (tx) => {
      const u = await tx.purchaseRequest.update({
        where: { id },
        data: {
          status: 'PAYMENT_VERIFIED',
          paymentVerifiedById: admin.userId,
          paymentVerifiedAt: now,
          paymentReference,
          paymentMethod: verifiedMethod,
          paymentAmount: verifiedAmount,
          paymentDate: verifiedDate,
          paymentNote,
          statusHistory: withHistory(request.statusHistory, { status: 'PAYMENT_VERIFIED', at: now.toISOString(), by: admin.email, note: historyNote }),
        },
      });
      // Record the manual payment on the linked invoice when one exists
      // (requests created from the authenticated self-serve flow attach a
      // PENDING invoice; public-form requests activate an invoice at
      // activation time). Never a second payment system — same Invoice row.
      if (request.activatedSubscriptionId) {
        const invoice = await tx.invoice.findFirst({
          where: { subscriptionId: request.activatedSubscriptionId, status: { not: 'PAID' } },
          orderBy: { createdAt: 'desc' },
        });
        if (invoice) {
          await tx.invoice.update({
            where: { id: invoice.id },
            data: { status: 'PAID', paidAt: verifiedDate, paymentMethod: verifiedMethod, transactionId: paymentReference, notes: [invoice.notes, `Verified via purchase request ${request.requestNumber}${paymentNote ? `: ${paymentNote}` : ''}`].filter(Boolean).join('\n') },
          });
        }
      }
      await tx.auditLog.create({
        data: { action: 'update', resource: 'purchase_request', resourceId: id, description: `Super admin (${admin.email}) verified manual payment for purchase request ${request.requestNumber} (${verifiedMethod}${paymentReference ? `, ref ${paymentReference}` : ''}, ${request.currency} ${verifiedAmount.toLocaleString()})`, userId: admin.userId, organizationId: null },
      });
      return u;
    });
    return apiSuccess(updated);
  }

  // ── reject ──────────────────────────────────────────────────────────────
  if (action === 'reject') {
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
    if (!reason) return apiError('reason is required to reject a purchase request', 422);
    const updated = await db.$transaction(async (tx) => {
      const u = await tx.purchaseRequest.update({
        where: { id },
        data: {
          status: 'REJECTED',
          rejectedAt: now,
          rejectionReason: reason,
          statusHistory: withHistory(request.statusHistory, { status: 'REJECTED', at: now.toISOString(), by: admin.email, note: reason }),
        },
      });
      await tx.auditLog.create({
        data: { action: 'update', resource: 'purchase_request', resourceId: id, description: `Super admin (${admin.email}) rejected purchase request ${request.requestNumber}: ${reason}`, userId: admin.userId, organizationId: null },
      });
      return u;
    });
    return apiSuccess(updated);
  }

  // ── activate ────────────────────────────────────────────────────────────
  // Creates/reuses the organization, provisions the PENDING subscription
  // carrying the snapshot terms, and activates via the EXISTING lifecycle.
  if (action === 'activate') {
    const plan = await db.plan.findUnique({ where: { id: request.planId }, select: { id: true, name: true, isActive: true } });
    if (!plan) return apiError('The requested plan no longer exists', 410);
    if (!plan.isActive) return apiError('The requested plan has been deactivated', 410);

    const claimedId = await db.$transaction(async (tx) => {
      // 0) Single-flight claim — atomic CAS on the request status so two
      //    concurrent "activate" calls cannot both proceed: the loser's
      //    updateMany matches 0 rows (PostgreSQL re-evaluates the WHERE clause
      //    against the committed row after the lock wait) and aborts the whole
      //    transaction, rolling back its subscription + invoice with it.
      const claimed = await tx.purchaseRequest.updateMany({
        where: { id, status: 'PAYMENT_VERIFIED' },
        data: { status: 'ACTIVATED' },
      });
      if (claimed.count !== 1) return null;

      // 1) Organization — match by contact email (one workspace per customer
      //    email); create when absent. Slug is derived + uniquified.
      let org = await tx.organization.findFirst({ where: { email: request.contactEmail } });
      if (!org) {
        const baseSlug = request.companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'customer';
        let slug = baseSlug;
        let n = 1;
        while (await tx.organization.findUnique({ where: { slug } })) slug = `${baseSlug}-${++n}`;
        org = await tx.organization.create({
          data: {
            name: request.companyName,
            slug,
            email: request.contactEmail,
            phone: request.contactPhone,
            // Snapshot terms decide the mode at activation time.
            deploymentMode: request.deploymentMode,
            status: 'active',
          },
        });
      } else if (org.deploymentMode !== request.deploymentMode) {
        await tx.organization.update({ where: { id: org.id }, data: { deploymentMode: request.deploymentMode } });
      }

      // 2) Invoice (manual payment record) — sequential number, snapshot price.
      const year = now.getFullYear();
      const last = await tx.invoice.findFirst({
        where: { invoiceNumber: { startsWith: `INV-${year}-` } },
        orderBy: { createdAt: 'desc' },
      });
      const lastSeq = last ? parseInt(last.invoiceNumber.split('-').pop() ?? '0', 10) || 0 : 0;
      const invoiceNumber = `INV-${year}-${String(lastSeq + 1).padStart(4, '0')}`;
      const periodDays = request.billingPeriod === 'YEARLY' ? 365 : 30;
      const endDate = new Date(now);
      endDate.setDate(endDate.getDate() + periodDays);

      // 3) PENDING subscription with the commercial snapshot.
      const subscription = await tx.subscription.create({
        data: {
          organizationId: org.id,
          planId: request.planId,
          status: 'PENDING',
          startDate: now,
          endDate,
          billingPeriod: request.billingPeriod,
          deviceQuantity: request.deploymentMode === 'MANAGED' ? request.deviceQuantity : null,
          deploymentModeSnapshot: request.deploymentMode,
          priceSnapshot: request.priceSnapshot === null ? Prisma.JsonNull : (request.priceSnapshot as Prisma.InputJsonValue),
          notes: `From purchase request ${request.requestNumber}${request.offerName ? ` (offer: ${request.offerName})` : ''}`,
        },
      });

      await tx.invoice.create({
        data: {
          subscriptionId: subscription.id,
          organizationId: org.id,
          invoiceNumber,
          currency: request.currency,
          // Payment was already verified in the queue — the invoice records
          // the EXACT verified payment (method/amount/date), not a guess.
          // Amount received (§10) — the requested price snapshot on the
          // request is never modified either way.
          amount: request.paymentAmount ?? request.finalPrice,
          status: 'PAID',
          dueDate: now,
          paidAt: request.paymentDate ?? now,
          paymentMethod: request.paymentMethod ?? 'Other',
          transactionId: request.paymentReference,
          notes: `Purchase request ${request.requestNumber} — ${request.planId === plan.id ? plan.name : 'plan'} ${request.billingPeriod}${request.deploymentMode === 'MANAGED' ? `, ${request.deviceQuantity} devices` : ', unlimited devices'}`,
        },
      });

      await tx.organization.update({ where: { id: org.id }, data: { subscriptionId: subscription.id } });
      return subscription.id;
    });

    // Loser of the single-flight claim — the request was activated concurrently.
    if (claimedId === null) {
      return apiError('Purchase request has already been activated', 409);
    }
    const subscriptionId: string = claimedId;

    // 4) Activate through the EXISTING lifecycle helper (PENDING → ACTIVE,
    //    org pointer, audit) — same code path as direct subscription activation.
    const activation = await activatePendingSubscription(subscriptionId, { userId: admin.userId, email: admin.email }, `Purchase request ${request.requestNumber}`);
    if (!activation.ok) {
      // Activation failed AFTER the atomic claim — the request's subscription
      // + PAID invoice already exist. Do NOT roll the request back to
      // REVIEWED: a retry would create a SECOND subscription (duplicate
      // activation). Instead persist the subscription linkage so the state
      // stays consistent and recoverable: the admin completes activation via
      // the normal lifecycle (PATCH /api/super-admin/subscriptions/[id] —
      // the same shared helper).
      await db.$transaction(async (tx) => {
        await tx.purchaseRequest.update({
          where: { id },
          data: {
            activatedSubscriptionId: subscriptionId,
            statusHistory: withHistory(request.statusHistory, {
              status: 'ACTIVATED',
              at: new Date().toISOString(),
              by: admin.email,
              note: `Subscription ${subscriptionId} created but activation deferred: ${activation.message}`,
            }),
          },
        });
        await tx.auditLog.create({
          data: { action: 'update', resource: 'purchase_request', resourceId: id, description: `Purchase request ${request.requestNumber}: subscription ${subscriptionId} created but activation deferred (${activation.message}) — recoverable via subscription activate`, userId: admin.userId, organizationId: null },
        });
      });
      return apiError(`Subscription ${subscriptionId} was created but activation did not complete: ${activation.message}. Activate it from Subscriptions to finish this purchase request.`, 409);
    }

    const updated = await db.$transaction(async (tx) => {
      const u = await tx.purchaseRequest.update({
        where: { id },
        data: {
          status: 'ACTIVATED',
          activatedSubscriptionId: subscriptionId,
          activatedAt: new Date(),
          statusHistory: withHistory(request.statusHistory, { status: 'ACTIVATED', at: new Date().toISOString(), by: admin.email }),
        },
      });
      await tx.auditLog.create({
        data: { action: 'update', resource: 'purchase_request', resourceId: id, description: `Super admin (${admin.email}) activated purchase request ${request.requestNumber} → subscription ${subscriptionId}`, userId: admin.userId, organizationId: null },
      });
      return u;
    });

    log.info('api.super-admin.purchase-requests.activate', { requestId: id, subscriptionId }, requestContext(req));
    return apiSuccess({ ...updated, subscriptionId });
  }

  return apiError('Unhandled action', 422);
}

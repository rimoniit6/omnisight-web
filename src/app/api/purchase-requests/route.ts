import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { resolvePrice, isPricingMode, isPricingPeriod } from '@/lib/pricing';
import { normalizeEmail } from '@/lib/email';
import { log, requestContext } from '@/lib/logger';
import { checkRateLimit, RATE_LIMITS, getClientIpFromHeaders } from '@/lib/rate-limit';

// POST /api/purchase-requests — PUBLIC purchase request submission (V1).
//
// Customer flow (no login required):
//   Plan → Deployment Mode → Monthly/Yearly → (Managed) Device Quantity →
//   server-calculated price → Submit Purchase Request.
//
// SECURITY: the client-submitted price/offer is NEVER trusted. The server
// re-runs the single pricing resolver and stores the authoritative snapshot.
// Requests land in the Super Admin queue (SUBMITTED) for review, manual
// payment verification, and activation through the EXISTING subscription
// lifecycle. This is the V1 commercial activation path — LicenseKey is not
// part of this flow.

function nextRequestNumber(last: string | undefined | null, year: number): string {
  const seq = last ? parseInt(last.split('-').pop() ?? '0', 10) || 0 : 0;
  return `PR-${year}-${String(seq + 1).padStart(4, '0')}`;
}

export async function POST(req: NextRequest) {
  try {
    const clientIp = getClientIpFromHeaders(req.headers);
    const rl = await checkRateLimit(
      `purchase-request:${clientIp}`,
      RATE_LIMITS.publicIntake.limit,
      RATE_LIMITS.publicIntake.windowMs
    );
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `Too many requests. Try again in ${rl.retryAfterSeconds} seconds.` },
        { status: 429 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    // ── Customer information ────────────────────────────────────────────────
    const companyName = typeof body.companyName === 'string' ? body.companyName.trim() : '';
    const contactName = typeof body.contactName === 'string' ? body.contactName.trim() : '';
    const contactEmail = normalizeEmail(body.contactEmail);
    const contactPhone = typeof body.contactPhone === 'string' ? body.contactPhone.trim().slice(0, 40) : null;
    const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 2000) : null;
    if (!companyName || !contactName || !contactEmail) {
      return NextResponse.json({ error: 'Company name, contact name, and email are required' }, { status: 422 });
    }
    if (companyName.length > 200 || contactName.length > 200 || contactEmail.length > 320) {
      return NextResponse.json({ error: 'Input too long' }, { status: 422 });
    }

    // ── Commercial selection ────────────────────────────────────────────────
    const planId = typeof body.planId === 'string' ? body.planId : '';
    const deploymentMode = body.deploymentMode;
    const billingPeriod = body.billingPeriod;
    if (!planId) return NextResponse.json({ error: 'planId is required' }, { status: 422 });
    if (!isPricingMode(deploymentMode)) {
      return NextResponse.json({ error: "deploymentMode must be 'MANAGED' or 'CUSTOMER_DB'" }, { status: 422 });
    }
    if (!isPricingPeriod(billingPeriod)) {
      return NextResponse.json({ error: "billingPeriod must be 'MONTHLY' or 'YEARLY'" }, { status: 422 });
    }

    const plan = await db.plan.findUnique({ where: { id: planId }, select: { id: true, isActive: true } });
    if (!plan || !plan.isActive) {
      return NextResponse.json({ error: 'Selected plan is not available' }, { status: 422 });
    }

    // Managed requires a positive device quantity; Customer DB ignores it
    // (unlimited — quantity is stored as null and never priced).
    let deviceQuantity: number | null = null;
    if (deploymentMode === 'MANAGED') {
      const raw = body.deviceQuantity;
      if (typeof raw !== 'number' || !Number.isFinite(raw) || Math.floor(raw) < 1) {
        return NextResponse.json({ error: 'deviceQuantity must be a positive integer for Managed deployments' }, { status: 422 });
      }
      deviceQuantity = Math.min(Math.floor(raw), 100000); // bounded input
    }

    // ── Authoritative server-side price calculation ─────────────────────────
    let breakdown;
    try {
      breakdown = await resolvePrice({ planId, deploymentMode, billingPeriod, deviceQuantity });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'PLAN_NOT_AVAILABLE') {
        return NextResponse.json({ error: 'Selected plan is not available' }, { status: 422 });
      }
      throw e;
    }

    // ── Persist with a sequential PR-YYYY-NNNN number ───────────────────────
    const now = new Date();
    const year = now.getFullYear();
    const created = await db.$transaction(async (tx) => {
      const last = await tx.purchaseRequest.findFirst({
        where: { requestNumber: { startsWith: `PR-${year}-` } },
        orderBy: { createdAt: 'desc' },
        select: { requestNumber: true },
      });
      const requestNumber = nextRequestNumber(last?.requestNumber, year);

      return tx.purchaseRequest.create({
        data: {
          requestNumber,
          companyName,
          contactName,
          contactEmail,
          contactPhone,
          notes,
          planId,
          deploymentMode,
          billingPeriod,
          deviceQuantity,
          basePrice: breakdown.basePrice,
          deviceCharge: breakdown.deviceCharge,
          discountAmount: breakdown.discountAmount,
          finalPrice: breakdown.finalPrice,
          currency: breakdown.currency,
          offerId: breakdown.offerId,
          offerName: breakdown.offerName,
          priceSnapshot: JSON.parse(JSON.stringify(breakdown)),
          status: 'SUBMITTED',
          statusHistory: [{ status: 'SUBMITTED', at: now.toISOString(), by: 'public_form' }],
        },
        select: { id: true, requestNumber: true, status: true, finalPrice: true, currency: true },
      });
    });

    log.info(
      'api.purchase-requests.create',
      { requestId: created.id, requestNumber: created.requestNumber, planId, deploymentMode, billingPeriod, deviceQuantity, finalPrice: breakdown.finalPrice },
      requestContext(req)
    );

    return NextResponse.json(
      {
        success: true,
        id: created.id,
        requestNumber: created.requestNumber,
        status: created.status,
        price: { final: created.finalPrice, currency: created.currency },
      },
      { status: 201 }
    );
  } catch (error) {
    log.error('api.purchase-requests.create', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Failed to submit purchase request' }, { status: 500 });
  }
}

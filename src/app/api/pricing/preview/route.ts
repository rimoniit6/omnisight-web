import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { resolvePrice, isPricingMode, isPricingPeriod } from '@/lib/pricing';
import { log, requestContext } from '@/lib/logger';
import { checkRateLimit, RATE_LIMITS, getClientIpFromHeaders } from '@/lib/rate-limit';

// POST /api/pricing/preview — PUBLIC price calculation.
//
// The UI (purchase form, landing pricing display) calls this to DISPLAY a
// price; it is never authoritative on its own. The purchase request endpoint
// RE-RUNS the same resolvePrice() server-side and stores the result, so a
// stale/manipulated preview can never create a wrong commercial record.
//
// Body: { planId, deploymentMode: 'MANAGED'|'CUSTOMER_DB', billingPeriod:
// 'MONTHLY'|'YEARLY', deviceQuantity?: number }
// Only MANAGED / CUSTOMER_DB are accepted — PRIVATE is legacy and never
// priced through the V1 catalog.

export async function POST(req: NextRequest) {
  try {
    const clientIp = getClientIpFromHeaders(req.headers);
    const rl = await checkRateLimit(
      `pricing-preview:${clientIp}`,
      RATE_LIMITS.licenseGenerate.limit,
      RATE_LIMITS.licenseGenerate.windowMs
    );
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `Too many requests. Try again in ${rl.retryAfterSeconds} seconds.` },
        { status: 429 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as {
      planId?: unknown;
      deploymentMode?: unknown;
      billingPeriod?: unknown;
      deviceQuantity?: unknown;
    };

    const planId = typeof body.planId === 'string' ? body.planId : '';
    if (!planId) return NextResponse.json({ error: 'planId is required' }, { status: 400 });
    if (!isPricingMode(body.deploymentMode)) {
      return NextResponse.json({ error: "deploymentMode must be 'MANAGED' or 'CUSTOMER_DB'" }, { status: 400 });
    }
    if (!isPricingPeriod(body.billingPeriod)) {
      return NextResponse.json({ error: "billingPeriod must be 'MONTHLY' or 'YEARLY'" }, { status: 400 });
    }

    const plan = await db.plan.findUnique({ where: { id: planId }, select: { id: true, isActive: true } });
    if (!plan || !plan.isActive) {
      return NextResponse.json({ error: 'Selected plan is not available' }, { status: 400 });
    }

    const deviceQuantity =
      typeof body.deviceQuantity === 'number' && Number.isFinite(body.deviceQuantity)
        ? Math.max(1, Math.floor(body.deviceQuantity))
        : null;

    try {
      const breakdown = await resolvePrice({
        planId,
        deploymentMode: body.deploymentMode,
        billingPeriod: body.billingPeriod,
        deviceQuantity,
      });
      return NextResponse.json({ breakdown });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'PLAN_NOT_AVAILABLE') {
        return NextResponse.json({ error: 'Selected plan is not available' }, { status: 400 });
      }
      throw e;
    }
  } catch (error) {
    log.error('api.pricing.preview', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Failed to calculate price' }, { status: 500 });
  }
}

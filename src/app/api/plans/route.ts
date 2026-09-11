import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { parsePlanFeatures } from '@/lib/subscription';
import { log, requestContext } from '@/lib/logger';

// GET /api/plans
// Public pricing catalog — no authentication required.
// Returns only active plans, with the features JSON normalized to an array.
//
// V1 additive extension (backward compatible — every legacy field is kept):
//   pricing: [{ deploymentMode, billingPeriod, basePrice, currency,
//               includedDevices, additionalDevicePrice, unlimitedDevices }]
//   offerName / offerDiscount — the winning active offer for that plan
//   (resolved by the single pricing resolver's deterministic rules).
// Consumers that ignore the new fields keep working unchanged. Legacy
// self-hosted plans (isSelfHosted) are still listed for the legacy /pricing
// page's "Self-Hosted / Enterprise" section, but carry no V1 pricing rows.

export async function GET(req: NextRequest) {
  try {
    const now = new Date();
    const plans = await db.plan.findMany({
      where: { isActive: true },
      orderBy: [{ priceMonthly: 'asc' }, { name: 'asc' }],
    });

    const planIds = plans.map((p) => p.id);
    const [pricings, offers] = await Promise.all([
      db.planPricing.findMany({ where: { planId: { in: planIds }, isActive: true } }),
      db.offer.findMany({ where: { isActive: true } }),
    ]);

    const matchingOffers = offers.filter(
      (o) => (!o.startsAt || o.startsAt <= now) && (!o.endsAt || o.endsAt > now),
    );

    return NextResponse.json({
      plans: plans.map((p) => {
        const rows = pricings
          .filter((r) => r.planId === p.id)
          .map((r) => ({
            deploymentMode: r.deploymentMode as 'MANAGED' | 'CUSTOMER_DB',
            billingPeriod: r.billingPeriod as 'MONTHLY' | 'YEARLY',
            basePrice: r.basePrice,
            currency: r.currency,
            includedDevices: r.deploymentMode === 'CUSTOMER_DB' ? null : r.includedDevices,
            additionalDevicePrice: r.deploymentMode === 'CUSTOMER_DB' ? null : r.additionalDevicePrice,
            unlimitedDevices: r.deploymentMode === 'CUSTOMER_DB',
          }));

        // Best offer for display (same precedence family as the resolver:
        // largest effective discount against the plan's monthly/yearly price).
        const candidates = matchingOffers.filter(
          (o) => (o.planId === null || o.planId === p.id),
        );
        const effective = (o: typeof candidates[number], base: number) =>
          o.isFree ? base : o.discountType === 'PERCENTAGE' ? (Math.min(o.discountValue, 100) / 100) * base : Math.min(o.discountValue, base);
        let best = candidates[0] ?? null;
        let bestAmount = -1;
        const refBase = Math.max(p.priceMonthly, p.priceYearly ?? 0, 1);
        for (const o of candidates) {
          const amount = effective(o, refBase);
          if (amount > bestAmount) {
            best = o;
            bestAmount = amount;
          }
        }

        return {
          // ── Legacy contract (unchanged) ──
          id: p.id,
          name: p.name,
          description: p.description,
          priceMonthly: p.priceMonthly,
          priceYearly: p.priceYearly,
          currency: p.currency,
          maxDevices: p.maxDevices,
          retentionDays: p.retentionDays,
          features: parsePlanFeatures(p.features),
          isSelfHosted: p.isSelfHosted,
          // ── V1 additive fields ──
          pricing: rows,
          offerName: best?.name ?? null,
          offerIsFree: best?.isFree ?? false,
        };
      }),
    });
  } catch (error) {
    log.error('api.plans.get', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch plans' }, { status: 500 });
  }
}

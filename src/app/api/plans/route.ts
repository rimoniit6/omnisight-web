import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { parsePlanFeatures } from '@/lib/subscription';
import { log, requestContext } from '@/lib/logger';

// GET /api/plans
// Public pricing catalog — no authentication required.
// Returns only active plans, with the features JSON normalized to an array.
//
// V1 additive extension:
//   pricing: [{ deploymentMode, billingPeriod, basePrice, currency,
//               includedDevices, additionalDevicePrice }]
//   offerName / offerIsFree — the winning active offer for that plan
//   (resolved by the single pricing resolver's deterministic rules).
// Both deployment modes use device-based entitlement (includedDevices +
// additionalDevicePrice). There are no "unlimited devices" in V1.

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
            includedDevices: r.includedDevices,
            additionalDevicePrice: r.additionalDevicePrice,
          }));

        // Best offer for display — uses the highest V1 basePrice across all
        // configured rows as the reference, never legacy Plan columns.
        // When no V1 pricing exists, no offer comparison is performed.
        const candidates = matchingOffers.filter(
          (o) => (o.planId === null || o.planId === p.id),
        );
        const effective = (o: typeof candidates[number], base: number) =>
          o.isFree ? base : o.discountType === 'PERCENTAGE' ? (Math.min(o.discountValue, 100) / 100) * base : Math.min(o.discountValue, base);
        let best: (typeof candidates)[number] | null = candidates[0] ?? null;
        let bestAmount = -1;
        const v1Prices = rows.filter((r) => r.basePrice > 0).map((r) => r.basePrice);
        const refBase = v1Prices.length > 0 ? Math.max(...v1Prices) : 0;
        let regularPrice = 0;
        let finalPrice = 0;
        let discountAmount = 0;
        if (refBase > 0) {
          for (const o of candidates) {
            const amount = effective(o, refBase);
            if (amount > bestAmount) {
              best = o;
              bestAmount = amount;
            }
          }
          regularPrice = refBase;
          if (best) {
            discountAmount = effective(best, refBase);
            finalPrice = Math.max(0, refBase - discountAmount);
          } else {
            finalPrice = refBase;
          }
        } else {
          best = null; // no configured pricing → no offer display
        }

        return {
          id: p.id,
          name: p.name,
          description: p.description,
          currency: p.currency,
          features: parsePlanFeatures(p.features),
          // NOTE: `isSelfHosted` was removed with the self-hosted architecture —
          // every catalog plan is a V1 MANAGED / CUSTOMER_DB plan.
          // ── V1 fields (source of truth) ──
          pricing: rows,
          hasActivePricing: rows.some((r) => r.basePrice > 0),
          offerName: best?.name ?? null,
          offerIsFree: best?.isFree ?? false,
          // ── Display fields for Landing Page (strikethrough + discount) ──
          regularPrice,
          finalPrice,
          discountAmount,
        };
      }),
    });
  } catch (error) {
    log.error('api.plans.get', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch plans' }, { status: 500 });
  }
}

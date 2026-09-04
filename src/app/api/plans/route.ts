import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { parsePlanFeatures } from '@/lib/subscription';
import { log, requestContext } from '@/lib/logger';

// GET /api/plans
// Public pricing catalog — no authentication required.
// Returns only active plans, with the features JSON normalized to an array.
export async function GET(req: NextRequest) {
  try {
    const plans = await db.plan.findMany({
      where: { isActive: true },
      orderBy: [{ priceMonthly: 'asc' }, { name: 'asc' }],
    });

    return NextResponse.json({
      plans: plans.map((p) => ({
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
      })),
    });
  } catch (error) {
    log.error('api.plans.get', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch plans' }, { status: 500 });
  }
}

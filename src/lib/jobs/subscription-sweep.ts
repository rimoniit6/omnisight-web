// Subscription expiry/suspension maintenance for the SaaS layer.
// Runs as a lease-guarded job ('subscription_sweep') from run.ts, alongside
// the existing scheduled jobs. Everything here is bounded and idempotent.

import { db } from '@/lib/db';

export interface SubscriptionSweepResult {
  expired: number;
  suspendedOrgs: number;
}

/**
 * Mark ACTIVE subscriptions whose endDate has passed as EXPIRED, and suspend
 * organizations with NO active subscription AND NO valid trial.
 *
 * The suspension pass is defensive — requireActiveSubscription denies lapsed
 * orgs regardless — it just keeps Organization.status in sync with reality so
 * the UI reflects the state promptly.
 */
export async function runSubscriptionSweep(now = new Date()): Promise<SubscriptionSweepResult> {
  // 1) ACTIVE subscriptions past their endDate -> EXPIRED
  const expired = await db.subscription.updateMany({
    where: { status: 'ACTIVE', endDate: { lt: now } },
    data: { status: 'EXPIRED' },
  });

  // 2) Suspension: orgs with no remaining active subscription and no valid
  //    trial -> 'suspended'. Only active orgs are considered; a manually
  //    archived org is never touched.
  const orgs = await db.organization.findMany({
    where: { status: 'active' },
    select: {
      id: true,
      trialEndsAt: true,
      subscription: { select: { status: true, endDate: true } },
    },
  });

  const toSuspend: string[] = [];
  for (const org of orgs) {
    const hasActiveSub =
      org.subscription !== null &&
      org.subscription.status === 'ACTIVE' &&
      (org.subscription.endDate === null || org.subscription.endDate > now);
    const inTrial = org.trialEndsAt !== null && org.trialEndsAt > now;
    if (!hasActiveSub && !inTrial) toSuspend.push(org.id);
  }

  let suspendedOrgs = 0;
  if (toSuspend.length) {
    const res = await db.organization.updateMany({
      where: { id: { in: toSuspend } },
      data: { status: 'suspended' },
    });
    suspendedOrgs = res.count;
  }

  return { expired: expired.count, suspendedOrgs };
}

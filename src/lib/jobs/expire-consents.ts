import { db } from '@/lib/db';
import { applyConsentTransition } from '@/lib/consent';
import type { ConsentStatus } from '@/lib/consent';

/**
 * Background processor: flips granted consents whose expiresAt window has
 * lapsed to 'expired' and writes a ConsentLog entry. Bounded to `limit` rows
 * per run so the scheduler stays fast; idempotent (only matches 'granted').
 */
export async function expireConsents(limit = 500): Promise<number> {
  const now = new Date();
  const expiring = await db.consent.findMany({
    where: { status: 'granted', expiresAt: { lt: now } },
    take: limit,
    select: { id: true, status: true, consentType: true, organizationId: true },
  });
  if (expiring.length === 0) return 0;

  await db.$transaction(async (tx) => {
    for (const c of expiring) {
      await applyConsentTransition(
        tx,
        { ...c, status: c.status as ConsentStatus },
        'expired',
        { performedBy: 'system', writeAuditLog: false, action: 'expired' }
      );
    }
  });
  return expiring.length;
}

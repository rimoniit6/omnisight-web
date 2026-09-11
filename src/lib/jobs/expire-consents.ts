import { db } from '@/lib/db';
import { getPrismaForOrg } from '@/lib/org-db';
import { applyConsentTransition } from '@/lib/consent';
import type { ConsentStatus } from '@/lib/consent';

/**
 * Background processor: flips granted consents whose expiresAt window has
 * lapsed to 'expired' and writes a ConsentLog entry. Bounded to `limit` rows
 * per org per run so the scheduler stays fast; idempotent (only matches
 * 'granted').
 *
 * Consents are org-owned (copied at activation), so the scan + transition
 * transaction run per organization on that org's OWN client — a global
 * platform scan would miss post-cutover rows entirely.
 */
export async function expireConsents(limit = 500): Promise<number> {
  const now = new Date();
  let total = 0;
  const orgs = await db.organization.findMany({ where: { status: 'active' }, select: { id: true } });
  for (const org of orgs) {
    const orgData = (await getPrismaForOrg(org.id)).client;
    // Org filter: on a shared platform client (org not yet activated) this
    // restricts the scan to THIS org's consents — otherwise every iteration
    // would re-expire (and re-log) the same rows once per org pass.
    const expiring = await orgData.consent.findMany({
      where: { organizationId: org.id, status: 'granted', expiresAt: { lt: now } },
      take: limit,
      select: { id: true, status: true, consentType: true, organizationId: true },
    });
    if (expiring.length === 0) continue;

    await orgData.$transaction(async (tx) => {
      for (const c of expiring) {
        await applyConsentTransition(
          tx,
          { ...c, status: c.status as ConsentStatus },
          'expired',
          { performedBy: 'system', writeAuditLog: false, action: 'expired' }
        );
      }
    });
    total += expiring.length;
  }
  return total;
}

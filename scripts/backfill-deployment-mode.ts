// Phase 1 Step 3: deployment-mode backfill (SAFE, explicit, non-destructive).
//
// Usage:
//   npx tsx scripts/backfill-deployment-mode.ts            # dry-run (default)
//   npx tsx scripts/backfill-deployment-mode.ts --apply    # write decisions
//
// Rules (see mapping table in output):
//   - No legacy signals     -> MANAGED (resolved, current behavior)
//   - useOwnDb only (analytics-only store, NOT primary-DB ownership)
//                           -> MANAGED + UNRESOLVED flag. A human must confirm
//     whether the PRIMARY database is customer-owned before anyone assigns
//     CUSTOMER_DB, because fail-closed tenant routing (Phase 1 Steps 5-7)
//     denies data-plane access to CUSTOMER_DB orgs without a configured
//     primary database. Auto-assigning it would break the org.
//
// NOTE: CUSTOMER_DB is never auto-assigned. It is reserved for explicit human
// assignment once a customer primary-database configuration exists.
//
// NOTE: the legacy license / self-hosted signals (Organization.licenseKeyId,
// Plan.isSelfHosted) were REMOVED with the LicenseKey architecture and are no
// longer consulted. PRIVATE is NOT a V1 service model and is never assigned by
// this script — pre-existing PRIVATE rows must be reviewed and moved to
// MANAGED or CUSTOMER_DB by a human.
//
// The script never deletes or modifies anything except deploymentMode /
// deploymentModeUnresolved on Organization rows (only with --apply). It never
// touches data-plane tables.

import { db } from '@/lib/db';

type Decision = {
  orgId: string;
  slug: string;
  name: string;
  signals: string[];
  mode: 'MANAGED' | 'CUSTOMER_DB';
  unresolved: boolean;
  reason: string;
};

async function decide(): Promise<Decision[]> {
  const orgs = await db.organization.findMany({
    select: {
      id: true,
      slug: true,
      name: true,
      customSettings: {
        select: { useOwnDb: true, dbHost: true, dbName: true, dbUser: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  return orgs.map((org) => {
    const signals: string[] = [];
    const ownDb = org.customSettings?.useOwnDb === true;
    const ownDbComplete =
      ownDb &&
      Boolean(org.customSettings?.dbHost) &&
      Boolean(org.customSettings?.dbName) &&
      Boolean(org.customSettings?.dbUser);
    if (ownDb) signals.push(ownDbComplete ? 'useOwnDb:complete' : 'useOwnDb:incomplete');

    const base = { orgId: org.id, slug: org.slug, name: org.name, signals };

    if (!ownDb) {
      return { ...base, mode: 'MANAGED' as const, unresolved: false, reason: 'no legacy signals — current single-DB behavior' };
    }
    // useOwnDb (complete or not): keep MANAGED and flag UNRESOLVED. useOwnDb is
    // an analytics-only credential store, not primary-DB ownership, so it must
    // never auto-assign CUSTOMER_DB.
    return {
      ...base,
      mode: 'MANAGED' as const,
      unresolved: true,
      reason: `UNRESOLVED — customer analytics-DB configured (${ownDbComplete ? 'complete' : 'incomplete'}); confirm PRIMARY-database ownership before assigning CUSTOMER_DB`,
    };
  });
}

async function main() {
  const apply = process.argv.includes('--apply');
  console.log('V1 service models: MANAGED | CUSTOMER_DB (PRIVATE is never assigned)');
  console.log(`Mode: ${apply ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);

  const decisions = await decide();
  console.log('slug | mode | unresolved | signals | reason');
  console.log('-----|------|------------|---------|-------');
  for (const d of decisions) {
    console.log(`${d.slug} | ${d.mode} | ${d.unresolved} | ${d.signals.join('+') || 'none'} | ${d.reason}`);
  }

  const unresolved = decisions.filter((d) => d.unresolved);
  console.log(`\nTotal: ${decisions.length}, UNRESOLVED: ${unresolved.length}`);
  if (unresolved.length > 0) {
    console.log('UNRESOLVED orgs (review required):');
    for (const d of unresolved) console.log(`  - ${d.slug} (${d.orgId}): ${d.reason}`);
  }

  if (apply) {
    for (const d of decisions) {
      await db.organization.update({
        where: { id: d.orgId },
        data: { deploymentMode: d.mode, deploymentModeUnresolved: d.unresolved },
      });
    }
    console.log('\nApplied deployment modes.');
  } else {
    console.log('\nDry-run complete — re-run with --apply to write.');
  }
}

main()
  .catch((e) => {
    console.error('Backfill failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });

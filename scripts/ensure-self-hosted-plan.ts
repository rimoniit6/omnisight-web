// OmniSight — production-safe bootstrap for the self-hosted plan.
//
// Seed.ts refuses to run in NODE_ENV=production. This dedicated bootstrap
// upserts ONLY the Enterprise_SelfHosted plan (the one that issues license
// keys), so a self-hosted Docker/VM deployment can ensure it exists without
// creating any demo data or touching users/orgs. Idempotent.
//
// Guards:
//   - SEED_ALLOWED=1 is required (explicit opt-in, matches seed.ts).
//   - Unlike seed.ts it is safe under NODE_ENV=production (no demo data).
//
// Usage: SEED_ALLOWED=1 tsx scripts/ensure-self-hosted-plan.ts

import { db } from '../src/lib/db';

async function main() {
  if (process.env.SEED_ALLOWED !== '1') {
    console.error('Refused: SEED_ALLOWED=1 is required (explicit opt-in).');
    process.exit(1);
  }

  const plan = {
    name: 'Enterprise_SelfHosted',
    description: 'Unlimited self-hosted deployment',
    priceMonthly: 0,
    priceYearly: 0,
    currency: 'BDT',
    maxDevices: -1, // unlimited
    retentionDays: 0, // unlimited
    isSelfHosted: true,
    isActive: true,
    features: [
      'basic_tracking',
      'screenshots',
      'reports',
      'export',
      'break_detection',
      'app_blocking',
      'location_tracking',
      'audit_logs',
      'custom_retention',
    ],
  };

  const result = await db.plan.upsert({
    where: { name: plan.name },
    update: plan,
    create: plan,
  });

  console.log(`[ensure-self-hosted-plan] ready: ${result.name} (id=${result.id}, maxDevices=${result.maxDevices})`);
}

main()
  .catch((e) => {
    console.error('Failed to ensure self-hosted plan:', e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });

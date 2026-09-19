// OmniSight — UAT dataset CLI: ensure UAT org + deterministic seed.
//
// Usage: SEED_ALLOWED=1 npx tsx --require ./tests/helpers/mock-server-only.cjs scripts/seed-uat-data.ts
//
// SAFETY:
//   • SEED_ALLOWED=1 is REQUIRED (same production guard as `db:seed:dev`).
//   • Re-running wipes and re-seeds ONLY the resolved UAT organization
//     (verified by ensureUatOrg + the wipe guard — never any other org).
//   • Credentials printed below are SYNTHETIC test placeholders documented in
//     docs/UAT-CHECKLIST.md — never production secrets.
//
// NOTE: The --require flag pre-seeds Node's require cache with a no-op
// `server-only` shim BEFORE tsx processes the module graph (same as
// scripts/seed-demo.ts). Without it `import 'server-only'` in src/lib throws
// outside the Next.js RSC bundler.

import { db } from '@/lib/db';
import {
  ensureUatOrg,
  ensureUatAdmin,
  wipeUatData,
  seedUatData,
  UAT_ADMIN_EMAIL,
  UAT_ADMIN_PASSWORD,
  UAT_AGENT_PASSWORD,
} from '../src/lib/uat/seed';

(async () => {
  if (process.env.SEED_ALLOWED !== '1') {
    console.error(
      '❌ SEED_ALLOWED=1 is required. This guard is a production safety gate — set it explicitly to seed UAT data.'
    );
    process.exit(1);
  }

  const { org, created } = await ensureUatOrg();
  console.log(`${created ? '✅' : 'ℹ️'} UAT org ${created ? 'created' : 'exists'}: ${org.name} (id=${org.id})`);

  const admin = await ensureUatAdmin(org.id);
  console.log(`${admin.created ? '✅' : 'ℹ️'} UAT admin ${admin.created ? 'created' : 'exists (left unchanged)'}: ${UAT_ADMIN_EMAIL}`);

  if (process.argv.includes('--wipe-only')) {
    await wipeUatData(org.id);
    console.log('✅ UAT data wiped (UAT org only).');
  } else {
    await wipeUatData(org.id);
    const result = await seedUatData(org.id);
    console.log('✅ UAT dataset seeded:', JSON.stringify(result, null, 2));
  }

  // Synthetic test-only credentials (see docs/UAT-CHECKLIST.md) — UAT org only.
  console.log(`   Admin login : ${UAT_ADMIN_EMAIL} / ${UAT_ADMIN_PASSWORD} (UAT test only)`);
  console.log(`   Agent login : <employeeId> / ${UAT_AGENT_PASSWORD} (UAT test only, 50 accounts)`);
  await db.$disconnect();
})().catch(async (e) => {
  console.error('❌ UAT seed failed:', e);
  await db.$disconnect();
  process.exit(1);
});
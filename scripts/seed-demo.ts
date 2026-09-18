// OmniSight — Demo dataset CLI: bootstrap (idempotent) + deterministic seed.
//
// Usage: npx tsx scripts/seed-demo.ts
// Safe to run repeatedly: re-running wipes and re-seeds ONLY the demo
// organization (verified by assertDemoOrg before any delete/write).

import { db } from '@/lib/db';
import { bootstrapDemo } from './bootstrap-demo';
import { resetDemoData, wipeDemoData } from '../src/lib/demo/seed';

(async () => {
  const b = await bootstrapDemo();
  if (process.argv.includes('--wipe-only')) {
    await wipeDemoData(b.demoOrgId);
    console.log('✅ Demo data wiped (demo org only).');
  } else {
    const r = await resetDemoData(b.demoOrgId);
    console.log('✅ Demo dataset seeded:', JSON.stringify(r, null, 2));
  }
  console.log(`   Demo org: ${b.demoOrgId} · Demo user: ${b.demoUserId}`);
  await db.$disconnect();
})().catch(async (e) => {
  console.error('❌ Demo seed failed:', e);
  await db.$disconnect();
  process.exit(1);
});

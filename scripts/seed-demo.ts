// OmniSight — Demo dataset CLI: bootstrap (idempotent) + deterministic seed.
//
// Usage: npx tsx --require ./tests/helpers/mock-server-only.cjs scripts/seed-demo.ts
// Safe to run repeatedly: re-running wipes and re-seeds ONLY the demo
// organization (verified by assertDemoOrg before any delete/write).
//
// NOTE: The --require flag pre-seeds Node's require cache with a no-op
// `server-only` shim BEFORE tsx processes the ESM module graph. Without it
// the `import 'server-only'` in src/lib modules throws because tsx runs
// outside the Next.js RSC bundler. A static `import` of the shim does NOT
// work here because ESM import hoisting evaluates all imports in dependency
// order — the shim would run too late.

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

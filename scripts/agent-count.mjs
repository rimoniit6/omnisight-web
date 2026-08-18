// Counts SOAK-tagged activity records — used by the offline-soak driver to
// verify exactly-once / no-loss semantics after each phase.
// Run: DATABASE_URL=file:../db/e2e-throwaway.db npx tsx scripts/agent-count.mjs
import { db } from '@/lib/db';

const tag = process.argv[2] || null;
const where = tag
  ? { title: { startsWith: 'SOAK' }, applicationName: tag }
  : { title: { startsWith: 'SOAK' } };
const n = await db.activity.count({ where });
console.log(String(n));
await db.$disconnect();

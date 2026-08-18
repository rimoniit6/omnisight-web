import { db } from '../src/lib/db';

(async () => {
  const rows = (await db.$queryRawUnsafe(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  )) as { tablename: string }[];
  console.log('total tables:', rows.length);
  for (const r of rows) console.log(' -', r.tablename);
  await db.$disconnect();
})();

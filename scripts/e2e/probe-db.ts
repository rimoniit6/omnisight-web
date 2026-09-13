import 'dotenv/config';
import { db } from '@/lib/db';

async function main() {
  const taps = await db.$queryRawUnsafe(
    `SELECT trigger_name, event_object_table FROM information_schema.triggers WHERE trigger_name LIKE '%screenshot%' ORDER BY event_object_table`
  );
  const onScreenshot = await db.$queryRawUnsafe(
    `SELECT trigger_name FROM information_schema.triggers WHERE event_object_table='Screenshot' ORDER BY trigger_name`
  );
  const tbl = await db.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name='RealtimeScreenshotEvent'`
  );
  const sig = await db.realtimeScreenshotEvent.count();
  console.log('triggers containing "screenshot":', JSON.stringify(taps));
  console.log('triggers on Screenshot table:', JSON.stringify(onScreenshot));
  console.log('RealtimeScreenshotEvent exists:', (tbl as { n: number }[])[0].n === 1, '| rows:', sig);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
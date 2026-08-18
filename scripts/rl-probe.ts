import { db } from '../src/lib/db';
import { checkRateLimit } from '../src/lib/rate-limit';

async function main() {
  const key = `probe:${Date.now()}`;
  for (let i = 0; i < 3; i += 1) {
    const rl = await checkRateLimit(key, 10, 5 * 60 * 1000);
    console.log(`attempt ${i + 1}: allowed=${rl.allowed} remaining=${rl.remaining} retryAfter=${rl.retryAfterSeconds}`);
  }
  const rows = await db.rateLimitCounter.findMany({ where: { key } });
  console.log('rows:', rows.map((r) => ({ key: r.key, tokens: r.tokens, updatedAt: r.updatedAt })));
  await db.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

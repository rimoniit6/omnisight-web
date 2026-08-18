/**
 * Shared (PostgreSQL-backed) rate limiter tests — R1 closure.
 *
 * Proves the token bucket is topology-independent:
 *   RL-1  limit honored sequentially (10 allowed, 11th rejected)
 *   RL-2  concurrent race — exactly `limit` winners among N parallel calls
 *   RL-3  two separate Prisma clients (two app processes) share one counter
 *   RL-4  time-based refill (window expiry) restores tokens
 *   RL-5  independent keys are independent
 *   RL-6  fail-closed on store outage for security-critical keys; fail-open
 *         for convenience throttles
 *   RL-7  counter rows are created in the shared table (persistence)
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_ratelimit).
 * Run: npx tsx --test tests/rate-limit-shared.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_ratelimit';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-ratelimit-0123456789abc';
(process.env as Record<string, string>).NODE_ENV = 'test';

let checkRateLimit: (key: string, limit: number, windowMs: number) => Promise<{
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}>;
let db: PrismaClient;

before(async () => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', { env: { ...process.env, DATABASE_URL: TEST_DB_URL }, stdio: 'pipe' });
  db = new PrismaClient();
  checkRateLimit = (await import('../src/lib/rate-limit')).checkRateLimit;
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  } catch {
    /* best effort */
  }
});

test('RL-1: limit honored sequentially — 10 allowed, 11th rejected', async () => {
  const key = `rl-1:${Date.now()}`;
  const results = [];
  for (let i = 0; i < 12; i++) results.push(await checkRateLimit(key, 10, 60_000));
  assert.equal(results.filter((r) => r.allowed).length, 10, 'exactly 10 allowed');
  assert.equal(results.filter((r) => !r.allowed).length, 2, 'remaining rejected');
  assert.ok(results[10].retryAfterSeconds >= 1, 'rejection carries retryAfterSeconds');
});

test('RL-2: concurrent race — exactly `limit` winners among parallel calls', async () => {
  const key = `rl-2:${Date.now()}`;
  const attempts = await Promise.all(
    Array.from({ length: 25 }, () => checkRateLimit(key, 10, 60_000))
  );
  const allowed = attempts.filter((r) => r.allowed).length;
  assert.equal(allowed, 10, `exactly 10 of 25 concurrent requests allowed (got ${allowed})`);
});

test('RL-3: two Prisma clients (two app instances) share one counter', async () => {
  const key = `rl-3:${Date.now()}`;
  const other = new PrismaClient(); // simulates a second application process
  try {
    const res = [];
    // Interleave requests from both clients against the SAME key — a shared
    // store must produce ONE combined bucket regardless of which process
    // serves the request.
    for (let i = 0; i < 6; i++) res.push(await checkRateLimit(key, 10, 60_000));
    for (let i = 0; i < 6; i++) res.push(await checkRateLimitFrom(other, key));
    const allowed = res.filter((r) => r.allowed).length;
    assert.equal(allowed, 10, `two instances share one bucket (got ${allowed})`);
  } finally {
    await other.$disconnect();
  }
});

// Helper bound to an arbitrary Prisma client: replicates checkRateLimit's SQL
// verbatim so cross-instance sharing is proven at the STORE level (a second
// process would issue exactly this statement against the same table).
async function checkRateLimitFrom(client: PrismaClient, key: string) {
  const limit = 10;
  const now = Date.now();
  const rows = await client.$queryRaw<Array<{ tokens: number }>>`
    INSERT INTO "RateLimitCounter" ("key", tokens, "lastRefill", "updatedAt")
    VALUES (${key}, ${limit}::double precision - 1, ${now}::bigint, now())
    ON CONFLICT ("key") DO UPDATE SET
      tokens = LEAST(${limit}::double precision, "RateLimitCounter".tokens + (${limit}::double precision / ${60_000}::double precision) * (${now}::bigint - "RateLimitCounter"."lastRefill")::double precision) - 1,
      "lastRefill" = GREATEST("RateLimitCounter"."lastRefill", ${now}::bigint),
      "updatedAt" = now()
    RETURNING tokens
  `;
  const tokens = Number(rows[0]?.tokens ?? limit - 1);
  return { allowed: tokens >= 0, limit, remaining: Math.max(0, Math.floor(tokens)), retryAfterSeconds: 0 };
}

test('RL-4: time-based refill restores tokens (window expiry)', async () => {
  const key = `rl-4:${Date.now()}`;
  // Drain the bucket (limit 2 over a 1-second window → 1 token/sec refill).
  assert.equal((await checkRateLimit(key, 2, 1000)).allowed, true);
  assert.equal((await checkRateLimit(key, 2, 1000)).allowed, true);
  assert.equal((await checkRateLimit(key, 2, 1000)).allowed, false, 'drained');
  // Backdate the refill so the bucket is full again (simulates window expiry).
  await db.$executeRaw`UPDATE "RateLimitCounter" SET "lastRefill" = ${Date.now() - 5000}::bigint WHERE "key" = ${key}`;
  assert.equal((await checkRateLimit(key, 2, 1000)).allowed, true, 'refilled after window passed');
});

test('RL-5: independent keys are independent', async () => {
  const k1 = `rl-5a:${Date.now()}`;
  const k2 = `rl-5b:${Date.now()}`;
  for (let i = 0; i < 10; i++) await checkRateLimit(k1, 10, 60_000);
  assert.equal((await checkRateLimit(k1, 10, 60_000)).allowed, false, 'k1 exhausted');
  assert.equal((await checkRateLimit(k2, 10, 60_000)).allowed, true, 'k2 unaffected');
});

test('RL-6: fail-closed for security-critical keys, fail-open for convenience, on store outage', async () => {
  // Simulate a store outage by renaming the table out of existence.
  await db.$executeRawUnsafe(`ALTER TABLE "RateLimitCounter" RENAME TO "RateLimitCounter_gone"`);
  try {
    const securityCritical = await checkRateLimit(`login:203.0.113.7:user@x.com`, 10, 60_000);
    assert.equal(securityCritical.allowed, false, 'security-critical key FAILS CLOSED on store outage');
    assert.ok(securityCritical.retryAfterSeconds >= 1, 'denial carries a retry hint');

    const convenience = await checkRateLimit(`agent-heartbeat:tok-abc`, 600, 60_000);
    assert.equal(convenience.allowed, true, 'convenience throttle fails OPEN on store outage');
  } finally {
    await db.$executeRawUnsafe(`ALTER TABLE "RateLimitCounter_gone" RENAME TO "RateLimitCounter"`);
  }
  // Restored: the limiter works again.
  assert.equal((await checkRateLimit(`rl-6:${Date.now()}`, 1, 60_000)).allowed, true);
});

test('RL-7: counters persist in the shared table (visible to any instance)', async () => {
  const key = `rl-7:${Date.now()}`;
  for (let i = 0; i < 4; i++) await checkRateLimit(key, 10, 60_000);
  const row = await db.rateLimitCounter.findUnique({ where: { key } });
  assert.ok(row, 'counter row persisted');
  assert.ok(row.tokens < 6.5, `tokens reflect consumption (got ${row.tokens})`);
});

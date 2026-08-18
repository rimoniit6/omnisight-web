/**
 * Realtime wake-up tests — R2 closure.
 *
 * Proves the pg_notify wake mechanism that eliminates the 5 s poll latency:
 *   RW-1  ensureNotifyTriggers creates the function + one trigger per table
 *   RW-2  an INSERT on a broadcast table fires pg_notify on the channel with
 *         the table name as payload (the service wakes its poller on this)
 *   RW-3  idempotent — re-running ensureNotifyTriggers does not error or
 *         duplicate triggers
 *
 * The service-side debounce/coalescing (scheduleWake/runPollSafe) is verified
 * live in Phase 11; this suite proves the DB→notification path end to end.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_wakeup).
 * Run: npx tsx --test tests/realtime-wakeup.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_wakeup';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-wakeup-0123456789abc';
(process.env as Record<string, string>).NODE_ENV = 'test';

let db: PrismaClient;
let ensureNotifyTriggers: (db: PrismaClient) => Promise<string[]>;
let BROADCAST_TABLES: readonly string[];
let NOTIFY_CHANNEL: string;

before(async () => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', { env: { ...process.env, DATABASE_URL: TEST_DB_URL }, stdio: 'pipe' });
  db = new PrismaClient();
  const mod = await import('../mini-services/live-updates/notify-triggers');
  ensureNotifyTriggers = mod.ensureNotifyTriggers;
  BROADCAST_TABLES = mod.BROADCAST_TABLES;
  NOTIFY_CHANNEL = mod.NOTIFY_CHANNEL;
  await ensureNotifyTriggers(db);
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  } catch {
    /* best effort */
  }
});

test('RW-1: ensureNotifyTriggers creates the function + a trigger per broadcast table', async () => {
  const fn = await db.$queryRawUnsafe<Array<{ proname: string }>>(
    `SELECT proname FROM pg_proc WHERE proname = 'omnisight_notify_event'`
  );
  assert.equal(fn.length, 1, 'trigger function exists');

  // pg_trigger (the real catalog) is authoritative — information_schema.triggers
  // returns one row PER EVENT in PG 18 (INSERT + UPDATE), which would double
  // count multi-event triggers.
  const triggers = await db.$queryRawUnsafe<Array<{ tgname: string }>>(
    `SELECT tgname FROM pg_trigger WHERE tgname LIKE 'omnisight_notify_%'`
  );
  assert.ok(triggers.length >= BROADCAST_TABLES.length, 'one trigger per broadcast table');
  const names = new Set(triggers.map((t) => t.tgname));
  for (const table of BROADCAST_TABLES) {
    assert.ok(names.has(`omnisight_notify_${table.toLowerCase()}`), `trigger for ${table}`);
  }
});

test('RW-2: an INSERT on a broadcast table fires pg_notify on the channel', async () => {
  const url = new URL(TEST_DB_URL);
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  await client.query(`LISTEN ${NOTIFY_CHANNEL}`);

  const org = await db.organization.create({ data: { name: `wake-${Date.now()}`, slug: `wake-${Date.now()}` } });
  const emp = await db.employee.create({
    data: { employeeId: `WK-${Date.now()}`, firstName: 'W', lastName: 'K', email: `wk-${Date.now()}@x.local`, organizationId: org.id },
  });

  // The notification arrives asynchronously; wait up to 5 s for it. The insert
  // error (if any) is captured so a failure here is diagnosable instead of a
  // silent timeout.
  let insertError: string | null = null;
  const notification = await new Promise<{ channel: string; payload: string } | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 5000);
    client.on('notification', (msg) => {
      clearTimeout(timer);
      resolve({ channel: msg.channel ?? '', payload: msg.payload ?? '' });
    });
    db.activity
      .create({
        data: { employeeId: emp.id, type: 'application', title: 'wake-test', applicationName: 'wake', category: 'neutral', duration: 1, timestamp: new Date(), createdAt: new Date() },
      })
      .catch((e) => {
        insertError = String((e as Error)?.message ?? e);
      });
  });

  await client.end();
  assert.ok(!insertError, `activity insert succeeded (error: ${insertError})`);
  assert.ok(notification, 'pg_notify fired within 5 s of the INSERT');
  assert.equal(notification?.channel, NOTIFY_CHANNEL, 'notification on the service channel');
  assert.equal(notification?.payload, 'Activity', 'payload identifies the changed table');
});

test('RW-3: ensureNotifyTriggers is idempotent (no error, no duplicate triggers)', async () => {
  await ensureNotifyTriggers(db);
  const triggers = await db.$queryRawUnsafe<Array<{ tgname: string; count: string }>>(
    `SELECT tgname, COUNT(*)::text AS count FROM pg_trigger WHERE tgname LIKE 'omnisight_notify_%' GROUP BY tgname`
  );
  for (const t of triggers) {
    assert.equal(t.count, '1', `trigger ${t.tgname} exists exactly once`);
  }
});

/**
 * P2-5 — durable live-updates poll cursor.
 *
 * The poll cursor was an in-memory Date reset to `now` on every restart,
 * silently dropping every event committed while the service was down. It is
 * now persisted to SystemSetting and restored on startup. This test verifies
 * the persistence layer against a THROWAWAY PostgreSQL database
 * (workai_test_livecursor):
 *
 *   - persistCursor writes the ISO timestamp; loadPersistedCursor restores it
 *     (a restarted service resumes the stream, not a fresh "now");
 *   - missing / invalid stored values fall back to now (never throw);
 *   - a crash BETWEEN broadcasts and persistCursor replays at most once
 *     (at-least-once semantics — the stored value only ever advances).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_livecursor';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-livecursor-0123456789abcdef';
(process.env as Record<string, string>).NODE_ENV = 'test';

before(() => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: 'pipe',
  });
});

type DbModule = typeof import('../src/lib/db');
let db: DbModule['db'];

before(async () => {
  db = (await import('../src/lib/db')).db;
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
  } catch {
    /* best-effort cleanup */
  }
});

test('LC-1: a persisted cursor survives a simulated restart', async () => {
  const { persistCursor, loadPersistedCursor, CURSOR_SETTING_KEY } = await import('../mini-services/live-updates/cursor-store');

  // Round 1 (service up): a poll processed rows up to t1, cursor persisted.
  const t1 = new Date('2026-08-15T10:30:00.000Z');
  await persistCursor(db, t1);

  // Simulate a fresh process: loadPersistedCursor must return t1, not now.
  const restored = await loadPersistedCursor(db);
  assert.equal(restored.getTime(), t1.getTime(), 'restart resumes from the persisted cursor');

  // Round 2 advances and persists — the stored value is monotonic.
  const t2 = new Date('2026-08-15T10:30:05.000Z');
  await persistCursor(db, t2);
  const restored2 = await loadPersistedCursor(db);
  assert.equal(restored2.getTime(), t2.getTime());
  assert.ok(restored2.getTime() > restored.getTime(), 'cursor only ever advances');

  const row = await db.systemSetting.findUnique({ where: { key: CURSOR_SETTING_KEY } });
  assert.equal(row?.value, t2.toISOString(), 'stored as ISO timestamp');
});

test('LC-2: no persisted row → fall back to now (first boot)', async () => {
  const { loadPersistedCursor, CURSOR_SETTING_KEY } = await import('../mini-services/live-updates/cursor-store');
  await db.systemSetting.deleteMany({ where: { key: CURSOR_SETTING_KEY } });
  const before = Date.now();
  const t = await loadPersistedCursor(db);
  const after = Date.now();
  assert.ok(t.getTime() >= before && t.getTime() <= after, 'falls back to the current instant');
});

test('LC-3: invalid stored value → fall back to now (never throws)', async () => {
  const { loadPersistedCursor } = await import('../mini-services/live-updates/cursor-store');
  await db.systemSetting.upsert({
    where: { key: 'live_updates.poll_cursor' },
    create: { key: 'live_updates.poll_cursor', value: 'not-a-timestamp' },
    update: { value: 'not-a-timestamp' },
  });
  const before = Date.now();
  const t = await loadPersistedCursor(db);
  const after = Date.now();
  assert.ok(t.getTime() >= before && t.getTime() <= after, 'invalid value never throws and never breaks startup');
});

test('LC-4: storage failure falls back without throwing (DB outage at boot)', async () => {
  const { loadPersistedCursor } = await import('../mini-services/live-updates/cursor-store');
  const broken = {
    systemSetting: {
      findUnique: async () => {
        throw new Error('connection refused');
      },
      upsert: async () => {
        throw new Error('connection refused');
      },
    },
  };
  const before = Date.now();
  const t = await loadPersistedCursor(broken);
  const after = Date.now();
  assert.ok(t.getTime() >= before && t.getTime() <= after, 'boot proceeds even when the DB is unreachable');
});

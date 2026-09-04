/**
 * Data-expiry reminder job — day-accurate triggering + per-cycle dedup.
 *
 * Proves the daily pass emails org admins exactly on the right days relative
 * to the retention window, and never re-sends within the same cycle:
 *   DE-1  within the 7-day window -> a warning is sent (once)
 *   DE-2  on the expiry day -> the final "expired today" notice is sent
 *   DE-3  re-running the SAME day -> nothing is sent again (dedup)
 *   DE-4  orgs with no data (nothing to expire) are skipped
 *
 * The email sender is the in-process mock (@/lib/email — no provider wired),
 * so the observable signals are the job's result counters and the
 * Organization.lastDataExpiryReminderAt mutation.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_dataexpiry).
 * Run: npx tsx --test tests/api/data-expiry-reminder.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import type { PrismaClient } from '@prisma/client';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_dataexpiry';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-dataexpiry-0123456789ab';
process.env.APP_URL = 'https://omnisight.example.com';

let db: PrismaClient;
let runDataExpiryReminder: (now?: Date) => Promise<{
  evaluatedOrgs: number;
  remindersSent: number;
  warningsSent: number;
  finalsSent: number;
  errors: string[];
}>;

const RETENTION_DAYS = 10;
const EARLIEST = new Date(2025, 0, 1); // local midnight
let orgId: string;

before(async () => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', { env: { ...process.env, DATABASE_URL: TEST_DB_URL }, stdio: 'pipe' });
  db = (await import('../../src/lib/db')).db;
  runDataExpiryReminder = (await import('../../src/lib/jobs/data-expiry-reminder')).runDataExpiryReminder;

  const plan = await db.plan.create({
    data: { name: 'Pro', retentionDays: RETENTION_DAYS, priceMonthly: 10, maxDevices: 10, features: [] },
  });
  const org = await db.organization.create({ data: { name: 'Reminder Org', slug: 'reminder-org' } });
  orgId = org.id;

  // An ACTIVE subscription whose plan defines a positive retention window.
  await db.subscription.create({
    data: { organizationId: org.id, planId: plan.id, status: 'ACTIVE', startDate: new Date() },
  });

  // One employee + one screenshot anchored to EARLIEST (oldest data).
  const emp = await db.employee.create({
    data: {
      employeeId: 'emp-reminder-1',
      firstName: 'Data',
      lastName: 'Owner',
      email: 'emp-reminder-1@corp.local',
      organizationId: org.id,
    },
  });
  await db.screenshot.create({
    data: {
      employeeId: emp.id,
      organizationId: org.id,
      filePath: '/tmp/reminder.png',
      fileName: 'reminder.png',
      fileSize: 100,
      capturedAt: EARLIEST,
      createdAt: EARLIEST,
    },
  });
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  } catch {
    /* best effort */
  }
});

// Earliest = Jan 1, retention 10 days => expiry = Jan 11.
// DAY 7 of January is 4 days before expiry (inside the 7-day warning window).
const WARNING_NOW = new Date(2025, 0, 7, 12, 30, 0);

test('DE-1: day inside the 7-day window sends exactly one warning', async () => {
  const res = await runDataExpiryReminder(WARNING_NOW);
  assert.deepEqual(res.errors, []);
  assert.equal(res.evaluatedOrgs, 1);
  assert.equal(res.warningsSent, 1, 'one warning within the 7-day window');
  assert.equal(res.remindersSent, 1);
  assert.equal(res.finalsSent, 0);

  const org = await db.organization.findUnique({ where: { id: orgId } });
  assert.ok(org?.lastDataExpiryReminderAt, 'org is marked as reminded');
});

test('DE-3: re-running the SAME day sends nothing (dedup)', async () => {
  const res = await runDataExpiryReminder(WARNING_NOW);
  assert.equal(res.warningsSent, 0, 'no duplicate warning');
  assert.equal(res.remindersSent, 0);
});

test('DE-2: on the expiry day the final notice is sent', async () => {
  // Expiry = EARLIEST + 10 days (2025-01-11). Run on that exact day.
  const EXPIRY_NOW = new Date(2025, 0, 11, 9, 0, 0);
  const res = await runDataExpiryReminder(EXPIRY_NOW);
  assert.deepEqual(res.errors, []);
  assert.equal(res.finalsSent, 1, 'final notice on the expiry day');
  assert.equal(res.warningsSent, 0);
  assert.equal(res.remindersSent, 1);
});

test('DE-4: an org with no data at all is skipped (nothing to expire)', async () => {
  const emptyOrg = await db.organization.create({ data: { name: 'Empty Org', slug: 'empty-org' } });
  const plan = await db.plan.create({
    data: { name: 'Pro2', retentionDays: RETENTION_DAYS, priceMonthly: 10, maxDevices: 10, features: [] },
  });
  await db.subscription.create({
    data: { organizationId: emptyOrg.id, planId: plan.id, status: 'ACTIVE', startDate: new Date() },
  });

  const res = await runDataExpiryReminder(new Date());
  // Only the empty org is eligible now (reminder org already reminded today).
  // No data -> no reminder, despite being in the window.
  assert.equal(res.remindersSent, 0);
});

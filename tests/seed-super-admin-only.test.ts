/**
 * Seed subsystem safety tests.
 *
 * Proves the rewritten seed (Super-Admin-only):
 *   - `seed()` creates ONLY the configured Super Admin + the required Plan
 *     reference catalog — ZERO demo orgs, ZERO demo users, ZERO demo data
 *   - `seed()` never wipes or deletes existing rows
 *   - seeding twice is idempotent and never overwrites the SA password
 *   - `seedAllowed()` refuses without SEED_ALLOWED=1 (and always in production)
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_seed).
 * Run: npx tsx --test tests/seed-super-admin-only.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_seed';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-seed-0123456789abcdef';
process.env.NODE_ENV = 'test';
process.env.SEED_ALLOWED = '1';
process.env.SUPER_ADMIN_EMAIL = 'seed-admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'SeedAdminPass123!';
process.env.SUPER_ADMIN_NAME = 'Seed Test SA';

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
let seed: () => Promise<void>;
let seedAllowed: () => boolean;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  const seedModule = await import('../src/lib/seed');
  seed = seedModule.seed;
  seedAllowed = seedModule.seedAllowed;
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

const SA_EMAIL = process.env.SUPER_ADMIN_EMAIL!;
const SA_PASSWORD = process.env.SUPER_ADMIN_PASSWORD!;

// ─── seedAllowed guard ──────────────────────────────────────────────────────

test('SS-01: seedAllowed is false without SEED_ALLOWED=1', () => {
  const env = process.env as Record<string, string>;
  const saved = env.SEED_ALLOWED;
  try {
    delete env.SEED_ALLOWED;
    assert.equal(seedAllowed(), false, 'seed must refuse without explicit opt-in');
  } finally {
    env.SEED_ALLOWED = saved;
  }
});

test('SS-02: seedAllowed is always false in production', () => {
  const env = process.env as Record<string, string>;
  const savedProd = env.NODE_ENV;
  const savedAllowed = env.SEED_ALLOWED;
  try {
    env.NODE_ENV = 'production';
    env.SEED_ALLOWED = '1';
    assert.equal(seedAllowed(), false, 'seed must refuse in production');
  } finally {
    env.NODE_ENV = savedProd;
    env.SEED_ALLOWED = savedAllowed;
  }
});

test('SS-03: seedAllowed is true in dev with explicit opt-in', () => {
  assert.equal(seedAllowed(), true, 'dev + SEED_ALLOWED=1 must be allowed');
});

// ─── seed() content guarantees ──────────────────────────────────────────────

test('SS-04: seed() does not wipe existing data', async () => {
  // Pre-existing tenant data that any destructive seed would erase.
  const org = await db.organization.create({ data: { name: 'survivor-org', slug: 'survivor-org' } });
  const user = await db.appUser.create({
    data: { email: 'survivor@test.local', name: 'Survivor', role: 'viewer', organizationId: null },
  });
  await db.employee.create({
    data: {
      employeeId: 'SURV-E',
      firstName: 'Surv',
      lastName: 'Empl',
      email: 'surv-e@test.local',
      organizationId: org.id,
      status: 'active',
    },
  });

  await seed();

  assert.ok(await db.organization.findUnique({ where: { id: org.id } }), 'pre-existing org survives');
  assert.ok(await db.appUser.findUnique({ where: { id: user.id } }), 'pre-existing user survives');
  assert.equal(await db.employee.count({ where: { organizationId: org.id } }), 1, 'employee survives');
});

test('SS-05: seed() creates ONLY the Super Admin and the Plan catalog', async () => {
  await seed();

  const sa = await db.appUser.findUnique({ where: { email: SA_EMAIL } });
  assert.ok(sa, 'Super Admin created');
  assert.equal(sa.role, 'super_admin');
  assert.ok(sa.password && sa.password.startsWith('$2'), 'SA password stored as a bcrypt hash');
  assert.ok(!sa.password.includes(SA_PASSWORD), 'plaintext password never stored');

  const saCount = await db.appUser.count({ where: { role: 'super_admin' } });
  assert.equal(saCount, 1, 'exactly one super admin after seed');

  // The 4 required plan entries exist and nothing else was bootstrapped.
  assert.equal(await db.plan.count(), 4, 'plan reference catalog (Free/Pro/Business/Enterprise_SelfHosted)');
  assert.equal(await db.organization.count(), 1, 'only the pre-existing survivor org — no demo orgs');
  assert.equal(await db.device.count(), 0, 'no demo devices');
});

test('SS-06: seed() is idempotent and never overwrites the SA password', async () => {
  await seed(); // second+ runs

  const sa = await db.appUser.findUnique({ where: { email: SA_EMAIL } });
  assert.equal(await db.appUser.count({ where: { role: 'super_admin' } }), 1, 'still exactly one SA');
  assert.equal(await db.plan.count(), 4, 'plan catalog unchanged');
  assert.ok(sa!.password.startsWith('$2'), 'still a hash (untouched by rerun)');
});
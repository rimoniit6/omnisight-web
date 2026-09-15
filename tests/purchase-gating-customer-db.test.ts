/**
 * CUSTOMER_DB PURCHASE GATING — isCustomerDbReady() unit tests.
 *
 * Proves the infrastructure-readiness check that gates CUSTOMER_DB subscription
 * activation works correctly. This is the core logic added in Phase 2.
 *
 *   PG-01  No settings at all → not ready
 *   PG-02  useOwnDb=false → not ready (MANAGED org)
 *   PG-03  useOwnDb=true but host/name/user missing → not ready
 *   PG-04  useOwnDb=true, config complete, test not run → not ready
 *   PG-05  useOwnDb=true, config complete, test 'failed' → not ready
 *   PG-06  useOwnDb=true, config complete, test 'success' → READY
 *   PG-07  useOwnDb=true, config complete, test 'pending' → not ready
 *   PG-08  MANAGED purchase activation path is unaffected (no gate)
 *
 * Run: npx tsx --test tests/purchase-gating-customer-db.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_purchase_gating';

process.env.DATABASE_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;
process.env.DIRECT_URL = process.env.DATABASE_URL;
(process.env as Record<string, string>).NODE_ENV = 'test';

let db: import('../src/lib/db').Db['db'];
let managedOrgId: string;
let cdbOrgId: string;

before(async () => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', { env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, DIRECT_URL: process.env.DIRECT_URL }, stdio: 'pipe' });

  const { db: database } = await import('../src/lib/db');
  db = database;

  managedOrgId = (await db.organization.create({
    data: { name: 'Managed Test Org', slug: 'pg-managed', email: 'managed@pg-test.local', deploymentMode: 'MANAGED', status: 'active' },
  })).id;

  cdbOrgId = (await db.organization.create({
    data: { name: 'CDB Test Org', slug: 'pg-cdb', email: 'cdb@pg-test.local', deploymentMode: 'CUSTOMER_DB', status: 'active' },
  })).id;
});

after(async () => {
  // Close cache invalidation LISTEN connection so it doesn't hold the test DB open
  const { resetCacheInvalidationState } = await import('../src/lib/cache-invalidation').catch(() => ({ resetCacheInvalidationState: async () => {} }));
  await resetCacheInvalidationState();

  if (db) await db.$disconnect();
  try {
    const { PrismaClient } = await import('@prisma/client');
    const admin = new PrismaClient({ datasources: { db: { url: `${PG_TEST_BASE}/postgres?schema=public` } }, log: ['error'] });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}"`);
    await admin.$disconnect();
  } catch { /* ignore cleanup errors */ }
});

// ── PG-01: No settings → not ready ──────────────────────────────────────
test('PG-01: organization with no settings is not ready', async () => {
  const { isCustomerDbReady } = await import('../src/lib/org-db');
  // Use a non-existent org ID
  const result = await isCustomerDbReady('non-existent-org-id');
  assert.equal(result.ready, false);
  assert.ok(result.reason.includes('not found') || result.reason.includes('settings'));
});

// ── PG-02: useOwnDb=false → not ready (MANAGED org) ────────────────────
test('PG-02: MANAGED org without own DB is not ready', async () => {
  const { isCustomerDbReady } = await import('../src/lib/org-db');
  // Create settings for the managed org with useOwnDb=false (default)
  await db.organizationSettings.create({
    data: { organizationId: managedOrgId, useOwnDb: false },
  });
  const result = await isCustomerDbReady(managedOrgId);
  assert.equal(result.ready, false);
  assert.ok(result.reason.includes('not enabled') || result.reason.includes('useOwnDb=false'));
});

// ── PG-03: useOwnDb=true but incomplete config → not ready ─────────────
test('PG-03: CUSTOMER_DB with incomplete config is not ready', async () => {
  const { isCustomerDbReady } = await import('../src/lib/org-db');
  await db.organizationSettings.create({
    data: {
      organizationId: cdbOrgId,
      useOwnDb: true,
      dbHost: null, // incomplete
      dbName: null,
      dbUser: null,
    },
  });
  const result = await isCustomerDbReady(cdbOrgId);
  assert.equal(result.ready, false);
  assert.ok(result.reason.includes('incomplete'));
});

// ── PG-04: Complete config but test not run → not ready ─────────────────
test('PG-04: CUSTOMER_DB with complete config but test not run is not ready', async () => {
  const org = await db.organization.create({
    data: { name: 'CDB Pending Org', slug: 'pg-cdb-pending', email: 'pending@pg-test.local', deploymentMode: 'CUSTOMER_DB', status: 'active' },
  });
  await db.organizationSettings.create({
    data: {
      organizationId: org.id,
      useOwnDb: true,
      dbHost: 'localhost',
      dbName: 'somedb',
      dbUser: 'admin',
      dbTestStatus: null, // not yet tested
    },
  });
  const { isCustomerDbReady } = await import('../src/lib/org-db');
  const result = await isCustomerDbReady(org.id);
  assert.equal(result.ready, false);
  assert.ok(result.reason.includes('not-run') || result.reason.includes('not passing'));
});

// ── PG-05: Complete config but test failed → not ready ──────────────────
test('PG-05: CUSTOMER_DB with failed connection test is not ready', async () => {
  const org = await db.organization.create({
    data: { name: 'CDB Failed Org', slug: 'pg-cdb-failed', email: 'failed@pg-test.local', deploymentMode: 'CUSTOMER_DB', status: 'active' },
  });
  await db.organizationSettings.create({
    data: {
      organizationId: org.id,
      useOwnDb: true,
      dbHost: 'localhost',
      dbName: 'somedb',
      dbUser: 'admin',
      dbTestStatus: 'failed',
    },
  });
  const { isCustomerDbReady } = await import('../src/lib/org-db');
  const result = await isCustomerDbReady(org.id);
  assert.equal(result.ready, false);
  assert.ok(result.reason.includes('failed'));
});

// ── PG-06: Complete config + success test → READY ───────────────────────
test('PG-06: CUSTOMER_DB with complete config and successful test is ready', async () => {
  await db.organizationSettings.update({
    where: { organizationId: cdbOrgId },
    data: {
      dbHost: 'db.example.com',
      dbName: 'customerdb',
      dbUser: 'admin',
      dbTestStatus: 'success',
    },
  });
  const { isCustomerDbReady } = await import('../src/lib/org-db');
  const result = await isCustomerDbReady(cdbOrgId);
  assert.deepEqual(result, { ready: true });
});

// ── PG-07: Complete config but test in 'pending' state → not ready ──────
test('PG-07: CUSTOMER_DB with pending test status is not ready', async () => {
  const org = await db.organization.create({
    data: { name: 'CDB Pending Test Org', slug: 'pg-cdb-pending-test', email: 'pendingtest@pg-test.local', deploymentMode: 'CUSTOMER_DB', status: 'active' },
  });
  await db.organizationSettings.create({
    data: {
      organizationId: org.id,
      useOwnDb: true,
      dbHost: 'db.example.com',
      dbName: 'customerdb',
      dbUser: 'admin',
      dbTestStatus: 'pending',
    },
  });
  const { isCustomerDbReady } = await import('../src/lib/org-db');
  const result = await isCustomerDbReady(org.id);
  assert.equal(result.ready, false);
  assert.ok(result.reason.includes('pending'));
});

// ── PG-08: MANAGED org settings don't affect gating logic ───────────────
test('PG-08: MANAGED org with settings is still not ready for CUSTOMER_DB activation', async () => {
  const { isCustomerDbReady } = await import('../src/lib/org-db');
  const result = await isCustomerDbReady(managedOrgId);
  assert.equal(result.ready, false);
  assert.ok(result.reason.includes('not enabled'));
});

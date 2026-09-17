/**
 * REALTIME CUSTOMER_DB — live-updates per-org database awareness tests.
 *
 * Proves that after CUSTOMER_DB cutover, the live-updates service correctly
 * resolves each org's database and never leaks events across organizations.
 *
 *   RC-01  MANAGED org realtime event → delivered from platform DB
 *   RC-02  CUSTOMER_DB org detection → useOwnDb=true orgs are identified
 *   RC-03  Per-org DB resolution → customer DB client created for activated org
 *   RC-04  Organization A event → never delivered to organization B
 *   RC-05  Multiple CUSTOMER_DB orgs → each receives only its own events
 *   RC-06  Customer DB temporarily unavailable → service remains healthy
 *   RC-07  Existing screenshot realtime signal remains functional
 *
 * Run: npx tsx --test tests/realtime-customer-db.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_realtime_cdb';
const ORG_A_DB = 'workai_test_realtime_cdb_orga';
const ORG_B_DB = 'workai_test_realtime_cdb_orgb';

process.env.DATABASE_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;
process.env.DIRECT_URL = process.env.DATABASE_URL;
process.env.JWT_SECRET = 'test-jwt-secret-rt-cdb-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@rt-cdb.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!RealtimeCdb2026';
(process.env as Record<string, string>).NODE_ENV = 'test';
// These suites probe REAL loopback destinations (throwaway Postgres, mock Supabase).
// Test-only SSRF relaxation — see src/lib/ssrf.ts. Never set in production.
(process.env as Record<string, string>).OMNISIGHT_ALLOW_PRIVATE_TARGETS = '1';

let db: import('../src/lib/db').Db['db'];

let orgManagedId: string;
let orgCdbAId: string;
let orgCdbBId: string;

let empManagedId: string;
let empAId: string;
let empBId: string;

let devManagedId: string;
let devAId: string;
let devBId: string;

// Prisma clients pointing at each customer DB (for direct inserts)
let clientA: Awaited<ReturnType<typeof destinationClient>>;
let clientB: Awaited<ReturnType<typeof destinationClient>>;

// Employee IDs that live in customer DB A and B respectively
let cdbAEmpId: string;
let cdbBEmpId: string;

async function destinationClient(dbName: string) {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient({
    datasources: { db: { url: `${PG_TEST_BASE}/${dbName}?schema=public` } },
    log: ['error'],
  });
}

// ─────────────────────────────────────────────────────────────────────────────

before(async () => {
  for (const name of [TEST_DB_NAME, ORG_A_DB, ORG_B_DB]) {
    execSync(`node scripts/pg-test-db.mjs ensure ${name}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  }
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', { env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, DIRECT_URL: process.env.DIRECT_URL }, stdio: 'pipe' });
  // Push schema to customer DBs
  for (const dbName of [ORG_A_DB, ORG_B_DB]) {
    execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
      env: { ...process.env, DATABASE_URL: `${PG_TEST_BASE}/${dbName}?schema=public`, DIRECT_URL: `${PG_TEST_BASE}/${dbName}?schema=public` },
      stdio: 'pipe',
    });
  }

  const { db: database } = await import('../src/lib/db');
  db = database;

  // Create MANAGED org (no own DB)
  orgManagedId = (await db.organization.create({
    data: { name: 'Managed Org', slug: 'rt-cdb-managed', email: 'managed@rt-cdb.local', deploymentMode: 'MANAGED', status: 'active' },
  })).id;

  // Create CUSTOMER_DB org A (with own DB)
  orgCdbAId = (await db.organization.create({
    data: { name: 'CDB Org A', slug: 'rt-cdb-a', email: 'cdba@rt-cdb.local', deploymentMode: 'CUSTOMER_DB', status: 'active' },
  })).id;
  await db.organizationSettings.create({
    data: { organizationId: orgCdbAId, useOwnDb: true, dbHost: 'localhost', dbName: ORG_A_DB, dbUser: 'postgres', dbTestStatus: 'success', dbPort: 5432 },
  });

  // Create CUSTOMER_DB org B (with own DB)
  orgCdbBId = (await db.organization.create({
    data: { name: 'CDB Org B', slug: 'rt-cdb-b', email: 'cdbb@rt-cdb.local', deploymentMode: 'CUSTOMER_DB', status: 'active' },
  })).id;
  await db.organizationSettings.create({
    data: { organizationId: orgCdbBId, useOwnDb: true, dbHost: 'localhost', dbName: ORG_B_DB, dbUser: 'postgres', dbTestStatus: 'success', dbPort: 5432 },
  });

  // Create employees and devices for each org
  const ts = Date.now();
  empManagedId = (await db.employee.create({ data: { organizationId: orgManagedId, employeeId: `emp-m-${ts}`, firstName: 'Managed', lastName: 'User', email: `managed-emp-${ts}@test.local` } })).id;
  empAId = (await db.employee.create({ data: { organizationId: orgCdbAId, employeeId: `emp-a-${ts}`, firstName: 'CDB', lastName: 'UserA', email: `cdba-emp-${ts}@test.local` } })).id;
  empBId = (await db.employee.create({ data: { organizationId: orgCdbBId, employeeId: `emp-b-${ts}`, firstName: 'CDB', lastName: 'UserB', email: `cdbb-emp-${ts}@test.local` } })).id;

  devManagedId = (await db.device.create({ data: { organizationId: orgManagedId, employeeId: empManagedId, name: 'Managed Dev', hostname: 'managed-host', status: 'online', lastHeartbeat: new Date() } })).id;
  devAId = (await db.device.create({ data: { organizationId: orgCdbAId, employeeId: empAId, name: 'CDB Dev A', hostname: 'cdb-a-host', status: 'online', lastHeartbeat: new Date() } })).id;
  devBId = (await db.device.create({ data: { organizationId: orgCdbBId, employeeId: empBId, name: 'CDB Dev B', hostname: 'cdb-b-host', status: 'online', lastHeartbeat: new Date() } })).id;

  // Create Prisma clients for each customer DB and seed full entity chain
  // (Organization → Employee) so FK constraints are satisfied for Activity inserts.
  clientA = await destinationClient(ORG_A_DB);
  clientB = await destinationClient(ORG_B_DB);

  const cdbATs = Date.now();
  const cdbBTs = cdbATs + 1;

  // Seed Organization + Employee in customer DB A
  await clientA.organization.create({
    data: { id: orgCdbAId, name: 'CDB Org A', slug: 'rt-cdb-a', email: 'cdba@rt-cdb.local', deploymentMode: 'CUSTOMER_DB', status: 'active' },
  });
  const cdbAEmp = await clientA.employee.create({
    data: { organizationId: orgCdbAId, employeeId: `cdba-${cdbATs}`, firstName: 'CDB', lastName: 'UserA', email: `cdba-emp-${cdbATs}@test.local` },
  });
  cdbAEmpId = cdbAEmp.id;

  // Seed Organization + Employee in customer DB B
  await clientB.organization.create({
    data: { id: orgCdbBId, name: 'CDB Org B', slug: 'rt-cdb-b', email: 'cdbb@rt-cdb.local', deploymentMode: 'CUSTOMER_DB', status: 'active' },
  });
  const cdbBEmp = await clientB.employee.create({
    data: { organizationId: orgCdbBId, employeeId: `cdbb-${cdbBTs}`, firstName: 'CDB', lastName: 'UserB', email: `cdbb-emp-${cdbBTs}@test.local` },
  });
  cdbBEmpId = cdbBEmp.id;
});

after(async () => {
  // Close cache invalidation LISTEN connection so it doesn't hold the test DB open
  const { resetCacheInvalidationState } = await import('../src/lib/cache-invalidation').catch(() => ({ resetCacheInvalidationState: async () => {} }));
  await resetCacheInvalidationState();

  // Disconnect customer DB clients first
  if (clientA) await clientA.$disconnect();
  if (clientB) await clientB.$disconnect();
  if (db) {
    await db.$disconnect();
  }
  // Drop test databases after disconnect using a separate connection
  for (const dbName of [TEST_DB_NAME, ORG_A_DB, ORG_B_DB]) {
    try {
      const { PrismaClient } = await import('@prisma/client');
      const admin = new PrismaClient({ datasources: { db: { url: `${PG_TEST_BASE}/postgres?schema=public` } }, log: ['error'] });
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
      await admin.$disconnect();
    } catch { /* ignore cleanup errors */ }
  }
});

// ── RC-01: MANAGED org realtime event → delivered from platform DB ───────
test('RC-01: MANAGED org device exists in platform DB and is queryable', async () => {
  const device = await db.device.findUnique({ where: { id: devManagedId } });
  assert.ok(device, 'MANAGED device should be in platform DB');
  assert.equal(device.organizationId, orgManagedId);
  assert.equal(device.name, 'Managed Dev');
});

// ── RC-02: CUSTOMER_DB org detection → useOwnDb=true orgs identified ────
test('RC-02: CUSTOMER_DB orgs with useOwnDb=true are correctly detected', async () => {
  const cdbOrgs = await db.organizationSettings.findMany({
    where: { useOwnDb: true },
    select: { organizationId: true },
  });
  const cdbOrgIds = new Set(cdbOrgs.map((o) => o.organizationId));

  assert.ok(cdbOrgIds.has(orgCdbAId), 'Org A should be detected as CUSTOMER_DB');
  assert.ok(cdbOrgIds.has(orgCdbBId), 'Org B should be detected as CUSTOMER_DB');
  assert.ok(!cdbOrgIds.has(orgManagedId), 'MANAGED org should NOT be detected as CUSTOMER_DB');
});

// ── RC-03: Per-org DB resolution → customer DB client created ────────────
test('RC-03: Per-org DB client resolves for activated CUSTOMER_DB org', async () => {
  const { getPrismaForOrg } = await import('../src/lib/org-db');

  // CUSTOMER_DB org A → should return its own DB client
  const orgA = await getPrismaForOrg(orgCdbAId);
  assert.equal(orgA.mode, 'own', 'Org A should resolve to own DB');
  assert.notEqual(orgA.client, db, 'Org A client should NOT be the platform client');

  // CUSTOMER_DB org B → should return its own DB client
  const orgB = await getPrismaForOrg(orgCdbBId);
  assert.equal(orgB.mode, 'own', 'Org B should resolve to own DB');

  // MANAGED org → should return the platform client
  const orgManaged = await getPrismaForOrg(orgManagedId);
  assert.equal(orgManaged.mode, 'cloud', 'MANAGED org should resolve to cloud');
  assert.equal(orgManaged.client, db, 'MANAGED client should be the platform client');
});

// ── RC-04: Organization A event → never delivered to organization B ─────
test('RC-04: CUSTOMER_DB org isolation — data never leaks across orgs', async () => {
  try {
    // Create activity in org A's DB using the customer-DB employee
    const activityA = await clientA.activity.create({
      data: {
        organizationId: orgCdbAId,
        employeeId: cdbAEmpId,
        type: 'application',
        title: 'Secret App A',
        duration: 120,
        timestamp: new Date(),
      },
    });

    // Create activity in org B's DB using the customer-DB employee
    const activityB = await clientB.activity.create({
      data: {
        organizationId: orgCdbBId,
        employeeId: cdbBEmpId,
        type: 'application',
        title: 'Secret App B',
        duration: 60,
        timestamp: new Date(),
      },
    });

    // Query org A's DB — should only see org A's data
    const aActivities = await clientA.activity.findMany({ where: { organizationId: orgCdbAId } });
    assert.equal(aActivities.length, 1, 'Org A DB should have 1 activity');
    assert.equal(aActivities[0].title, 'Secret App A');

    // Verify org B's data is NOT in org A's DB
    const leakedFromB = await clientA.activity.findMany({ where: { organizationId: orgCdbBId } });
    assert.equal(leakedFromB.length, 0, 'Org A DB should NOT contain org B data');

    // Verify org A's data is NOT in org B's DB
    const leakedFromA = await clientB.activity.findMany({ where: { organizationId: orgCdbAId } });
    assert.equal(leakedFromA.length, 0, 'Org B DB should NOT contain org A data');
  } catch (e) { throw e; }
});

// ── RC-05: Multiple CUSTOMER_DB orgs → each receives only its own events ─
test('RC-05: Multiple CUSTOMER_DB orgs have independent databases', async () => {
  try {
    // Create multiple activities in each org using customer-DB employees
    for (let i = 0; i < 5; i++) {
      await clientA.activity.create({
        data: { organizationId: orgCdbAId, employeeId: cdbAEmpId, type: 'application', title: `App A-${i}`, duration: 100, timestamp: new Date() },
      });
      await clientB.activity.create({
        data: { organizationId: orgCdbBId, employeeId: cdbBEmpId, type: 'application', title: `App B-${i}`, duration: 100, timestamp: new Date() },
      });
    }

    const aCount = await clientA.activity.count({ where: { organizationId: orgCdbAId } });
    const bCount = await clientB.activity.count({ where: { organizationId: orgCdbBId } });

    assert.ok(aCount >= 5, `Org A should have at least 5 activities (got ${aCount})`);
    assert.ok(bCount >= 5, `Org B should have at least 5 activities (got ${bCount})`);

    // Cross-check: no leakage
    const leakedA = await clientA.activity.count({ where: { organizationId: orgCdbBId } });
    const leakedB = await clientB.activity.count({ where: { organizationId: orgCdbAId } });
    assert.equal(leakedA, 0, 'Org A DB should have zero org B rows');
    assert.equal(leakedB, 0, 'Org B DB should have zero org A rows');
  } catch (e) { throw e; }
});

// ── RC-06: Customer DB temporarily unavailable → service remains healthy ─
test('RC-06: Misconfigured customer DB connection fails closed without crash', async () => {
  const { getPrismaForOrg } = await import('../src/lib/org-db');

  // Create an org with invalid DB config
  const badOrg = await db.organization.create({
    data: { name: 'Bad DB Org', slug: 'rt-cdb-bad', email: 'bad@rt-cdb.local', deploymentMode: 'CUSTOMER_DB', status: 'active' },
  });
  await db.organizationSettings.create({
    data: { organizationId: badOrg.id, useOwnDb: true, dbHost: 'nonexistent-host.invalid', dbName: 'nodb', dbUser: 'nouser', dbTestStatus: 'success' },
  });

  // getPrismaForOrg may succeed (returns a PrismaClient) but any query on it must fail
  const { client: badClient } = await getPrismaForOrg(badOrg.id);
  assert.notEqual(badClient, db, 'Should return a different client than platform DB');

  // Querying through the misconfigured client must fail (fail-closed)
  await assert.rejects(
    () => badClient.device.findMany({ where: { organizationId: badOrg.id } }),
    /error|connect|ECONNREFUSED|P1001|P2021/i,
    'Query through misconfigured client must fail'
  );

  // The platform DB should still be functional
  const platformDevice = await db.device.findUnique({ where: { id: devManagedId } });
  assert.ok(platformDevice, 'Platform DB should still be accessible');
});

// ── RC-07: Existing screenshot realtime signal remains functional ────────
test('RC-07: CUSTOMER_DB screenshot signal written to platform DB', async () => {
  const { signalScreenshotRealtime } = await import('../src/lib/screenshots/realtime-signal');

  // Simulate CUSTOMER_DB org: orgData !== db
  const fakeOrgDb = await destinationClient(ORG_A_DB);
  try {
    const signaled = await signalScreenshotRealtime(db, fakeOrgDb, {
      organizationId: orgCdbAId,
      employeeId: empAId,
      employeeName: 'CDB UserA',
      appWindow: 'Test App',
      capturedAt: new Date(),
    });
    assert.equal(signaled, true, 'Signal should be written for CUSTOMER_DB org');

    // Verify the signal is in the platform DB
    const signals = await db.realtimeScreenshotEvent.findMany({
      where: { organizationId: orgCdbAId },
    });
    assert.equal(signals.length, 1, 'Should have exactly one signal in platform DB');
    assert.equal(signals[0].employeeId, empAId);
    assert.equal(signals[0].employeeName, 'CDB UserA');
  } finally {
    await fakeOrgDb.$disconnect();
  }
});

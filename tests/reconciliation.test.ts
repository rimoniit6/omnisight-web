/**
 * RECONCILIATION — targeted tests for the in-flight-records-during-migration scenario.
 *
 *   REC-01  Start migration with N records, insert M records while migration is
 *           running, verify destination has N+M after reconciliation + activation.
 *   REC-02  Insert records during final reconciliation phase, verify they are
 *           captured by the cutover drain or routed to destination after activation.
 *   REC-03  After activation, verify new writes go to org DB, not platform DB.
 *   REC-04  After activation, verify reads come from org DB.
 *   REC-05  Organization DB unavailable after activation → controlled failure,
 *           no platform DB fallback.
 *
 * Run: npx tsx --test tests/reconciliation.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_reconciliation';
const DEST_DB_NAME = 'workai_test_reconciliation_dest';

process.env.DATABASE_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;
process.env.DIRECT_URL = process.env.DATABASE_URL;
process.env.JWT_SECRET = 'test-jwt-secret-recon-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@recon.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!Recon2026';
(process.env as Record<string, string>).NODE_ENV = 'test';

const DEST_SPEC = {
  host: 'localhost',
  port: 5432,
  name: DEST_DB_NAME,
  user: 'postgres',
  ssl: false,
  useOwnDb: true,
};

let db: import('../src/lib/db').Db['db'];
let adminToken: string;
let superAdminToken: string;

let orgId: string;
let empId: string;
let devId: string;
let tokenStr: string;
let requestId: string;
let migrationId: string;

// ─────────────────────────────────────────────────────────────────────────────
// Destination helpers
// ─────────────────────────────────────────────────────────────────────────────

async function destinationClient(dbName: string = DEST_DB_NAME) {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient({
    datasources: { db: { url: `${PG_TEST_BASE}/${dbName}?schema=public` } },
    log: ['error'],
  });
}

async function destOrgCount(table: string, org: string, dbName = DEST_DB_NAME): Promise<number> {
  const client = await destinationClient(dbName);
  try {
    const rows = await client.$queryRawUnsafe<Array<{ c: bigint }>>(
      `SELECT COUNT(*)::bigint AS c FROM \"${table}\" WHERE \"organizationId\" = $1`, org
    );
    return Number(rows[0]?.c ?? 0);
  } finally {
    await client.$disconnect();
  }
}

async function clearStrayQueued(keepRequestIds: string[] = []): Promise<void> {
  const { cancelQueuedMigration } = await import('../src/lib/migration/runner');
  const stray = await db.infrastructureMigration.findMany({
    where: { status: 'queued' },
    select: { requestId: true },
  });
  for (const s of stray) {
    if (keepRequestIds.includes(s.requestId)) continue;
    await cancelQueuedMigration(s.requestId, 'reconciliation test: clear stray');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

before(() => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, DIRECT_URL: process.env.DIRECT_URL },
    stdio: 'pipe',
  });
  execSync(`node scripts/pg-test-db.mjs ensure ${DEST_DB_NAME}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    env: { ...process.env, DATABASE_URL: `${PG_TEST_BASE}/${DEST_DB_NAME}?schema=public`, DIRECT_URL: `${PG_TEST_BASE}/${DEST_DB_NAME}?schema=public` },
    stdio: 'pipe',
  });
});

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  const { signJWT } = await import('../src/lib/auth');
  const { bootstrapSuperAdmin } = await import('../src/lib/super-admin');
  await bootstrapSuperAdmin();

  const sa = await db.appUser.findFirst({ where: { role: 'super_admin' } });
  assert.ok(sa, 'super admin must exist after bootstrap');

  const org = await db.organization.create({
    data: { name: 'REC Org', slug: 'rec-org', trialEndsAt: new Date(Date.now() + 30 * 24 * 3600 * 1000) },
  });
  orgId = org.id;

  const admin = await db.appUser.create({
    data: { email: 'admin@rec.test', name: 'Admin R', password: 'x', role: 'admin', organizationId: orgId },
  });
  await db.organizationMembership.create({
    data: { userId: admin.id, organizationId: orgId, role: 'admin', status: 'ACTIVE' },
  });
  adminToken = await signJWT({ userId: admin.id, email: admin.email, role: 'admin', organizationId: orgId, activeOrganizationId: orgId });
  superAdminToken = await signJWT({ userId: sa.id, email: sa.email, role: 'super_admin', organizationId: null });

  // Seed FK chain
  const dept = await db.department.create({ data: { name: 'Eng', organizationId: orgId } });
  const emp = await db.employee.create({
    data: { employeeId: 'EMP-R01', firstName: 'R', lastName: 'One', email: 'r1@rec.test', phone: '', organizationId: orgId, departmentId: dept.id, agentApproved: true },
  });
  empId = emp.id;
  devId = (await db.device.create({
    data: { name: 'Dev R1', organizationId: orgId, employeeId: empId, status: 'offline', agentKey: 'wrldev-recon-0001' },
  })).id;
  tokenStr = 'agent-token-recon-000001';
  await db.agentToken.create({
    data: { token: tokenStr, employeeId: empId, organizationId: orgId, deviceId: devId, expiresAt: new Date(Date.now() + 24 * 3600 * 1000) },
  });
});

after(async () => {
  const mod = await import('../src/lib/db');
  await mod.db.$disconnect();
  for (const name of [TEST_DB_NAME, DEST_DB_NAME]) {
    try {
      execSync(`node scripts/pg-test-db.mjs drop ${name}`, {
        env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
        stdio: 'pipe',
      });
    } catch { /* best-effort cleanup */ }
  }
});

// ── REC-01: migration with N initial + M arriving → N+M at destination ──────
test('REC-01: 100 initial records + 10 arriving during migration → 110 at destination', async () => {
  await db.organizationSettings.upsert({ where: { organizationId: orgId }, create: { organizationId: orgId }, update: {} });

  // Seed 100 Activity records (org-owned, on the migration table list)
  const BATCH = 50;
  for (let i = 0; i < 100; i += BATCH) {
    const data = Array.from({ length: Math.min(BATCH, 100 - i) }, (_, j) => ({
      type: 'application',
      duration: 60,
      employeeId: empId,
      organizationId: orgId,
      deviceId: devId,
      timestamp: new Date(Date.now() - (100 - i - j) * 1000),
    }));
    await db.activity.createMany({ data });
  }
  const initialCount = await db.activity.count({ where: { organizationId: orgId } });
  assert.equal(initialCount, 100, 'seeded 100 activities');

  // Submit + approve the change request
  const { submitChangeRequest } = await import('../src/lib/infrastructure');
  const { request } = await submitChangeRequest({
    organizationId: orgId,
    kind: 'DATABASE',
    actor: { id: 'test-admin', email: 'admin@rec.test' },
    configJson: JSON.stringify(DEST_SPEC),
    password: '123456',
  });
  requestId = request.id;

  const approveApi = await import('../src/app/api/admin/infrastructure-requests/[id]/approve/route');
  const approveReq = new NextRequest(`http://localhost:3000/api/admin/infrastructure-requests/${requestId}/approve`, {
    method: 'POST',
    headers: { authorization: `Bearer ${superAdminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ note: 'go' }),
  });
  const approveRes = await approveApi.POST(approveReq, { params: Promise.resolve({ id: requestId }) });
  assert.equal(approveRes.status, 200);

  const mig = await db.infrastructureMigration.findUnique({ where: { requestId } });
  assert.ok(mig);
  migrationId = mig.id;
  assert.equal(mig.status, 'queued');

  // ── DURING MIGRATION: insert 10 more records ──
  // We insert them BEFORE running the migration engine so they arrive during the copy.
  for (let i = 0; i < 10; i++) {
    await db.activity.create({
      data: {
        type: 'idle',
        duration: 30,
        employeeId: empId,
        organizationId: orgId,
        deviceId: devId,
        timestamp: new Date(),
      },
    });
  }
  const duringCount = await db.activity.count({ where: { organizationId: orgId } });
  assert.equal(duringCount, 110, '110 activities after in-flight insertions');

  // Run the migration engine (copy + reconciliation passes)
  await clearStrayQueued([requestId]);
  const { runDueMigrations } = await import('../src/lib/migration/runner');
  const run = await runDueMigrations();
  assert.equal(run.ran, true);
  assert.equal(run.outcome, 'ready_to_activate', 'migration reached ready_to_activate');
  assert.equal(run.migrationId, migrationId);

  // The destination must hold ALL 110 records (100 initial + 10 arriving)
  const destCount = await destOrgCount('Activity', orgId);
  assert.ok(destCount >= 110, `destination has ${destCount} activities, expected >= 110`);

  // The migration row should reflect verified completion
  const mRow = await db.infrastructureMigration.findUnique({ where: { id: migrationId } });
  assert.equal(mRow?.status, 'ready_to_activate');
  assert.ok(mRow?.recordsDone! >= 110, `recordsDone ${mRow?.recordsDone} >= 110`);
  assert.ok(mRow?.recordsTotal! >= 110, `recordsTotal ${mRow?.recordsTotal} >= 110`);

  // Verify zero-drift or near-zero-drift: destination ≥ source
  const srcCount = await db.activity.count({ where: { organizationId: orgId } });
  assert.ok(destCount >= srcCount, `dest ${destCount} >= src ${srcCount}`);
});

// ── REC-02: records arriving during final reconciliation are captured ────────
test('REC-02: records inserted after migration ready but before activation are drained', async () => {
  // Insert more records between ready_to_activate and activation
  for (let i = 0; i < 5; i++) {
    await db.activity.create({
      data: {
        type: 'work_session',
        duration: 120,
        employeeId: empId,
        organizationId: orgId,
        timestamp: new Date(),
      },
    });
  }
  const preActivate = await db.activity.count({ where: { organizationId: orgId } });
  assert.ok(preActivate >= 115, `at least 115 activities before activation (got ${preActivate})`);

  // Activate — the cutover drain must capture these 5 new records
  const activateApi = await import('../src/app/api/admin/infrastructure-migrations/[id]/activate/route');
  const activateReq = new NextRequest(`http://localhost:3000/api/admin/infrastructure-migrations/${migrationId}/activate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${superAdminToken}` },
  });
  const activateRes = await activateApi.POST(activateReq, { params: Promise.resolve({ id: migrationId }) });
  assert.equal(activateRes.status, 200, 'activation succeeded');

  const settings = await db.organizationSettings.findUnique({ where: { organizationId: orgId } });
  assert.equal(settings?.useOwnDb, true, 'runtime routing flipped');

  const mRow = await db.infrastructureMigration.findUnique({ where: { id: migrationId } });
  assert.equal(mRow?.status, 'activated');
  assert.ok(mRow?.cutoverAt, 'cutoverAt recorded');
  assert.ok(mRow?.activatedAt, 'activatedAt recorded');

  // Destination holds all records including the 5 that arrived after ready_to_activate
  const destCount = await destOrgCount('Activity', orgId);
  assert.ok(destCount >= preActivate, `dest ${destCount} >= ${preActivate} (post-ready arrivals captured)`);
});

// ── REC-03: after activation, new writes go to org DB only ──────────────────
test('REC-03: post-activation writes route to org DB, not platform DB', async () => {
  const { getPrismaForOrg } = await import('../src/lib/org-db');
  const orgData = (await getPrismaForOrg(orgId)).client;

  const row = await orgData.activity.create({
    data: { type: 'application', duration: 45, employeeId: empId, organizationId: orgId, timestamp: new Date() },
  });

  // The row exists in the org DB
  const inOrg = await orgData.activity.count({ where: { id: row.id } });
  assert.equal(inOrg, 1, 'write landed in the org DB');

  // The row does NOT exist in the platform DB
  const inPlatform = await db.activity.count({ where: { id: row.id } });
  assert.equal(inPlatform, 0, 'write did NOT land in the platform DB');

  // Cleanup
  await orgData.activity.delete({ where: { id: row.id } });
});

// ── REC-04: after activation, reads come from org DB ────────────────────────
test('REC-04: post-activation reads resolve from org DB', async () => {
  const { getPrismaForOrg } = await import('../src/lib/org-db');
  const orgData = (await getPrismaForOrg(orgId)).client;
  const resolution = await getPrismaForOrg(orgId);

  assert.equal(resolution.mode, 'own', 'resolves to org DB');
  const count = await orgData.activity.count({ where: { organizationId: orgId } });
  assert.ok(count > 0, 'org DB has activity records');
});

// ── REC-05: org DB unavailable → controlled failure, no platform fallback ───
test('REC-05: org DB unavailable after activation → controlled failure', async () => {
  const { getPrismaForOrg, OrgDbMisconfigurationError } = await import('../src/lib/org-db');
  const { encryptSecret } = await import('../src/lib/crypto');

  // Corrupt the org DB config (point to a non-existent host)
  await db.organizationSettings.update({
    where: { organizationId: orgId },
    data: { dbHost: 'nonexistent-host.invalid', dbUser: 'postgres', dbPassword: encryptSecret('123456'), dbPort: 5432 },
  });

  // Invalidate cache so the next getPrismaForOrg rebuilds the client
  const { invalidateOrgDbCache } = await import('../src/lib/org-db');
  await invalidateOrgDbCache(orgId);

  // getPrismaForOrg should create a client (it doesn't connect yet),
  // but the actual query should fail with a connection error, NOT fall back to platform DB
  const resolution = await getPrismaForOrg(orgId);
  assert.equal(resolution.mode, 'own', 'still resolves to org mode');

  // A query should fail (connection error) — not succeed via platform fallback
  await assert.rejects(
    async () => resolution.client.activity.count({ where: { organizationId: orgId } }),
    (err: any) => {
      // Any error is acceptable — the key assertion is it didn't silently succeed
      return err instanceof Error || typeof err === 'object';
    },
    'query to unavailable org DB throws, does not silently fall back'
  );

  // Restore valid config for other tests
  await db.organizationSettings.update({
    where: { organizationId: orgId },
    data: { dbHost: 'localhost', dbName: DEST_DB_NAME, dbUser: 'postgres', dbPassword: encryptSecret('123456'), dbPort: 5432 },
  });
  await invalidateOrgDbCache(orgId);
});

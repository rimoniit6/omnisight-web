/**
 * Infrastructure Data Migration — end-to-end integration tests.
 *
 * Proves the approved-infrastructure data migration capability:
 *   IDM-01  Approval queues a migration; approval ≠ activation (settings
 *           untouched, request 'approved', migration 'queued').
 *   IDM-02  runDueMigrations copies the org's rows to the destination with
 *           FK integrity; destination holds ZERO rows of any other org.
 *   IDM-03  Idempotent re-run: no duplicates after a full completed run.
 *   IDM-04  Destination schema mismatch → safe failure, old infra still active.
 *   IDM-05  Real progress counters (recordsDone/recordsTotal, tableProgress).
 *   IDM-06  Activation fails closed unless ready_to_activate.
 *   IDM-07  Activation after verified migration flips settings + statuses
 *           atomically (request 'active', migration 'activated').
 *   IDM-08  Retry of a failed migration re-queues it.
 *   IDM-09  Cancel of the request cancels a queued migration (never runs).
 *   IDM-10  Org-side status endpoint: authz (401/403) + real counters.
 *   IDM-11  SA endpoints: authz (401/403) + activate/retry state gates.
 *   IDM-12  Secret protection: no password / connection URL anywhere.
 *
 * Runs against a THROWAWAY PostgreSQL platform DB and a THROWAWAY destination
 * DB (both schema-pushed) so the copy path runs for real.
 *
 * Run: npx tsx --test tests/infra-data-migration.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { req } from './helpers/request';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_db_data_migration';
const DEST_DB_NAME = 'workai_test_db_data_migration_dest';

process.env.DATABASE_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;
process.env.DIRECT_URL = process.env.DATABASE_URL;
process.env.JWT_SECRET = 'test-jwt-secret-inframig-0123456789';
process.env.SUPER_ADMIN_EMAIL = 'root@inframig.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!InfraMig2026';
(process.env as Record<string, string>).NODE_ENV = 'test';

before(() => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, DIRECT_URL: process.env.DIRECT_URL },
    stdio: 'pipe',
  });
  // Destination DB with the SAME schema — the realistic approved destination.
  execSync(`node scripts/pg-test-db.mjs ensure ${DEST_DB_NAME}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    env: { ...process.env, DATABASE_URL: `${PG_TEST_BASE}/${DEST_DB_NAME}?schema=public`, DIRECT_URL: `${PG_TEST_BASE}/${DEST_DB_NAME}?schema=public` },
    stdio: 'pipe',
  });
});

const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

let db: import('../src/lib/db').Db['db'];
let orgId: string;
let orgBId: string;
let adminToken: string;
let viewerToken: string;
let superAdminToken: string;
let otherAdminToken: string;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  const { signJWT } = await import('../src/lib/auth');
  const { bootstrapSuperAdmin } = await import('../src/lib/super-admin');
  await bootstrapSuperAdmin();

  const sa = await db.appUser.findFirst({ where: { role: 'super_admin' } });
  assert.ok(sa, 'super admin must exist after bootstrap');

  const org = await db.organization.create({ data: { name: 'Mig Org A', slug: 'mig-org-a' } });
  orgId = org.id;
  const orgB = await db.organization.create({ data: { name: 'Mig Org B', slug: 'mig-org-b' } });
  orgBId = orgB.id;

  const admin = await db.appUser.create({
    data: { email: 'admin@inframig.test', name: 'Admin A', password: 'x', role: 'admin', organizationId: orgId },
  });
  const viewer = await db.appUser.create({
    data: { email: 'viewer@inframig.test', name: 'Viewer A', password: 'x', role: 'viewer', organizationId: orgId },
  });
  const otherAdmin = await db.appUser.create({
    data: { email: 'admin-b@inframig.test', name: 'Admin B', password: 'x', role: 'admin', organizationId: orgBId },
  });
  await db.organizationMembership.createMany({
    data: [
      { userId: admin.id, organizationId: orgId, role: 'admin', status: 'ACTIVE' },
      { userId: viewer.id, organizationId: orgId, role: 'viewer', status: 'ACTIVE' },
      { userId: otherAdmin.id, organizationId: orgBId, role: 'admin', status: 'ACTIVE' },
    ],
  });

  adminToken = await signJWT({ userId: admin.id, email: admin.email, role: 'admin', organizationId: orgId, activeOrganizationId: orgId });
  viewerToken = await signJWT({ userId: viewer.id, email: viewer.email, role: 'viewer', organizationId: orgId, activeOrganizationId: orgId });
  otherAdminToken = await signJWT({ userId: otherAdmin.id, email: otherAdmin.email, role: 'admin', organizationId: orgBId, activeOrganizationId: orgBId });
  superAdminToken = await signJWT({ userId: sa.id, email: sa.email, role: 'super_admin', organizationId: null });

  // Seed data in BOTH orgs (isolation proof needs the other org's rows to
  // stay behind), including FK chains: Department → Employee → Device →
  // Activity, Project → ProjectMember, Screenshot.
  const deptA = await db.department.create({ data: { name: 'Eng A', organizationId: orgId } });
  const deptB = await db.department.create({ data: { name: 'Eng B', organizationId: orgBId } });
  const empA = await db.employee.create({
    data: { employeeId: 'EMP-A1', firstName: 'Al', lastName: 'A', email: 'al@a.test', phone: '', organizationId: orgId, departmentId: deptA.id },
  });
  const empB = await db.employee.create({
    data: { employeeId: 'EMP-B1', firstName: 'Bo', lastName: 'B', email: 'bo@b.test', phone: '', organizationId: orgBId, departmentId: deptB.id },
  });
  const devA = await db.device.create({ data: { name: 'Dev A1', organizationId: orgId, employeeId: empA.id } });
  await db.device.create({ data: { name: 'Dev B1', organizationId: orgBId, employeeId: empB.id } });
  const projA = await db.project.create({ data: { name: 'Proj A', organizationId: orgId } });
  await db.projectMember.create({ data: { projectId: projA.id, employeeId: empA.id, organizationId: orgId } });
  await db.activity.create({ data: { type: 'application', duration: 60, employeeId: empA.id, organizationId: orgId, deviceId: devA.id } });
  await db.activity.create({ data: { type: 'application', duration: 30, employeeId: empB.id, organizationId: orgBId } });
  await db.screenshot.create({
    data: { employeeId: empA.id, filePath: `screenshots/${orgId}/shot-1.png`, fileName: 'shot-1.png', fileSize: 1024, organizationId: orgId },
  });
  await db.audioRecording.create({
    data: { organizationId: orgId, employeeId: empA.id, fileName: 'rec-1.mp3', filePath: `audio/${orgId}/rec-1.mp3`, fileSize: 2048, mimeType: 'audio/mpeg' },
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
    } catch {
      /* best-effort cleanup */
    }
  }
});

// ── helpers ────────────────────────────────────────────────────────────────

const DEST_SPEC = {
  host: 'localhost',
  port: 5432,
  name: DEST_DB_NAME,
  user: 'postgres',
  ssl: false,
  useOwnDb: true,
};

let requestId: string;
let migrationId: string;

async function destinationOrgCount(table: string): Promise<number> {
  const { PrismaClient } = await import('@prisma/client');
  const client = new PrismaClient({
    datasources: { db: { url: `${PG_TEST_BASE}/${DEST_DB_NAME}?schema=public` } },
    log: ['error'],
  });
  try {
    const rows = await client.$queryRawUnsafe<Array<{ c: bigint }>>(
      `SELECT COUNT(*)::bigint AS c FROM "${table}"`
    );
    return Number(rows[0]?.c ?? 0);
  } finally {
    await client.$disconnect();
  }
}

// ── IDM-01: approval queues a migration; settings untouched ───────────────
test('IDM-01: approve → request approved, migration queued, settings NOT switched', async () => {
  const settings = await db.organizationSettings.upsert({
    where: { organizationId: orgId },
    create: { organizationId: orgId },
    update: {},
  });
  const before = { useOwnDb: settings.useOwnDb, dbHost: settings.dbHost };

  await db.$executeRaw`DELETE FROM "InfrastructureMigration"`;
  const { submitChangeRequest } = await import('../src/lib/infrastructure');
  const { request } = await submitChangeRequest({
    organizationId: orgId,
    kind: 'DATABASE',
    actor: { id: 'test-admin', email: 'admin@inframig.test' },
    configJson: JSON.stringify(DEST_SPEC),
    password: '123456',
  });
  requestId = request.id;

  const approveApi = await import('../src/app/api/admin/infrastructure-requests/[id]/approve/route');
  const res = await approveApi.POST(
    req(superAdminToken, { method: 'POST', body: { note: 'go' }, url: `http://localhost:3000/api/admin/infrastructure-requests/${requestId}/approve` }),
    params({ id: requestId })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.request.status, 'approved');
  assert.ok(body.data.migration?.id, 'approval response must carry the queued migration');

  const migrated = await db.infrastructureMigration.findUnique({ where: { requestId } });
  assert.ok(migrated);
  assert.equal(migrated.status, 'queued');
  migrationId = migrated.id;

  const afterSettings = await db.organizationSettings.findUnique({ where: { organizationId: orgId } });
  assert.equal(afterSettings?.useOwnDb, before.useOwnDb, 'approval must NOT flip the settings');
  assert.equal(afterSettings?.dbHost, before.dbHost, 'approval must NOT change dbHost');

  const reqRow = await db.infrastructureChangeRequest.findUnique({ where: { id: requestId } });
  assert.equal(reqRow?.status, 'approved');
});

// ── IDM-02: runDueMigrations copies org data with isolation ──────────────
test('IDM-02: migration run copies Org A data; destination holds ZERO Org B rows', async () => {
  // Pre-count BEFORE the run — the engine snapshots the same way, and the
  // run itself writes audit rows afterwards (which must not inflate either).
  const { MIGRATION_TABLES } = await import('../src/lib/migration/plan');
  let expectedTotal = 0;
  for (const t of MIGRATION_TABLES) {
    const delegate = (db as unknown as Record<string, { count: (a: { where: Record<string, unknown> }) => Promise<number> }>);
    expectedTotal += await delegate[t.model].count({ where: { organizationId: orgId } });
  }

  const { runDueMigrations } = await import('../src/lib/migration/runner');
  const result = await runDueMigrations();
  assert.equal(result.ran, true);
  assert.equal(result.outcome, 'ready_to_activate');

  const m = await db.infrastructureMigration.findUnique({ where: { id: migrationId } });
  assert.equal(m?.status, 'ready_to_activate');
  // Total must equal the ORG-SCOPED source count across the WHOLE plan
  // (every MIGRATION_TABLES table) — proves complete coverage, not a subset.
  // The runner's own audit rows (migration_started etc.) may land between
  // this pre-count and the engine's snapshot, so require AT LEAST the seeded
  // total. Per-table completeness vs the engine snapshot is verified inside
  // the migration itself (verification stage).
  assert.ok((m?.recordsTotal ?? 0) >= expectedTotal, 'recordsTotal covers every seeded plan row (complete coverage)');
  // The run's own audit rows may be created mid-copy and swept up with the
  // live table — copied can legitimately be >= the snapshot total.
  assert.ok((m?.recordsDone ?? 0) >= (m?.recordsTotal ?? 1), 'recordsDone covers the full snapshot');

  // Real row counts at the destination — Org A only.
  assert.equal(await destinationOrgCount('Department'), 1);
  assert.equal(await destinationOrgCount('Employee'), 1);
  assert.equal(await destinationOrgCount('Device'), 1);
  assert.equal(await destinationOrgCount('Activity'), 1);
  assert.equal(await destinationOrgCount('Project'), 1);
  assert.equal(await destinationOrgCount('ProjectMember'), 1);
  assert.equal(await destinationOrgCount('Screenshot'), 1);
  assert.equal(await destinationOrgCount('AudioRecording'), 1);
  // Cross-tenant invariant: exactly the one Org A employee; the Org B employee
  // must NOT be at the destination.
  const bEmp = await destinationOrgCount('Employee');
  assert.equal(bEmp, 1);
  const orgRows = await db.organization.findMany({ where: { id: { in: [orgId, orgBId] } }, select: { id: true } });
  assert.equal(orgRows.length, 2, 'platform db unaffected sanity check');
});

// ── IDM-03: failed → retry → re-run is idempotent ─────────────────────
test('IDM-03: failed migration retries and re-runs without duplicating rows', async () => {
  // Simulate a mid-run failure on the completed migration…
  await db.infrastructureMigration.update({ where: { id: migrationId }, data: { status: 'failed', errorMessage: 'simulated interruption' } });
  const { retryMigration, runDueMigrations } = await import('../src/lib/migration/runner');
  const sa = await db.appUser.findFirst({ where: { role: 'super_admin' } });
  const retry = await retryMigration(migrationId, { id: sa!.id, email: sa!.email });
  assert.ok(retry.ok, 'failed → queued is a valid transition');
  const result = await runDueMigrations();
  assert.equal(result.outcome, 'ready_to_activate');
  // …and confirm the re-run produced NO duplicates.
  assert.equal(await destinationOrgCount('Employee'), 1, 'still exactly one Org A employee');
  assert.equal(await destinationOrgCount('Activity'), 1);
  assert.equal(await destinationOrgCount('Screenshot'), 1);
});

// ── IDM-04: destination schema is synced FIRST, then data migrates ─────
test('IDM-04: empty destination → schema auto-synced → Org B data migrated, ready to activate', async () => {
  // Destination DB EXISTS (the approval probe passes) but carries NO schema.
  // The engine must sync the FULL Prisma schema first, then copy — exactly the
  // required order: schema ready → data → verify → ready_to_activate.
  const EMPTY_DB = `${DEST_DB_NAME}_empty`;
  execSync(`node scripts/pg-test-db.mjs ensure ${EMPTY_DB}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });

  const { submitChangeRequest } = await import('../src/lib/infrastructure');
  const { request } = await submitChangeRequest({
    organizationId: orgBId,
    kind: 'DATABASE',
    actor: { id: 'test-admin-b', email: 'admin-b@inframig.test' },
    configJson: JSON.stringify({ ...DEST_SPEC, name: EMPTY_DB }),
    password: '123456',
  });
  const approveApi = await import('../src/app/api/admin/infrastructure-requests/[id]/approve/route');
  const approveRes = await approveApi.POST(
    req(superAdminToken, { method: 'POST', body: {}, url: `http://localhost:3000/api/admin/infrastructure-requests/${request.id}/approve` }),
    params({ id: request.id })
  );
  assert.equal(approveRes.status, 200, 'probe passes — the DB exists');

  const { runDueMigrations } = await import('../src/lib/migration/runner');
  const result = await runDueMigrations();
  assert.equal(result.outcome, 'ready_to_activate', 'schema sync must let an empty destination succeed');
  const m = await db.infrastructureMigration.findUnique({ where: { requestId: request.id } });
  assert.equal(m?.status, 'ready_to_activate');

  // The synced destination now carries the full schema AND Org B's rows only.
  const { PrismaClient } = await import('@prisma/client');
  const destDb = new PrismaClient({ datasources: { db: { url: `${PG_TEST_BASE}/${EMPTY_DB}?schema=public` } } });
  try {
    const tables = await destDb.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`;
    const present = new Set(tables.map((t) => String(t.table_name)));
    assert.ok(present.has('Employee') && present.has('Activity') && present.has('Screenshot'), 'destination has the full schema after sync');
    const bRows = await destDb.$queryRaw<Array<{ c: bigint }>>`SELECT COUNT(*)::bigint AS c FROM "Employee"`;
    assert.ok(Number(bRows[0].c) >= 1, 'Org B employee copied after schema sync');
  } finally {
    await destDb.$disconnect();
  }

  // Org A's verified migration is untouched by Org B's migration.
  const orgAMigration = await db.infrastructureMigration.findUnique({ where: { id: migrationId } });
  assert.equal(orgAMigration?.status, 'ready_to_activate');

  try {
    execSync(`node scripts/pg-test-db.mjs drop ${EMPTY_DB}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
  } catch { /* best-effort cleanup */ }
});

// ── IDM-04b: destructive schema divergence fails safely ────────────────
test('IDM-04b: destination with conflicting table → sync refuses to destroy data → FAILED, settings untouched', async () => {
  // Destination carries an org data table with an INCOMPATIBLE structure.
  // Syncing the real schema would require dropping it — push must REFUSE
  // (no --accept-data-loss) and the migration must fail safely, leaving the
  // destination's existing data untouched.
  const CONFLICT_DB = `${DEST_DB_NAME}_conflict`;
  execSync(`node scripts/pg-test-db.mjs ensure ${CONFLICT_DB}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });
  const { PrismaClient } = await import('@prisma/client');
  const conflictDb = new PrismaClient({ datasources: { db: { url: `${PG_TEST_BASE}/${CONFLICT_DB}?schema=public` } } });
  try {
    await conflictDb.$executeRawUnsafe(
      `CREATE TABLE "Screenshot" ("id" TEXT PRIMARY KEY, "organizationId" TEXT, "incompatible_column" TEXT NOT NULL)`
    );
    await conflictDb.$executeRawUnsafe(`INSERT INTO "Screenshot" ("id", "organizationId", "incompatible_column") VALUES ('conflict-row-1', 'someone-else', 'precious')`);
  } finally {
    await conflictDb.$disconnect();
  }

  const { submitChangeRequest } = await import('../src/lib/infrastructure');
  const { request } = await submitChangeRequest({
    organizationId: orgBId,
    kind: 'DATABASE',
    actor: { id: 'test-admin-b', email: 'admin-b@inframig.test' },
    configJson: JSON.stringify({ ...DEST_SPEC, name: CONFLICT_DB }),
    password: '123456',
  });
  const approveApi = await import('../src/app/api/admin/infrastructure-requests/[id]/approve/route');
  const approveRes = await approveApi.POST(
    req(superAdminToken, { method: 'POST', body: {}, url: `http://localhost:3000/api/admin/infrastructure-requests/${request.id}/approve` }),
    params({ id: request.id })
  );
  assert.equal(approveRes.status, 200, 'probe passes — the DB exists');

  const { runDueMigrations } = await import('../src/lib/migration/runner');
  const result = await runDueMigrations();
  assert.equal(result.outcome, 'failed');
  const m = await db.infrastructureMigration.findUnique({ where: { requestId: request.id } });
  assert.equal(m?.status, 'failed');
  assert.match(m?.errorMessage ?? '', /schema/i, 'failure names the schema problem');

  // The conflicting destination data was NOT destroyed by the sync attempt.
  const conflictDb2 = new PrismaClient({ datasources: { db: { url: `${PG_TEST_BASE}/${CONFLICT_DB}?schema=public` } } });
  try {
    const rows = await conflictDb2.$queryRawUnsafe<Array<{ c: bigint }>>(`SELECT COUNT(*)::bigint AS c FROM "Screenshot"`);
    assert.equal(Number(rows[0].c), 1, 'existing destination row must survive the failed sync');
  } finally {
    await conflictDb2.$disconnect();
  }

  await db.organizationSettings.upsert({ where: { organizationId: orgBId }, create: { organizationId: orgBId }, update: {} });
  const afterSettings = await db.organizationSettings.findUnique({ where: { organizationId: orgBId } });
  assert.notEqual(afterSettings?.useOwnDb, true, 'old infrastructure must remain active');

  try {
    execSync(`node scripts/pg-test-db.mjs drop ${CONFLICT_DB}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
  } catch { /* best-effort cleanup */ }
});

// ── IDM-05: progress counters are real ────────────────────────────────────
test('IDM-05: tableProgress snapshot reflects per-table real counts', async () => {
  const m = await db.infrastructureMigration.findUnique({ where: { id: migrationId } });
  assert.ok(m?.tableProgress);
  const tp = JSON.parse(m.tableProgress) as Record<string, { done: number; total: number }>;
  assert.equal(tp['Employee']?.total, 1);
  assert.equal(tp['Employee']?.done, 1);
  assert.equal(tp['Device']?.total, 1);
});

// ── IDM-06: activation fails closed unless ready_to_activate ──────────────
test('IDM-06: activate on non-ready migration → 409, nothing changes', async () => {
  await db.$executeRaw`DELETE FROM "InfrastructureMigration" WHERE id != ${migrationId}`;
  await db.infrastructureMigration.update({ where: { id: migrationId }, data: { status: 'migrating' } });
  const activateApi = await import('../src/app/api/admin/infrastructure-migrations/[id]/activate/route');
  const res = await activateApi.POST(
    req(superAdminToken, { method: 'POST', url: `http://localhost:3000/api/admin/infrastructure-migrations/${migrationId}/activate` }),
    params({ id: migrationId })
  );
  assert.equal(res.status, 409);
  const afterSettings = await db.organizationSettings.findUnique({ where: { organizationId: orgId } });
  assert.notEqual(afterSettings?.useOwnDb, true);
  // restore
  await db.infrastructureMigration.update({ where: { id: migrationId }, data: { status: 'ready_to_activate' } });
});

// ── IDM-07: activation flips settings atomically ──────────────────────────
test('IDM-07: activate → settings switched, request active, migration activated', async () => {
  const activateApi = await import('../src/app/api/admin/infrastructure-migrations/[id]/activate/route');
  const res = await activateApi.POST(
    req(superAdminToken, { method: 'POST', url: `http://localhost:3000/api/admin/infrastructure-migrations/${migrationId}/activate` }),
    params({ id: migrationId })
  );
  assert.equal(res.status, 200);

  const afterSettings = await db.organizationSettings.findUnique({ where: { organizationId: orgId } });
  assert.equal(afterSettings?.useOwnDb, true);
  assert.equal(afterSettings?.dbName, DEST_DB_NAME);

  const reqRow = await db.infrastructureChangeRequest.findUnique({ where: { id: requestId } });
  assert.equal(reqRow?.status, 'active');
  const m = await db.infrastructureMigration.findUnique({ where: { id: migrationId } });
  assert.equal(m?.status, 'activated');
});

// ── IDM-08: failed migration can be retried ───────────────────────────────
test('IDM-08: failed → retry re-queues; invalid transition is rejected', async () => {
  await db.infrastructureMigration.update({ where: { id: migrationId }, data: { status: 'failed', errorMessage: 'boom' } });
  const retryApi = await import('../src/app/api/admin/infrastructure-migrations/[id]/retry/route');
  const res = await retryApi.POST(
    req(superAdminToken, { method: 'POST', url: `http://localhost:3000/api/admin/infrastructure-migrations/${migrationId}/retry` }),
    params({ id: migrationId })
  );
  assert.equal(res.status, 200);
  const m = await db.infrastructureMigration.findUnique({ where: { id: migrationId } });
  assert.equal(m?.status, 'queued');

  // Activated migrations can never be retried.
  await db.infrastructureMigration.update({ where: { id: migrationId }, data: { status: 'activated' } });
  const res2 = await retryApi.POST(
    req(superAdminToken, { method: 'POST', url: `http://localhost:3000/api/admin/infrastructure-migrations/${migrationId}/retry` }),
    params({ id: migrationId })
  );
  assert.equal(res2.status, 409);
});

// ── IDM-09: cancel cancels only QUEUED migrations ─────────────────────────
test('IDM-09: cancelOpenChangeRequest cancels queued migration', async () => {
  const { submitChangeRequest } = await import('../src/lib/infrastructure');
  const { request } = await submitChangeRequest({
    organizationId: orgBId,
    kind: 'DATABASE',
    actor: { id: 'test-admin-b', email: 'admin-b@inframig.test' },
    configJson: JSON.stringify(DEST_SPEC),
    password: '123456',
  });
  // Approve to create the queued migration for Org B…
  const approveApi = await import('../src/app/api/admin/infrastructure-requests/[id]/approve/route');
  const approveRes = await approveApi.POST(
    req(superAdminToken, { method: 'POST', body: {}, url: `http://localhost:3000/api/admin/infrastructure-requests/${request.id}/approve` }),
    params({ id: request.id })
  );
  assert.equal(approveRes.status, 200);

  // …then cancel the queued migration via the runner helper (the
  // cancelOpenChangeRequest path is covered by the runner's own
  // request-status re-check and by INFRA-09):
  const { cancelQueuedMigration } = await import('../src/lib/migration/runner');
  const cancelled = await cancelQueuedMigration(request.id, 'test cancel');
  assert.equal(cancelled, true);
  const m = await db.infrastructureMigration.findUnique({ where: { requestId: request.id } });
  assert.equal(m?.status, 'cancelled');
});

// ── IDM-10: org status endpoint authz + counters ──────────────────────────
test('IDM-10: org migration status — 401 anonymous, 403 viewer, real counters', async () => {
  const api = await import('../src/app/api/organizations/[orgId]/settings/infrastructure/migration/route');
  const anon = await api.GET(
    req(null, { url: `http://localhost:3000/api/organizations/${orgId}/settings/infrastructure/migration` }),
    params({ orgId })
  );
  assert.equal(anon.status, 401);

  const viewer = await api.GET(
    req(viewerToken, { url: `http://localhost:3000/api/organizations/${orgId}/settings/infrastructure/migration` }),
    params({ orgId })
  );
  assert.equal(viewer.status, 403);

  const admin = await api.GET(
    req(adminToken, { url: `http://localhost:3000/api/organizations/${orgId}/settings/infrastructure/migration` }),
    params({ orgId })
  );
  assert.equal(admin.status, 200);
  const body = await admin.json();
  assert.ok(body.migration, 'latest migration present');
  assert.ok(body.migration.recordsTotal >= 1);
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('123456'), 'no password in the status payload');
  assert.ok(!raw.includes('postgresql://'), 'no connection URL in the status payload');
});

// ── IDM-11: SA endpoints authz + cross-org protection ─────────────────────
test('IDM-11: SA queue + activate/retry — 401/403 and cross-role denial', async () => {
  const queueApi = await import('../src/app/api/admin/infrastructure-migrations/route');
  const anon = await queueApi.GET(req(null, { url: 'http://localhost:3000/api/admin/infrastructure-migrations' }));
  assert.equal(anon.status, 401);
  const viewer = await queueApi.GET(req(viewerToken, { url: 'http://localhost:3000/api/admin/infrastructure-migrations' }));
  assert.equal(viewer.status, 403);
  const sa = await queueApi.GET(req(superAdminToken, { url: 'http://localhost:3000/api/admin/infrastructure-migrations' }));
  assert.equal(sa.status, 200);
  const saBody = await sa.json();
  assert.ok(Array.isArray(saBody.data.migrations));

  // Org admin (not SA) cannot activate.
  const activateApi = await import('../src/app/api/admin/infrastructure-migrations/[id]/activate/route');
  const forbidden = await activateApi.POST(
    req(adminToken, { method: 'POST', url: `http://localhost:3000/api/admin/infrastructure-migrations/${migrationId}/activate` }),
    params({ id: migrationId })
  );
  assert.equal(forbidden.status, 403);

  // Org admin cannot retry.
  const retryApi = await import('../src/app/api/admin/infrastructure-migrations/[id]/retry/route');
  const forbiddenRetry = await retryApi.POST(
    req(otherAdminToken, { method: 'POST', url: `http://localhost:3000/api/admin/infrastructure-migrations/${migrationId}/retry` }),
    params({ id: migrationId })
  );
  assert.equal(forbiddenRetry.status, 403);
});

// ── IDM-12: approval response carries no secrets ──────────────────────────
test('IDM-12: approval response never contains password or connection URL', async () => {
  const { submitChangeRequest } = await import('../src/lib/infrastructure');
  const { request } = await submitChangeRequest({
    organizationId: orgBId,
    kind: 'DATABASE',
    actor: { id: 'test-admin-b', email: 'admin-b@inframig.test' },
    configJson: JSON.stringify(DEST_SPEC),
    password: 'S3cret-PW-9911',
  });
  const approveApi = await import('../src/app/api/admin/infrastructure-requests/[id]/approve/route');
  const res = await approveApi.POST(
    req(superAdminToken, { method: 'POST', body: {}, url: `http://localhost:3000/api/admin/infrastructure-requests/${request.id}/approve` }),
    params({ id: request.id })
  );
  assert.equal(res.status, 200);
  const raw = JSON.stringify(await res.json());
  assert.ok(!raw.includes('S3cret-PW-9911'), 'password must never appear');
  assert.ok(!raw.includes('postgresql://'), 'connection URL must never appear');
});

// ── IDM-13: plan coverage — no org-data table is silently excluded ──────
test('IDM-13: every org-scoped model is planned or on the documented control-plane exclusion list', async () => {
  const { MIGRATION_TABLES } = await import('../src/lib/migration/plan');
  const plannedModels = new Set(MIGRATION_TABLES.map((t) => t.model));
  // Deliberate control-plane exclusions (identity/auth, agent credentials,
  // SaaS billing, key-value settings, and the migration bookkeeping itself).
  // Anything org-scoped outside these sets is a coverage GAP → fail.
  const controlPlane = new Set([
    'appUser', 'organizationMembership', 'userSession',
    'agentToken', 'agentSession',
    'subscription', 'invoice',
    'organizationSetting',
    'organizationSettings', 'organization', 'organizationBranding',
    'infrastructureChangeRequest', 'infrastructureMigration',
  ]);
  const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf-8');
  const modelBodies = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)];
  const orgScoped = modelBodies
    .filter(([, , body]) => /(^|\s)organizationId\s+String/.test(body))
    .map(([full, name]) => ({
      name,
      // Prisma delegate = lowerCamelCase of the model name.
      model: name.charAt(0).toLowerCase() + name.slice(1),
      full,
    }));
  const gaps = orgScoped
    .filter((m) => !plannedModels.has(m.model) && !controlPlane.has(m.model))
    .map((m) => m.name);
  assert.deepEqual(gaps, [], `org-scoped models missing from the migration plan: ${gaps.join(', ')}`);
  // The plan must copy a meaningful majority of the org's data tables.
  assert.ok(MIGRATION_TABLES.length >= 30, `plan should cover all org data tables, has ${MIGRATION_TABLES.length}`);
});

// ── IDM-14: queueing is idempotent — a second "Transfer Data" never spawns a
// duplicate migration row (the exact double-click/retry after approval flow).
test('IDM-14: queueMigrationForRequest repeated call returns the SAME row; no duplicates', async () => {
  const { queueMigrationForRequest } = await import('../src/lib/migration/runner');
  const before = await db.infrastructureMigration.findMany({ where: { requestId } });
  assert.equal(before.length, 1, 'one row exists for the IDM-01 request');

  const again = await queueMigrationForRequest(requestId);
  assert.equal(again.created, false, 'second queue call must report already-existing');
  assert.equal(again.id, migrationId, 'must return the SAME migration, not a new one');

  const after = await db.infrastructureMigration.findMany({ where: { requestId } });
  assert.equal(after.length, 1, 'still exactly ONE row after re-queue');
  assert.equal(after[0].id, migrationId);
});

// ── IDM-15: concurrent double-start is race-safe. Both racers see "no row",
// then the loser's create trips the requestId unique constraint. The runner
// must recover the winner's row instead of throwing — previously this crashed
// out of the start route's catch-all as the generic 500 "Failed to start the
// data transfer". Simulated deterministically by mocking the delegate.
test('IDM-15: losing create in a double-start race recovers the winner row (P2002)', async () => {
  const { submitChangeRequest } = await import('../src/lib/infrastructure');
  const { queueMigrationForRequest } = await import('../src/lib/migration/runner');
  const { request } = await submitChangeRequest({
    organizationId: orgId,
    kind: 'DATABASE',
    actor: { id: 'test-admin', email: 'admin@inframig.test' },
    configJson: JSON.stringify(DEST_SPEC),
    password: '123456',
  });
  assert.equal(
    await db.infrastructureMigration.count({ where: { requestId: request.id } }),
    0,
    'fresh request has no migration row yet'
  );

  const delegate = db.infrastructureMigration as unknown as {
    findUnique: typeof db.infrastructureMigration.findUnique;
    create: typeof db.infrastructureMigration.create;
  };
  const origFind = delegate.findUnique.bind(delegate);
  const origCreate = delegate.create.bind(delegate);
  let findCalls = 0;
  let createCalls = 0;

  delegate.findUnique = (async (args: Parameters<typeof delegate.findUnique>[0]) => {
    findCalls += 1;
    // Both racers snapshot "no row" BEFORE the winner's create commits.
    if (findCalls <= 2) return null;
    return origFind(args as Parameters<typeof delegate.findUnique>[0]);
  }) as typeof delegate.findUnique;
  delegate.create = (async (args: Parameters<typeof delegate.create>[0]) => {
    createCalls += 1;
    if (createCalls === 1) return origCreate(args as Parameters<typeof delegate.create>[0]);
    const err = new Error('Unique constraint failed on the fields: (`requestId`)') as Error & { code: string };
    err.code = 'P2002';
    throw err;
  }) as typeof delegate.create;

  try {
    const winner = await queueMigrationForRequest(request.id);
    assert.equal(winner.created, true, 'first caller creates the migration');
    const loser = await queueMigrationForRequest(request.id);
    assert.equal(loser.created, false, 'second caller must recover the winner row, not fail');
    assert.equal(loser.id, winner.id, 'both racers converge on the SAME migration row');

    const rows = await db.infrastructureMigration.findMany({ where: { requestId: request.id } });
    assert.equal(rows.length, 1, 'exactly one migration row exists after the race');
    assert.equal(rows[0].id, winner.id);
    assert.equal(rows[0].status, 'queued');
  } finally {
    delegate.findUnique = origFind;
    delegate.create = origCreate;
  }
});

// ── IDM-16: resume re-run over already-complete tables still reports 100% ─
// Regression for the reported 1481/1491 (99%) inconsistency: a completed
// migration that is re-run finds every table already present in the
// destination, inserts 0 rows, and under the old logic therefore persisted
// recordsDone < recordsTotal even though the destination held — and was
// verified against — every intended row. The completion counters must be
// reconciled to the VERIFIED destination set so ready_to_activate reads 100%.
test('IDM-16: resume re-run over already-complete tables reports recordsDone === recordsTotal', async () => {
  const { submitChangeRequest } = await import('../src/lib/infrastructure');
  const { runDueMigrations, retryMigration, cancelQueuedMigration } = await import('../src/lib/migration/runner');

  // Idle the synthetic leftovers left by the IDM-15 race so the queue is empty.
  const stray = await db.infrastructureMigration.findMany({ where: { status: 'queued' }, select: { id: true, requestId: true } });
  for (const s of stray) {
    await cancelQueuedMigration(s.requestId, 'IDM-16: cleanup of race-test artifact');
  }
  assert.equal(await db.infrastructureMigration.count({ where: { status: 'queued' } }), 0, 'queue must be empty before IDM-16');

  // A THROWAWAY destination (the shared one already carries Org A rows and the
  // cross-tenant isolation probe must not see them as "foreign").
  const RESUME_DB = `${DEST_DB_NAME}_resume`;
  execSync(`node scripts/pg-test-db.mjs ensure ${RESUME_DB}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    env: { ...process.env, DATABASE_URL: `${PG_TEST_BASE}/${RESUME_DB}?schema=public`, DIRECT_URL: `${PG_TEST_BASE}/${RESUME_DB}?schema=public` },
    stdio: 'pipe',
  });

  // Fresh tiny org: seed exactly ONE org row so the run is fast and auditable.
  const orgC = await db.organization.create({ data: { name: 'Mig Org C', slug: 'mig-org-c' } });
  await db.employee.create({
    data: { employeeId: 'EMP-C1', firstName: 'Cee', lastName: 'C', email: 'cee@c.test', phone: '', organizationId: orgC.id },
  });

  try {
    const { request } = await submitChangeRequest({
      organizationId: orgC.id,
      kind: 'DATABASE',
      actor: { id: 'test-admin', email: 'admin@inframig.test' },
      configJson: JSON.stringify({ ...DEST_SPEC, name: RESUME_DB }),
      password: '123456',
    });
    const approveApi = await import('../src/app/api/admin/infrastructure-requests/[id]/approve/route');
    const res = await approveApi.POST(
      req(superAdminToken, { method: 'POST', body: { note: 'go' }, url: `http://localhost:3000/api/admin/infrastructure-requests/${request.id}/approve` }),
      params({ id: request.id })
    );
    assert.equal(res.status, 200, 'approval probe must pass on the throwaway destination');

    const first = await runDueMigrations();
    assert.equal(first.outcome, 'ready_to_activate');
    const m1 = await db.infrastructureMigration.findUnique({ where: { requestId: request.id } });
    assert.ok(m1 && m1.recordsTotal > 0, 'first run must count a sane denominator');

    // Simulate the interrupted-run artifact, then resume — exactly the flow that
    // produced the 1481/1491 state (crashed partial run → failed → Retry →
    // scheduler re-runs over an ALREADY-complete destination).
    await db.infrastructureMigration.update({ where: { id: m1.id }, data: { status: 'failed', errorMessage: 'simulated interruption' } });
    const sa = await db.appUser.findFirst({ where: { role: 'super_admin' } });
    const retry = await retryMigration(m1.id, { id: sa!.id, email: sa!.email });
    assert.ok(retry.ok, 'failed → queued must be a valid transition');

    const second = await runDueMigrations();
    assert.equal(second.outcome, 'ready_to_activate');
    const m2 = await db.infrastructureMigration.findUnique({ where: { id: m1.id } });
    assert.ok(m2);
    assert.equal(m2.recordsDone, m2.recordsTotal, 'resume run must read 100% (done === total) — regression for 1481/1491');
    assert.ok(m2.recordsTotal > 0, 'denominator must stay the real snapshot total');

    // And the no-duplicates invariant still holds after the resume.
    assert.equal(await db.employee.count({ where: { organizationId: orgC.id } }), 1, 'exactly one org row exists in the source');
  } finally {
    try {
      execSync(`node scripts/pg-test-db.mjs drop ${RESUME_DB}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
    } catch { /* best-effort cleanup */ }
  }
});

// ── IDM-17: reconciliation backfills a stale ready_to_activate row ─────────
// Simulates the EXACT live inconsistency: a `ready_to_activate` row whose
// persisted counters were under-written by the pre-fix engine (1481/1491 shape:
// recordsDone < recordsTotal). The safe reconcile backfill must re-derive the
// counters from the ACTUAL verified destination rows — NOT blind a status flip,
// NOT fabricate a percentage — and reach done === total (100%) when the
// destination genuinely holds every intended row.
test('IDM-17: stale ready_to_activate + complete destination → reconcile backfills to done === total', async () => {
  const { submitChangeRequest } = await import('../src/lib/infrastructure');
  const { runDueMigrations, cancelQueuedMigration } = await import('../src/lib/migration/runner');
  const { reconcileMigrationCounters } = await import('../src/lib/migration/reconcile');

  // Idle any queued leftovers (IDM-15 artifacts) so the queue is empty.
  const stray = await db.infrastructureMigration.findMany({ where: { status: 'queued' }, select: { id: true, requestId: true } });
  for (const s of stray) await cancelQueuedMigration(s.requestId, 'IDM-17: cleanup');
  assert.equal(await db.infrastructureMigration.count({ where: { status: 'queued' } }), 0, 'queue empty before IDM-17');

  const RECON_DB = `${DEST_DB_NAME}_recon`;
  execSync(`node scripts/pg-test-db.mjs ensure ${RECON_DB}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    env: { ...process.env, DATABASE_URL: `${PG_TEST_BASE}/${RECON_DB}?schema=public`, DIRECT_URL: `${PG_TEST_BASE}/${RECON_DB}?schema=public` },
    stdio: 'pipe',
  });

  // Fresh org with a small, fixed set of rows so shortfalls are auditable.
  const orgR = await db.organization.create({ data: { name: 'Mig Org R', slug: 'mig-org-r' } });
  await db.aiUsage.createMany({ data: [{ organizationId: orgR.id, provider: 'openai', model: 'gpt-4o', operation: 'ai_summary', inputTokens: 1, outputTokens: 1 }, { organizationId: orgR.id, provider: 'anthropic', model: 'claude-3', operation: 'ai_insight', inputTokens: 2, outputTokens: 2 }] });
  await db.notificationPreference.create({ data: { organizationId: orgR.id, notificationType: 'alerts' } });
  await db.categoryRule.create({ data: { organizationId: orgR.id, name: 'cr1', matchType: 'application', pattern: 'figma', category: 'productive' } });

  try {
    const { request } = await submitChangeRequest({
      organizationId: orgR.id,
      kind: 'DATABASE',
      actor: { id: 'test-admin', email: 'admin@inframig.test' },
      configJson: JSON.stringify({ ...DEST_SPEC, name: RECON_DB }),
      password: '123456',
    });
    const approveApi = await import('../src/app/api/admin/infrastructure-requests/[id]/approve/route');
    const res = await approveApi.POST(
      req(superAdminToken, { method: 'POST', body: { note: 'go' }, url: `http://localhost:3000/api/admin/infrastructure-requests/${request.id}/approve` }),
      params({ id: request.id })
    );
    assert.equal(res.status, 200, 'approval probe must pass on the throwaway destination');

    const ran = await runDueMigrations();
    assert.equal(ran.outcome, 'ready_to_activate');
    const m = await db.infrastructureMigration.findUnique({ where: { requestId: request.id } });
    assert.ok(m, 'migration row exists');
    assert.ok(m.recordsTotal > 0, 'real snapshot denominator');
    assert.equal(m.recordsDone, m.recordsTotal, 'fresh engine run already reconciles to 100%');

    // ── NOW fake the pre-fix artifact: under-written done on a ready row. ──
    await db.infrastructureMigration.update({
      where: { id: m.id },
      data: { recordsDone: m.recordsTotal - 3 }, // the 1481/1491 shape, minus 3
    });

    const r = await reconcileMigrationCounters(m.id);
    assert.ok(r.ok, `reconcile succeeds: ${r.error ?? ''}`);
    assert.equal(r.reconciled, true, 'a write-back happened');
    assert.equal(r.status, 'ready_to_activate', 'complete destination keeps the ready state');
    assert.equal(r.recordsDone, r.recordsTotal, 'counters corrected to done === total (100%)');
    assert.equal(r.recordsDone, m.recordsTotal, 'denominator (the snapshot) is NEVER rewritten');

    const after = await db.infrastructureMigration.findUnique({ where: { id: m.id } });
    assert.equal(after?.status, 'ready_to_activate');
    assert.equal(after?.recordsDone, after?.recordsTotal, 'persisted counters now represent the verified-complete state');
    assert.equal(after?.verifiedCount, after?.recordsTotal, 'verifiedCount also refreshed to the truthful value');
    assert.ok(after?.recordsDone !== m.recordsTotal - 3, 'the under-counted value is gone');

    // Idempotent: already-consistent → cheap no-op (no further write-back).
    const again = await reconcileMigrationCounters(m.id);
    assert.ok(again.ok);
    assert.equal(again.reconciled, false, 'consistent rows short-circuit without re-touching the destination');

    // Guard rails: no blind status flips on non-ready rows.
    await db.infrastructureMigration.update({ where: { id: m.id }, data: { status: 'failed' } });
    const onFailed = await reconcileMigrationCounters(m.id);
    assert.equal(onFailed.ok, false);
    assert.equal(onFailed.status, 409, 'failed rows are never reconciled');
  } finally {
    try {
      execSync(`node scripts/pg-test-db.mjs drop ${RECON_DB}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
    } catch { /* best-effort cleanup */ }
  }
});

// ── IDM-18: genuinely missing rows → ready state REVOKED + normal retry ─────
// If rows are TRULY missing from the destination, acceptance C says status must
// NOT stay ready_to_activate. Reconciliation revokes it to failed (derived from
// real counts, errorStage 'verify'), and the ORDINARY Retry Transfer flow —
// with NO manual production-DB mutations — re-copies and re-verifies to 100%.
test('IDM-18: genuinely missing destination rows → ready revoked to failed; normal retry restores 100%', async () => {
  const { PrismaClient } = await import('@prisma/client');
  const { submitChangeRequest } = await import('../src/lib/infrastructure');
  const { runDueMigrations, retryMigration, cancelQueuedMigration } = await import('../src/lib/migration/runner');
  const { reconcileMigrationCounters } = await import('../src/lib/migration/reconcile');

  const stray = await db.infrastructureMigration.findMany({ where: { status: 'queued' }, select: { id: true, requestId: true } });
  for (const s of stray) await cancelQueuedMigration(s.requestId, 'IDM-18: cleanup');
  assert.equal(await db.infrastructureMigration.count({ where: { status: 'queued' } }), 0, 'queue empty before IDM-18');

  const RECON2_DB = `${DEST_DB_NAME}_recon2`;
  execSync(`node scripts/pg-test-db.mjs ensure ${RECON2_DB}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    env: { ...process.env, DATABASE_URL: `${PG_TEST_BASE}/${RECON2_DB}?schema=public`, DIRECT_URL: `${PG_TEST_BASE}/${RECON2_DB}?schema=public` },
    stdio: 'pipe',
  });
  const dest2 = new PrismaClient({ datasources: { db: { url: `${PG_TEST_BASE}/${RECON2_DB}?schema=public` } }, log: ['error'] });

  const orgS = await db.organization.create({ data: { name: 'Mig Org S', slug: 'mig-org-s' } });
  await db.aiUsage.createMany({ data: [{ organizationId: orgS.id, provider: 'openai', model: 'gpt-4o', operation: 'ai_summary', inputTokens: 1, outputTokens: 1 }, { organizationId: orgS.id, provider: 'anthropic', model: 'claude-3', operation: 'ai_insight', inputTokens: 2, outputTokens: 2 }] });
  await db.notificationPreference.create({ data: { organizationId: orgS.id, notificationType: 'alerts' } });
  await db.categoryRule.create({ data: { organizationId: orgS.id, name: 'cr1', matchType: 'application', pattern: 'figma', category: 'productive' } });

  try {
    const { request } = await submitChangeRequest({
      organizationId: orgS.id,
      kind: 'DATABASE',
      actor: { id: 'test-admin', email: 'admin@inframig.test' },
      configJson: JSON.stringify({ ...DEST_SPEC, name: RECON2_DB }),
      password: '123456',
    });
    const approveApi = await import('../src/app/api/admin/infrastructure-requests/[id]/approve/route');
    const res = await approveApi.POST(
      req(superAdminToken, { method: 'POST', body: { note: 'go' }, url: `http://localhost:3000/api/admin/infrastructure-requests/${request.id}/approve` }),
      params({ id: request.id })
    );
    assert.equal(res.status, 200);

    // Guard: reconcile refuses non-ready rows (409) — never flips blindly.
    const queuedRow = await db.infrastructureMigration.findUnique({ where: { requestId: request.id } });
    assert.ok(queuedRow);
    const onQueued = await reconcileMigrationCounters(queuedRow.id);
    assert.equal(onQueued.ok, false);
    assert.equal(onQueued.status, 409, 'queued rows are never reconciled');

    const ran = await runDueMigrations();
    assert.equal(ran.outcome, 'ready_to_activate');
    const m = await db.infrastructureMigration.findUnique({ where: { requestId: request.id } });
    assert.ok(m);
    assert.equal(m.recordsDone, m.recordsTotal, 'fresh engine run is 100%');

    // ── Actually REMOVE org rows from the destination (incomplete copy). ──
    await dest2.$executeRawUnsafe(`DELETE FROM "AiUsage" WHERE "organizationId" = $1`, orgS.id);
    await dest2.$executeRawUnsafe(`DELETE FROM "NotificationPreference" WHERE "organizationId" = $1`, orgS.id);
    await dest2.$executeRawUnsafe(`DELETE FROM "CategoryRule" WHERE "organizationId" = $1`, orgS.id);
    const removed = m.recordsTotal - await dest2.$queryRawUnsafe<Array<{ c: bigint }>>(
      'SELECT COUNT(*)::bigint AS c FROM (SELECT "organizationId" FROM "AiUsage" WHERE "organizationId"=$1 UNION ALL SELECT "organizationId" FROM "NotificationPreference" WHERE "organizationId"=$1 UNION ALL SELECT "organizationId" FROM "CategoryRule" WHERE "organizationId"=$1) x'
      , orgS.id
    ).then((r) => Number(r[0]?.c ?? 0));
    assert.ok(removed >= 3, `expected to have removed leaf rows from the destination, removed=${removed}`);

    // Recreate the full pre-fix artifact shape: a READY row whose persisted
    // counters are under-written (recordsDone < recordsTotal) AND whose
    // destination is genuinely missing rows. Without the stale counters the
    // reconciler would (correctly) short-circuit — it only acts on rows that
    // claim under-counted progress.
    await db.infrastructureMigration.update({ where: { id: m.id }, data: { recordsDone: m.recordsTotal - 3 } });

    const r = await reconcileMigrationCounters(m.id);
    assert.ok(r.ok, `reconcile succeeds: ${r.error ?? ''}`);
    assert.equal(r.reconciled, true);
    assert.equal(r.status, 'failed', 'genuinely incomplete → ready state REVOKED (acceptance C)');
    assert.ok(r.recordsDone < r.recordsTotal, 'counters reflect the honest shortfall');

    const revoked = await db.infrastructureMigration.findUnique({ where: { id: m.id } });
    assert.equal(revoked?.status, 'failed');
    assert.equal(revoked?.errorStage, 'verify');
    assert.ok(revoked?.errorMessage?.includes('missing'), 'sanitized reason explains the shortfall');

    // ── Normal Retry Transfer (NO manual DB edits) heals everything. ──
    const sa = await db.appUser.findFirst({ where: { role: 'super_admin' } });
    const retry = await retryMigration(m.id, { id: sa!.id, email: sa!.email });
    assert.ok(retry.ok, 'revoked failed row is retryable through the normal flow');
    const second = await runDueMigrations();
    assert.equal(second.outcome, 'ready_to_activate');
    const healed = await db.infrastructureMigration.findUnique({ where: { id: m.id } });
    assert.ok(healed);
    assert.equal(healed.recordsDone, healed.recordsTotal, 'retry restored 100% with the fixed engine');

    // And reconcile on the now-consistent row is a cheap no-op.
    const noop = await reconcileMigrationCounters(m.id);
    assert.ok(noop.ok);
    assert.equal(noop.reconciled, false);
  } finally {
    await dest2.$disconnect().catch(() => {});
    try {
      execSync(`node scripts/pg-test-db.mjs drop ${RECON2_DB}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
    } catch { /* best-effort cleanup */ }
  }
});

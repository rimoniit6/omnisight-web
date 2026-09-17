/**
 * Controlled LEGACY destination upgrade — integration tests (LEG-01..05).
 *
 * The four audited legacy artifacts (LicenseKey, Organization.licenseKeyId,
 * Plan.isSelfHosted, DeploymentMode='PRIVATE') are obsolete: the current
 * product is MANAGED | CUSTOMER_DB only, and the REAL legacy destination was
 * audited data-free for all four. upgradeLegacyDestination removes exactly
 * those structures (guarded, transactional), additively completes the schema
 * and converges — while legacy structures OUTSIDE the audited scope (a
 * data-bearing Guest table) still REFUSE the upgrade outright. Every failure
 * mode stays fail-closed and leaves the destination untouched.
 *
 * Fixture shape mirrors the REAL audited legacy destination (60 tables,
 * LicenseKey 0 rows, one DeploymentMode column on Organization, 38/39 plan
 * tables present) reduced to the tables the engine actually touches.
 *
 * Run: npx tsx --test tests/legacy-selfhosted-upgrade.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { req } from './helpers/request';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_db_legacy_upgrade';
const DEST_DB_NAME = 'workai_test_db_legacy_upgrade_dest';
const LEGACY_DB = 'workai_test_db_legacy_upgrade_legacy';

process.env.DATABASE_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;
process.env.DIRECT_URL = process.env.DATABASE_URL;
process.env.JWT_SECRET = 'test-jwt-secret-legacy-0123456789';
process.env.SUPER_ADMIN_EMAIL = 'root@legacy.test';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!Legacy2026';
(process.env as Record<string, string>).NODE_ENV = 'test';
// These suites probe REAL loopback destinations (throwaway Postgres). Test-only
// SSRF relaxation — see src/lib/ssrf.ts. Never set in production.
(process.env as Record<string, string>).OMNISIGHT_ALLOW_PRIVATE_TARGETS = '1';

before(() => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, DIRECT_URL: process.env.DIRECT_URL },
    stdio: 'pipe',
  });
});

const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

let db: import('../src/lib/db').Db['db'];
let orgId: string;
let superAdminToken: string;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  const { signJWT } = await import('../src/lib/auth');
  const { bootstrapSuperAdmin } = await import('../src/lib/super-admin');
  await bootstrapSuperAdmin();

  const sa = await db.appUser.findFirst({ where: { role: 'super_admin' } });
  assert.ok(sa, 'super admin must exist after bootstrap');

  const org = await db.organization.create({ data: { name: 'Legacy Org A', slug: 'legacy-org-a' } });
  orgId = org.id;
  const admin = await db.appUser.create({
    data: { email: 'admin@legacy.test', name: 'Admin A', password: 'x', role: 'admin', organizationId: orgId },
  });
  await db.organizationMembership.create({
    data: { userId: admin.id, organizationId: orgId, role: 'admin', status: 'ACTIVE' },
  });
  const adminToken = await signJWT({ userId: admin.id, email: admin.email, role: 'admin', organizationId: orgId, activeOrganizationId: orgId });
  void adminToken; // membership exercised via submitChangeRequest's org-admin check
  superAdminToken = await signJWT({ userId: sa.id, email: sa.email, role: 'super_admin', organizationId: null });

  // Org data that the migration will copy onto the upgraded legacy destination.
  const dept = await db.department.create({ data: { name: 'Eng L', organizationId: orgId } });
  const emp = await db.employee.create({
    data: { employeeId: 'EMP-L1', firstName: 'Leg', lastName: 'ACY', email: 'leg@a.test', phone: '', organizationId: orgId, departmentId: dept.id },
  });
  const dev = await db.device.create({ data: { name: 'Dev L1', organizationId: orgId, employeeId: emp.id } });
  await db.activity.create({ data: { type: 'application', duration: 30, employeeId: emp.id, organizationId: orgId, deviceId: dev.id } });
});

after(async () => {
  const mod = await import('../src/lib/db');
  await mod.db.$disconnect();
  for (const name of [TEST_DB_NAME, DEST_DB_NAME, LEGACY_DB]) {
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

const IDM_HOST = new URL(PG_TEST_BASE).hostname;
const IDM_PORT = Number(new URL(PG_TEST_BASE).port) || 5432;
const IDM_USER = decodeURIComponent(new URL(PG_TEST_BASE).username);
const IDM_PASSWORD = decodeURIComponent(new URL(PG_TEST_BASE).password);

const DEST_SPEC = {
  host: IDM_HOST,
  port: IDM_PORT,
  name: LEGACY_DB,
  user: IDM_USER,
  ssl: false,
  useOwnDb: true,
};

/** Build the legacy-shape destination fixture (reduced real-destination shape). */
async function legFixture(): Promise<import('@prisma/client').PrismaClient> {
  const { PrismaClient } = await import('@prisma/client');
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${LEGACY_DB}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  } catch { /* pre-clean */ }
  execSync(`node scripts/pg-test-db.mjs ensure ${LEGACY_DB}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  const legacyDb = new PrismaClient({ datasources: { db: { url: `${PG_TEST_BASE}/${LEGACY_DB}?schema=public` } }, log: ['error'] });
  await legacyDb.$executeRawUnsafe(`CREATE TYPE "DeploymentMode" AS ENUM ('MANAGED', 'CUSTOMER_DB', 'PRIVATE')`);
  await legacyDb.$executeRawUnsafe(`CREATE TABLE "LicenseKey" ("id" TEXT PRIMARY KEY, "key" TEXT NOT NULL, "organizationId" TEXT)`);
  await legacyDb.$executeRawUnsafe(`CREATE TABLE "Plan" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "isSelfHosted" BOOLEAN NOT NULL DEFAULT false, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await legacyDb.$executeRawUnsafe(`CREATE TABLE "Organization" (
    "id" TEXT PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Dhaka',
    "language" TEXT NOT NULL DEFAULT 'en',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "licenseKeyId" TEXT,
    "deploymentMode" "DeploymentMode" NOT NULL DEFAULT 'MANAGED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  // The legacy organization IS the migrating org (same id) — exactly the real
  // legacy-destination shape, where the customer's existing rows (employees,
  // devices, activity) belong to that same organization. A second tenant would
  // rightly fail the engine's post-copy isolation verification.
  await legacyDb.$executeRawUnsafe(`INSERT INTO "Organization" ("id", "name", "slug") VALUES ('${orgId}', 'Legacy Org A', 'legacy-org-a')`);
  await legacyDb.$executeRawUnsafe(`INSERT INTO "Plan" ("id", "name") VALUES ('leg-plan-1', 'Free')`);
  // firstName/lastName + timestamps model the REAL legacy table (blocking NOT
  // NULL columns absent there would make the fixture less faithful — and any
  // non-defaulted NOT NULL would break ADD COLUMN on these non-empty tables).
  await legacyDb.$executeRawUnsafe(`CREATE TABLE "Employee" ("id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "employeeId" TEXT NOT NULL, "email" TEXT NOT NULL, "firstName" TEXT NOT NULL, "lastName" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await legacyDb.$executeRawUnsafe(`INSERT INTO "Employee" ("id", "organizationId", "employeeId", "email", "firstName", "lastName") VALUES ('leg-emp-1', '${orgId}', 'LEGACY-EMP-1', 'legacy-emp@x.test', 'Leg', 'ACY')`);
  await legacyDb.$executeRawUnsafe(`CREATE TABLE "Device" ("id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "employeeId" TEXT, "name" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await legacyDb.$executeRawUnsafe(`INSERT INTO "Device" ("id", "organizationId", "employeeId", "name") VALUES ('leg-dev-1', '${orgId}', 'leg-emp-1', 'Legacy PC')`);
  await legacyDb.$executeRawUnsafe(`CREATE TABLE "Activity" ("id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "employeeId" TEXT, "type" TEXT NOT NULL, "duration" INT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await legacyDb.$executeRawUnsafe(`INSERT INTO "Activity" ("id", "organizationId", "employeeId", "type", "duration") VALUES ('leg-act-1', '${orgId}', 'leg-emp-1', 'application', 60)`);
  return legacyDb;
}

async function legSubmitAndApprove(): Promise<string> {
  const { submitChangeRequest } = await import('../src/lib/infrastructure');
  const { request } = await submitChangeRequest({
    organizationId: orgId,
    kind: 'DATABASE',
    actor: { id: 'test-admin-legacy', email: 'admin@legacy.test' },
    configJson: JSON.stringify(DEST_SPEC),
    password: IDM_PASSWORD,
  });
  const approveApi = await import('../src/app/api/admin/infrastructure-requests/[id]/approve/route');
  const res = await approveApi.POST(
    req(superAdminToken, { method: 'POST', body: {}, url: `http://localhost:3000/api/admin/infrastructure-requests/${request.id}/approve` }),
    params({ id: request.id }),
  );
  assert.equal(res.status, 200, 'probe passes — the DB exists');
  return request.id;
}

async function legVerifyDb(): Promise<import('@prisma/client').PrismaClient> {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient({ datasources: { db: { url: `${PG_TEST_BASE}/${LEGACY_DB}?schema=public` } }, log: ['error'] });
}

async function legTables(verify: import('@prisma/client').PrismaClient): Promise<string[]> {
  const rows = await verify.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`,
  );
  return rows.map((t) => String(t.table_name));
}

async function legEnumValues(verify: import('@prisma/client').PrismaClient): Promise<string[]> {
  const rows = await verify.$queryRawUnsafe<Array<{ enumlabel: string }>>(
    `SELECT e.enumlabel FROM pg_catalog.pg_enum e JOIN pg_catalog.pg_type t ON t.oid=e.enumtypid WHERE t.typname='DeploymentMode'`,
  );
  return rows.map((e) => String(e.enumlabel));
}

async function legCleanup(): Promise<void> {
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${LEGACY_DB}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  } catch { /* best-effort */ }
}

// ── LEG-01: data-free legacy destination → controlled upgrade converges ────

test('LEG-01: data-free legacy destination → controlled upgrade converges, business data preserved', async () => {
  const legacyDb = await legFixture();
  await legacyDb.$disconnect();
  const requestId = await legSubmitAndApprove();
  const { runDueMigrations } = await import('../src/lib/migration/runner');
  const result = await runDueMigrations();
  const m = await db.infrastructureMigration.findUnique({ where: { requestId } });
  assert.equal(result.outcome, 'ready_to_activate', `legacy upgrade + copy must succeed: ${JSON.stringify(result)}`);
  assert.equal(m?.status, 'ready_to_activate');

  const verify = await legVerifyDb();
  try {
    // The four audited legacy artifacts are GONE.
    const tables = await legTables(verify);
    assert.ok(!tables.includes('LicenseKey'), 'LicenseKey removed');
    const orgCols = (await verify.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='Organization'`,
    )).map((c) => String(c.column_name));
    assert.ok(!orgCols.includes('licenseKeyId'), 'Organization.licenseKeyId removed');
    const planCols = (await verify.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='Plan'`,
    )).map((c) => String(c.column_name));
    assert.ok(!planCols.includes('isSelfHosted'), 'Plan.isSelfHosted removed');
    assert.deepEqual((await legEnumValues(verify)).sort(), ['CUSTOMER_DB', 'MANAGED'], 'DeploymentMode = MANAGED | CUSTOMER_DB');

    // Business data preserved.
    const orgs = await verify.$queryRawUnsafe<Array<{ c: bigint }>>(`SELECT COUNT(*)::bigint AS c FROM "Organization"`);
    assert.ok(Number(orgs[0].c) >= 1, 'organization data preserved');
    for (const [table, id, label] of [
      ['Employee', 'leg-emp-1', 'legacy employee preserved'],
      ['Device', 'leg-dev-1', 'legacy device preserved'],
      ['Activity', 'leg-act-1', 'legacy activity preserved'],
    ] as const) {
      const rows = await verify.$queryRawUnsafe<Array<{ c: bigint }>>(`SELECT COUNT(*)::bigint AS c FROM "${table}" WHERE "id"='${id}'`);
      assert.equal(Number(rows[0].c), 1, label);
    }

    // Missing plan table was additively created and the org copy ran on top.
    assert.ok(tables.includes('RealtimeScreenshotEvent'), 'missing plan table created');
    const copied = await verify.$queryRawUnsafe<Array<{ c: bigint }>>(`SELECT COUNT(*)::bigint AS c FROM "Employee" WHERE "organizationId"='${orgId}'`);
    assert.ok(Number(copied[0].c) >= 1, 'org data copied onto the upgraded destination');

    // Every migration-plan table is present post-upgrade.
    const { MIGRATION_TABLES } = await import('../src/lib/migration/plan');
    const missing = MIGRATION_TABLES.map((t) => t.table).filter((t) => !tables.includes(t));
    assert.equal(missing.length, 0, `all plan tables present post-upgrade: ${missing.join(',')}`);
  } finally {
    await verify.$disconnect();
  }

  await db.organizationSettings.upsert({ where: { organizationId: orgId }, create: { organizationId: orgId }, update: {} });
  const afterSettings = await db.organizationSettings.findUnique({ where: { organizationId: orgId } });
  assert.notEqual(afterSettings?.useOwnDb, true, 'settings untouched until explicit activation');

  await legCleanup();
});

// ── LEG-02: idempotency — re-prepare on the converged destination ──────────

test('LEG-02: legacy upgrade is idempotent — re-running on a converged destination is a no-op', async () => {
  // Self-contained: perform the full upgrade first, then re-prepare and prove
  // the second pass changes nothing.
  const { PrismaClient } = await import('@prisma/client');
  const legacyDb = await legFixture();
  await legacyDb.$disconnect();
  await legSubmitAndApprove();
  const { runDueMigrations } = await import('../src/lib/migration/runner');
  const first = await runDueMigrations();
  assert.equal(first.outcome, 'ready_to_activate', `first upgrade must succeed: ${JSON.stringify(first)}`);

  const { prepareDestinationSchema, classifyDestinationSchema } = await import('../src/lib/migration/db-migrate');
  const verify = new PrismaClient({ datasources: { db: { url: `${PG_TEST_BASE}/${LEGACY_DB}?schema=public` } }, log: ['error'] });
  try {
    const cls = await classifyDestinationSchema(verify);
    assert.equal(cls.kind, 'CURRENT_OMNISIGHT', `destination is current after the upgrade (got ${cls.kind})`);
    const before = await verify.$queryRawUnsafe<Array<{ c: bigint }>>(`SELECT COUNT(*)::bigint AS c FROM "Employee"`);
    const res = await prepareDestinationSchema(verify);
    assert.deepEqual(res, { ok: true }, `re-prepare is a no-op success: ${JSON.stringify(res)}`);
    const after = await verify.$queryRawUnsafe<Array<{ c: bigint }>>(`SELECT COUNT(*)::bigint AS c FROM "Employee"`);
    assert.equal(Number(after[0].c), Number(before[0].c), 'no rows changed by the re-run');
  } finally {
    await verify.$disconnect();
  }
  await legCleanup();
});

// ── LEG-03: data-bearing legacy object → refuse, nothing modified ──────────

test('LEG-03: legacy upgrade refuses when a legacy object still carries data (fail-closed, nothing modified)', async () => {
  const legacyDb = await legFixture();
  await legacyDb.$executeRawUnsafe(`INSERT INTO "LicenseKey" ("id", "key") VALUES ('lk-1', 'LEGACY-KEY-VALUE')`);
  await legacyDb.$disconnect();
  const requestId = await legSubmitAndApprove();
  const { runDueMigrations } = await import('../src/lib/migration/runner');
  const result = await runDueMigrations();
  assert.equal(result.outcome, 'failed', 'data-bearing legacy objects must refuse the upgrade');
  const m = await db.infrastructureMigration.findUnique({ where: { requestId } });
  assert.equal(m?.status, 'failed');
  assert.equal(m?.errorStage, 'schema');
  assert.match(m?.errorMessage ?? '', /LicenseKey/i, 'the blocker is NAMED');
  assert.match(m?.errorMessage ?? '', /license-key row/i);
  assert.match(m?.errorMessage ?? '', /controlled legacy conversion|fresh empty Customer DB/i);

  const verify = await legVerifyDb();
  try {
    const keys = await verify.$queryRawUnsafe<Array<{ c: bigint }>>(`SELECT COUNT(*)::bigint AS c FROM "LicenseKey" WHERE "id"='lk-1'`);
    assert.equal(Number(keys[0].c), 1, 'the license-key row survived — nothing was deleted');
    const tables = await legTables(verify);
    assert.ok(tables.includes('LicenseKey'), 'LicenseKey table still present');
    assert.ok((await legEnumValues(verify)).includes('PRIVATE'), 'enum untouched — no type swap happened');
    const planTables = tables.filter((t) => ['RealtimeScreenshotEvent', 'AppListEntry', 'WebcamEvent'].includes(t));
    assert.equal(planTables.length, 0, 'no additive completion ran either — destination untouched');
  } finally {
    await verify.$disconnect();
  }

  await legCleanup();
});

// ── LEG-04: PRIVATE organizations → refuse, enum untouched ─────────────────

test('LEG-04: PRIVATE organizations refuse the upgrade (fail-closed, enum untouched)', async () => {
  const legacyDb = await legFixture();
  await legacyDb.$executeRawUnsafe(`UPDATE "Organization" SET "deploymentMode"='PRIVATE' WHERE "id"='${orgId}'`);
  await legacyDb.$disconnect();
  const requestId = await legSubmitAndApprove();
  const { runDueMigrations } = await import('../src/lib/migration/runner');
  const result = await runDueMigrations();
  assert.equal(result.outcome, 'failed');
  const m = await db.infrastructureMigration.findUnique({ where: { requestId } });
  assert.equal(m?.status, 'failed');
  assert.match(m?.errorMessage ?? '', /PRIVATE/i);
  const verify = await legVerifyDb();
  try {
    const orgs = await verify.$queryRawUnsafe<Array<{ deploymentMode: string }>>(`SELECT "deploymentMode" FROM "Organization" WHERE "id"='${orgId}'`);
    assert.equal(String(orgs[0]?.deploymentMode), 'PRIVATE', 'the PRIVATE org is intact');
    assert.ok((await legEnumValues(verify)).includes('PRIVATE'), 'enum untouched');
  } finally {
    await verify.$disconnect();
  }
  await legCleanup();
});

// ── LEG-05: out-of-scope legacy structures → refuse outright ───────────────

test('LEG-05: out-of-scope legacy structures (data-bearing Guest) refuse the upgrade', async () => {
  const legacyDb = await legFixture();
  await legacyDb.$executeRawUnsafe(`CREATE TABLE "Guest" ("id" TEXT PRIMARY KEY, "organizationId" TEXT)`);
  await legacyDb.$executeRawUnsafe(`INSERT INTO "Guest" ("id", "organizationId") VALUES ('g-1', 'x')`);
  await legacyDb.$disconnect();
  const requestId = await legSubmitAndApprove();
  const { runDueMigrations } = await import('../src/lib/migration/runner');
  const result = await runDueMigrations();
  assert.equal(result.outcome, 'failed', 'out-of-scope legacy fingerprints must refuse');
  const m = await db.infrastructureMigration.findUnique({ where: { requestId } });
  assert.equal(m?.status, 'failed');
  assert.match(m?.errorMessage ?? '', /Guest/);
  assert.match(m?.errorMessage ?? '', /outside the controlled upgrade scope/i);
  const verify = await legVerifyDb();
  try {
    const guests = await verify.$queryRawUnsafe<Array<{ c: bigint }>>(`SELECT COUNT(*)::bigint AS c FROM "Guest" WHERE "id"='g-1'`);
    assert.equal(Number(guests[0].c), 1, 'the Guest row survived');
    assert.ok((await legEnumValues(verify)).includes('PRIVATE'), 'no cleanup ran — enum untouched');
  } finally {
    await verify.$disconnect();
  }
  await legCleanup();
});

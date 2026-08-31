/**
 * Demo Data Integrity Tests — Mega Seed Verification
 *
 * Validates the dataset produced by seed-mega.ts:
 *   - Minimum entity counts
 *   - No duplicate Super Admin
 *   - No duplicate memberships
 *   - Valid foreign-key relationships
 *   - Organization status distribution
 *   - Membership role distribution
 *   - Multi-org users exist
 *
 * Run: npx tsx --test tests/demo-data-integrity.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

// ─── Test DB isolation ──────────────────────────────────────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_demo_integrity';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-demo-integrity-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@demo-integrity.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!DemoIntegrity2026x';
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
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;

  // Run the mega seed against the test DB
  const { seedMega } = await import('../src/lib/seed-mega');
  await seedMega();
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
  } catch { /* best-effort cleanup */ }
});

// ─── DDI-01: Organization count ────────────────────────────────────────

test('DDI-01: At least 12 organizations created', async () => {
  const count = await db.organization.count();
  assert.ok(count >= 12, `Expected >= 12 organizations, got ${count}`);
});

// ─── DDI-02: Organization status distribution ──────────────────────────

test('DDI-02: Organization status distribution includes active, suspended, archived', async () => {
  const active = await db.organization.count({ where: { status: 'active' } });
  const suspended = await db.organization.count({ where: { status: 'suspended' } });
  const archived = await db.organization.count({ where: { status: 'archived' } });
  assert.ok(active >= 8, `Expected >= 8 active orgs, got ${active}`);
  assert.ok(suspended >= 1, `Expected >= 1 suspended org, got ${suspended}`);
  assert.ok(archived >= 1, `Expected >= 1 archived org, got ${archived}`);
});

// ─── DDI-03: AppUser count ─────────────────────────────────────────────

test('DDI-03: At least 100 AppUsers created', async () => {
  const count = await db.appUser.count();
  assert.ok(count >= 100, `Expected >= 100 users, got ${count}`);
});

// ─── DDI-04: Exactly one Super Admin ───────────────────────────────────

test('DDI-04: Exactly one Super Admin exists', async () => {
  const saCount = await db.appUser.count({ where: { role: 'super_admin' } });
  assert.equal(saCount, 1, `Expected exactly 1 Super Admin, got ${saCount}`);
  const sa = await db.appUser.findFirst({ where: { role: 'super_admin' } });
  assert.ok(sa, 'Super Admin user exists');
  assert.equal(sa.isActive, true, 'Super Admin is active');
  assert.equal(sa.organizationId, null, 'Super Admin has no organization binding');
});

// ─── DDI-05: Membership count ──────────────────────────────────────────

test('DDI-05: At least 100 organization memberships', async () => {
  const count = await db.organizationMembership.count();
  assert.ok(count >= 100, `Expected >= 100 memberships, got ${count}`);
});

// ─── DDI-06: No duplicate memberships ──────────────────────────────────

test('DDI-06: No duplicate (userId, organizationId) memberships', async () => {
  const all = await db.organizationMembership.findMany({
    select: { userId: true, organizationId: true },
  });
  const seen = new Set<string>();
  let duplicates = 0;
  for (const m of all) {
    const key = `${m.userId}:${m.organizationId}`;
    if (seen.has(key)) duplicates++;
    seen.add(key);
  }
  assert.equal(duplicates, 0, `Found ${duplicates} duplicate memberships`);
});

// ─── DDI-07: Membership roles are valid ────────────────────────────────

test('DDI-07: All membership roles are valid (owner/org_admin/manager/viewer)', async () => {
  const invalid = await db.$queryRawUnsafe<{ role: string }[]>(
    `SELECT DISTINCT role FROM "OrganizationMembership" WHERE role NOT IN ('owner', 'org_admin', 'manager', 'viewer')`
  );
  assert.equal(invalid.length, 0, `Invalid roles found: ${JSON.stringify(invalid)}`);
});

// ─── DDI-08: Membership status values are valid ────────────────────────

test('DDI-08: All membership statuses are valid (ACTIVE/INVITED/SUSPENDED/REMOVED)', async () => {
  const invalid = await db.$queryRawUnsafe<{ status: string }[]>(
    `SELECT DISTINCT status FROM "OrganizationMembership" WHERE status NOT IN ('ACTIVE', 'INVITED', 'SUSPENDED', 'REMOVED')`
  );
  assert.equal(invalid.length, 0, `Invalid statuses found: ${JSON.stringify(invalid)}`);
});

// ─── DDI-09: Employee count ────────────────────────────────────────────

test('DDI-09: At least 50 employees created', async () => {
  const count = await db.employee.count();
  assert.ok(count >= 50, `Expected >= 50 employees, got ${count}`);
});

// ─── DDI-10: Device count ──────────────────────────────────────────────

test('DDI-10: At least 30 devices created', async () => {
  const count = await db.device.count();
  assert.ok(count >= 30, `Expected >= 30 devices, got ${count}`);
});

// ─── DDI-11: Project count ─────────────────────────────────────────────

test('DDI-11: At least 20 projects created', async () => {
  const count = await db.project.count();
  assert.ok(count >= 20, `Expected >= 20 projects, got ${count}`);
});

// ─── DDI-12: Activity count ────────────────────────────────────────────

test('DDI-12: At least 500 activities created', async () => {
  const count = await db.activity.count();
  assert.ok(count >= 500, `Expected >= 500 activities, got ${count}`);
});

// ─── DDI-13: All memberships reference valid users ─────────────────────

test('DDI-13: All memberships reference existing users', async () => {
  const orphans = await db.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT COUNT(*) as count FROM "OrganizationMembership" m
     LEFT JOIN "AppUser" u ON u.id = m."userId"
     WHERE u.id IS NULL`
  );
  assert.equal(Number(orphans[0].count), 0, `Found ${orphans[0].count} orphan memberships (no user)`);
});

// ─── DDI-14: All memberships reference valid organizations ─────────────

test('DDI-14: All memberships reference existing organizations', async () => {
  const orphans = await db.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT COUNT(*) as count FROM "OrganizationMembership" m
     LEFT JOIN "Organization" o ON o.id = m."organizationId"
     WHERE o.id IS NULL`
  );
  assert.equal(Number(orphans[0].count), 0, `Found ${orphans[0].count} orphan memberships (no org)`);
});

// ─── DDI-15: Employees reference valid organizations ───────────────────

test('DDI-15: All employees reference existing organizations', async () => {
  const orphans = await db.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT COUNT(*) as count FROM "Employee" e
     LEFT JOIN "Organization" o ON o.id = e."organizationId"
     WHERE o.id IS NULL`
  );
  assert.equal(Number(orphans[0].count), 0, `Found ${orphans[0].count} orphan employees`);
});

// ─── DDI-16: Devices reference valid organizations ─────────────────────

test('DDI-16: All devices reference existing organizations', async () => {
  const orphans = await db.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT COUNT(*) as count FROM "Device" d
     LEFT JOIN "Organization" o ON o.id = d."organizationId"
     WHERE o.id IS NULL`
  );
  assert.equal(Number(orphans[0].count), 0, `Found ${orphans[0].count} orphan devices`);
});

// ─── DDI-17: Multi-org users exist ─────────────────────────────────────

test('DDI-17: At least one user belongs to multiple organizations', async () => {
  const multiOrg = await db.$queryRawUnsafe<{ userId: string; orgCount: bigint }[]>(
    `SELECT "userId", COUNT(DISTINCT "organizationId") as "orgCount"
     FROM "OrganizationMembership"
     GROUP BY "userId"
     HAVING COUNT(DISTINCT "organizationId") > 1`
  );
  assert.ok(multiOrg.length >= 1, `Expected >= 1 multi-org user, got ${multiOrg.length}`);
});

// ─── DDI-18: Organization member counts vary ───────────────────────────

test('DDI-18: Organization sizes vary (not all identical)', async () => {
  const sizes = await db.$queryRawUnsafe<{ organizationId: string; count: bigint }[]>(
    `SELECT "organizationId", COUNT(*) as count
     FROM "OrganizationMembership"
     WHERE status = 'ACTIVE'
     GROUP BY "organizationId"
     ORDER BY count DESC`
  );
  assert.ok(sizes.length >= 10, `Expected >= 10 orgs with members, got ${sizes.length}`);
  const maxCount = Number(sizes[0].count);
  const minCount = Number(sizes[sizes.length - 1].count);
  assert.ok(maxCount > minCount, `Org sizes should vary: max=${maxCount}, min=${minCount}`);
});

// ─── DDI-19: No duplicate AppUser emails ───────────────────────────────

test('DDI-19: No duplicate AppUser emails', async () => {
  const dupes = await db.$queryRawUnsafe<{ email: string; count: bigint }[]>(
    `SELECT email, COUNT(*) as count FROM "AppUser" GROUP BY email HAVING COUNT(*) > 1`
  );
  assert.equal(dupes.length, 0, `Duplicate emails found: ${JSON.stringify(dupes)}`);
});

// ─── DDI-20: No duplicate organization slugs ───────────────────────────

test('DDI-20: No duplicate organization slugs', async () => {
  const dupes = await db.$queryRawUnsafe<{ slug: string; count: bigint }[]>(
    `SELECT slug, COUNT(*) as count FROM "Organization" GROUP BY slug HAVING COUNT(*) > 1`
  );
  assert.equal(dupes.length, 0, `Duplicate slugs found: ${JSON.stringify(dupes)}`);
});

// ─── DDI-21: Location coordinates are valid ────────────────────────────

test('DDI-21: All location coordinates are within valid ranges', async () => {
  const invalid = await db.$queryRawUnsafe<{ id: string; lat: number; lng: number }[]>(
    `SELECT id, latitude as lat, longitude as lng FROM "LocationEvent"
     WHERE latitude < -90 OR latitude > 90 OR longitude < -180 OR longitude > 180`
  );
  assert.equal(invalid.length, 0, `Invalid coordinates found: ${JSON.stringify(invalid.slice(0, 5))}`);
});

// ─── DDI-22: Audit log organization references ─────────────────────────

test('DDI-22: All audit logs reference valid organizations (or null for SA)', async () => {
  const orphans = await db.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT COUNT(*) as count FROM "AuditLog" a
     WHERE a."organizationId" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "Organization" o WHERE o.id = a."organizationId")`
  );
  assert.equal(Number(orphans[0].count), 0, `Found ${orphans[0].count} audit logs with invalid org refs`);
});

// ─── DDI-23: Dataset is deterministic (re-seed produces same counts) ───

test('DDI-23: Re-running seed produces the same entity counts', async () => {
  const countsBefore = {
    orgs: await db.organization.count(),
    users: await db.appUser.count(),
    memberships: await db.organizationMembership.count(),
    employees: await db.employee.count(),
    devices: await db.device.count(),
    projects: await db.project.count(),
    activities: await db.activity.count(),
  };

  // Re-run the seed
  const { seedMega } = await import('../src/lib/seed-mega');
  await seedMega();

  const countsAfter = {
    orgs: await db.organization.count(),
    users: await db.appUser.count(),
    memberships: await db.organizationMembership.count(),
    employees: await db.employee.count(),
    devices: await db.device.count(),
    projects: await db.project.count(),
    activities: await db.activity.count(),
  };

  assert.deepEqual(countsAfter, countsBefore, 'Re-seed should produce identical counts');
});

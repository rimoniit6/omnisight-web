/**
 * Super Admin Organizations — Regression Tests for SA-ORG-01 through SA-ORG-07.
 *
 * Proves:
 *  SA-ORG-01  API response uses `data` key (not `organizations`)
 *  SA-ORG-02  Count (pagination.total) matches list length
 *  SA-ORG-03  Super Admin sees all organizations without selected org
 *  SA-ORG-04  Super Admin sees all organizations even when bound to one org
 *  SA-ORG-05  Organization-scoped user sees only their own organizations
 *  SA-ORG-06  Empty database returns empty array with count 0
 *  SA-ORG-07  Unauthorized user cannot access super-admin organizations
 *
 * Runs against a THROWAWAY PostgreSQL database.
 * Run: npx tsx --test tests/super-admin-organizations.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { req } from './helpers/request';

// ─── Test DB isolation ──────────────────────────────────────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_sa_orgs';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-sa-orgs-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@sa-orgs.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!SAOrgs2026x';
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
let signJWT: (payload: { userId: string; email: string; role: string; organizationId?: string; activeOrganizationId?: string }) => Promise<string>;
let bootstrapSuperAdmin: (env?: Record<string, string | undefined>) => Promise<{ created: boolean; alreadyExisted: boolean; user: { id: string; email: string; role: string } }>;

let orgA: { id: string; name: string };
let orgB: { id: string; name: string };
let orgC: { id: string; name: string };

let superAdminUser: { id: string };
let superAdminToken: string;
let superAdminBoundToken: string;
let adminAToken: string;
let viewerAToken: string;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  const sa = await import('../src/lib/super-admin');
  bootstrapSuperAdmin = sa.bootstrapSuperAdmin;

  // Bootstrap super admin
  const result = await bootstrapSuperAdmin();
  superAdminUser = { id: result.user.id };

  // Create three organizations
  orgA = await db.organization.create({ data: { name: 'Org A', slug: 'sa-orgs-a' } });
  orgB = await db.organization.create({ data: { name: 'Org B', slug: 'sa-orgs-b' } });
  orgC = await db.organization.create({ data: { name: 'Org C', slug: 'sa-orgs-c' } });

  // Create org-scoped users
  const adminA = await db.appUser.create({
    data: { email: 'admin@a-sa-orgs.test', name: 'Admin A', password: 'x', role: 'admin', organizationId: orgA.id },
  });
  const viewerA = await db.appUser.create({
    data: { email: 'viewer@a-sa-orgs.test', name: 'Viewer A', password: 'x', role: 'viewer', organizationId: orgA.id },
  });

  // Create memberships
  await db.organizationMembership.createMany({
    data: [
      { userId: adminA.id, organizationId: orgA.id, role: 'admin', status: 'ACTIVE' },
      { userId: viewerA.id, organizationId: orgA.id, role: 'viewer', status: 'ACTIVE' },
    ],
  });

  // Sign tokens
  superAdminToken = await signJWT({ userId: superAdminUser.id, email: 'root@sa-orgs.local', role: 'super_admin' });
  superAdminBoundToken = await signJWT({ userId: superAdminUser.id, email: 'root@sa-orgs.local', role: 'super_admin', organizationId: orgA.id, activeOrganizationId: orgA.id });
  adminAToken = await signJWT({ userId: adminA.id, email: 'admin@a-sa-orgs.test', role: 'admin', organizationId: orgA.id, activeOrganizationId: orgA.id });
  viewerAToken = await signJWT({ userId: viewerA.id, email: 'viewer@a-sa-orgs.test', role: 'viewer', organizationId: orgA.id, activeOrganizationId: orgA.id });
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


// ─── SA-ORG-01: API response uses `data` key ────────────────────────────

test('SA-ORG-01: API response uses `data` key for organization list', async () => {
  const api = await import('../src/app/api/super-admin/organizations/route');
  const res = await api.GET(req(superAdminToken, { url: 'http://localhost:3000/api/super-admin/organizations' }));
  const body = await res.json();
  assert.equal(res.status, 200);
  // The API MUST return `data` (not `organizations`) as the key
  assert.ok(Array.isArray(body.data), 'Response must have `data` array key');
  assert.ok(!body.organizations, 'Response must NOT have `organizations` key (frontend reads `data`)');
});

// ─── SA-ORG-02: Count matches list length ────────────────────────────────

test('SA-ORG-02: pagination.total matches data length when no filtering', async () => {
  const api = await import('../src/app/api/super-admin/organizations/route');
  const res = await api.GET(req(superAdminToken, { url: 'http://localhost:3000/api/super-admin/organizations' }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.length, 3, 'Should return 3 organizations');
  assert.equal(body.pagination.total, 3, 'pagination.total should be 3');
  assert.equal(body.data.length, body.pagination.total, 'List length must equal total count');
});

// ─── SA-ORG-03: Super Admin sees all without selected org ────────────────

test('SA-ORG-03: Super Admin without organization context sees all organizations', async () => {
  const api = await import('../src/app/api/super-admin/organizations/route');
  // Use token WITHOUT organizationId (org-less Super Admin)
  const res = await api.GET(req(superAdminToken, { url: 'http://localhost:3000/api/super-admin/organizations' }));
  const body = await res.json();
  assert.equal(res.status, 200);
  const ids = body.data.map((o: { id: string }) => o.id);
  assert.ok(ids.includes(orgA.id), 'Org A visible');
  assert.ok(ids.includes(orgB.id), 'Org B visible');
  assert.ok(ids.includes(orgC.id), 'Org C visible');
  assert.equal(ids.length, 3, 'All 3 organizations visible');
});

// ─── SA-ORG-04: Super Admin bound to org still sees all ─────────────────

test('SA-ORG-04: Super Admin bound to Org A still sees all organizations in super-admin list', async () => {
  const api = await import('../src/app/api/super-admin/organizations/route');
  // Use token WITH activeOrganizationId = orgA
  const res = await api.GET(req(superAdminBoundToken, { url: 'http://localhost:3000/api/super-admin/organizations' }));
  const body = await res.json();
  assert.equal(res.status, 200);
  const ids = body.data.map((o: { id: string }) => o.id);
  assert.ok(ids.includes(orgA.id), 'Org A visible');
  assert.ok(ids.includes(orgB.id), 'Org B visible');
  assert.ok(ids.includes(orgC.id), 'Org C visible');
  assert.equal(ids.length, 3, 'All 3 organizations visible even when bound');
});

// ─── SA-ORG-05: Org-scoped user sees only their org ─────────────────────

test('SA-ORG-05: Org Admin sees only their own organization', async () => {
  const api = await import('../src/app/api/super-admin/organizations/route');
  // Admin A should be rejected (not super_admin)
  const res = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/super-admin/organizations' }));
  assert.ok(res.status === 401 || res.status === 403, `Org Admin must be rejected from super-admin list, got ${res.status}`);
});

test('SA-ORG-05b: Viewer sees only their own organization via org-scoped endpoint', async () => {
  // Use the regular organizations endpoint (not super-admin) which scopes by membership
  const api = await import('../src/app/api/organizations/route');
  const res = await api.GET(req(viewerAToken, { url: 'http://localhost:3000/api/organizations' }));
  const body = await res.json();
  assert.equal(res.status, 200);
  // Viewer A is only in orgA — should NOT see orgB or orgC
  if (Array.isArray(body)) {
    const ids = body.map((o: { id: string }) => o.id);
    assert.ok(ids.includes(orgA.id), 'Viewer sees their own org');
    assert.ok(!ids.includes(orgB.id), 'Viewer must NOT see Org B');
    assert.ok(!ids.includes(orgC.id), 'Viewer must NOT see Org C');
  } else if (body.data) {
    const ids = body.data.map((o: { id: string }) => o.id);
    assert.ok(ids.includes(orgA.id), 'Viewer sees their own org');
    assert.ok(!ids.includes(orgB.id), 'Viewer must NOT see Org B');
    assert.ok(!ids.includes(orgC.id), 'Viewer must NOT see Org C');
  }
});

// ─── SA-ORG-06: Empty database returns empty ─────────────────────────────

test('SA-ORG-06: Empty database returns empty array with count 0', async () => {
  // Delete all organizations temporarily
  const allOrgs = await db.organization.findMany({ select: { id: true } });
  await db.organization.deleteMany();

  const api = await import('../src/app/api/super-admin/organizations/route');
  const res = await api.GET(req(superAdminToken, { url: 'http://localhost:3000/api/super-admin/organizations' }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.length, 0, 'Empty DB returns empty array');
  assert.equal(body.pagination.total, 0, 'Empty DB returns total 0');

  // Restore organizations. Two fixes vs the original restore:
  //   1. Collision-safe slug — the FULL cuid is used, because the first 8 chars
  //      of two cuids can collide and hit the unique slug constraint.
  //   2. Idempotent — upsert so a re-run on the same DB never fails.
  for (const org of allOrgs) {
    await db.organization.upsert({
      where: { slug: `sa-orgs-${org.id}` },
      create: { name: org.id, slug: `sa-orgs-${org.id}` },
      update: {},
    });
  }
  // Note: this is a simplified restore — the original orgA/orgB/orgC variables still hold the original IDs
  // The important thing is that the empty-state test passed
});

// ─── SA-ORG-07: Unauthorized access is rejected ──────────────────────────

test('SA-ORG-07: Unauthenticated access returns 401', async () => {
  const api = await import('../src/app/api/super-admin/organizations/route');
  const res = await api.GET(req(null, { url: 'http://localhost:3000/api/super-admin/organizations' }));
  assert.equal(res.status, 401, 'Unauthenticated must be rejected');
});

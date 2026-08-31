/**
 * Super Admin Optional Organization Context — Regression Tests
 *
 * Proves the architectural contract:
 *   - Super Admin with 0 orgs → Create Organization required
 *   - Super Admin with 1+ orgs → NO organization prompt, app loads
 *   - Super Admin with activeOrgId=null → valid authenticated state
 *   - Super Admin role preserved after org switch
 *   - Org Admin / Manager / Viewer behavior unchanged
 *
 * Run: npx tsx --test tests/super-admin-organization-context.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation ──────────────────────────────────────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_sa_org_ctx';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-sa-org-ctx-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@sa-org-ctx.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!SAOrgCtx2026x';
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
let bootstrapSuperAdmin: (env?: Record<string, string | undefined>) => Promise<{
  created: boolean;
  alreadyExisted: boolean;
  user: { id: string; email: string; role: string; organizationId: string | null };
}>;

type MeApi = typeof import('../src/app/api/auth/me/route');
let meApi: MeApi;

let saUserId: string;
let saToken: string;
let orgA: { id: string; name: string };

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  const sa = await import('../src/lib/super-admin');
  bootstrapSuperAdmin = sa.bootstrapSuperAdmin;
  meApi = await import('../src/app/api/auth/me/route');

  // Bootstrap super admin
  const result = await bootstrapSuperAdmin();
  saUserId = result.user.id;

  // SA token WITHOUT org context (org-less)
  saToken = await signJWT({
    userId: saUserId,
    email: process.env.SUPER_ADMIN_EMAIL!,
    role: 'super_admin',
    // No organizationId — this is the org-less state
  });
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

function meReq(token: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/me', {
    method: 'GET',
    headers: { 'authorization': `Bearer ${token}` },
  });
}

// ─── SA-ORG-01: Super Admin with zero orgs → Create Org required ──────

test('SA-ORG-01: /api/auth/me with 0 orgs returns organizationCount=0 and org=null', async () => {
  // Ensure zero orgs
  await db.organization.deleteMany();
  const count = await db.organization.count();
  assert.equal(count, 0, 'Zero orgs confirmed');

  const res = await meApi.GET(meReq(saToken));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.user.role, 'super_admin');
  assert.equal(body.organization, null, 'No active organization');
  assert.equal(body.organizationCount, 0, 'organizationCount must be 0');
});

// ─── SA-ORG-02: Super Admin with 1 org → no org prompt ────────────────

test('SA-ORG-02: /api/auth/me with 1 org returns organizationCount=1', async () => {
  orgA = await db.organization.create({
    data: { name: 'Test Org A', slug: 'sa-org-ctx-a' },
  });

  const res = await meApi.GET(meReq(saToken));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.user.role, 'super_admin');
  assert.equal(body.organizationCount, 1, 'organizationCount must be 1');
  // Organization is null because SA has no active org binding
  assert.equal(body.organization, null, 'Org-less SA has null organization');
});

// ─── SA-ORG-03: Super Admin with multiple orgs → no org prompt ────────

test('SA-ORG-03: /api/auth/me with multiple orgs returns correct count', async () => {
  const orgB = await db.organization.create({
    data: { name: 'Test Org B', slug: 'sa-org-ctx-b' },
  });

  const res = await meApi.GET(meReq(saToken));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.organizationCount >= 2, `Expected >= 2 orgs, got ${body.organizationCount}`);
});

// ─── SA-ORG-04: Org-less Super Admin is valid authenticated state ──────

test('SA-ORG-04: Org-less SA token → 200 with valid user and null org', async () => {
  const res = await meApi.GET(meReq(saToken));
  const body = await res.json();
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  assert.equal(body.user.id, saUserId);
  assert.equal(body.user.role, 'super_admin');
  assert.ok(body.user.email, 'Email present');
  assert.equal(body.organization, null, 'Org-less state is valid');
  assert.ok(body.organizationCount >= 2, 'Org count reported');
});

// ─── SA-ORG-05: Super Admin switches org → role remains super_admin ────

test('SA-ORG-05: SA with activeOrgId + membership → role stays super_admin, org is set', async () => {
  // Create membership for SA in orgA so the endpoint can resolve the org
  await db.organizationMembership.upsert({
    where: { userId_organizationId: { userId: saUserId, organizationId: orgA.id } },
    create: { userId: saUserId, organizationId: orgA.id, role: 'org_admin', status: 'ACTIVE' },
    update: { role: 'org_admin', status: 'ACTIVE' },
  });

  const saBoundToken = await signJWT({
    userId: saUserId,
    email: process.env.SUPER_ADMIN_EMAIL!,
    role: 'super_admin',
    organizationId: orgA.id,
    activeOrganizationId: orgA.id,
  });

  const res = await meApi.GET(meReq(saBoundToken));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.user.role, 'super_admin', 'Role must remain super_admin');
  assert.ok(body.organization, 'Active org is present');
  assert.equal(body.organization.id, orgA.id, 'Correct org bound');
  assert.ok(body.organizationCount >= 2, 'Org count still reported');
});

// ─── SA-ORG-06: SA after switch can access operational dashboard ───────

test('SA-ORG-06: SA bound to orgA → organization detail is correct', async () => {
  // Membership was created in SA-ORG-05
  const saBoundToken = await signJWT({
    userId: saUserId,
    email: process.env.SUPER_ADMIN_EMAIL!,
    role: 'super_admin',
    organizationId: orgA.id,
    activeOrganizationId: orgA.id,
  });

  const res = await meApi.GET(meReq(saBoundToken));
  const body = await res.json();
  assert.equal(body.organization.id, orgA.id);
  assert.equal(body.organization.name, 'Test Org A');
});

// ─── SA-ORG-07: SA clears org → does NOT trigger Create Org ───────────

test('SA-ORG-07: Org-less SA with existing orgs → organizationCount > 0', async () => {
  // This is the KEY test: SA with null org but orgs exist
  const res = await meApi.GET(meReq(saToken));
  const body = await res.json();
  assert.equal(body.user.role, 'super_admin');
  assert.equal(body.organization, null, 'No active org');
  assert.ok(body.organizationCount >= 2, 'But orgs exist in DB');
  // The frontend AuthGuard should NOT show CreateOrganizationScreen
  // because organizationCount > 0
});

// ─── SA-ORG-08: Unauthenticated → 401 ─────────────────────────────────

test('SA-ORG-08: Unauthenticated request → 401', async () => {
  const res = await meApi.GET(
    new NextRequest('http://localhost:3000/api/auth/me', { method: 'GET' })
  );
  assert.equal(res.status, 401);
});

// ─── SA-ORG-09: Admin user → organizationCount not included ────────────

test('SA-ORG-09: Non-SA user → organizationCount is undefined (not included)', async () => {
  const admin = await db.appUser.create({
    data: { email: 'admin@sa-org-ctx.local', name: 'Admin', password: 'x', role: 'user' },
  });
  await db.organizationMembership.create({
    data: { userId: admin.id, organizationId: orgA.id, role: 'org_admin', status: 'ACTIVE' },
  });
  const adminToken = await signJWT({
    userId: admin.id, email: admin.email, role: 'org_admin',
    organizationId: orgA.id, activeOrganizationId: orgA.id,
  });

  const res = await meApi.GET(meReq(adminToken));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.user.role, 'org_admin');
  // organizationCount should NOT be present for non-SA users
  assert.equal(body.organizationCount, undefined, 'Non-SA users do not get organizationCount');
});

// ─── SA-ORG-10: Organization membership RBAC unchanged ─────────────────

test('SA-ORG-10: Viewer cannot access super-admin endpoints', async () => {
  const viewer = await db.appUser.create({
    data: { email: 'viewer@sa-org-ctx.local', name: 'Viewer', password: 'x', role: 'viewer' },
  });
  await db.organizationMembership.create({
    data: { userId: viewer.id, organizationId: orgA.id, role: 'viewer', status: 'ACTIVE' },
  });
  const viewerToken = await signJWT({
    userId: viewer.id, email: viewer.email, role: 'viewer',
    organizationId: orgA.id, activeOrganizationId: orgA.id,
  });

  const saApi = await import('../src/app/api/super-admin/organizations/route');
  const res = await saApi.GET(
    new NextRequest('http://localhost:3000/api/super-admin/organizations', {
      method: 'GET',
      headers: { 'authorization': `Bearer ${viewerToken}` },
    })
  );
  assert.ok(res.status === 401 || res.status === 403, `Viewer denied, got ${res.status}`);
});

// ─── SA-ORG-11: AuthGuard logic verification (structural) ──────────────

test('SA-ORG-11: AuthGuard in page.tsx checks organizationCount === 0', async () => {
  const { readFileSync } = await import('fs');
  const { resolve } = await import('path');
  const pageSrc = readFileSync(resolve(__dirname, '../src/app/page.tsx'), 'utf8');

  // The AuthGuard must check organizationCount, not just !organization
  assert.ok(
    pageSrc.includes('organizationCount === 0'),
    'AuthGuard must check organizationCount === 0 (not just !organization)'
  );
  // Must NOT have the old unconditionally-blocking pattern
  assert.ok(
    !pageSrc.includes("user?.role === 'super_admin' && !organization") ||
      pageSrc.includes("user?.role === 'super_admin' && !organization && organizationCount !== null && organizationCount === 0"),
    'AuthGuard must not unconditionally block SA when org is null'
  );
});

// ─── SA-ORG-12: No privilege escalation introduced ─────────────────────

test('SA-ORG-12: SA cannot be downgraded to org-level role via membership', async () => {
  // Create a membership for SA in orgA
  await db.organizationMembership.upsert({
    where: { userId_organizationId: { userId: saUserId, organizationId: orgA.id } },
    create: { userId: saUserId, organizationId: orgA.id, role: 'viewer', status: 'ACTIVE' },
    update: { role: 'viewer', status: 'ACTIVE' },
  });

  // SA with org context should STILL have super_admin role
  const saBoundToken = await signJWT({
    userId: saUserId,
    email: process.env.SUPER_ADMIN_EMAIL!,
    role: 'super_admin',
    organizationId: orgA.id,
    activeOrganizationId: orgA.id,
  });

  const res = await meApi.GET(meReq(saBoundToken));
  const body = await res.json();
  assert.equal(body.user.role, 'super_admin', 'SA role must not be downgraded by membership');
});

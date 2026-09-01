/**
 * Multi-Org GA — REAL application-flow tests (P0/P1 verification).
 *
 * Unlike the model-level multi-org tests, these drive the ACTUAL API route
 * handlers (auth/users, auth/login, me/organization/switch, employees, app-list,
 * super-admin/organizations, organizations/[id]/members) so the full chain
 * USER ACTION → API → AUTHORIZATION → DATABASE → RESPONSE is exercised.
 *
 * Covers spec sections A–I:
 *   A  user provisioning creates membership + login picks active org
 *   B  multi-org user: per-org roles, switch changes role, no client forge
 *   C  membership removal revokes org access but keeps other orgs
 *   D  suspension blocks existing web-admin sessions
 *   E  archive blocks existing web-admin sessions
 *   F  super-admin console access control
 *   G  cross-tenant isolation via the API
 *   H  role differentiation (viewer vs admin)
 *   I  concurrency (duplicate membership, parallel removal)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_multi_org_ga';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-multi-org-ga-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin-ga@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

let db: any;

after(async () => {
  await db?.$disconnect();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function signTestJWT(userId: string, email: string, role: string, organizationId?: string) {
  const { signJWT } = await import('../src/lib/auth');
  return signJWT({ userId, email, role, organizationId, activeOrganizationId: organizationId });
}

async function makeUser(email: string, role: string, password: string, orgId?: string) {
  const { hashPassword } = await import('../src/lib/auth');
  return db.appUser.create({
    data: {
      email,
      name: email.split('@')[0],
      password: await hashPassword(password),
      role,
      organizationId: orgId ?? null,
      isActive: true,
    },
  });
}

function extractCookieToken(res: any): string | null {
  const sc = res.headers?.get?.('set-cookie');
  if (!sc) return null;
  const first = sc.split(';')[0];
  const eq = first.indexOf('=');
  return eq >= 0 ? first.slice(eq + 1) : null;
}

async function login(email: string, password: string): Promise<{ token: string; body: any; status: number }> {
  const loginApi = await import('../src/app/api/auth/login/route');
  const req = new NextRequest('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const res = await loginApi.POST(req);
  const text = await res.text();
  let body: any = {};
  try { body = JSON.parse(text); } catch { body = {}; }
  if (res.status !== 200) {
    console.error(`[GA-TEST] login ${email} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  // Prefer the cookie token (re-signed by switch/login), else body.token
  const cookieToken = extractCookieToken(res);
  return { token: cookieToken || body.token, body, status: res.status };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

let orgA: any, orgB: any, orgC: any, superAdmin: any;

before(async () => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: TEST_DB_URL, DIRECT_URL: TEST_DB_URL },
  });
  const { PrismaClient } = await import('@prisma/client');
  db = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
  await db.$executeRawUnsafe('TRUNCATE TABLE "OrganizationMembership" CASCADE');
  await db.$executeRawUnsafe('TRUNCATE TABLE "AgentToken" CASCADE');
  await db.$executeRawUnsafe('TRUNCATE TABLE "Employee" CASCADE');
  await db.$executeRawUnsafe('TRUNCATE TABLE "Device" CASCADE');
  await db.$executeRawUnsafe('TRUNCATE TABLE "Organization" CASCADE');
  await db.$executeRawUnsafe('TRUNCATE TABLE "AppUser" CASCADE');
  await db.$executeRawUnsafe('TRUNCATE TABLE "UserSession" CASCADE');

  orgA = await db.organization.create({ data: { name: 'GA Org A', slug: 'ga-org-a', timezone: 'UTC' } });
  orgB = await db.organization.create({ data: { name: 'GA Org B', slug: 'ga-org-b', timezone: 'UTC' } });
  orgC = await db.organization.create({ data: { name: 'GA Org C', slug: 'ga-org-c', timezone: 'UTC' } });
  superAdmin = await makeUser('super-ga@test.local', 'super_admin', 'SuperPass123');
  // Super admin ownership membership in A (so they can manage it via console)
  await db.organizationMembership.create({
    data: { userId: superAdmin.id, organizationId: orgA.id, role: 'owner', status: 'ACTIVE' },
  });
});

// ─── A. User provisioning creates membership + login picks active org ─────────

test('A: creating a user via API creates an ACTIVE membership and login resolves the org', async () => {
  const usersApi = await import('../src/app/api/auth/users/route');
  const saToken = await signTestJWT(superAdmin.id, superAdmin.email, 'super_admin', orgA.id);

  const createRes = await usersApi.POST(
    new NextRequest('http://localhost:3000/api/auth/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${saToken}` },
      body: JSON.stringify({
        email: 'provisioned@test.local',
        name: 'Provisioned',
        password: 'Provisioned123',
        role: 'org_admin',
        organizationId: orgA.id,
      }),
    })
  );
  assert.equal(createRes.status, 201, 'user creation should succeed');

  // Membership must exist (authoritative source)
  const m = await db.organizationMembership.findUnique({
    where: { userId_organizationId: { userId: (await db.appUser.findUnique({ where: { email: 'provisioned@test.local' } })).id, organizationId: orgA.id } },
  });
  assert.ok(m, 'OrganizationMembership must be created on user provisioning');
  assert.equal(m.status, 'ACTIVE');
  assert.equal(m.role, 'org_admin');

  // Login must resolve the active org from the membership
  const { token, body, status } = await login('provisioned@test.local', 'Provisioned123');
  assert.equal(status, 200);
  assert.ok(token, 'login returns a token');
  assert.equal(body.organization?.id, orgA.id, 'login active org must be Org A');
  assert.equal(body.user.role, 'org_admin', 'login role must be the membership role');
});

// ─── B. Multi-org user: per-org roles, switch changes role, no forge ─────────

test('B: multi-org user has per-org roles; switching changes effective role; client orgId is ignored', async () => {
  const user = await makeUser('multiorg@test.local', 'admin', 'MultiOrg123', orgA.id);
  // Org A: admin, Org B: viewer
  await db.organizationMembership.create({ data: { userId: user.id, organizationId: orgA.id, role: 'admin', status: 'ACTIVE' } });
  await db.organizationMembership.create({ data: { userId: user.id, organizationId: orgB.id, role: 'viewer', status: 'ACTIVE' } });

  // Login picks Org A (legacy field) as admin
  const { token: tokenA, body } = await login('multiorg@test.local', 'MultiOrg123');
  assert.equal(body.organization?.id, orgA.id);
  assert.equal(body.user.role, 'admin');

  const appListApi = await import('../src/app/api/app-list/route');
  const employeesApi = await import('../src/app/api/employees/route');

  // As Org A admin, app-list POST allowed (201)
  const adminAppList = await appListApi.POST(
    new NextRequest('http://localhost:3000/api/app-list', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ appName: 'App A', listType: 'whitelist' }),
    })
  );
  assert.equal(adminAppList.status, 201, 'Org A admin may create app-list entry');

  // Switch to Org B (viewer) via the REAL switch endpoint
  const switchApi = await import('../src/app/api/me/organization/switch/route');
  const switchRes = await switchApi.POST(
    new NextRequest('http://localhost:3000/api/me/organization/switch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ organizationId: orgB.id }),
    })
  );
  assert.equal(switchRes.status, 200, 'switch to Org B must succeed');
  const tokenB = extractCookieToken(switchRes);
  assert.ok(tokenB, 'switch must re-issue a token');

  // As Org B viewer, app-list POST denied (403)
  const viewerAppList = await appListApi.POST(
    new NextRequest('http://localhost:3000/api/app-list', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({ name: 'App B', category: 'productivity' }),
    })
  );
  assert.equal(viewerAppList.status, 403, 'Org B viewer may NOT create app-list entry');

  // Forge: Org A admin token, but attempt to read Org B employees via query param
  await db.employee.create({ data: { employeeId: 'EMP-FORGE-B', firstName: 'B', lastName: 'Emp', email: 'b@x', organizationId: orgB.id, status: 'active' } });
  await db.employee.create({ data: { employeeId: 'EMP-FORGE-A', firstName: 'A', lastName: 'Emp', email: 'a@x', organizationId: orgA.id, status: 'active' } });
  const forgeRes = await employeesApi.GET(
    new NextRequest(`http://localhost:3000/api/employees?organizationId=${orgB.id}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${tokenA}` },
    })
  );
  const forgeBody = await forgeRes.json();
  const allOrgA = (forgeBody.employees || []).every((e: any) => e.organizationId === orgA.id);
  assert.ok(allOrgA, 'client-supplied organizationId must be ignored (tenant isolation)');
  assert.ok(!(forgeBody.employees || []).some((e: any) => e.employeeId === 'EMP-FORGE-B'), 'must not leak Org B employees');
});

// ─── C. Membership removal revokes org access, keeps other orgs ──────────────

test('C: removing Org A membership denies Org A but Org B still works', async () => {
  const user = await makeUser('removemember@test.local', 'admin', 'Remove123', orgA.id);
  await db.organizationMembership.create({ data: { userId: user.id, organizationId: orgA.id, role: 'admin', status: 'ACTIVE' } });
  await db.organizationMembership.create({ data: { userId: user.id, organizationId: orgB.id, role: 'viewer', status: 'ACTIVE' } });

  const { token: tokenA } = await login('removemember@test.local', 'Remove123');

  // Remove Org A membership via the management API (as super admin)
  const membersApi = await import('../src/app/api/organizations/[id]/members/[memberId]/route');
  const delRes = await membersApi.DELETE(
    new NextRequest(`http://localhost:3000/api/organizations/${orgA.id}/members/${user.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await signTestJWT(superAdmin.id, superAdmin.email, 'super_admin', orgA.id)}` },
    }),
    { params: Promise.resolve({ id: orgA.id, memberId: user.id }) }
  );
  assert.equal(delRes.status, 200, 'membership removal must succeed');

  // Existing Org A session (tokenA still has activeOrganizationId=orgA) must now be denied
  const employeesApi = await import('../src/app/api/employees/route');
  const denied = await employeesApi.GET(
    new NextRequest('http://localhost:3000/api/employees', {
      method: 'GET',
      headers: { authorization: `Bearer ${tokenA}` },
    })
  );
  assert.equal(denied.status, 403, 'removed membership must revoke Org A access');

  // Org B still works (re-login to get a token whose active org resolves to Org B)
  const { token: tokenB, status } = await login('removemember@test.local', 'Remove123');
  assert.equal(status, 200);
  const okB = await employeesApi.GET(
    new NextRequest('http://localhost:3000/api/employees', {
      method: 'GET',
      headers: { authorization: `Bearer ${tokenB}` },
    })
  );
  assert.equal(okB.status, 200, 'Org B access must still work after Org A removal');
});

// ─── D. Suspension blocks existing web-admin sessions ───────────────────────

test('D: suspending an org blocks an already-authenticated web-admin session', async () => {
  const user = await makeUser('suspend@test.local', 'admin', 'Suspend123', orgA.id);
  await db.organizationMembership.create({ data: { userId: user.id, organizationId: orgA.id, role: 'admin', status: 'ACTIVE' } });

  const { token } = await login('suspend@test.local', 'Suspend123');

  // Pre-suspension: allowed
  const employeesApi = await import('../src/app/api/employees/route');
  const before = await employeesApi.GET(new NextRequest('http://localhost:3000/api/employees', { method: 'GET', headers: { authorization: `Bearer ${token}` } }));
  assert.equal(before.status, 200);

  // Super admin suspends Org A
  const suspendApi = await import('../src/app/api/super-admin/organizations/[id]/route');
  const suspRes = await suspendApi.PATCH(
    new NextRequest(`http://localhost:3000/api/super-admin/organizations/${orgA.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await signTestJWT(superAdmin.id, superAdmin.email, 'super_admin', orgA.id)}` },
      body: JSON.stringify({ status: 'suspended' }),
    }),
    { params: Promise.resolve({ id: orgA.id }) }
  );
  assert.equal(suspRes.status, 200);

  // Existing session must now be denied
  const after = await employeesApi.GET(new NextRequest('http://localhost:3000/api/employees', { method: 'GET', headers: { authorization: `Bearer ${token}` } }));
  assert.equal(after.status, 403, 'suspended org must block existing web-admin session');

  // Super admin can still manage the suspended org
  const listRes = await (await import('../src/app/api/super-admin/organizations/route')).GET(
    new NextRequest('http://localhost:3000/api/super-admin/organizations', { method: 'GET', headers: { authorization: `Bearer ${await signTestJWT(superAdmin.id, superAdmin.email, 'super_admin', orgA.id)}` } })
  );
  assert.equal(listRes.status, 200, 'super admin can still list orgs while one is suspended');
});

// ─── E. Archive blocks existing web-admin sessions ──────────────────────────

test('E: archiving an org blocks an already-authenticated web-admin session', async () => {
  const user = await makeUser('archive@test.local', 'admin', 'Archive123', orgB.id);
  await db.organizationMembership.create({ data: { userId: user.id, organizationId: orgB.id, role: 'admin', status: 'ACTIVE' } });

  const { token } = await login('archive@test.local', 'Archive123');
  const employeesApi = await import('../src/app/api/employees/route');

  const suspendApi = await import('../src/app/api/super-admin/organizations/[id]/route');
  const archRes = await suspendApi.PATCH(
    new NextRequest(`http://localhost:3000/api/super-admin/organizations/${orgB.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await signTestJWT(superAdmin.id, superAdmin.email, 'super_admin', orgB.id)}` },
      body: JSON.stringify({ status: 'archived' }),
    }),
    { params: Promise.resolve({ id: orgB.id }) }
  );
  assert.equal(archRes.status, 200);

  const after = await employeesApi.GET(new NextRequest('http://localhost:3000/api/employees', { method: 'GET', headers: { authorization: `Bearer ${token}` } }));
  assert.equal(after.status, 403, 'archived org must block existing web-admin session');
});

// ─── F. Super Admin console access control ───────────────────────────────────

test('F: only super_admin can access the super-admin organizations console', async () => {
  const admin = await makeUser('f-admin@test.local', 'admin', 'FAdmin123', orgA.id);
  const owner = await makeUser('f-owner@test.local', 'owner', 'FOwner123', orgA.id);
  const manager = await makeUser('f-manager@test.local', 'manager', 'FManager123', orgA.id);
  const viewer = await makeUser('f-viewer@test.local', 'viewer', 'FViewer123', orgA.id);
  for (const u of [admin, owner, manager, viewer]) {
    await db.organizationMembership.create({ data: { userId: u.id, organizationId: orgA.id, role: u.role, status: 'ACTIVE' } });
  }

  const consoleApi = await import('../src/app/api/super-admin/organizations/route');
  const cases: Array<[any, number]> = [
    [superAdmin, 200],
    [admin, 403],
    [owner, 403],
    [manager, 403],
    [viewer, 403],
  ];
  for (const [u, expected] of cases) {
    const res = await consoleApi.GET(
      new NextRequest('http://localhost:3000/api/super-admin/organizations', {
        method: 'GET',
        headers: { authorization: `Bearer ${await signTestJWT(u.id, u.email, u.role, orgA.id)}` },
      })
    );
    assert.equal(res.status, expected, `role ${u.role} -> expected ${expected}`);
  }
});

// ─── G. Cross-tenant isolation via API ──────────────────────────────────────

test('G: Org A member cannot read Org B employees through the API', async () => {
  const user = await makeUser('cross@test.local', 'admin', 'Cross123', orgA.id);
  await db.organizationMembership.create({ data: { userId: user.id, organizationId: orgA.id, role: 'admin', status: 'ACTIVE' } });
  await db.employee.create({ data: { employeeId: 'EMP-G-A', firstName: 'A', lastName: 'E', email: 'ga@a', organizationId: orgA.id, status: 'active' } });
  await db.employee.create({ data: { employeeId: 'EMP-G-B', firstName: 'B', lastName: 'E', email: 'gb@b', organizationId: orgC.id, status: 'active' } });

  const { token } = await login('cross@test.local', 'Cross123');
  const employeesApi = await import('../src/app/api/employees/route');
  const res = await employeesApi.GET(new NextRequest('http://localhost:3000/api/employees', { method: 'GET', headers: { authorization: `Bearer ${token}` } }));
  const body = await res.json();
  assert.ok((body.employees || []).every((e: any) => e.organizationId === orgA.id), 'only Org A employees returned');
  assert.ok(!(body.employees || []).some((e: any) => e.employeeId === 'EMP-G-B'), 'Org C employee must not leak');
});

// ─── H. Role differentiation ─────────────────────────────────────────────────

test('H: organization-specific roles are enforced independently', async () => {
  // Re-activate orgB in case a previous test archived it
  await db.organization.update({ where: { id: orgB.id }, data: { status: 'active' } });
  const user = await makeUser('role@test.local', 'viewer', 'Role123', orgA.id);
  await db.organizationMembership.create({ data: { userId: user.id, organizationId: orgA.id, role: 'viewer', status: 'ACTIVE' } });
  await db.organizationMembership.create({ data: { userId: user.id, organizationId: orgB.id, role: 'admin', status: 'ACTIVE' } });

  const { token: tokenA } = await login('role@test.local', 'Role123');
  // Create a token for Org B (admin role) directly
  const tokenB = await signTestJWT(user.id, user.email, 'admin', orgB.id);

  const membersApi = await import('../src/app/api/organizations/[id]/members/route');
  // Org A viewer cannot list members
  const denied = await membersApi.GET(new NextRequest(`http://localhost:3000/api/organizations/${orgA.id}/members`, {
    method: 'GET', headers: { authorization: `Bearer ${tokenA}` },
  }), { params: Promise.resolve({ id: orgA.id }) });
  assert.equal(denied.status, 403, 'Org A viewer cannot manage members');
  // Org B admin can list members
  const allowed = await membersApi.GET(new NextRequest(`http://localhost:3000/api/organizations/${orgB.id}/members`, {
    method: 'GET', headers: { authorization: `Bearer ${tokenB}` },
  }), { params: Promise.resolve({ id: orgB.id }) });
  assert.equal(allowed.status, 200, 'Org B admin can manage members');
});

// ─── I. Concurrency ─────────────────────────────────────────────────────────

test('I: duplicate membership add is idempotent; parallel removal is safe', async () => {
  const user = await makeUser('concurrent@test.local', 'viewer', 'Conc123', orgA.id);
  await db.organizationMembership.create({ data: { userId: user.id, organizationId: orgA.id, role: 'viewer', status: 'ACTIVE' } });

  const membersApi = await import('../src/app/api/organizations/[id]/members/route');
  const saTok = await signTestJWT(superAdmin.id, superAdmin.email, 'super_admin', orgA.id);
  const base = { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${saTok}` } } as const;
  const addBody = JSON.stringify({ email: user.email, role: 'viewer' });

  // Two parallel adds must not create a duplicate (compound unique).
  const [r1, r2] = await Promise.all([
    membersApi.POST(new NextRequest(`http://localhost:3000/api/organizations/${orgA.id}/members`, { ...base, body: addBody }), { params: Promise.resolve({ id: orgA.id }) }),
    membersApi.POST(new NextRequest(`http://localhost:3000/api/organizations/${orgA.id}/members`, { ...base, body: addBody }), { params: Promise.resolve({ id: orgA.id }) }),
  ]);
  assert.ok(r1.status === 201 || r1.status === 200);
  assert.ok(r2.status === 201 || r2.status === 200);
  const count = await db.organizationMembership.count({ where: { userId: user.id, organizationId: orgA.id } });
  assert.equal(count, 1, 'duplicate membership add must be idempotent');

  // Parallel removals: second must be 404 (already gone).
  const delApi = await import('../src/app/api/organizations/[id]/members/[memberId]/route');
  const [d1, d2] = await Promise.all([
    delApi.DELETE(new NextRequest(`http://localhost:3000/api/organizations/${orgA.id}/members/${user.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${saTok}` } }), { params: Promise.resolve({ id: orgA.id, memberId: user.id }) }),
    delApi.DELETE(new NextRequest(`http://localhost:3000/api/organizations/${orgA.id}/members/${user.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${saTok}` } }), { params: Promise.resolve({ id: orgA.id, memberId: user.id }) }),
  ]);
  const statuses = [d1.status, d2.status].sort();
  // At least one must succeed; the other may be 404 (race) or also 200 (idempotent)
  assert.ok(statuses[0] >= 200 && statuses[0] < 300, 'at least one parallel removal succeeded');
});

// ─── J. Refresh-token uses membership role (not AppUser.role) ──────────────
// Uses orgC because tests D/E suspend orgA/archive orgB.
// orgC remains ACTIVE throughout all tests.

test('J: refresh-token resolves role from membership, not AppUser.role', async () => {
  const user = await makeUser('refresh-role@test.local', 'admin', 'RefreshRole123', orgC.id);
  await db.organizationMembership.create({ data: { userId: user.id, organizationId: orgC.id, role: 'admin', status: 'ACTIVE' } });

  // Login — should get admin role from membership
  const { token: loginToken, body: loginBody } = await login('refresh-role@test.local', 'RefreshRole123');
  assert.equal(loginBody.user.role, 'admin', 'login role must be admin from membership');

  // Refresh — should still get admin role
  const refreshApi = await import('../src/app/api/auth/refresh-token/route');
  const refreshRes = await refreshApi.POST(
    new NextRequest('http://localhost:3000/api/auth/refresh-token', {
      method: 'POST',
      headers: { authorization: `Bearer ${loginToken}` },
    })
  );
  assert.equal(refreshRes.status, 200);
  const refreshBody = await refreshRes.json();
  assert.equal(refreshBody.user.role, 'admin', 'refresh must return membership role (admin)');

  // Downgrade membership role to viewer
  await db.organizationMembership.update({
    where: { userId_organizationId: { userId: user.id, organizationId: orgC.id } },
    data: { role: 'viewer' },
  });

  // Refresh again — must now return viewer (NOT the old admin from AppUser.role)
  const refreshRes2 = await refreshApi.POST(
    new NextRequest('http://localhost:3000/api/auth/refresh-token', {
      method: 'POST',
      headers: { authorization: `Bearer ${refreshBody.token}` },
    })
  );
  assert.equal(refreshRes2.status, 200);
  const refreshBody2 = await refreshRes2.json();
  assert.equal(refreshBody2.user.role, 'viewer', 'refresh must reflect downgraded membership role');
});

// ─── K. Multi-org role isolation across refresh ────────────────────────────

test('K: refresh-token role matches active org membership, not other org', async () => {
  // Use orgC (active) and create a fresh org for this test
  const freshOrg = await db.organization.create({ data: { name: 'Refresh Test Org', slug: `refresh-test-${Date.now()}`, timezone: 'UTC' } });
  const user = await makeUser('refresh-isolation@test.local', 'viewer', 'RefreshIso123', freshOrg.id);
  await db.organizationMembership.create({ data: { userId: user.id, organizationId: freshOrg.id, role: 'admin', status: 'ACTIVE' } });
  await db.organizationMembership.create({ data: { userId: user.id, organizationId: orgC.id, role: 'viewer', status: 'ACTIVE' } });

  // Login — picks freshOrg (legacy field) as admin
  const { token: tokenA } = await login('refresh-isolation@test.local', 'RefreshIso123');

  // Refresh while in freshOrg — must be admin
  const refreshApi = await import('../src/app/api/auth/refresh-token/route');
  const refreshA = await refreshApi.POST(
    new NextRequest('http://localhost:3000/api/auth/refresh-token', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenA}` },
    })
  );
  const bodyA = await refreshA.json();
  assert.equal(bodyA.user.role, 'admin', 'freshOrg refresh must return admin role');

  // Switch to orgC
  const switchApi = await import('../src/app/api/me/organization/switch/route');
  const switchRes = await switchApi.POST(
    new NextRequest('http://localhost:3000/api/me/organization/switch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ organizationId: orgC.id }),
    })
  );
  assert.equal(switchRes.status, 200);
  const tokenB = extractCookieToken(switchRes);
  assert.ok(tokenB, 'switch must re-issue token');

  // Refresh while in orgC — must be viewer (NOT admin from freshOrg)
  const refreshB = await refreshApi.POST(
    new NextRequest('http://localhost:3000/api/auth/refresh-token', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenB}` },
    })
  );
  const bodyB = await refreshB.json();
  assert.equal(bodyB.user.role, 'viewer', 'orgC refresh must return viewer role, not admin from freshOrg');
});

// ─── L. Suspended organization rejects refresh ──────────────────────────────

test('L: refresh-token rejects when organization is suspended', async () => {
  // Create a fresh org we can suspend for this test
  const suspendOrg = await db.organization.create({ data: { name: 'Suspend Test Org', slug: `suspend-test-${Date.now()}`, timezone: 'UTC' } });
  const user = await makeUser('refresh-suspend@test.local', 'admin', 'RefreshSusp123', suspendOrg.id);
  await db.organizationMembership.create({ data: { userId: user.id, organizationId: suspendOrg.id, role: 'admin', status: 'ACTIVE' } });

  const { token } = await login('refresh-suspend@test.local', 'RefreshSusp123');

  // Pre-suspension: refresh works
  const refreshApi = await import('../src/app/api/auth/refresh-token/route');
  const before = await refreshApi.POST(
    new NextRequest('http://localhost:3000/api/auth/refresh-token', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    })
  );
  assert.equal(before.status, 200, 'pre-suspension refresh must succeed');

  // Super Admin suspends the org
  const suspendApi = await import('../src/app/api/super-admin/organizations/[id]/route');
  const suspRes = await suspendApi.PATCH(
    new NextRequest(`http://localhost:3000/api/super-admin/organizations/${suspendOrg.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await signTestJWT(superAdmin.id, superAdmin.email, 'super_admin', suspendOrg.id)}` },
      body: JSON.stringify({ status: 'suspended' }),
    }),
    { params: Promise.resolve({ id: suspendOrg.id }) }
  );
  assert.equal(suspRes.status, 200);

  // Refresh must now be rejected (org is suspended)
  const after = await refreshApi.POST(
    new NextRequest('http://localhost:3000/api/auth/refresh-token', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    })
  );
  assert.ok(after.status === 403 || after.status === 401, 'suspended org refresh must be rejected');
});

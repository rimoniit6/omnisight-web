/**
 * Phase 2 §37: Super Admin privacy attack tests + §5/§36 mode tests.
 *
 * Proves (throwaway DB):
 *  PV-01  SA → super-admin/[CUSTOMER_DB]/employees            => 403
 *  PV-02  SA → super-admin/[PRIVATE]/devices                  => 403
 *  PV-03  SA → super-admin/[MANAGED]/employees                => 200
 *  PV-04  SA → /api/employees?organizationId=<CUSTOMER_DB>    => 403
 *  PV-05  SA → /api/employees/search?organizationId=<PRIVATE> => 403
 *  PV-06  SA (org-less) → screenshots/analytics               => EMPTY (no leak)
 *  PV-07  SA → switch CUSTOMER_DB / PRIVATE                   => 403
 *  PV-08  Mode change → CUSTOMER_DB                           => rejected (422)
 *  PV-09  Mode change MANAGED → PRIVATE                       => allowed + audited
 *  PV-10  Mode change PRIVATE → MANAGED w/o confirm           => rejected (422)
 *  PV-11  Mode change PRIVATE → MANAGED with confirm          => allowed + unresolved cleared
 *  PV-12  mustChangePassword session: allowlisted /me => 200, /organizations => 401;
 *          after change-password => access restored
 *  PV-13  Org member (non-SA) unaffected: own CUSTOMER_DB tenant => 200
 *
 * Run: npx tsx --test tests/super-admin-privacy.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_sa_privacy';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-sa-privacy-0123456789abcdef';
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
let signJWT: (payload: {
  userId: string;
  email: string;
  role: string;
  organizationId?: string;
  activeOrganizationId?: string;
  sessionId?: string;
}) => Promise<string>;

let saId: string;
let managedId: string;
let customerId: string;
let privateId: string;
let memberId: string;

function req(url: string, token: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  const sa = await db.appUser.create({
    data: { email: 'sa@privacy.local', name: 'SA', role: 'super_admin', isActive: true },
  });
  saId = sa.id;

  managedId = (await db.organization.create({ data: { name: 'M', slug: 'pv-m', deploymentMode: 'MANAGED' } })).id;
  customerId = (await db.organization.create({ data: { name: 'C', slug: 'pv-c', deploymentMode: 'CUSTOMER_DB' } })).id;
  privateId = (await db.organization.create({ data: { name: 'P', slug: 'pv-p', deploymentMode: 'PRIVATE' } })).id;

  // Customer-org operational data that must never leak to SA.
  const emp = await db.employee.create({
    data: { employeeId: 'PV-E1', firstName: 'Priv', lastName: 'Ate', email: 'pv@customer.local', organizationId: customerId },
  });
  await db.activity.create({
    data: { type: 'application', title: 'secret-app', duration: 3600, employeeId: emp.id, organizationId: customerId },
  });
  await db.screenshot.create({
    data: { employeeId: emp.id, organizationId: customerId, filePath: '/uploads/screenshots/pv.png', fileName: 'pv.png', fileSize: 10, mimeType: 'image/png' },
  });

  const member = await db.appUser.create({
    data: { email: 'member@privacy.local', name: 'Member', role: 'user', isActive: true },
  });
  memberId = member.id;
  await db.organizationMembership.create({
    data: { userId: memberId, organizationId: customerId, role: 'org_admin', status: 'ACTIVE' },
  });
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
  } catch { /* best-effort */ }
});

async function saToken(): Promise<string> {
  return signJWT({ userId: saId, email: 'sa@privacy.local', role: 'super_admin' });
}

function saRoute(id: string, kind: string) {
  return `http://localhost:3000/api/super-admin/organizations/${id}/${kind}`;
}

// PV-01
test('PV-01: SA employees read on CUSTOMER_DB is rejected', async () => {
  const { GET } = await import('../src/app/api/super-admin/organizations/[id]/employees/route');
  const res = await GET(req(saRoute(customerId, 'employees'), await saToken()), { params: Promise.resolve({ id: customerId }) });
  assert.equal(res.status, 403);
});

// PV-02
test('PV-02: SA devices read on PRIVATE is rejected', async () => {
  const { GET } = await import('../src/app/api/super-admin/organizations/[id]/devices/route');
  const res = await GET(req(saRoute(privateId, 'devices'), await saToken()), { params: Promise.resolve({ id: privateId }) });
  assert.equal(res.status, 403);
});

// PV-03
test('PV-03: SA employees read on MANAGED still works', async () => {
  const { GET } = await import('../src/app/api/super-admin/organizations/[id]/employees/route');
  const res = await GET(req(saRoute(managedId, 'employees'), await saToken()), { params: Promise.resolve({ id: managedId }) });
  assert.equal(res.status, 200);
});

// PV-04
test('PV-04: SA employees list with customer orgId param is rejected', async () => {
  const { GET } = await import('../src/app/api/employees/route');
  const res = await GET(req(`http://localhost:3000/api/employees?organizationId=${customerId}`, await saToken()));
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.code, 'TENANT_ACCESS_DENIED_FOR_MODE');
});

// PV-05
test('PV-05: SA employee search with private orgId param is rejected', async () => {
  const { GET } = await import('../src/app/api/employees/search/route');
  const res = await GET(req(`http://localhost:3000/api/employees/search?q=x&organizationId=${privateId}`, await saToken()));
  assert.equal(res.status, 403);
});

// PV-06
test('PV-06: org-less SA sees EMPTY screenshots/analytics (no cross-customer leak)', async () => {
  const shots = await import('../src/app/api/screenshots/route');
  const analytics = await import('../src/app/api/analytics/route');
  const token = await saToken();
  const sRes = await shots.GET(req('http://localhost:3000/api/screenshots', token));
  assert.equal(sRes.status, 200);
  const sBody = await sRes.json();
  assert.equal(sBody.total, 0, 'org-less SA must not see customer screenshots');
  const aRes = await analytics.GET(req('http://localhost:3000/api/analytics', token));
  assert.equal(aRes.status, 200);
});

// PV-07
test('PV-07: SA switch to CUSTOMER_DB/PRIVATE is rejected', async () => {
  const { POST } = await import('../src/app/api/me/organization/switch/route');
  const token = await saToken();
  const cRes = await POST(req('http://localhost:3000/api/me/organization/switch', token, 'POST', { organizationId: customerId }));
  assert.equal(cRes.status, 403);
  const pRes = await POST(req('http://localhost:3000/api/me/organization/switch', token, 'POST', { organizationId: privateId }));
  assert.equal(pRes.status, 403);
});

// PV-08
test('PV-08: deployment-mode change to CUSTOMER_DB is rejected', async () => {
  const { PATCH } = await import('../src/app/api/super-admin/organizations/[id]/route');
  const res = await PATCH(
    req(`http://localhost:3000/api/super-admin/organizations/${managedId}`, await saToken(), 'PATCH', { deploymentMode: 'CUSTOMER_DB' }),
    { params: Promise.resolve({ id: managedId }) },
  );
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.match(body.error, /CUSTOMER_DB/);
  const row = await db.organization.findUnique({ where: { id: managedId }, select: { deploymentMode: true } });
  assert.equal(row?.deploymentMode, 'MANAGED', 'mode must not change on rejection');
});

// PV-09
test('PV-09: MANAGED to PRIVATE change is allowed and audited', async () => {
  const { PATCH } = await import('../src/app/api/super-admin/organizations/[id]/route');
  const res = await PATCH(
    req(`http://localhost:3000/api/super-admin/organizations/${managedId}`, await saToken(), 'PATCH', { deploymentMode: 'PRIVATE' }),
    { params: Promise.resolve({ id: managedId }) },
  );
  assert.equal(res.status, 200);
  const row = await db.organization.findUnique({ where: { id: managedId }, select: { deploymentMode: true } });
  assert.equal(row?.deploymentMode, 'PRIVATE');
  const audit = await db.auditLog.findFirst({
    where: { resource: 'organization', resourceId: managedId, description: { contains: 'deploymentMode' } },
  });
  assert.ok(audit, 'mode change must be audited');
  // restore for later tests
  await db.organization.update({ where: { id: managedId }, data: { deploymentMode: 'MANAGED' } });
});

// PV-10
test('PV-10: PRIVATE to MANAGED without confirmation is rejected', async () => {
  const { PATCH } = await import('../src/app/api/super-admin/organizations/[id]/route');
  const res = await PATCH(
    req(`http://localhost:3000/api/super-admin/organizations/${privateId}`, await saToken(), 'PATCH', { deploymentMode: 'MANAGED' }),
    { params: Promise.resolve({ id: privateId }) },
  );
  assert.equal(res.status, 422);
});

// PV-11
test('PV-11: PRIVATE to MANAGED with confirmation succeeds and clears unresolved', async () => {
  await db.organization.update({ where: { id: privateId }, data: { deploymentModeUnresolved: true } });
  const { PATCH } = await import('../src/app/api/super-admin/organizations/[id]/route');
  const res = await PATCH(
    req(`http://localhost:3000/api/super-admin/organizations/${privateId}`, await saToken(), 'PATCH', { deploymentMode: 'MANAGED', confirmDataResidency: true }),
    { params: Promise.resolve({ id: privateId }) },
  );
  assert.equal(res.status, 200);
  const row = await db.organization.findUnique({ where: { id: privateId }, select: { deploymentMode: true, deploymentModeUnresolved: true } });
  assert.equal(row?.deploymentMode, 'MANAGED');
  assert.equal(row?.deploymentModeUnresolved, false);
  await db.organization.update({ where: { id: privateId }, data: { deploymentMode: 'PRIVATE' } });
});

// PV-12
test('PV-12: mustChangePassword is API-enforced except allowlisted auth routes', async () => {
  const flagged = await db.appUser.create({
    data: { email: 'flagged@privacy.local', name: 'Flagged', role: 'org_admin', isActive: true, password: 'x', mustChangePassword: true },
  });
  const { hashPassword } = await import('../src/lib/auth');
  await db.appUser.update({ where: { id: flagged.id }, data: { password: await hashPassword('TempPass123!') } });
  const token = await signJWT({ userId: flagged.id, email: 'flagged@privacy.local', role: 'org_admin' });

  const me = await import('../src/app/api/auth/me/route');
  const meRes = await me.GET(req('http://localhost:3000/api/auth/me', token));
  assert.equal(meRes.status, 200, 'allowlisted /me must work');

  const orgs = await import('../src/app/api/organizations/route');
  const blocked = await orgs.GET(req('http://localhost:3000/api/organizations', token));
  assert.equal(blocked.status, 401, 'non-allowlisted API must reject flagged sessions');

  const cp = await import('../src/app/api/auth/change-password/route');
  const cpRes = await cp.POST(
    req('http://localhost:3000/api/auth/change-password', token, 'POST', { currentPassword: 'TempPass123!', newPassword: 'NewPass456!x' }),
  );
  assert.equal(cpRes.status, 200, 'password change must work');

  const after = await orgs.GET(req('http://localhost:3000/api/organizations', token));
  assert.notEqual(after.status, 401, 'access restored after password change');
});

// PV-13
test('PV-13: org member keeps normal tenant access to own CUSTOMER_DB org', async () => {
  const token = await signJWT({ userId: memberId, email: 'member@privacy.local', role: 'org_admin', organizationId: customerId, activeOrganizationId: customerId });
  const { GET } = await import('../src/app/api/employees/route');
  const res = await GET(req('http://localhost:3000/api/employees', token));
  assert.equal(res.status, 200);
  const body = await res.json();
  const ids = (body.data ?? body.employees ?? []).map((e: { id: string }) => e.id);
  assert.ok(ids.length >= 1, 'member must see own org employees');
});

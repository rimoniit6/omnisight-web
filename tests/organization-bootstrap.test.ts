/**
 * Clean Production Bootstrap — org-less Super Admin → first Organization.
 *
 * Covers the phase requirements:
 *   1. Fresh PostgreSQL database
 *   2. Migrations / schema
 *   3. Bootstrap Super Admin from environment variables
 *   4. Login using env credentials
 *   5. Login succeeds with ZERO organizations
 *   6. "Create Organization" is available (POST /api/organizations works)
 *   7. Organization is created
 *   8. Super Admin receives organization context (fresh JWT carries it)
 *   9. Dashboard / org-scoped APIs work with the bound token
 *  10. Empty state: 0 employees / 0 departments / 0 projects / 0 devices
 *  11. No "No organization found" error on org-scoped reads after binding
 *  12. Create Employee / Department → normal org-scoped behavior works
 *  13. Non-super-admins cannot create organizations (403)
 *  14. Duplicate organization name → 409
 *  15. No demo business data is created by the flow
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_orgbootstrap).
 * Run: npx tsx --test tests/organization-bootstrap.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation (set BEFORE any app module import) ──────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_orgbootstrap';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-orgbootstrap-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'bootstrap@corp.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!Bootstrap2026x';
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
let bootstrapSuperAdmin: (env?: Record<string, string | undefined>) => Promise<unknown>;
let signJWT: (payload: { userId: string; email: string; role: string; organizationId?: string }) => Promise<string>;

type LoginApi = typeof import('../src/app/api/auth/login/route');
type OrgsApi = typeof import('../src/app/api/organizations/route');
type OrgApi = typeof import('../src/app/api/organization/route');
type DashboardApi = typeof import('../src/app/api/dashboard/route');
type EmployeesApi = typeof import('../src/app/api/employees/route');
type DepartmentsApi = typeof import('../src/app/api/departments/route');

let loginApi: LoginApi;
let orgsApi: OrgsApi;
let orgApi: OrgApi;
let dashboardApi: DashboardApi;
let employeesApi: EmployeesApi;
let departmentsApi: DepartmentsApi;

let superToken: string; // org-less super admin JWT (from real login)

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  const sa = await import('../src/lib/super-admin');
  bootstrapSuperAdmin = sa.bootstrapSuperAdmin;
  signJWT = (await import('../src/lib/auth')).signJWT;

  const [l, o, og, d, e, dep] = await Promise.all([
    import('../src/app/api/auth/login/route'),
    import('../src/app/api/organizations/route'),
    import('../src/app/api/organization/route'),
    import('../src/app/api/dashboard/route'),
    import('../src/app/api/employees/route'),
    import('../src/app/api/departments/route'),
  ]);
  loginApi = l;
  orgsApi = o;
  orgApi = og;
  dashboardApi = d;
  employeesApi = e;
  departmentsApi = dep;

  // Fresh deployment: bootstrap the env super admin. The DB is otherwise EMPTY.
  const r = await bootstrapSuperAdmin() as { created: boolean; user: { id: string; email: string; role: string; organizationId: string | null } };
  assert.equal(r.created, true);
  assert.equal(r.user.organizationId, null, 'super admin must start org-less');
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

function req(token: string | null, opts: { method?: string; body?: unknown; url?: string; ip?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (opts.ip) headers['x-forwarded-for'] = opts.ip;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(opts.url || 'http://localhost:3000/api/test', {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

/** Extract the session cookie JWT from a login/response Set-Cookie header. */
function cookieToken(res: Response): string | null {
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) return null;
  const m = setCookie.match(/worklens_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// ─── 1. Org-less bootstrap state ───────────────────────────────────────────

test('OB-1: zero organizations after fresh bootstrap', async () => {
  const orgCount = await db.organization.count();
  assert.equal(orgCount, 0, 'fresh deployment must have zero organizations');
  const empCount = await db.employee.count();
  const deptCount = await db.department.count();
  const deviceCount = await db.device.count();
  assert.equal(empCount, 0);
  assert.equal(deptCount, 0);
  assert.equal(deviceCount, 0);
});

test('OB-2: Super Admin logs in with ZERO organizations (org-less session)', async () => {
  const res = await loginApi.POST(
    req(null, {
      method: 'POST',
      body: { email: process.env.SUPER_ADMIN_EMAIL, password: process.env.SUPER_ADMIN_PASSWORD },
      ip: '203.0.113.200',
    })
  );
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.user.role, 'super_admin');
  assert.equal(body.organization, null, 'org-less login must not fabricate an organization');
  assert.ok(body.token);

  superToken = body.token;
  const cookieTok = cookieToken(res);
  assert.ok(cookieTok, 'session cookie must be set');
});

test('OB-3: org-scoped read fails 404 BEFORE creation (the exact reported bug)', async () => {
  const res = await orgApi.GET(req(superToken, { url: 'http://localhost:3000/api/organization' }));
  assert.equal(res.status, 404, 'org-less super admin on /api/organization gets 404 (not 500)');
});

// ─── 2. First organization creation ────────────────────────────────────────

test('OB-4: Super Admin creates the FIRST organization (201)', async () => {
  const res = await orgsApi.POST(
    req(superToken, { method: 'POST', body: { name: 'Acme Corporation' }, ip: '203.0.113.201' })
  );
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.data.name, 'Acme Corporation');
  assert.ok(body.data.id);
  assert.ok(body.data.slug, 'server-derived slug');
  assert.ok(body.token, 're-signed session token must be returned');
  assert.equal(body.organization.id, body.data.id);
  assert.equal(body.organization.name, 'Acme Corporation');

  // Super Admin is bound to the org in the DB.
  const sa = await db.appUser.findFirst({ where: { email: { equals: 'bootstrap@corp.local', mode: 'insensitive' } } });
  assert.equal(sa!.organizationId, body.data.id, 'super admin must be bound to the created org');
});

test('OB-5: audit log records organization creation', async () => {
  const org = await db.organization.findFirst({ where: { name: 'Acme Corporation' } });
  const entry = await db.auditLog.findFirst({
    where: { resource: 'organization', action: 'create', resourceId: org!.id },
  });
  assert.ok(entry, 'org creation must be audited');
});

test('OB-6: duplicate organization name → 409', async () => {
  // An org-less super admin whose POST target name already exists.
  await db.appUser.create({
    data: { id: 'ob6-sa', email: 'ob6@corp.local', name: 'SA Six', role: 'super_admin', password: 'hash-placeholder', organizationId: null },
  });
  const orgLess = await signJWT({ userId: 'ob6-sa', email: 'ob6@corp.local', role: 'super_admin' });
  const res = await orgsApi.POST(
    req(orgLess, { method: 'POST', body: { name: 'acme corporation' }, ip: '203.0.113.202' })
  );
  assert.equal(res.status, 409, 'duplicate name (case-insensitive) must be rejected');
});

test('OB-6b: org-BOUND super admin cannot create a second organization (403)', async () => {
  const acme = await db.organization.findFirst({ where: { name: 'Acme Corporation' } });
  await db.appUser.create({
    data: { id: 'ob6b-sa', email: 'ob6b@corp.local', name: 'SA Six B', role: 'super_admin', password: 'hash-placeholder', organizationId: acme!.id },
  });
  const boundTok = await signJWT({
    userId: 'ob6b-sa',
    email: 'ob6b@corp.local',
    role: 'super_admin',
    organizationId: acme!.id,
  });
  const res = await orgsApi.POST(
    req(boundTok, { method: 'POST', body: { name: 'Second Org' }, ip: '203.0.113.210' })
  );
  assert.equal(res.status, 403, 'org-bound super admin must be rejected (no silent re-bind)');
  assert.equal(
    await db.organization.count({ where: { name: 'Second Org' } }),
    0,
    'no second organization created'
  );
});

test('OB-7: non-super-admin cannot create organizations (403)', async () => {
  const adminTok = await signJWT({ userId: 'ob7-admin', email: 'ob7@corp.local', role: 'admin' });
  const res = await orgsApi.POST(
    req(adminTok, { method: 'POST', body: { name: 'Rogue Org' }, ip: '203.0.113.203' })
  );
  assert.equal(res.status, 403, 'admin (non super) must be rejected');
  const viewerTok = await signJWT({ userId: 'ob7-viewer', email: 'ob7v@corp.local', role: 'viewer' });
  const res2 = await orgsApi.POST(
    req(viewerTok, { method: 'POST', body: { name: 'Rogue Org 2' }, ip: '203.0.113.204' })
  );
  assert.equal(res2.status, 403);
  assert.equal(await db.organization.count({ where: { name: { startsWith: 'Rogue' } } }), 0, 'nothing created');
});

test('OB-8: unauthenticated org creation → 401', async () => {
  const res = await orgsApi.POST(req(null, { method: 'POST', body: { name: 'Anon Org' }, ip: '203.0.113.205' }));
  assert.equal(res.status, 401);
});

// ─── 3. Org-bound session → normal control plane ───────────────────────────

test('OB-9: fresh JWT carries the organization context', async () => {
  // The token returned by OB-4 is not stashed globally — re-login now returns
  // a BOUND token (user.organizationId is set in the DB).
  const res = await loginApi.POST(
    req(null, {
      method: 'POST',
      body: { email: process.env.SUPER_ADMIN_EMAIL, password: process.env.SUPER_ADMIN_PASSWORD },
      ip: '203.0.113.206',
    })
  );
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.ok(body.organization, 'post-binding login must return the organization');
  assert.equal(body.organization.name, 'Acme Corporation');

  // Verify the JWT itself carries organizationId.
  const parts = body.token.split('.');
  const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  assert.equal(payload.organizationId, body.organization.id, 'JWT must carry organizationId');

  superToken = body.token;
});

test('OB-10: org-scoped read works after binding (no more 404)', async () => {
  const res = await orgApi.GET(req(superToken, { url: 'http://localhost:3000/api/organization' }));
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.name, 'Acme Corporation');
  assert.equal(body.employeeCount, 0, 'empty employees');
  assert.equal(body.deviceCount, 0, 'empty devices');
  assert.equal((body.departments || []).length, 0, 'empty departments');
});

test('OB-11: dashboard loads successfully with empty production state', async () => {
  const res = await dashboardApi.GET(req(superToken, { url: 'http://localhost:3000/api/dashboard' }));
  assert.equal(res.status, 200, 'dashboard must load');
});

test('OB-12: create department + employee → normal org-scoped behavior works', async () => {
  // Department
  const depRes = await departmentsApi.POST(
    req(superToken, { method: 'POST', body: { name: 'Engineering' }, ip: '203.0.113.207' })
  );
  const depBody = await depRes.json().catch(() => ({})) as { id?: string };
  assert.equal(depRes.status, 201, JSON.stringify(depBody));

  const dept = await db.department.findFirst({ where: { name: 'Engineering' } });
  assert.ok(dept, 'department persisted');
  assert.equal(dept!.organizationId, (await db.organization.findFirst({ where: { name: 'Acme Corporation' } }))!.id, 'department is org-scoped');

  // Employee
  const empRes = await employeesApi.POST(
    req(superToken, {
      method: 'POST',
      body: {
        employeeId: 'OB-EMP-001',
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada.lovelace@acme.test',
        departmentId: dept!.id,
      },
      ip: '203.0.113.208',
    })
  );
  const empBody = await empRes.json().catch(() => ({})) as { id?: string };
  assert.equal(empRes.status, 201, JSON.stringify(empBody));

  const emp = await db.employee.findFirst({ where: { employeeId: 'OB-EMP-001' } });
  assert.ok(emp, 'employee persisted');
  assert.equal(emp!.organizationId, dept!.organizationId, 'employee is org-scoped');

  // Project creation — normal org-scoped behavior (requirement #19/20).
  const projectsApi = await import('../src/app/api/projects/route');
  const projRes = await projectsApi.POST(
    req(superToken, { method: 'POST', body: { name: 'Project Alpha' }, ip: '203.0.113.209' })
  );
  const projBody = await projRes.json().catch(() => ({})) as { id?: string };
  assert.equal(projRes.status, 201, JSON.stringify(projBody));
  const proj = await db.project.findFirst({ where: { name: 'Project Alpha' } });
  assert.ok(proj, 'project persisted');
  assert.equal(proj!.organizationId, dept!.organizationId, 'project is org-scoped');

  // Org read reflects the new data.
  const orgRes = await orgApi.GET(req(superToken, { url: 'http://localhost:3000/api/organization' }));
  const orgBody = await orgRes.json();
  assert.equal(orgBody.employeeCount, 1);
  assert.equal((orgBody.departments || []).length, 1);
});

test('OB-13: no demo business data was ever created', async () => {
  const orgs = await db.organization.findMany({ select: { name: true } });
  assert.deepEqual(orgs.map((o) => o.name), ['Acme Corporation'], 'only the created org exists');
  const users = await db.appUser.findMany({ select: { email: true, role: true } });
  assert.ok(users.some((u) => u.email === 'bootstrap@corp.local' && u.role === 'super_admin'));
  assert.ok(!users.some((u) => ['admin@techvision.com', 'manager@techvision.com', 'viewer@techvision.com'].includes(u.email)), 'no demo users');
  // No device/claim until a real agent EXE calls discover.
  assert.equal(await db.deviceClaim.count(), 0);
  assert.equal(await db.consent.count(), 0);
  assert.equal(await db.consentPolicy.count(), 0);
  assert.equal(await db.project.count(), 1, 'only the project created by the test flow');
  assert.equal(await db.activity.count(), 0);
  assert.equal(await db.screenshot.count(), 0);
});

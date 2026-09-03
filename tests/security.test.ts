/**
 * Phase A — Admin control-plane security tests.
 *
 * Hardens and proves the security boundaries added in Phase A:
 *   - Devices, Employees, Departments, Projects (+ members), and Agent
 *     Registrations now require an authenticated session, are org-scoped, and
 *     gate mutations behind admin+ RBAC.
 *   - Cross-organization references (employeeId, departmentId, managerId,
 *     projectId, registration id) are validated against the session org.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_security).
 * Run: npx tsx --test tests/security.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';
import { req } from './helpers/request';

// ─── Test DB isolation ──────────────────────────────────────────────────────
// Must be set BEFORE any app module is imported.
// Each suite owns a dedicated throwaway PostgreSQL database; the schema is
// pushed with `prisma db push` (test-only convenience — production deploys
// with `prisma migrate deploy`). PG_TEST_BASE_URL overrides the default local
// instance (e.g. for CI).
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_security';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-security-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

before(() => {
  if (process.env.SECURITY_TEST_MIGRATED_DB !== '1') {
    execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
    execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
      env: { ...process.env, DATABASE_URL: TEST_DB_URL },
      stdio: 'pipe',
    });
  }
});

// Module handles populated in before() (env vars must be set first).
type DbModule = typeof import('../src/lib/db');
let db: DbModule['db'];
let signJWT: (payload: { userId: string; email: string; role: string; organizationId?: string }) => Promise<string>;

type DevicesApi = typeof import('../src/app/api/devices/route');
type DeviceIdApi = typeof import('../src/app/api/devices/[id]/route');
type EmployeesApi = typeof import('../src/app/api/employees/route');
type EmployeeIdApi = typeof import('../src/app/api/employees/[id]/route');
type DepartmentsApi = typeof import('../src/app/api/departments/route');
type DepartmentIdApi = typeof import('../src/app/api/departments/[id]/route');
type ProjectsApi = typeof import('../src/app/api/projects/route');
type ProjectIdApi = typeof import('../src/app/api/projects/[id]/route');
type ProjectMembersApi = typeof import('../src/app/api/projects/[id]/members/route');
type ProjectMemberIdApi = typeof import('../src/app/api/projects/[id]/members/[memberId]/route');

let devicesApi: DevicesApi;
let deviceIdApi: DeviceIdApi;
let employeesApi: EmployeesApi;
let employeeIdApi: EmployeeIdApi;
let departmentsApi: DepartmentsApi;
let departmentIdApi: DepartmentIdApi;
let projectsApi: ProjectsApi;
let projectIdApi: ProjectIdApi;
let projectMembersApi: ProjectMembersApi;
let projectMemberIdApi: ProjectMemberIdApi;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  const [
    dApi, dIdApi,
    eApi, eIdApi, depApi, depIdApi,
    pApi, pIdApi, pmApi, pmiApi,
  ] = await Promise.all([
    import('../src/app/api/devices/route'),
    import('../src/app/api/devices/[id]/route'),
    import('../src/app/api/employees/route'),
    import('../src/app/api/employees/[id]/route'),
    import('../src/app/api/departments/route'),
    import('../src/app/api/departments/[id]/route'),
    import('../src/app/api/projects/route'),
    import('../src/app/api/projects/[id]/route'),
    import('../src/app/api/projects/[id]/members/route'),
    import('../src/app/api/projects/[id]/members/[memberId]/route'),
  ]);
  devicesApi = dApi;
  deviceIdApi = dIdApi;
  employeesApi = eApi;
  employeeIdApi = eIdApi;
  departmentsApi = depApi;
  departmentIdApi = depIdApi;
  projectsApi = pApi;
  projectIdApi = pIdApi;
  projectMembersApi = pmApi;
  projectMemberIdApi = pmiApi;
});

after(async () => {
  await db.$disconnect();
  if (process.env.SECURITY_TEST_MIGRATED_DB !== '1') {
    try {
      execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
        env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
        stdio: 'pipe',
      });
    } catch {
      /* best-effort cleanup */
    }
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────────


function tokenFor(orgId: string, role: string, userId: string) {
  return signJWT({ userId, email: `${role}@${orgId.slice(-6)}.local`, role, organizationId: orgId });
}

async function seedOrg(slug: string) {
  return db.organization.create({ data: { name: slug, slug } });
}

async function seedEmployee(orgId: string, code: string, deptId: string | null = null) {
  return db.employee.create({
    data: {
      employeeId: code,
      firstName: code.split('-')[0],
      lastName: 'Test',
      email: `${code.toLowerCase()}@test.local`,
      organizationId: orgId,
      status: 'active',
      departmentId: deptId,
    },
  });
}

async function seedDept(orgId: string, name: string) {
  return db.department.create({ data: { name, organizationId: orgId } });
}

async function seedProject(orgId: string, name: string, deptId: string | null = null) {
  return db.project.create({ data: { name, organizationId: orgId, departmentId: deptId } });
}

async function seedDevice(orgId: string, name: string, employeeId: string | null = null) {
  return db.device.create({
    data: { name, hostname: name.toLowerCase(), organizationId: orgId, employeeId, status: 'online' },
  });
}


async function statusOf(res: Response) {
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

// ─── DEVICE tests ───────────────────────────────────────────────────────────

test('DEVICE-1: unauthenticated GET /api/devices -> 401', async () => {
  const res = await devicesApi.GET(req(null));
  assert.equal(res.status, 401);
});

test('DEVICE-2: authenticated Org A admin sees only Org A devices', async () => {
  const orgA = await seedOrg('dev-a');
  const orgB = await seedOrg('dev-b');
  await seedDevice(orgA.id, 'PC-A');
  await seedDevice(orgA.id, 'PC-A2');
  await seedDevice(orgB.id, 'PC-B');

  const res = await devicesApi.GET(req(await tokenFor(orgA.id, 'admin', 'u-dev-a'), { url: 'http://localhost:3000/api/devices?pageSize=50' }));
  const { data, total } = await res.json();
  assert.equal(res.status, 200);
  assert.equal(total, 2);
  assert.ok(data.every((d: { organizationId: string }) => d.organizationId === orgA.id));
});

test('DEVICE-3: Org A user cannot access Org B device (404, not disclosed)', async () => {
  const orgA = await seedOrg('devx-a');
  const orgB = await seedOrg('devx-b');
  const devB = await seedDevice(orgB.id, 'PC-B-X');

  const res = await deviceIdApi.GET(req(await tokenFor(orgA.id, 'admin', 'u-devx-a')), { params: Promise.resolve({ id: devB.id }) });
  assert.equal(res.status, 404);
});

test('DEVICE-4: viewer cannot mutate devices (403)', async () => {
  const orgA = await seedOrg('devv-a');
  const dev = await seedDevice(orgA.id, 'PC-V');
  const viewer = await tokenFor(orgA.id, 'viewer', 'u-devv-viewer');

  const post = await devicesApi.POST(req(viewer, { method: 'POST', body: { name: 'Nope' } }));
  assert.equal(post.status, 403);

  const put = await deviceIdApi.PUT(req(viewer, { method: 'PUT', body: { name: 'Nope' } }), { params: Promise.resolve({ id: dev.id }) });
  assert.equal(put.status, 403);

  const del = await deviceIdApi.DELETE(req(viewer, { method: 'DELETE' }), { params: Promise.resolve({ id: dev.id }) });
  assert.equal(del.status, 403);
});

test('DEVICE-5: admin can create/update/delete own-org device', async () => {
  const orgA = await seedOrg('devc-a');
  const emp = await seedEmployee(orgA.id, 'DC-001');
  const admin = await tokenFor(orgA.id, 'admin', 'u-devc-admin');

  const create = await devicesApi.POST(req(admin, { method: 'POST', body: { name: 'New PC', employeeId: emp.id } }));
  assert.equal(create.status, 201);
  const created = (await create.json()).data;
  assert.equal(created.organizationId, orgA.id);
  assert.equal(created.employeeId, emp.id);

  const update = await deviceIdApi.PUT(req(admin, { method: 'PUT', body: { name: 'Renamed PC' } }), { params: Promise.resolve({ id: created.id }) });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).data.name, 'Renamed PC');

  const del = await deviceIdApi.DELETE(req(admin, { method: 'DELETE' }), { params: Promise.resolve({ id: created.id }) });
  assert.equal(del.status, 200);
  assert.equal(await db.device.findUnique({ where: { id: created.id } }), null);
});

test('DEVICE-6: cross-org employee assignment rejected (422)', async () => {
  const orgA = await seedOrg('deve-a');
  const orgB = await seedOrg('deve-b');
  const empB = await seedEmployee(orgB.id, 'DE-B');
  const devA = await seedDevice(orgA.id, 'PC-E');
  const adminA = await tokenFor(orgA.id, 'admin', 'u-deve-a');

  const post = await devicesApi.POST(req(adminA, { method: 'POST', body: { name: 'Bad', employeeId: empB.id } }));
  assert.equal(post.status, 422);

  const put = await deviceIdApi.PUT(req(adminA, { method: 'PUT', body: { employeeId: empB.id } }), { params: Promise.resolve({ id: devA.id }) });
  assert.equal(put.status, 422);
});

// ─── EMPLOYEE tests ─────────────────────────────────────────────────────────

test('EMPLOYEE-7: unauthenticated GET /api/employees -> 401 (never all employees)', async () => {
  const res = await employeesApi.GET(req(null));
  assert.equal(res.status, 401);
});

test('EMPLOYEE-8: Org A sees only Org A employees', async () => {
  const orgA = await seedOrg('emp-a');
  const orgB = await seedOrg('emp-b');
  await seedEmployee(orgA.id, 'EMP-A1');
  await seedEmployee(orgA.id, 'EMP-A2');
  await seedEmployee(orgB.id, 'EMP-B1');

  const res = await employeesApi.GET(req(await tokenFor(orgA.id, 'admin', 'u-emp-a'), { url: 'http://localhost:3000/api/employees?pageSize=50' }));
  const { data, total } = await res.json();
  assert.equal(res.status, 200);
  assert.equal(total, 2);
  assert.ok(data.every((e: { organizationId: string }) => e.organizationId === orgA.id));
  // agent credentials never leak
  assert.ok(data.every((e: Record<string, unknown>) => !('agentPassword' in e)));
});

test('EMPLOYEE-9: cross-org employee lookup blocked (404)', async () => {
  const orgA = await seedOrg('empx-a');
  const orgB = await seedOrg('empx-b');
  const empB = await seedEmployee(orgB.id, 'EMP-XB');

  const res = await employeeIdApi.GET(req(await tokenFor(orgA.id, 'admin', 'u-empx-a')), { params: Promise.resolve({ id: empB.id }) });
  assert.equal(res.status, 404);
});

test('EMPLOYEE-10: viewer cannot create/update/delete employee (403)', async () => {
  const orgA = await seedOrg('empv-a');
  const emp = await seedEmployee(orgA.id, 'EMP-V');
  const viewer = await tokenFor(orgA.id, 'viewer', 'u-empv-viewer');

  const post = await employeesApi.POST(req(viewer, { method: 'POST', body: { firstName: 'X', lastName: 'Y', email: 'x@y.local', employeeId: 'EMP-V2' } }));
  assert.equal(post.status, 403);

  const put = await employeeIdApi.PUT(req(viewer, { method: 'PUT', body: { status: 'inactive' } }), { params: Promise.resolve({ id: emp.id }) });
  assert.equal(put.status, 403);

  const del = await employeeIdApi.DELETE(req(viewer, { method: 'DELETE' }), { params: Promise.resolve({ id: emp.id }) });
  assert.equal(del.status, 403);
});

test('EMPLOYEE-11: admin can create/update/archive own-org employee', async () => {
  const orgA = await seedOrg('empc-a');
  const admin = await tokenFor(orgA.id, 'admin', 'u-empc-admin');

  const create = await employeesApi.POST(req(admin, { method: 'POST', body: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@test.local', employeeId: 'EMP-C1' } }));
  assert.equal(create.status, 201);
  const emp = (await create.json()).data;
  assert.equal(emp.organizationId, orgA.id);

  const update = await employeeIdApi.PUT(req(admin, { method: 'PUT', body: { designation: 'Engineer' } }), { params: Promise.resolve({ id: emp.id }) });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).data.designation, 'Engineer');

  const del = await employeeIdApi.DELETE(req(admin, { method: 'DELETE' }), { params: Promise.resolve({ id: emp.id }) });
  assert.equal(del.status, 200);
  assert.equal((await db.employee.findUnique({ where: { id: emp.id } }))!.status, 'archived');
});

test('EMPLOYEE-12: cross-org department assignment rejected (422)', async () => {
  const orgA = await seedOrg('empd-a');
  const orgB = await seedOrg('empd-b');
  const deptB = await seedDept(orgB.id, 'OrgB Dept');
  const empA = await seedEmployee(orgA.id, 'EMP-D');
  const adminA = await tokenFor(orgA.id, 'admin', 'u-empd-a');

  const post = await employeesApi.POST(req(adminA, { method: 'POST', body: { firstName: 'X', lastName: 'Y', email: 'xy@test.local', employeeId: 'EMP-D2', departmentId: deptB.id } }));
  assert.equal(post.status, 422);

  const put = await employeeIdApi.PUT(req(adminA, { method: 'PUT', body: { departmentId: deptB.id } }), { params: Promise.resolve({ id: empA.id }) });
  assert.equal(put.status, 422);
});

// ─── PROJECT tests ──────────────────────────────────────────────────────────

test('PROJECT-13: unauthenticated GET /api/projects -> 401', async () => {
  const res = await projectsApi.GET(req(null));
  assert.equal(res.status, 401);
});

test('PROJECT-14: Org A sees only Org A projects (list + stats aggregates)', async () => {
  const orgA = await seedOrg('proj-a');
  const orgB = await seedOrg('proj-b');
  await seedProject(orgA.id, 'Proj A1');
  await seedProject(orgA.id, 'Proj A2');
  await seedProject(orgB.id, 'Proj B1');

  const res = await projectsApi.GET(req(await tokenFor(orgA.id, 'admin', 'u-proj-a'), { url: 'http://localhost:3000/api/projects?pageSize=50' }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.total, 2);
  assert.ok(body.data.every((p: { organizationId: string }) => p.organizationId === orgA.id));
  // Aggregate stats are org-scoped too.
  assert.equal(body.stats.totalProjects, 2);
});

test('PROJECT-15: viewer cannot mutate project (403)', async () => {
  const orgA = await seedOrg('projv-a');
  const viewer = await tokenFor(orgA.id, 'viewer', 'u-projv-viewer');
  const res = await projectsApi.POST(req(viewer, { method: 'POST', body: { name: 'Nope' } }));
  assert.equal(res.status, 403);
});

test('PROJECT-16: cross-org project mutation rejected (404)', async () => {
  const orgA = await seedOrg('projx-a');
  const orgB = await seedOrg('projx-b');
  const projB = await seedProject(orgB.id, 'Proj B-X');
  const adminA = await tokenFor(orgA.id, 'admin', 'u-projx-a');

  const get = await projectIdApi.GET(req(adminA), { params: Promise.resolve({ id: projB.id }) });
  assert.equal(get.status, 404);

  const put = await projectIdApi.PUT(req(adminA, { method: 'PUT', body: { name: 'Hijack' } }), { params: Promise.resolve({ id: projB.id }) });
  assert.equal(put.status, 404);

  const del = await projectIdApi.DELETE(req(adminA, { method: 'DELETE' }), { params: Promise.resolve({ id: projB.id }) });
  assert.equal(del.status, 404);
});

test('PROJECT-17: cross-org project member assignment rejected (422 / 404)', async () => {
  const orgA = await seedOrg('projm-a');
  const orgB = await seedOrg('projm-b');
  const projA = await seedProject(orgA.id, 'Proj M-A');
  const projB = await seedProject(orgB.id, 'Proj M-B');
  const empB = await seedEmployee(orgB.id, 'PM-B');
  const adminA = await tokenFor(orgA.id, 'admin', 'u-projm-a');

  // Employee from Org B on Org A's project -> 422.
  const postA = await projectMembersApi.POST(req(adminA, { method: 'POST', body: { employeeId: empB.id } }), { params: Promise.resolve({ id: projA.id }) });
  assert.equal(postA.status, 422);

  // Org A admin acting on Org B's project -> 404.
  const postB = await projectMembersApi.POST(req(adminA, { method: 'POST', body: { employeeId: empB.id } }), { params: Promise.resolve({ id: projB.id }) });
  assert.equal(postB.status, 404);

  // Member PUT/DELETE on Org B's project -> 404.
  const put = await projectMemberIdApi.PUT(req(adminA, { method: 'PUT', body: { role: 'lead' } }), { params: Promise.resolve({ id: projB.id, memberId: 'whatever' }) });
  assert.equal(put.status, 404);
  const del = await projectMemberIdApi.DELETE(req(adminA, { method: 'DELETE' }), { params: Promise.resolve({ id: projB.id, memberId: 'whatever' }) });
  assert.equal(del.status, 404);
});

// ─── DEPARTMENT tests ───────────────────────────────────────────────────────

test('DEPARTMENT-18: viewer cannot create department (403)', async () => {
  const orgA = await seedOrg('depv-a');
  const viewer = await tokenFor(orgA.id, 'viewer', 'u-depv-viewer');
  const res = await departmentsApi.POST(req(viewer, { method: 'POST', body: { name: 'Nope' } }));
  assert.equal(res.status, 403);
});

test('DEPARTMENT-19: admin can create department in own org', async () => {
  const orgA = await seedOrg('depc-a');
  const admin = await tokenFor(orgA.id, 'admin', 'u-depc-admin');
  const res = await departmentsApi.POST(req(admin, { method: 'POST', body: { name: 'Engineering' } }));
  assert.equal(res.status, 201);
  const dept = (await res.json()).data;
  assert.equal(dept.organizationId, orgA.id);
  assert.equal(dept.name, 'Engineering');
});

test('DEPARTMENT-20: cross-org manager reference rejected (422) + cross-org department mutation (404)', async () => {
  const orgA = await seedOrg('depx-a');
  const orgB = await seedOrg('depx-b');
  const managerB = await seedEmployee(orgB.id, 'DEP-MB');
  const deptA = await seedDept(orgA.id, 'Dept A-X');
  const deptB = await seedDept(orgB.id, 'Dept B-X');
  const adminA = await tokenFor(orgA.id, 'admin', 'u-depx-a');

  const post = await departmentsApi.POST(req(adminA, { method: 'POST', body: { name: 'Bad', managerId: managerB.id } }));
  assert.equal(post.status, 422);

  const put = await departmentIdApi.PUT(req(adminA, { method: 'PUT', body: { managerId: managerB.id } }), { params: Promise.resolve({ id: deptA.id }) });
  assert.equal(put.status, 422);

  const getB = await departmentIdApi.GET(req(adminA), { params: Promise.resolve({ id: deptB.id }) });
  assert.equal(getB.status, 404);

  const delB = await departmentIdApi.DELETE(req(adminA, { method: 'DELETE' }), { params: Promise.resolve({ id: deptB.id }) });
  assert.equal(delB.status, 404);
});

// ─── AGENT REGISTRATION tests (removed — PATH B decommissioned) ─────────────
// REG-21 through REG-24 tested the now-removed /api/agent-registrations routes.
// REG-25 (credential serialization) is covered by device-claims-only tests.
// REG-26 (proxy RBAC) is covered below.

test('REG-25: device-claims responses never serialize agentPassword', async () => {
  const orgA = await seedOrg('regs-a');
  const emp = await seedEmployee(orgA.id, 'REG-S');
  await db.employee.update({
    where: { id: emp.id },
    data: { agentPassword: '$2b$12$REG-SECRET-HASH-NEVER-SERIALIZED' },
  });
  const device = await seedDevice(orgA.id, 'dev-sec', emp.id);
  await db.deviceClaim.create({
    data: {
      organizationId: orgA.id,
      deviceId: device.id,
      claimSecretHash: 'a'.repeat(64),
      status: 'pending',
    },
  });
  const admin = await tokenFor(orgA.id, 'admin', 'u-regs-admin');

  // Claims list (device + employee includes).
  const claimsList = await import('../src/app/api/device-claims/route').then((m) =>
    m.GET(req(admin, { url: 'http://localhost:3000/api/device-claims?pageSize=50' }))
  );
  const claimsBody = await claimsList.json();
  assert.ok(
    !JSON.stringify(claimsBody).includes('agentPassword'),
    'device-claims list must never serialize agentPassword'
  );
});

test('REG-26: proxy RBAC — device-claims list is admin-gated', async () => {
  const proxy = await import('../src/proxy');
  const mkReq = async (role: string, path: string) =>
    new NextRequest(`http://localhost:3000${path}`, {
      headers: {
        authorization: `Bearer ${await signJWT({ userId: 'u', email: 'u@x.local', role, organizationId: 'org-x' })}`,
      },
    });

  // Viewer: claims list denied (403).
  const viewerRes = await proxy.proxy(await mkReq('viewer', '/api/device-claims'));
  assert.equal(viewerRes.status, 403, 'viewer must be denied device-claims');

  // Admin: allowed through (NextResponse.next() → 200 pass-through).
  const adminRes = await proxy.proxy(await mkReq('admin', '/api/device-claims'));
  assert.equal(adminRes.status, 200, 'admin must pass device-claims');

  // Device-owned cancel stays proxy-public (claim-secret auth inside route)
  // even for a non-session request — gating must not break the agent flow.
  const cancel = await proxy.proxy(
    new NextRequest('http://localhost:3000/api/device-claims/any-id/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceKey: 'x', secret: 'y' }),
    })
  );
  assert.equal(cancel.status, 200, 'cancel path must remain proxy-public');
});

// ─── Positive paths + super_admin global scope ──────────────────────────────

test('POSITIVE: own-org detail reads return 200 for device/employee/project/department', async () => {
  const orgA = await seedOrg('pos-a');
  const emp = await seedEmployee(orgA.id, 'POS-1');
  const dev = await seedDevice(orgA.id, 'PC-POS', emp.id);
  const dept = await seedDept(orgA.id, 'Pos Dept');
  const proj = await seedProject(orgA.id, 'Pos Proj', dept.id);
  const admin = await tokenFor(orgA.id, 'admin', 'u-pos-a');

  const devRes = await deviceIdApi.GET(req(admin), { params: Promise.resolve({ id: dev.id }) });
  assert.equal(devRes.status, 200);
  assert.equal((await devRes.json()).data.id, dev.id);

  const empRes = await employeeIdApi.GET(req(admin), { params: Promise.resolve({ id: emp.id }) });
  assert.equal(empRes.status, 200);

  const projRes = await projectIdApi.GET(req(admin), { params: Promise.resolve({ id: proj.id }) });
  assert.equal(projRes.status, 200);

  const deptRes = await departmentIdApi.GET(req(admin), { params: Promise.resolve({ id: dept.id }) });
  assert.equal(deptRes.status, 200);

  // Member list + add for the same org still work end-to-end.
  const membersRes = await projectMembersApi.GET(req(admin), { params: Promise.resolve({ id: proj.id }) });
  assert.equal(membersRes.status, 200);
  const addRes = await projectMembersApi.POST(req(admin, { method: 'POST', body: { employeeId: emp.id } }), { params: Promise.resolve({ id: proj.id }) });
  assert.equal(addRes.status, 201);
});

test('SUPERADMIN: org-less super_admin reads globally (allowGlobal) but cannot mutate (403)', async () => {
  const orgA = await seedOrg('sa-a');
  const orgB = await seedOrg('sa-b');
  await seedDevice(orgA.id, 'PC-SA-A');
  await seedDevice(orgB.id, 'PC-SA-B');
  const superToken = await signJWT({ userId: 'u-super', email: 'super@test.local', role: 'super_admin' });

  const res = await devicesApi.GET(req(superToken, { url: 'http://localhost:3000/api/devices?pageSize=50' }));
  const body = await res.json();
  assert.equal(res.status, 200);
  const names = (body.data as Array<{ name: string }>).map((d) => d.name);
  assert.ok(names.includes('PC-SA-A') && names.includes('PC-SA-B'), 'org-less super_admin sees devices across orgs');

  const post = await devicesApi.POST(req(superToken, { method: 'POST', body: { name: 'Nope' } }));
  assert.equal(post.status, 403, 'org-less super_admin must NOT create org-scoped rows');

  // A normal org-less non-super_admin token cannot read either.
  const ghost = await signJWT({ userId: 'u-ghost', email: 'ghost@test.local', role: 'admin' });
  const ghostRes = await devicesApi.GET(req(ghost));
  assert.equal(ghostRes.status, 403);
});

// ─── CONSENT regression ─────────────────────────────────────────────────────

test('CONSENT-25: consent lifecycle still works after Phase A (grant -> enforce -> revoke)', async () => {
  const org = await seedOrg('seccon-a');
  const emp = await seedEmployee(org.id, 'SEC-C1');
  await db.consentPolicy.create({
    data: { organizationId: org.id, consentType: 'screenshot', title: 'screenshot v1', content: 'policy text sufficiently detailed for v1', version: 'v1', status: 'published', effectiveAt: new Date(), createdBy: 'test' },
  });
  const consent = await db.consent.create({
    data: { employeeId: emp.id, consentType: 'screenshot', status: 'pending', organizationId: org.id },
  });
  const { applyConsentTransition } = await import('../src/lib/consent');
  const { hasActiveConsent } = await import('../src/lib/consent');

  await db.$transaction((tx) =>
    applyConsentTransition(tx, { id: consent.id, status: 'pending', consentType: 'screenshot', organizationId: org.id }, 'granted', { performedBy: 'test', userId: 't' })
  );
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), true);

  await db.$transaction((tx) =>
    applyConsentTransition(tx, { id: consent.id, status: 'granted', consentType: 'screenshot', organizationId: org.id }, 'revoked', { performedBy: 'test', userId: 't', action: 'revoked' })
  );
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), false);
});

test('CONSENT-26: no consent API/behavior changes — fail-closed semantics intact', async () => {
  const org = await seedOrg('seccon-b');
  const emp = await seedEmployee(org.id, 'SEC-C2');
  const { hasActiveConsent } = await import('../src/lib/consent');

  // Pending (never granted) must fail closed — unchanged behavior.
  await db.consent.create({
    data: { employeeId: emp.id, consentType: 'activity_tracking', status: 'pending', organizationId: org.id },
  });
  assert.equal(await hasActiveConsent(emp.id, 'activity_tracking'), false);

  // Nothing granted for the other types either.
  assert.equal(await hasActiveConsent(emp.id, 'monitoring'), false);
  assert.equal(await hasActiveConsent(emp.id, 'webcam_access'), false);
});

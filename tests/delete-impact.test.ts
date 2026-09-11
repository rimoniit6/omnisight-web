/**
 * Dependency-aware delete safety tests.
 *
 * Proves the delete-impact engine + hardened delete routes:
 *   - Per-entity impact previews are live-counted and truthful
 *   - Full-organization deletion requires Super Admin + explicit confirmation,
 *     cascades tenant data, preserves user accounts + audit history, revokes
 *     org-bound sessions, and never reports fake counts
 *   - A Device with monitoring history is RETIRED, never silently cascade-deleted
 *   - An EMPTY device may be hard-deleted
 *   - Employees archive (soft) and their agent login is disabled
 *   - The membership last-admin guard blocks the final admin removal
 *   - Removing a membership revokes that member's org-bound sessions
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_delete).
 * Run: npx tsx --test tests/delete-impact.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { req } from './helpers/request';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_delete';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-delete-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'delete-admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'DeleteAdminPass123!';

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
let signJWT: (payload: { userId: string; email: string; role: string; organizationId?: string }) => Promise<string>;

type OrgIdApi = typeof import('../src/app/api/super-admin/organizations/[orgId]/route');
type OrgImpactApi = typeof import('../src/app/api/super-admin/organizations/[orgId]/delete-impact/route');
type AdminImpactApi = typeof import('../src/app/api/admin/delete-impact/route');
type DeviceIdApi = typeof import('../src/app/api/devices/[id]/route');
type EmployeeIdApi = typeof import('../src/app/api/employees/[id]/route');
type MemberIdApi = typeof import('../src/app/api/organizations/[orgId]/members/[memberId]/route');

let orgIdApi: OrgIdApi;
let orgImpactApi: OrgImpactApi;
let adminImpactApi: AdminImpactApi;
let deviceIdApi: DeviceIdApi;
let employeeIdApi: EmployeeIdApi;
let memberIdApi: MemberIdApi;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  [orgIdApi, orgImpactApi, adminImpactApi, deviceIdApi, employeeIdApi, memberIdApi] = await Promise.all([
    import('../src/app/api/super-admin/organizations/[orgId]/route'),
    import('../src/app/api/super-admin/organizations/[orgId]/delete-impact/route'),
    import('../src/app/api/admin/delete-impact/route'),
    import('../src/app/api/devices/[id]/route'),
    import('../src/app/api/employees/[id]/route'),
    import('../src/app/api/organizations/[orgId]/members/[memberId]/route'),
  ]);
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

// ─── Helpers ────────────────────────────────────────────────────────────────

interface Actor {
  userId: string;
  token: string;
  membershipId: string;
}

async function seedOrg(slug: string) {
  return db.organization.create({ data: { name: slug, slug } });
}

async function seedEmployee(orgId: string, code: string, departmentId: string | null = null) {
  return db.employee.create({
    data: {
      employeeId: code,
      firstName: code.split('-')[0],
      lastName: 'Test',
      email: `${code.toLowerCase()}@test.local`,
      organizationId: orgId,
      status: 'active',
      departmentId,
    },
  });
}

async function seedDept(orgId: string, name: string) {
  return db.department.create({ data: { name, organizationId: orgId } });
}

async function seedDevice(orgId: string, name: string) {
  return db.device.create({
    data: { name, hostname: name.toLowerCase(), organizationId: orgId, status: 'online' },
  });
}

async function seedProject(orgId: string, name: string, departmentId: string | null = null) {
  return db.project.create({ data: { name, organizationId: orgId, departmentId } });
}

async function makeSaUser(email = 'sa@delete.test.local'): Promise<Actor & { user: { id: string } }> {
  const user = await db.appUser.create({
    data: { email, name: 'Global SA', role: 'super_admin', organizationId: null },
  });
  const token = await signJWT({ userId: user.id, email: user.email, role: 'super_admin' });
  return { userId: user.id, token, membershipId: '', user };
}

async function makeOrgAdmin(
  orgId: string,
  email: string,
  membershipRole: string = 'org_admin'
): Promise<Actor> {
  const user = await db.appUser.create({
    data: { email, name: 'Org Admin', role: 'admin', organizationId: null },
  });
  const membership = await db.organizationMembership.create({
    data: { userId: user.id, organizationId: orgId, role: membershipRole, status: 'ACTIVE' },
  });
  const token = await signJWT({ userId: user.id, email: user.email, role: 'admin', organizationId: orgId });
  return { userId: user.id, token, membershipId: membership.id };
}

async function makeViewer(orgId: string, email: string): Promise<Actor> {
  const user = await db.appUser.create({
    data: { email, name: 'Org Viewer', role: 'viewer', organizationId: null },
  });
  const membership = await db.organizationMembership.create({
    data: { userId: user.id, organizationId: orgId, role: 'viewer', status: 'ACTIVE' },
  });
  const token = await signJWT({ userId: user.id, email: user.email, role: 'viewer', organizationId: orgId });
  return { userId: user.id, token, membershipId: membership.id };
}

// ─── Organization delete preview + confirmed cascade ────────────────────────

test('DI-01: Super Admin sees a live-counted org delete impact preview', async () => {
  const sa = await makeSaUser('di01-sa@test.local');
  const org = await seedOrg('di01-org');
  await seedEmployee(org.id, 'DI01-A');
  await seedEmployee(org.id, 'DI01-B');
  await seedDevice(org.id, 'DI01-DEV');
  await makeOrgAdmin(org.id, 'di01-admin@test.local');
  await makeViewer(org.id, 'di01-viewer@test.local');
  // A real org has audit history — the preview must show it as preserved.
  await db.auditLog.create({
    data: { action: 'create', resource: 'organization', resourceId: org.id, description: 'org created', organizationId: org.id },
  });

  const res = await orgImpactApi.GET(req(sa.token), { params: Promise.resolve({ orgId: org.id }) });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.impact.entity, 'organization');
  assert.equal(body.impact.disposition, 'cascade');
  assert.ok(body.impact.confirmRequired === true, 'org deletion must require confirmation');
  assert.ok(body.impact.totalImpacted >= 4, `expected >=4 impacted rows, got ${body.impact.totalImpacted}`);

  const byModel = new Map(body.impact.rows.map((r: { model: string; count: number }) => [r.model, r.count]));
  assert.ok((byModel.get('employee') ?? 0) >= 2, 'employees rows counted');
  assert.ok((byModel.get('device') ?? 0) >= 1, 'devices rows counted');
  assert.ok((byModel.get('organizationMembership') ?? 0) >= 2, 'memberships rows counted');

  const preservedModels = body.impact.preserved.map((p: { model: string }) => p.model);
  assert.ok(preservedModels.includes('appUser'), 'user accounts preserved');
  assert.ok(preservedModels.includes('auditLog'), 'audit history preserved');
});

test('DI-02: org delete preview + DELETE are Super-Admin only', async () => {
  const org = await seedOrg('di02-org');
  const admin = await makeOrgAdmin(org.id, 'di02-admin@test.local');

  const preview = await orgImpactApi.GET(req(admin.token), { params: Promise.resolve({ orgId: org.id }) });
  assert.equal(preview.status, 403, 'non-SA must not preview tenant deletion');

  const del = await orgIdApi.DELETE(req(admin.token, { method: 'DELETE', body: { confirmed: true } }), {
    params: Promise.resolve({ orgId: org.id }),
  });
  assert.equal(del.status, 403, 'non-SA must not delete an organization');
  assert.ok(await db.organization.findUnique({ where: { id: org.id } }), 'org untouched');
});

test('DI-03: org DELETE without confirmed:true returns 409 with the impact', async () => {
  const sa = await makeSaUser('di03-sa@test.local');
  const org = await seedOrg('di03-org');
  await seedEmployee(org.id, 'DI03-E');

  const res = await orgIdApi.DELETE(req(sa.token, { method: 'DELETE', body: {} }), {
    params: Promise.resolve({ orgId: org.id }),
  });
  const body = await res.json();
  assert.equal(res.status, 409, JSON.stringify(body));
  assert.equal(body.error, 'Organization deletion requires explicit confirmation.');
  assert.ok(body.impact && body.impact.totalImpacted === 1, 'fresh impact embedded in 409');
  assert.ok(await db.organization.findUnique({ where: { id: org.id } }), 'org must survive without confirmation');
});

test('DI-04: confirmed org DELETE cascades tenant data, keeps users + audit history', async () => {
  const sa = await makeSaUser('di04-sa@test.local');
  const org = await seedOrg('di04-org');
  const emp = await seedEmployee(org.id, 'DI04-E');
  const dev = await seedDevice(org.id, 'DI04-DEV');
  await seedProject(org.id, 'DI04-P');
  const admin = await makeOrgAdmin(org.id, 'di04-admin@test.local');
  const viewer = await makeViewer(org.id, 'di04-viewer@test.local');
  await db.userSession.create({
    data: { userId: viewer.userId, expiresAt: new Date(Date.now() + 3600_000), activeOrganizationId: org.id },
  });

  const res = await orgIdApi.DELETE(req(sa.token, { method: 'DELETE', body: { confirmed: true } }), {
    params: Promise.resolve({ orgId: org.id }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.deleted, true);

  assert.equal(await db.organization.findUnique({ where: { id: org.id } }), null, 'org deleted');
  assert.equal(await db.employee.findUnique({ where: { id: emp.id } }), null, 'employee cascaded');
  assert.equal(await db.device.findUnique({ where: { id: dev.id } }), null, 'device cascaded');
  assert.equal(
    await db.organizationMembership.count({ where: { organizationId: org.id } }),
    0,
    'memberships cascaded'
  );

  // User accounts survive (de-pinned from the org).
  const saUser = await db.appUser.findUnique({ where: { id: sa.userId } });
  assert.ok(saUser, 'super admin user survives');
  const adminUser = await db.appUser.findUnique({ where: { id: admin.userId } });
  assert.ok(adminUser, 'org admin user survives');

  // Audit entry for the deletion survives (organizationId falls back to NULL).
  const audit = await db.auditLog.findFirst({
    where: { action: 'delete', resource: 'organization', resourceId: org.id },
  });
  assert.ok(audit, 'deletion audit entry preserved');
  assert.equal(audit.organizationId, null, 'audit survives with org id nulled');

  // Org-bound session revoked before the org row was removed.
  const session = await db.userSession.findFirst({ where: { userId: viewer.userId } });
  assert.ok(session && session.revokedAt, 'org-bound session revoked');
});

// ─── Device retire-vs-hard-delete ───────────────────────────────────────────

test('DI-05: a Device with history is RETIRED, never silently cascade-deleted', async () => {
  const org = await seedOrg('di05-org');
  const admin = await makeOrgAdmin(org.id, 'di05-admin@test.local');
  const emp = await seedEmployee(org.id, 'DI05-E');
  const dev = await seedDevice(org.id, 'DI05-DEV');
  await db.activity.create({
    data: { type: 'application', applicationName: 'chrome.exe', duration: 60, employeeId: emp.id, deviceId: dev.id, organizationId: org.id },
  });

  const res = await deviceIdApi.DELETE(req(admin.token, { method: 'DELETE' }), {
    params: Promise.resolve({ id: dev.id }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.softDeleted, true, 'device with history must be soft-deleted');
  assert.ok((body.preservedCounts ?? []).some((r: { model: string }) => r.model === 'activity'));

  const after = await db.device.findUnique({ where: { id: dev.id } });
  assert.ok(after, 'retired device row kept');
  assert.equal(after.status, 'retired');
  assert.equal(await db.activity.count({ where: { deviceId: dev.id } }), 1, 'history preserved');
});

test('DI-06: an EMPTY device is hard-deleted and gone', async () => {
  const org = await seedOrg('di06-org');
  const admin = await makeOrgAdmin(org.id, 'di06-admin@test.local');
  const dev = await seedDevice(org.id, 'DI06-DEV');

  const res = await deviceIdApi.DELETE(req(admin.token, { method: 'DELETE' }), {
    params: Promise.resolve({ id: dev.id }),
  });
  assert.equal(res.status, 200);
  assert.equal(await db.device.findUnique({ where: { id: dev.id } }), null, 'empty device removed');
});

// ─── Employee archive + agent-login disable ─────────────────────────────────

test('DI-07: employee DELETE archives and disables the agent login', async () => {
  const org = await seedOrg('di07-org');
  const admin = await makeOrgAdmin(org.id, 'di07-admin@test.local');
  const emp = await seedEmployee(org.id, 'DI07-E');
  const agent = await db.agentAccount.create({
    data: {
      employeeId: emp.id,
      agentId: 'DI07-E',
      passwordHash: 'not-a-real-hash-for-test',
      status: 'active',
    },
  });

  const res = await employeeIdApi.DELETE(req(admin.token, { method: 'DELETE' }), {
    params: Promise.resolve({ id: emp.id }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.archived, true);

  const empAfter = await db.employee.findUnique({ where: { id: emp.id } });
  assert.equal(empAfter?.status, 'archived');
  const agentAfter = await db.agentAccount.findUnique({ where: { id: agent.id } });
  assert.equal(agentAfter?.status, 'disabled', 'agent login disabled on archive');
  assert.ok(body.impact?.preserved?.some((p: { model: string }) => p.model === 'agentAccount'));
});

// ─── Org-scoped admin delete-impact preview endpoint ────────────────────────

test('DI-08: admin delete-impact preview reports department/device consequences', async () => {
  const org = await seedOrg('di08-org');
  const admin = await makeOrgAdmin(org.id, 'di08-admin@test.local');
  const dept = await seedDept(org.id, 'DI08-Dept');
  await seedEmployee(org.id, 'DI08-A', dept.id);
  await seedEmployee(org.id, 'DI08-B', dept.id);
  await seedProject(org.id, 'DI08-P', dept.id);
  await seedDevice(org.id, 'DI08-EMPTY');

  const depRes = await adminImpactApi.POST(req(admin.token, { method: 'POST', body: { entity: 'department', id: dept.id } }));
  const depBody = await depRes.json();
  assert.equal(depRes.status, 200, JSON.stringify(depBody));
  assert.equal(depBody.impact.disposition, 'direct');
  assert.equal(depBody.impact.totalImpacted, 3, '2 employees + 1 project');

  const devRes = await adminImpactApi.POST(req(admin.token, { method: 'POST', body: { entity: 'device', id: (await db.device.findFirst({ where: { name: 'DI08-EMPTY' } }))!.id } }));
  const devBody = await devRes.json();
  assert.equal(devRes.status, 200, JSON.stringify(devBody));
  assert.equal(devBody.impact.disposition, 'direct', 'empty device preview = direct');
});

test('DI-09: non-admin is denied the admin delete-impact preview', async () => {
  const org = await seedOrg('di09-org');
  const viewer = await makeViewer(org.id, 'di09-viewer@test.local');
  const dept = await seedDept(org.id, 'DI09-Dept');
  const res = await adminImpactApi.POST(req(viewer.token, { method: 'POST', body: { entity: 'department', id: dept.id } }));
  assert.equal(res.status, 403);
});

// ─── Membership last-admin guard + session revocation ───────────────────────

test('DI-10: removing the last ACTIVE org administrator is blocked (409)', async () => {
  const org = await seedOrg('di10-org');
  const onlyAdmin = await makeOrgAdmin(org.id, 'di10-admin@test.local', 'org_admin');

  const res = await memberIdApi.DELETE(req(onlyAdmin.token, { method: 'DELETE' }), {
    params: Promise.resolve({ orgId: org.id, memberId: onlyAdmin.userId }),
  });
  assert.equal(res.status, 409, 'last-admin removal must be refused');
  const membership = await db.organizationMembership.findUnique({
    where: { userId_organizationId: { userId: onlyAdmin.userId, organizationId: org.id } },
  });
  assert.ok(membership, 'membership survives the blocked attempt');
});

test('DI-11: with a second admin present, removal succeeds and revokes sessions', async () => {
  const org = await seedOrg('di11-org');
  const adminA = await makeOrgAdmin(org.id, 'di11a@test.local', 'org_admin');
  const adminB = await makeOrgAdmin(org.id, 'di11b@test.local', 'org_admin');
  // Admin B holds a session bound to this org.
  await db.userSession.create({
    data: { userId: adminB.userId, expiresAt: new Date(Date.now() + 3600_000), activeOrganizationId: org.id },
  });

  const res = await memberIdApi.DELETE(req(adminA.token, { method: 'DELETE' }), {
    params: Promise.resolve({ orgId: org.id, memberId: adminB.userId }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));

  const gone = await db.organizationMembership.findUnique({
    where: { userId_organizationId: { userId: adminB.userId, organizationId: org.id } },
  });
  assert.equal(gone, null, 'membership removed');

  const session = await db.userSession.findFirst({ where: { userId: adminB.userId } });
  assert.ok(session?.revokedAt, 'removed member org-bound session revoked');
});

test('DI-12: a Super Admin may override the last-admin guard', async () => {
  const sa = await makeSaUser('di12-sa@test.local');
  const org = await seedOrg('di12-org');
  const onlyAdmin = await makeOrgAdmin(org.id, 'di12-admin@test.local', 'org_admin');

  const res = await memberIdApi.DELETE(req(sa.token, { method: 'DELETE' }), {
    params: Promise.resolve({ orgId: org.id, memberId: onlyAdmin.userId }),
  });
  assert.equal(res.status, 200, 'SA override permitted');

  const gone = await db.organizationMembership.findUnique({
    where: { userId_organizationId: { userId: onlyAdmin.userId, organizationId: org.id } },
  });
  assert.equal(gone, null, 'last admin removed by SA');
});
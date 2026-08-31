/**
 * Super Admin Hardening — Regression Tests SA-01 through SA-13.
 *
 * Proves:
 *  SA-01  Super Admin can list all organizations
 *  SA-02  Super Admin can create organization
 *  SA-03  Super Admin can suspend organization
 *  SA-04  Super Admin can reactivate organization
 *  SA-05  Super Admin can archive organization
 *  SA-06  Super Admin can manage Organization A (view employees)
 *  SA-07  Super Admin can manage Organization B (view devices)
 *  SA-08  Super Admin can switch organizational context
 *  SA-09  Super Admin does not require membership in target org
 *  SA-10  Normal admin cannot access Super Admin endpoints
 *  SA-11  Manager cannot access Super Admin endpoints
 *  SA-12  Viewer cannot access Super Admin endpoints
 *  SA-13  Organization ID manipulation cannot escalate privileges
 *
 * Runs against a THROWAWAY PostgreSQL database.
 * Run: npx tsx --test tests/super-admin-hardening.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation ──────────────────────────────────────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_sa_hardening';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-sa-harden-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@sa-harden.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!SAHarden2026x';
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
let empA: { id: string };
let empB: { id: string };
let deviceA: { id: string };
let deviceB: { id: string };
let projectA: { id: string };
let projectB: { id: string };

let superAdminUser: { id: string };
let adminAToken: string;
let adminBToken: string;
let managerAToken: string;
let viewerAToken: string;
let superAdminToken: string;
let superAdminBoundToken: string;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  const sa = await import('../src/lib/super-admin');
  bootstrapSuperAdmin = sa.bootstrapSuperAdmin;

  // Bootstrap super admin
  const result = await bootstrapSuperAdmin();
  superAdminUser = { id: result.user.id };

  // Create two organizations
  orgA = await db.organization.create({ data: { name: 'Test Org A', slug: 'test-org-a-harden' } });
  orgB = await db.organization.create({ data: { name: 'Test Org B', slug: 'test-org-b-harden' } });

  // Create employees
  empA = await db.employee.create({
    data: { employeeId: 'EMP-SA-A', firstName: 'Alice', lastName: 'SA', email: 'alice@sa-a.test', organizationId: orgA.id, status: 'active', agentApproved: true },
  });
  empB = await db.employee.create({
    data: { employeeId: 'EMP-SA-B', firstName: 'Bob', lastName: 'SA', email: 'bob@sa-b.test', organizationId: orgB.id, status: 'active', agentApproved: true },
  });

  // Create devices
  const freshBeat = new Date();
  deviceA = await db.device.create({
    data: { name: 'PC-A', hostname: 'PC-A', agentKey: 'key-sa-a', organizationId: orgA.id, employeeId: empA.id, status: 'online', lastHeartbeat: freshBeat },
  });
  deviceB = await db.device.create({
    data: { name: 'PC-B', hostname: 'PC-B', agentKey: 'key-sa-b', organizationId: orgB.id, employeeId: empB.id, status: 'online', lastHeartbeat: freshBeat },
  });

  // Create projects
  projectA = await db.project.create({ data: { name: 'Project A', organizationId: orgA.id, status: 'active' } });
  projectB = await db.project.create({ data: { name: 'Project B', organizationId: orgB.id, status: 'active' } });

  // Create app users
  const adminA = await db.appUser.create({
    data: { email: 'admin@a-harden.test', name: 'Admin A', password: 'x', role: 'admin', organizationId: orgA.id },
  });
  const adminB = await db.appUser.create({
    data: { email: 'admin@b-harden.test', name: 'Admin B', password: 'x', role: 'admin', organizationId: orgB.id },
  });
  const managerA = await db.appUser.create({
    data: { email: 'manager@a-harden.test', name: 'Manager A', password: 'x', role: 'manager', organizationId: orgA.id },
  });
  const viewerA = await db.appUser.create({
    data: { email: 'viewer@a-harden.test', name: 'Viewer A', password: 'x', role: 'viewer', organizationId: orgA.id },
  });

  // Create memberships
  await db.organizationMembership.createMany({
    data: [
      { userId: adminA.id, organizationId: orgA.id, role: 'admin', status: 'ACTIVE' },
      { userId: adminB.id, organizationId: orgB.id, role: 'admin', status: 'ACTIVE' },
      { userId: managerA.id, organizationId: orgA.id, role: 'manager', status: 'ACTIVE' },
      { userId: viewerA.id, organizationId: orgA.id, role: 'viewer', status: 'ACTIVE' },
    ],
  });

  // Sign tokens (NO sessionId — test-only, bypasses session re-validation)
  superAdminToken = await signJWT({ userId: superAdminUser.id, email: 'root@sa-harden.local', role: 'super_admin' });
  superAdminBoundToken = await signJWT({ userId: superAdminUser.id, email: 'root@sa-harden.local', role: 'super_admin', organizationId: orgA.id, activeOrganizationId: orgA.id });
  adminAToken = await signJWT({ userId: adminA.id, email: 'admin@a-harden.test', role: 'admin', organizationId: orgA.id, activeOrganizationId: orgA.id });
  adminBToken = await signJWT({ userId: adminB.id, email: 'admin@b-harden.test', role: 'admin', organizationId: orgB.id, activeOrganizationId: orgB.id });
  managerAToken = await signJWT({ userId: managerA.id, email: 'manager@a-harden.test', role: 'manager', organizationId: orgA.id, activeOrganizationId: orgA.id });
  viewerAToken = await signJWT({ userId: viewerA.id, email: 'viewer@a-harden.test', role: 'viewer', organizationId: orgA.id, activeOrganizationId: orgA.id });
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

function req(token: string | null, opts: { method?: string; body?: unknown; url?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(opts.url || 'http://localhost:3000/api/test', {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

// ─── SA-01: Super Admin can list all organizations ──────────────────────

test('SA-01: Super Admin can list all organizations', async () => {
  const api = await import('../src/app/api/super-admin/organizations/route');
  const res = await api.GET(req(superAdminToken, { url: 'http://localhost:3000/api/super-admin/organizations' }));
  const body = await res.json();
  assert.equal(res.status, 200);
  const ids = (body.organizations as Array<{ id: string }>).map((o) => o.id);
  assert.ok(ids.includes(orgA.id), 'Org A visible to Super Admin');
  assert.ok(ids.includes(orgB.id), 'Org B visible to Super Admin');
});

// ─── SA-02: Super Admin can create organization ─────────────────────────

test('SA-02: Super Admin can create organization', async () => {
  const api = await import('../src/app/api/super-admin/organizations/route');
  const res = await api.POST(req(superAdminToken, { method: 'POST', body: { name: 'SA Created Org' } }));
  const body = await res.json();
  assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(body)}`);
  assert.ok(body.id, 'Created org has an id');
  assert.equal(body.name, 'SA Created Org');
  // Cleanup
  await db.organization.delete({ where: { id: body.id } });
});

// ─── SA-03: Super Admin can suspend organization ────────────────────────

test('SA-03: Super Admin can suspend organization', async () => {
  const api = await import('../src/app/api/super-admin/organizations/[id]/route');
  const res = await api.PATCH(req(superAdminToken, { method: 'PATCH', body: { status: 'suspended' }, url: `http://localhost:3000/api/super-admin/organizations/${orgA.id}` }), { params: Promise.resolve({ id: orgA.id }) });
  const body = await res.json();
  assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(body.status, 'suspended');
  // Restore
  await db.organization.update({ where: { id: orgA.id }, data: { status: 'active' } });
});

// ─── SA-04: Super Admin can reactivate organization ─────────────────────

test('SA-04: Super Admin can reactivate organization', async () => {
  // Suspend first
  await db.organization.update({ where: { id: orgA.id }, data: { status: 'suspended' } });
  const api = await import('../src/app/api/super-admin/organizations/[id]/route');
  const res = await api.PATCH(req(superAdminToken, { method: 'PATCH', body: { status: 'active' }, url: `http://localhost:3000/api/super-admin/organizations/${orgA.id}` }), { params: Promise.resolve({ id: orgA.id }) });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'active');
});

// ─── SA-05: Super Admin can archive organization ────────────────────────

test('SA-05: Super Admin can archive organization', async () => {
  const api = await import('../src/app/api/super-admin/organizations/[id]/route');
  const res = await api.PATCH(req(superAdminToken, { method: 'PATCH', body: { status: 'archived' }, url: `http://localhost:3000/api/super-admin/organizations/${orgA.id}` }), { params: Promise.resolve({ id: orgA.id }) });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'archived');
  // Restore
  await db.organization.update({ where: { id: orgA.id }, data: { status: 'active' } });
});

// ─── SA-06: Super Admin can manage Org A (view employees) ──────────────

test('SA-06: Super Admin can view Org A employees without membership', async () => {
  const api = await import('../src/app/api/super-admin/organizations/[id]/employees/route');
  const res = await api.GET(req(superAdminToken, { url: `http://localhost:3000/api/super-admin/organizations/${orgA.id}/employees` }), { params: Promise.resolve({ id: orgA.id }) });
  const body = await res.json();
  assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
  const ids = (body.employees as Array<{ id: string }>).map((e) => e.id);
  assert.ok(ids.includes(empA.id), 'Org A employee visible to Super Admin');
});

// ─── SA-07: Super Admin can manage Org B (view devices) ────────────────

test('SA-07: Super Admin can view Org B devices without membership', async () => {
  const api = await import('../src/app/api/super-admin/organizations/[id]/devices/route');
  const res = await api.GET(req(superAdminToken, { url: `http://localhost:3000/api/super-admin/organizations/${orgB.id}/devices` }), { params: Promise.resolve({ id: orgB.id }) });
  const body = await res.json();
  assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
  const ids = (body.devices as Array<{ id: string }>).map((d) => d.id);
  assert.ok(ids.includes(deviceB.id), 'Org B device visible to Super Admin');
});

// ─── SA-08: Super Admin can switch organizational context ───────────────

test('SA-08: Super Admin bound to Org A sees only Org A on dashboard', async () => {
  const dashApi = await import('../src/app/api/dashboard/route');
  const res = await dashApi.GET(req(superAdminBoundToken, { url: 'http://localhost:3000/api/dashboard' }));
  const body = await res.json();
  assert.equal(res.status, 200);
  // Bound to Org A, should see Org A data
  assert.equal(body.data.totalDevices, 1, 'Bound Super Admin sees only Org A devices');
});

// ─── SA-09: Super Admin does not require membership in target org ──────

test('SA-09: Super Admin can view Org B without membership', async () => {
  const api = await import('../src/app/api/super-admin/organizations/[id]/route');
  const res = await api.GET(req(superAdminToken, { url: `http://localhost:3000/api/super-admin/organizations/${orgB.id}` }), { params: Promise.resolve({ id: orgB.id }) });
  const body = await res.json();
  assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(body.organization.id, orgB.id);
  assert.equal(body.organization.name, 'Test Org B');
});

// ─── SA-10: Normal admin cannot access Super Admin endpoints ────────────

test('SA-10: Org Admin cannot list organizations via super-admin', async () => {
  const api = await import('../src/app/api/super-admin/organizations/route');
  const res = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/super-admin/organizations' }));
  assert.ok(res.status === 401 || res.status === 403, `Org Admin must be rejected from super-admin list, got ${res.status}`);
});

test('SA-10b: Org Admin cannot suspend organization', async () => {
  const api = await import('../src/app/api/super-admin/organizations/[id]/route');
  const res = await api.PATCH(req(adminAToken, { method: 'PATCH', body: { status: 'suspended' }, url: `http://localhost:3000/api/super-admin/organizations/${orgA.id}` }), { params: Promise.resolve({ id: orgA.id }) });
  assert.ok(res.status === 401 || res.status === 403, `Org Admin must be rejected from suspend, got ${res.status}`);
});

// ─── SA-11: Manager cannot access Super Admin endpoints ─────────────────

test('SA-11: Manager cannot list organizations via super-admin', async () => {
  const api = await import('../src/app/api/super-admin/organizations/route');
  const res = await api.GET(req(managerAToken, { url: 'http://localhost:3000/api/super-admin/organizations' }));
  assert.ok(res.status === 401 || res.status === 403, `Manager must be rejected from super-admin list, got ${res.status}`);
});

// ─── SA-12: Viewer cannot access Super Admin endpoints ──────────────────

test('SA-12: Viewer cannot list organizations via super-admin', async () => {
  const api = await import('../src/app/api/super-admin/organizations/route');
  const res = await api.GET(req(viewerAToken, { url: 'http://localhost:3000/api/super-admin/organizations' }));
  assert.ok(res.status === 401 || res.status === 403, `Viewer must be rejected from super-admin list, got ${res.status}`);
});

// ─── SA-13: Organization ID manipulation cannot escalate privileges ─────

test('SA-13a: Admin A trying to manage Org B employees via super-admin endpoint is rejected', async () => {
  const api = await import('../src/app/api/super-admin/organizations/[id]/employees/route');
  const res = await api.GET(req(adminAToken, { url: `http://localhost:3000/api/super-admin/organizations/${orgB.id}/employees` }), { params: Promise.resolve({ id: orgB.id }) });
  assert.ok(res.status === 401 || res.status === 403, `Admin A must not access super-admin Org B employees, got ${res.status}`);
});

test('SA-13b: Admin A trying to create org via super-admin is rejected', async () => {
  const api = await import('../src/app/api/super-admin/organizations/route');
  const res = await api.POST(req(adminAToken, { method: 'POST', body: { name: 'Rogue Org' } }));
  assert.ok(res.status === 401 || res.status === 403, `Admin A must not create org via super-admin, got ${res.status}`);
});

test('SA-13c: Admin A trying to manage Org B memberships via super-admin is rejected', async () => {
  const api = await import('../src/app/api/super-admin/organizations/[id]/memberships/route');
  const res = await api.GET(req(adminAToken, { url: `http://localhost:3000/api/super-admin/organizations/${orgB.id}/memberships` }), { params: Promise.resolve({ id: orgB.id }) });
  assert.ok(res.status === 401 || res.status === 403, `Admin A must not access super-admin Org B memberships, got ${res.status}`);
});

// ─── SA-14: Super Admin can view org detail with counts ─────────────────

test('SA-14: Super Admin can view Org A detail with employee/device/project counts', async () => {
  const api = await import('../src/app/api/super-admin/organizations/[id]/route');
  const res = await api.GET(req(superAdminToken, { url: `http://localhost:3000/api/super-admin/organizations/${orgA.id}` }), { params: Promise.resolve({ id: orgA.id }) });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.organization.id, orgA.id);
  assert.ok(typeof body.organization.employeeCount === 'number', 'Has employeeCount');
  assert.ok(typeof body.organization.deviceCount === 'number', 'Has deviceCount');
  assert.ok(typeof body.organization.projectCount === 'number', 'Has projectCount');
});

// ─── SA-15: Super Admin can view org audit logs ────────────────────────

test('SA-15: Super Admin can view Org A audit logs', async () => {
  // Seed an audit log
  await db.auditLog.create({ data: { action: 'test', resource: 'test', description: 'SA-15 probe', organizationId: orgA.id } });
  const api = await import('../src/app/api/super-admin/organizations/[id]/audit-logs/route');
  const res = await api.GET(req(superAdminToken, { url: `http://localhost:3000/api/super-admin/organizations/${orgA.id}/audit-logs` }), { params: Promise.resolve({ id: orgA.id }) });
  const body = await res.json();
  assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
  const descs = (body.data as Array<{ description: string }>).map((l) => l.description);
  assert.ok(descs.some((d) => d === 'SA-15 probe'), 'Audit log probe visible');
  // Cleanup
  await db.auditLog.deleteMany({ where: { description: 'SA-15 probe' } });
});

// ─── SA-16: Super Admin can view org projects ──────────────────────────

test('SA-16: Super Admin can view Org B projects', async () => {
  const api = await import('../src/app/api/super-admin/organizations/[id]/projects/route');
  const res = await api.GET(req(superAdminToken, { url: `http://localhost:3000/api/super-admin/organizations/${orgB.id}/projects` }), { params: Promise.resolve({ id: orgB.id }) });
  const body = await res.json();
  assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
  const ids = (body.projects as Array<{ id: string }>).map((p) => p.id);
  assert.ok(ids.includes(projectB.id), 'Org B project visible to Super Admin');
});

// ─── SA-17: Super Admin can view org memberships ───────────────────────

test('SA-17: Super Admin can view Org A memberships', async () => {
  const api = await import('../src/app/api/super-admin/organizations/[id]/memberships/route');
  const res = await api.GET(req(superAdminToken, { url: `http://localhost:3000/api/super-admin/organizations/${orgA.id}/memberships` }), { params: Promise.resolve({ id: orgA.id }) });
  const body = await res.json();
  assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
  assert.ok(body.memberships.length > 0, 'Org A has memberships');
});

// ─── SA-18: Unauthenticated access to super-admin is rejected ──────────

test('SA-18: Unauthenticated access to super-admin organizations is 401', async () => {
  const api = await import('../src/app/api/super-admin/organizations/route');
  const res = await api.GET(req(null, { url: 'http://localhost:3000/api/super-admin/organizations' }));
  assert.equal(res.status, 401, 'Unauthenticated must be rejected');
});

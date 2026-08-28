/**
 * Guest → Employee conversion — workforce-only RBAC + isolation tests.
 *
 * PROVES that Guest → Employee conversion is a WORKFORCE STATUS CONVERSION ONLY:
 *   - it does NOT create an AppUser, OrganizationMembership, password, login or
 *     invitation (Employee stays completely separate from Admin Panel login)
 *   - existing workforce/telemetry identity is preserved (same Employee row)
 *   - RBAC matrix: Super Admin / Org Admin / Manager ALLOW, Viewer / Guest /
 *     Employee DENY
 *   - cross-org conversion is rejected (404, concealed)
 *   - the authorization is DB-authoritative: a stale JWT cannot bypass a current
 *     DB role change
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_guest_convert).
 * Run: npx tsx --test tests/guest-convert-rbac.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_guest_convert';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-guest-convert-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

before(() => {
  if (process.env.GUEST_CONVERT_TEST_MIGRATED_DB !== '1') {
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

type DbModule = typeof import('../src/lib/db');
let db: DbModule['db'];
let signJWT: (payload: { userId: string; email: string; role: string; organizationId?: string }) => Promise<string>;

type DiscoverApi = typeof import('../src/app/api/agent/discover/route');
type ApproveApi = typeof import('../src/app/api/device-claims/[id]/approve/route');
type ConvertApi = typeof import('../src/app/api/guests/[id]/convert/route');

let discoverApi: DiscoverApi;
let approveApi: ApproveApi;
let convertApi: ConvertApi;
let hashEnrollmentCode: (code: string) => string;

// orgA + its org-admin/admin/manager/viewer actors, orgB (foreign).
let orgA: { id: string };
let orgB: { id: string };
// Distinct enrollment codes so discover deterministically maps a device to the
// intended org (a shared code would be ambiguous with two orgs present).
const ENROLL_CODE_A = 'test-enroll-code-gconvA-0123456789abcdef';
const ENROLL_CODE_B = 'test-enroll-code-gconvB-0123456789abcdef';

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  hashEnrollmentCode = (await import('../src/lib/agent/auth')).hashEnrollmentCode;

  const [dApi, apApi, cvApi] = await Promise.all([
    import('../src/app/api/agent/discover/route'),
    import('../src/app/api/device-claims/[id]/approve/route'),
    import('../src/app/api/guests/[id]/convert/route'),
  ]);
  discoverApi = dApi;
  approveApi = apApi;
  convertApi = cvApi;

  orgA = await db.organization.create({ data: { name: 'Convert Org A', slug: 'convert-org-a' } });
  orgB = await db.organization.create({ data: { name: 'Convert Org B', slug: 'convert-org-b' } });
  await db.organizationSetting.create({ data: { organizationId: orgA.id, key: 'agent_enrollment_code', value: hashEnrollmentCode(ENROLL_CODE_A), category: 'agent' } });
  await db.organizationSetting.create({ data: { organizationId: orgB.id, key: 'agent_enrollment_code', value: hashEnrollmentCode(ENROLL_CODE_B), category: 'agent' } });
});

after(async () => {
  await db.$disconnect();
  if (process.env.GUEST_CONVERT_TEST_MIGRATED_DB !== '1') {
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

async function tokenFor(role: string, userId: string, orgId: string) {
  return signJWT({ userId, email: `${userId}@${role}.local`, role, organizationId: orgId });
}

async function discoverGuest(code: string, label: string, ip: string) {
  const res = await discoverApi.POST(req(null, {
    method: 'POST',
    body: { deviceKey: `key-gc-${label}-device-abcdef`, hostname: 'PC-CONV', os: 'Windows 11', osVersion: '23H2', processor: 'x64', memory: '16GB', agentVersion: '1.2.0', arch: 'x64', enrollmentCode: code },
    ip,
  }));
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

async function approveGuest(adminToken: string, claimId: string) {
  const res = await approveApi.POST(
    req(adminToken, { method: 'POST', body: { mode: 'guest' }, ip: '198.51.100.40' }),
    { params: Promise.resolve({ id: claimId }) }
  );
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

async function convertGuest(token: string, guestId: string, email: string) {
  const res = await convertApi.POST(
    req(token, { method: 'POST', body: { firstName: 'F', lastName: 'L', email }, ip: '198.51.100.41' }),
    { params: Promise.resolve({ id: guestId }) }
  );
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

async function makeGuest(orgId: string, label: string) {
  const code = orgId === orgB.id ? ENROLL_CODE_B : ENROLL_CODE_A;
  const { body } = await discoverGuest(code, label, `203.0.113.${label.length % 240}`);
  const adminToken = await tokenFor('admin', `u-admin-${label}`, orgId);
  const ap = await approveGuest(adminToken, body.claimId as string);
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  const guest = await db.guest.findFirst({ where: { deviceId: body.deviceId as string } });
  return { id: guest!.id, employeeId: guest!.employeeId, deviceId: body.deviceId as string };
}

// ─── GC-1: conversion is workforce-only (no AppUser / membership / login) ────

test('GC-1: conversion creates an Employee only — no AppUser, no membership, no password', async () => {
  const guest = await makeGuest(orgA.id, 'GC1');
  const beforeAppUsers = await db.appUser.count({ where: { email: { endsWith: '@gconv.local' } } });
  const beforeMemberships = await db.organizationMembership.count({ where: { organizationId: orgA.id } });
  const beforeEmployees = await db.employee.count();

  const admin = await tokenFor('admin', 'u-gc1-admin', orgA.id);
  const res = await convertGuest(admin, guest.id, 'gc1.converted@company.com');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((res.body as Record<string, unknown>).webAccount, undefined, 'no web account in the payload');

  // Same Employee row preserved (telemetry identity intact) and promoted.
  const emp = await db.employee.findUnique({ where: { id: guest.employeeId } });
  assert.ok(emp, 'employee row exists');
  assert.equal(emp.type, 'employee');
  assert.equal(emp.guestId, null);

  // NO account provisioning of any kind.
  assert.equal(await db.appUser.count({ where: { email: { endsWith: '@gconv.local' } } }), beforeAppUsers, 'no AppUser created by conversion');
  assert.equal(await db.organizationMembership.count({ where: { organizationId: orgA.id } }), beforeMemberships, 'no membership created by conversion');
  assert.equal(await db.employee.count(), beforeEmployees, 'no extra employee row (same row reused)');

  // guest_converted audit event recorded; no web-account audit event.
  assert.equal(await db.auditLog.count({ where: { action: 'guest_converted', resourceId: guest.id } }), 1, 'guest_converted audit');
  assert.equal(await db.auditLog.count({ where: { action: 'employee_web_account_provisioned' } }), 0, 'no web-account audit event');

  // Guest lifecycle row removed.
  assert.equal(await db.guest.count({ where: { id: guest.id } }), 0, 'guest row removed after conversion');
});

// ─── GC-2: RBAC matrix ───────────────────────────────────────────────────────

test('GC-2: RBAC matrix — super_admin/admin/manager ALLOW; viewer/guest/employee DENY', async () => {
  const allowed: Array<[string, string]> = [
    ['super_admin', 'u-gc2-super'],
    ['admin', 'u-gc2-admin'],
    ['manager', 'u-gc2-mgr'],
  ];
  for (const [role, uid] of allowed) {
    const guest = await makeGuest(orgA.id, `GC2${role.slice(0, 4)}`);
    const token = await tokenFor(role, uid, role === 'super_admin' ? orgA.id : orgA.id);
    const res = await convertGuest(token, guest.id, `gc2.${role}@company.com`);
    assert.equal(res.status, 200, `${role} must be allowed to convert: ${JSON.stringify(res.body)}`);
    assert.equal((await db.employee.findUnique({ where: { id: guest.employeeId } }))!.type, 'employee');
  }

  const denied: Array<[string, string]> = [
    ['viewer', 'u-gc2-viewer'],
    ['guest', 'u-gc2-guest'],
    ['employee', 'u-gc2-emp'],
  ];
  for (const [role, uid] of denied) {
    const guest = await makeGuest(orgA.id, `GC2${role.slice(0, 4)}D`);
    const token = await tokenFor(role, uid, orgA.id);
    const res = await convertGuest(token, guest.id, `gc2.deny.${role}@company.com`);
    assert.equal(res.status, 403, `${role} must be denied: ${JSON.stringify(res.body)}`);
    // Enrollment untouched (still a guest workforce state).
    assert.equal((await db.employee.findUnique({ where: { id: guest.employeeId } }))!.type, 'guest');
  }
});

// ─── GC-3: cross-org conversion is rejected ─────────────────────────────────

test('GC-3: admin/manager of one org cannot convert another org guest (404)', async () => {
  const guestB = await makeGuest(orgB.id, 'GC3B');
  const adminA = await tokenFor('admin', 'u-gc3-adminA', orgA.id);
  const managerA = await tokenFor('manager', 'u-gc3-mgrA', orgA.id);

  const resAdmin = await convertGuest(adminA, guestB.id, 'gc3.x@company.com');
  assert.equal(resAdmin.status, 404, 'cross-org conversion by adminA must be concealed as 404');

  const resManager = await convertGuest(managerA, guestB.id, 'gc3.y@company.com');
  assert.equal(resManager.status, 404, 'cross-org conversion by managerA must be concealed as 404');

  // Guest B enrollment preserved by the denied foreign mutations.
  assert.equal((await db.employee.findUnique({ where: { id: guestB.employeeId } }))!.type, 'guest');
});

// ─── GC-4: stale JWT cannot bypass current DB role (DB-authoritative) ───────

test('GC-4: a manager JWT is denied after the DB role changes to viewer', async () => {
  // Real AppUser row so the gateway re-reads the DB role (not the JWT claim).
  const actor = await db.appUser.create({
    data: { email: 'gc4.actor@company.com', name: 'GC4 Actor', role: 'manager', organizationId: orgA.id, isActive: true },
  });
  const staleJwt = await signJWT({ userId: actor.id, email: 'gc4.actor@company.com', role: 'manager', organizationId: orgA.id });
  const guest = await makeGuest(orgA.id, 'GC4');

  // While the DB says manager, conversion succeeds.
  const ok = await convertGuest(staleJwt, guest.id, 'gc4.allowed@company.com');
  assert.equal(ok.status, 200, 'manager DB role allows conversion: ' + JSON.stringify(ok.body));

  // Downgrade the DB role to viewer; the SAME JWT (still claiming manager) must be denied.
  await db.appUser.update({ where: { id: actor.id }, data: { role: 'viewer' } });
  const guest2 = await makeGuest(orgA.id, 'GC42');
  const denied = await convertGuest(staleJwt, guest2.id, 'gc4.denied@company.com');
  assert.equal(denied.status, 403, 'stale manager JWT must be denied once DB role is viewer');
  assert.equal((await db.employee.findUnique({ where: { id: guest2.employeeId } }))!.type, 'guest');

  // A viewer-role JWT minted for the same identity is also denied.
  const viewerJwt = await signJWT({ userId: actor.id, email: 'gc4.actor@company.com', role: 'viewer', organizationId: orgA.id });
  const guest3 = await makeGuest(orgA.id, 'GC43');
  const denied2 = await convertGuest(viewerJwt, guest3.id, 'gc4.denied2@company.com');
  assert.equal(denied2.status, 403, 'viewer role is denied');
});

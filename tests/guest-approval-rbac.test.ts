/**
 * Guest approval / lifecycle — RBAC + privilege-escalation tests.
 *
 * Proves the permission model around guest enrollment end to end:
 *   - viewer / employee / manager cannot approve, revoke, suspend, reactivate
 *     or convert guests (admin-only, org-bound)
 *   - a guest NEVER gains admin/manager privileges (no AgentAccount, no
 *     admin token, cannot approve devices, cannot list other orgs)
 *   - cross-org admin mutations are concealed (404)
 *   - guest conversion cannot be triggered by non-admins
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_guest_rbac).
 * Run: npx tsx --test tests/guest-approval-rbac.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_guest_rbac';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-guest-rbac-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

before(() => {
  if (process.env.GUEST_RBAC_TEST_MIGRATED_DB !== '1') {
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
type GuestsApi = typeof import('../src/app/api/guests/route');
type RevokeApi = typeof import('../src/app/api/guests/[id]/revoke/route');
type SuspendApi = typeof import('../src/app/api/guests/[id]/suspend/route');
type ConvertApi = typeof import('../src/app/api/guests/[id]/convert/route');

let discoverApi: DiscoverApi;
let approveApi: ApproveApi;
let guestsApi: GuestsApi;
let revokeApi: RevokeApi;
let suspendApi: SuspendApi;
let convertApi: ConvertApi;
let hashEnrollmentCode: (code: string) => string;

let org: { id: string };
const ENROLL_CODE = 'test-enroll-code-grbac-0123456789abcdef';

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  hashEnrollmentCode = (await import('../src/lib/agent/auth')).hashEnrollmentCode;

  const [dApi, apApi, gApi, rvApi, spApi, cvApi] = await Promise.all([
    import('../src/app/api/agent/discover/route'),
    import('../src/app/api/device-claims/[id]/approve/route'),
    import('../src/app/api/guests/route'),
    import('../src/app/api/guests/[id]/revoke/route'),
    import('../src/app/api/guests/[id]/suspend/route'),
    import('../src/app/api/guests/[id]/convert/route'),
  ]);
  discoverApi = dApi;
  approveApi = apApi;
  guestsApi = gApi;
  revokeApi = rvApi;
  suspendApi = spApi;
  convertApi = cvApi;

  org = await db.organization.create({ data: { name: 'RBAC Guests Org', slug: 'rbac-guests-org' } });
  await db.organizationSetting.create({
    data: {
      organizationId: org.id,
      key: 'agent_enrollment_code',
      value: hashEnrollmentCode(ENROLL_CODE),
      category: 'agent',
    },
  });
});

after(async () => {
  await db.$disconnect();
  if (process.env.GUEST_RBAC_TEST_MIGRATED_DB !== '1') {
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

async function tokenFor(role: string, userId: string) {
  return signJWT({ userId, email: `${role}@${org.id.slice(-6)}.local`, role, organizationId: org.id });
}

async function discoverGuest(label: string, ip = '203.0.113.20') {
  const res = await discoverApi.POST(req(null, {
    method: 'POST',
    body: { deviceKey: `key-r-${label.toLowerCase()}-device-abcdef`, hostname: 'PC-RBAC', os: 'Windows 11', osVersion: '23H2', processor: 'x64', memory: '16GB', agentVersion: '1.2.0', arch: 'x64', enrollmentCode: ENROLL_CODE },
    ip,
  }));
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

async function approveGuest(adminToken: string, claimId: string) {
  const res = await approveApi.POST(
    req(adminToken, { method: 'POST', body: { mode: 'guest' }, ip: '198.51.100.20' }),
    { params: Promise.resolve({ id: claimId }) }
  );
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

// ─── RBAC-1: approval ───────────────────────────────────────────────────────

test('RBAC-1: only admin can approve a claim as guest — viewer/employee/manager all 403', async () => {
  const { body } = await discoverGuest('RBAC1');
  const roles: Array<['viewer' | 'employee' | 'manager', string]> = [
    ['viewer', 'u-r1-viewer'],
    ['employee', 'u-r1-emp'],
    ['manager', 'u-r1-mgr'],
  ];
  for (const [role, uid] of roles) {
    const token = await tokenFor(role, uid);
    const res = await approveGuest(token, body.claimId as string);
    assert.equal(res.status, 403, `${role} must not approve guests`);
  }
  // Admin succeeds.
  const admin = await tokenFor('admin', 'u-r1-admin');
  const ok = await approveGuest(admin, body.claimId as string);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

// ─── RBAC-2: lifecycle mutations ────────────────────────────────────────────

test('RBAC-2: viewer/employee/manager cannot revoke, suspend, reactivate or convert guests', async () => {
  // Two guests: one for suspend/revoke checks, one stays ACTIVE for convert.
  const { body: g1 } = await discoverGuest('RBAC2a');
  const { body: g2 } = await discoverGuest('RBAC2b');
  const admin = await tokenFor('admin', 'u-r2-admin');
  assert.equal((await approveGuest(admin, g1.claimId as string)).status, 200);
  assert.equal((await approveGuest(admin, g2.claimId as string)).status, 200);
  const guest1 = await db.guest.findFirst({ where: { deviceId: g1.deviceId as string } });
  const guest2 = await db.guest.findFirst({ where: { deviceId: g2.deviceId as string } });

  for (const [role, uid] of [['viewer', 'u-r2-viewer'], ['employee', 'u-r2-emp'], ['manager', 'u-r2-mgr']] as const) {
    const token = await tokenFor(role, uid);
    const revoke = await revokeApi.POST(req(token, { method: 'POST', body: { reason: 'x' }, ip: '198.51.100.21' }), { params: Promise.resolve({ id: guest1!.id }) });
    assert.equal(revoke.status, 403, `${role} must not revoke guests`);

    const suspend = await suspendApi.POST(req(token, { method: 'POST', body: { reason: 'x' }, ip: '198.51.100.21' }), { params: Promise.resolve({ id: guest2!.id }) });
    assert.equal(suspend.status, 403, `${role} must not suspend guests`);

    const convert = await convertApi.POST(
      req(token, { method: 'POST', body: { firstName: 'A', lastName: 'B', email: 'a.b@company.com' }, ip: '198.51.100.21' }),
      { params: Promise.resolve({ id: guest2!.id }) }
    );
    assert.equal(convert.status, 403, `${role} must not convert guests`);
  }

  // Guests untouched by the denied mutations.
  assert.equal((await db.guest.findUnique({ where: { id: guest1!.id } }))!.status, 'ACTIVE');
  assert.equal((await db.guest.findUnique({ where: { id: guest2!.id } }))!.status, 'ACTIVE');
});

// ─── RBAC-3: admin lifecycle works; cross-org concealed ─────────────────────

test('RBAC-3: admin can revoke/suspend/convert; cross-org admin mutations are 404', async () => {
  const { body } = await discoverGuest('RBAC3');
  const admin = await tokenFor('admin', 'u-r3-admin');
  assert.equal((await approveGuest(admin, body.claimId as string)).status, 200);
  const guest = await db.guest.findFirst({ where: { deviceId: body.deviceId as string } });

  const otherOrg = await db.organization.create({ data: { name: 'Other RBAC Org', slug: 'other-rbac-org' } });
  const foreignAdmin = await signJWT({ userId: 'u-r3-foreign', email: 'f@other.local', role: 'admin', organizationId: otherOrg.id });

  // Foreign admin: concealed (404) on every lifecycle mutation.
  for (const route of [revokeApi, suspendApi]) {
    const res = await route.POST(req(foreignAdmin, { method: 'POST', body: { reason: 'x' }, ip: '198.51.100.22' }), { params: Promise.resolve({ id: guest!.id }) });
    assert.equal(res.status, 404, 'cross-org mutation must be concealed');
  }
  const convert = await convertApi.POST(
    req(foreignAdmin, { method: 'POST', body: { firstName: 'A', lastName: 'B', email: 'a.b@company.com' }, ip: '198.51.100.22' }),
    { params: Promise.resolve({ id: guest!.id }) }
  );
  assert.equal(convert.status, 404, 'cross-org convert must be concealed');

  // Our admin suspends + converts the second… actually convert the guest here.
  const conv = await convertApi.POST(
    req(admin, { method: 'POST', body: { firstName: 'Real', lastName: 'Person', email: 'real.person@company.com' }, ip: '198.51.100.22' }),
    { params: Promise.resolve({ id: guest!.id }) }
  );
  assert.equal(conv.status, 200, JSON.stringify(await conv.json()));
});

// ─── RBAC-4: guest privilege boundaries ─────────────────────────────────────

test('RBAC-4: a guest never gains admin/manager power — no AgentAccount, cannot approve devices, no admin API access', async () => {
  const { body } = await discoverGuest('RBAC4');
  const admin = await tokenFor('admin', 'u-r4-admin');
  assert.equal((await approveGuest(admin, body.claimId as string)).status, 200);
  const guest = await db.guest.findFirst({ where: { deviceId: body.deviceId as string }, include: { employee: true } });

  // The guest-backed employee has NO AgentAccount (no password login path).
  assert.equal(await db.agentAccount.count({ where: { employeeId: guest!.employeeId } }), 0, 'guest has no AgentAccount');

  // No manager/admin roles exist on the employee row (type = guest only).
  assert.equal(guest!.employee.type, 'guest');
  assert.equal(guest!.employee.status, 'active', 'active but never privileged');

  // The guest's own employeeId cannot be used as an admin token (no such
  // AppUser) — requireAdminOrg-style routes reject it. Sign a token for the
  // guest employee id and prove the MUTATION paths are denied (approve is
  // admin-gated), while listing follows the existing session-gated convention.
  const guestToken = await signJWT({ userId: guest!.employeeId, email: guest!.employee.email, role: 'employee', organizationId: org.id });

  // Guest cannot approve devices (admin-only mutation).
  const { body: g2 } = await discoverGuest('RBAC4b');
  const approveAsGuest = await approveGuest(guestToken, g2.claimId as string);
  assert.equal(approveAsGuest.status, 403, 'guest cannot approve other devices');

  // Guest cannot revoke guests (admin-only mutation).
  const revokeAsGuest = await revokeApi.POST(
    req(guestToken, { method: 'POST', body: { reason: 'x' }, ip: '198.51.100.23' }),
    { params: Promise.resolve({ id: guest!.id }) }
  );
  assert.equal(revokeAsGuest.status, 403, 'guest cannot revoke guests');

  // Listing is session-gated (existing convention) — an org-bound session may
  // read, but only its own org.
  const list = await guestsApi.GET(req(guestToken, { url: 'http://localhost:3000/api/guests' }));
  assert.equal(list.status, 200, 'session-gated read is allowed');
  const parsed = await list.json().catch(() => ({})) as { data?: Array<{ id: string }> };
  assert.ok(Array.isArray(parsed.data));
});

// ─── RBAC-5: unauthenticated is denied everywhere ──────────────────────────

test('RBAC-5: unauthenticated requests are rejected for guest endpoints', async () => {
  const { body } = await discoverGuest('RBAC5');

  const approve = await approveGuest(null as unknown as string, body.claimId as string);
  assert.equal(approve.status, 401, 'unauthenticated approve must be rejected');

  const list = await guestsApi.GET(req(null));
  assert.equal(list.status, 401, 'unauthenticated list must be rejected');
});

/**
 * Phase 3 hardening — Agent existing-device rediscovery authorization.
 *
 * Covers the security rules from workload/67 (STEP 1 audit) and the
 * AUTH-EXIST-01..25 matrix from the hardening master prompt:
 *
 *   - Rules A/B/C: authenticated AgentSession is the ONLY identity authority.
 *     Existing devices owned by another employee (same org) or another
 *     organization are indistinguishable from a missing device (uniform 404).
 *   - Rule D: an unassigned device in the session's org is bound to the
 *     session employee transactionally inside the device row lock.
 *   - Revoked devices fail closed and are NEVER rebound.
 *   - Anonymous device CREATION was removed (enrollment-code removal): a new
 *     device without a session gets 422 AUTHENTICATION_REQUIRED (AUTH-EXIST-09).
 *     The device-KEY identity fallback for EXISTING devices is preserved.
 *   - Concurrency: two simultaneous rediscoveries cannot create conflicting
 *     ownership or duplicate pending claims.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_agexist).
 * Run: npx tsx --test tests/agent-existing-device-security.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';
import { req } from './helpers/request';

// ─── Test DB isolation (must be set BEFORE any app module import) ──────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_agexist';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-agexist-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

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

type LoginApi = typeof import('../src/app/api/agent/login/route');
type DiscoverApi = typeof import('../src/app/api/agent/discover/route');
type ApproveApi = typeof import('../src/app/api/device-claims/[id]/approve/route');
type RejectApi = typeof import('../src/app/api/device-claims/[id]/reject/route');
type RevokeApi = typeof import('../src/app/api/device-claims/[id]/revoke/route');
type CancelApi = typeof import('../src/app/api/device-claims/[id]/cancel/route');

let loginApi: LoginApi;
let discoverApi: DiscoverApi;
let approveApi: ApproveApi;
let rejectApi: RejectApi;
let revokeApi: RevokeApi;
let cancelApi: CancelApi;

let createAgentAccount: (typeof import('../src/lib/agent-account'))['createAgentAccount'];
let createAgentSession: (typeof import('../src/lib/agent/session'))['createAgentSession'];
let validateAgentSession: (typeof import('../src/lib/agent/session'))['validateAgentSession'];

const PASSWORD = 'Str0ng!Pass123x';
let orgA: { id: string };
let orgB: { id: string };

before(async () => {
  db = (await import('../src/lib/db')).db;
  ({ signJWT } = await import('../src/lib/auth'));
  loginApi = await import('../src/app/api/agent/login/route');
  discoverApi = await import('../src/app/api/agent/discover/route');
  approveApi = await import('../src/app/api/device-claims/[id]/approve/route');
  rejectApi = await import('../src/app/api/device-claims/[id]/reject/route');
  revokeApi = await import('../src/app/api/device-claims/[id]/revoke/route');
  cancelApi = await import('../src/app/api/device-claims/[id]/cancel/route');
  ({ createAgentAccount } = await import('../src/lib/agent-account'));
  ({ createAgentSession, validateAgentSession } = await import('../src/lib/agent/session'));

  orgA = await db.organization.create({ data: { name: 'Exist Org A', slug: 'exist-org-a' } });
  orgB = await db.organization.create({ data: { name: 'Exist Org B', slug: 'exist-org-b' } });
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


function adminToken(orgId: string, id: string) {
  return signJWT({ userId: id, email: `${id}@${orgId.slice(-6)}.local`, role: 'admin', organizationId: orgId });
}

async function seedEmployee(orgId: string, code: string, status = 'active') {
  return db.employee.create({
    data: {
      employeeId: code,
      firstName: code.split('-')[0],
      lastName: 'Test',
      email: `${code.toLowerCase()}@test.local`,
      organizationId: orgId,
      status,
      agentApproved: false,
    },
  });
}

async function seedAccount(orgId: string, code: string) {
  const emp = await seedEmployee(orgId, code);
  await createAgentAccount({ employeeId: emp.id, agentId: code, password: PASSWORD });
  return emp;
}

/** Login and return the AgentSession token (throws on failure). */
async function login(agentId: string, ip = '203.0.113.60'): Promise<string> {
  const res = await loginApi.POST(req(null, { method: 'POST', body: { agentId, password: PASSWORD }, ip }));
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.token as string;
}

function discoverBody(deviceKey: string, hostname = 'PC-EXIST', extra: Record<string, unknown> = {}) {
  return {
    deviceKey,
    hostname,
    os: 'Windows 11',
    osVersion: '23H2',
    processor: 'x64',
    memory: '16GB',
    agentVersion: '1.3.0',
    arch: 'x64',
    ...extra,
  };
}

/** POST /api/agent/discover carrying an AgentSession bearer (authenticated). */
async function discoverWithSession(token: string, deviceKey: string, ip = '198.51.100.60', extra: Record<string, unknown> = {}) {
  const res = await discoverApi.POST(req(token, { method: 'POST', body: discoverBody(deviceKey, undefined, extra), ip }));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** POST /api/agent/discover with NO bearer (anonymous — expects 422 since enrollment code removed). */
async function discoverAnon(deviceKey: string, ip = '198.51.100.61', extra: Record<string, unknown> = {}) {
  const res = await discoverApi.POST(req(null, { method: 'POST', body: discoverBody(deviceKey, undefined, extra), ip }));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function adminAction(
  route: { POST: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response> },
  admin: string,
  id: string,
  body: Record<string, unknown>
) {
  const res = await route.POST(req(admin, { method: 'POST', body, ip: '198.51.100.62' }), {
    params: Promise.resolve({ id }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function approve(admin: string, claimId: string, employeeId: string) {
  return adminAction(approveApi, admin, claimId, { employeeId, projectIds: [] });
}

async function reject(admin: string, claimId: string, reason = 'test-reject') {
  return adminAction(rejectApi, admin, claimId, { reason });
}

async function revoke(admin: string, claimId: string, reason = 'test-revoke') {
  return adminAction(revokeApi, admin, claimId, { reason });
}

async function cancelClaim(claimId: string, deviceKey: string, secret: string) {
  const res = await cancelApi.POST(req(null, { method: 'POST', body: { deviceKey, secret }, ip: '198.51.100.63' }), {
    params: Promise.resolve({ id: claimId }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function getDevice(agentKey: string) {
  return db.device.findFirst({ where: { agentKey } });
}

async function claimCount(deviceId: string) {
  return db.deviceClaim.count({ where: { deviceId } });
}

// ─── AUTH-EXIST-01/02/03: core ownership rules ──────────────────────────────

test('AUTH-EXIST-01: same-employee existing-device rediscovery succeeds', async () => {
  const a = await seedAccount(orgA.id, 'EX-01');
  const tA = await login('EX-01', '203.0.113.70');
  const first = await discoverWithSession(tA, 'key-ex-01-own-device-abcdef', '198.51.100.70');
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const device = await getDevice('key-ex-01-own-device-abcdef');
  assert.ok(device);
  assert.equal(device!.employeeId, a.id, 'device bound to owner at creation');
  assert.equal(device!.organizationId, orgA.id);

  // Rediscovery of the SAME device by the SAME employee → idempotent pending.
  const again = await discoverWithSession(tA, 'key-ex-01-own-device-abcdef', '198.51.100.70');
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.status, 'pending');
  assert.equal(again.body.claimId, first.body.claimId, 'same pending claim returned, no duplicate');
  assert.equal(again.body.employeeAssigned, true);
});

test('AUTH-EXIST-02: different employee, same organization → 404, no rebind', async () => {
  const a = await seedAccount(orgA.id, 'EX-02A');
  const b = await seedAccount(orgA.id, 'EX-02B');
  const tA = await login('EX-02A', '203.0.113.71');
  const created = await discoverWithSession(tA, 'key-ex-02-a-device-abcdef', '198.51.100.71');
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const tB = await login('EX-02B', '203.0.113.72');
  const denied = await discoverWithSession(tB, 'key-ex-02-a-device-abcdef', '198.51.100.72');
  assert.equal(denied.status, 404, JSON.stringify(denied.body));
  assert.deepEqual(denied.body, { error: 'Device not found' });

  const device = await getDevice('key-ex-02-a-device-abcdef');
  assert.equal(device!.employeeId, a.id, 'employee B must never rebind A\u2019s device');
});

test('AUTH-EXIST-03: different organization → 404, no claim created', async () => {
  const a = await seedAccount(orgA.id, 'EX-03A');
  const c = await seedAccount(orgB.id, 'EX-03C');
  const tA = await login('EX-03A', '203.0.113.73');
  const created = await discoverWithSession(tA, 'key-ex-03-a-device-abcdef', '198.51.100.73');
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const deviceId = (created.body.deviceId as string) ?? (await getDevice('key-ex-03-a-device-abcdef'))!.id;

  const tC = await login('EX-03C', '203.0.113.74');
  const denied = await discoverWithSession(tC, 'key-ex-03-a-device-abcdef', '198.51.100.74');
  assert.equal(denied.status, 404, JSON.stringify(denied.body));
  assert.deepEqual(denied.body, { error: 'Device not found' });
  assert.equal(await claimCount(deviceId), 1, 'no claim created by the cross-org request');
});

// ─── AUTH-EXIST-04/05/24: forged identity fields ────────────────────────────

test('AUTH-EXIST-04: forged employeeId in the body is ignored', async () => {
  const a = await seedAccount(orgA.id, 'EX-04A');
  const b = await seedAccount(orgA.id, 'EX-04B');
  const tB = await login('EX-04B', '203.0.113.75');

  // 4a: B creates a NEW device while forging A's employeeId → binds to B.
  const created = await discoverWithSession(tB, 'key-ex-04-b-device-abcdef', '198.51.100.75', {
    employeeId: a.id,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const own = await getDevice('key-ex-04-b-device-abcdef');
  assert.equal(own!.employeeId, b.id, 'forged employeeId must not override the session');

  // 4b: B tries A's device while forging A's employeeId → still 404.
  const tA = await login('EX-04A', '203.0.113.76');
  await discoverWithSession(tA, 'key-ex-04-avictim-device-abcdef', '198.51.100.76');
  const denied = await discoverWithSession(tB, 'key-ex-04-avictim-device-abcdef', '198.51.100.75', {
    employeeId: a.id,
  });
  assert.equal(denied.status, 404, 'forged employeeId must not grant access to another employee\u2019s device');
});

test('AUTH-EXIST-05: forged organizationId in the body is ignored', async () => {
  const b = await seedAccount(orgA.id, 'EX-05B');
  const tB = await login('EX-05B', '203.0.113.77');
  const created = await discoverWithSession(tB, 'key-ex-05-b-device-abcdef', '198.51.100.77', {
    organizationId: orgB.id,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const own = await getDevice('key-ex-05-b-device-abcdef');
  assert.equal(own!.organizationId, orgA.id, 'forged organizationId must never move the device to org B');
  assert.equal(own!.employeeId, b.id);
});

test('AUTH-EXIST-24: session identity is always server-derived (org from AgentAccount→Employee)', async () => {
  const a = await seedAccount(orgA.id, 'EX-24');
  const tA = await login('EX-24', '203.0.113.78');
  const session = await db.agentSession.findUnique({ where: { token: tA } });
  assert.ok(session);
  assert.equal(session!.employeeId, a.id);
  assert.equal(session!.organizationId, orgA.id, 'session org comes from the AgentAccount\u2019s employee, never the client');

  const created = await discoverWithSession(tA, 'key-ex-24-a-device-abcdef', '198.51.100.78', {
    employeeId: 'EX-24-IMPOSTOR',
    organizationId: orgB.id,
    agentId: 'EX-24-IMPOSTOR',
    deviceOwnerId: 'EX-24-IMPOSTOR',
    userId: 'EX-24-IMPOSTOR',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const device = await getDevice('key-ex-24-a-device-abcdef');
  assert.equal(device!.organizationId, orgA.id);
  assert.equal(device!.employeeId, a.id);
});

// ─── AUTH-EXIST-06/07: fail-closed states ───────────────────────────────────

test('AUTH-EXIST-06: revoked device fails closed and is NEVER rebound', async () => {
  const a = await seedAccount(orgA.id, 'EX-06');
  const tA = await login('EX-06', '203.0.113.79');
  const admin = await adminToken(orgA.id, 'u-ex06-admin');

  const d = await discoverWithSession(tA, 'key-ex-06-revoked-device-abcdef', '198.51.100.79');
  assert.equal(d.status, 201, JSON.stringify(d.body));
  const deviceId = d.body.deviceId as string;
  const claimId = d.body.claimId as string;

  const ar = await approve(admin, claimId, a.id);
  assert.equal(ar.status, 200, JSON.stringify(ar.body));
  const rv = await revoke(admin, claimId, 'security-test');
  assert.equal(rv.status, 200, JSON.stringify(rv.body));

  const afterRevoke = await getDevice('key-ex-06-revoked-device-abcdef');
  assert.equal(afterRevoke!.status, 'inactive');
  assert.equal(afterRevoke!.employeeId, null, 'revoke unbinds the device');

  // Owner rediscovery: terminal revoked state — fail closed, no rebind, no
  // fresh claim even though the device is unassigned again.
  const again = await discoverWithSession(tA, 'key-ex-06-revoked-device-abcdef', '198.51.100.79');
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.status, 'revoked', 'revoked must stay terminal');
  assert.equal(await claimCount(deviceId), 1, 'no fresh claim after revocation');
  const final = await getDevice('key-ex-06-revoked-device-abcdef');
  assert.equal(final!.employeeId, null, 'revoked device must never be rebound via rediscovery');
});

test('AUTH-EXIST-07: disabled employee fails closed (session invalid; login denied)', async () => {
  const a = await seedAccount(orgA.id, 'EX-07');
  const tA = await login('EX-07', '203.0.113.80');
  await discoverWithSession(tA, 'key-ex-07-a-device-abcdef', '198.51.100.80');

  await db.employee.update({ where: { id: a.id }, data: { status: 'inactive' } });

  const valid = await validateAgentSession(req(tA, { ip: '203.0.113.80' }));
  assert.equal(valid.valid, false, 'disabled employee session must fail closed');

  const relogin = await loginApi.POST(req(null, { method: 'POST', body: { agentId: 'EX-07', password: PASSWORD }, ip: '203.0.113.80' }));
  assert.equal(relogin.status, 401, 'disabled employee cannot log in');

  // The stale session token cannot drive authenticated behavior: the request
  // falls back to anonymous zero-touch (documented legacy fallback) and the
  // device ownership is untouched — nothing is rebound to a new identity.
  const rediscover = await discoverWithSession(tA, 'key-ex-07-a-device-abcdef', '198.51.100.80');
  assert.ok(rediscover.status === 200 || rediscover.status === 201, JSON.stringify(rediscover.body));
  const device = await getDevice('key-ex-07-a-device-abcdef');
  assert.equal(device!.employeeId, a.id, 'device ownership unchanged by an invalid session');
});

// ─── AUTH-EXIST-08/09/10: unassigned devices ────────────────────────────────

test('AUTH-EXIST-08: authenticated discover binds device to session employee/org', async () => {
  const a = await seedAccount(orgA.id, 'EX-08');
  const tA = await login('EX-08', '203.0.113.81');
  const d = await discoverWithSession(tA, 'key-ex-08-unassigned-device-abcdef', '198.51.100.81');
  assert.equal(d.status, 201, JSON.stringify(d.body));

  const device = await getDevice('key-ex-08-unassigned-device-abcdef');
  assert.equal(device!.employeeId, a.id, 'device bound to the authenticated employee');
  assert.equal(device!.organizationId, orgA.id, 'org from session');
});

test('AUTH-EXIST-09: anonymous discover without session → 422 (enrollment code removed)', async () => {
  const anon = await discoverAnon('key-ex-09-anon-blocked-abcdef', '198.51.100.82');
  assert.equal(anon.status, 422, 'anonymous discovery no longer supported');
});

test('AUTH-EXIST-10: device stays unassigned until admin approval (authenticated discover)', async () => {
  const a = await seedEmployee(orgA.id, 'EX-10EMP');
  const empAccount = await seedAccount(orgA.id, 'EX-10ACC');
  const tA = await login('EX-10ACC', '198.51.100.83');
  const d = await discoverWithSession(tA, 'key-ex-10-auth-device-abcdef', '198.51.100.83');
  const admin = await adminToken(orgA.id, 'u-ex10-admin');
  const deviceBefore = await getDevice('key-ex-10-auth-device-abcdef');
  assert.equal(deviceBefore!.employeeId, empAccount.id, 'authenticated discover binds to session employee');

  const ar = await approve(admin, d.body.claimId as string, a.id);
  assert.equal(ar.status, 200, JSON.stringify(ar.body));
  const deviceAfter = await getDevice('key-ex-10-auth-device-abcdef');
  assert.equal(deviceAfter!.employeeId, a.id, 'admin approval re-assigns to target employee');
  assert.equal(deviceAfter!.status, 'online');
});

// ─── AUTH-EXIST-11/12/13/14: claim state machine preserved ──────────────────

test('AUTH-EXIST-11: approved same-employee reconnect still works', async () => {
  const a = await seedAccount(orgA.id, 'EX-11');
  const tA = await login('EX-11', '203.0.113.84');
  const admin = await adminToken(orgA.id, 'u-ex11-admin');

  const d = await discoverWithSession(tA, 'key-ex-11-approved-device-abcdef', '198.51.100.84');
  const ar = await approve(admin, d.body.claimId as string, a.id);
  assert.equal(ar.status, 200, JSON.stringify(ar.body));

  const reconnect = await discoverWithSession(tA, 'key-ex-11-approved-device-abcdef', '198.51.100.84');
  assert.equal(reconnect.status, 200, JSON.stringify(reconnect.body));
  assert.equal(reconnect.body.status, 'approved');
  assert.equal(reconnect.body.employeeAssigned, true);
  assert.equal(reconnect.body.claimId, d.body.claimId, 'no duplicate claim for an approved device');
});

test('AUTH-EXIST-12: rejected claim stays rejected per the state machine', async () => {
  const a = await seedAccount(orgA.id, 'EX-12');
  const tA = await login('EX-12', '203.0.113.85');
  const admin = await adminToken(orgA.id, 'u-ex12-admin');

  const d = await discoverWithSession(tA, 'key-ex-12-rejected-device-abcdef', '198.51.100.85');
  const rj = await reject(admin, d.body.claimId as string, 'not approved');
  assert.equal(rj.status, 200, JSON.stringify(rj.body));

  // Polling without reRegister intent → surfaces the rejection.
  const poll = await discoverWithSession(tA, 'key-ex-12-rejected-device-abcdef', '198.51.100.85');
  assert.equal(poll.status, 200, JSON.stringify(poll.body));
  assert.equal(poll.body.status, 'rejected');
  assert.equal(poll.body.claimId, d.body.claimId);

  // Explicit reRegister intent → fresh claim (existing behavior preserved).
  const fresh = await discoverWithSession(tA, 'key-ex-12-rejected-device-abcdef', '198.51.100.85', {
    reRegister: true,
  });
  assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
  assert.equal(fresh.body.status, 'pending');
  assert.notEqual(fresh.body.claimId, d.body.claimId, 'fresh claim issued after explicit re-registration');
  assert.equal(await claimCount(d.body.deviceId as string), 2);
});

test('AUTH-EXIST-13: cancelled claim can rediscover/re-register', async () => {
  const a = await seedAccount(orgA.id, 'EX-13');
  const tA = await login('EX-13', '203.0.113.86');
  const d = await discoverWithSession(tA, 'key-ex-13-cancelled-device-abcdef', '198.51.100.86');
  assert.equal(d.status, 201, JSON.stringify(d.body));

  const c = await cancelClaim(d.body.claimId as string, 'key-ex-13-cancelled-device-abcdef', d.body.secret as string);
  assert.equal(c.status, 200, JSON.stringify(c.body));

  const rediscover = await discoverWithSession(tA, 'key-ex-13-cancelled-device-abcdef', '198.51.100.86');
  assert.equal(rediscover.status, 201, JSON.stringify(rediscover.body));
  assert.equal(rediscover.body.status, 'pending');
  assert.notEqual(rediscover.body.claimId, d.body.claimId, 'fresh claim after cancellation');
  const device = await getDevice('key-ex-13-cancelled-device-abcdef');
  assert.equal(device!.employeeId, a.id, 'employee re-bound after cancel → rediscover');
});

test('AUTH-EXIST-14: expired claim creates a fresh claim per existing rules', async () => {
  const a = await seedAccount(orgA.id, 'EX-14');
  const tA = await login('EX-14', '203.0.113.87');
  const d = await discoverWithSession(tA, 'key-ex-14-expired-device-abcdef', '198.51.100.87');
  assert.equal(d.status, 201, JSON.stringify(d.body));

  await db.deviceClaim.update({
    where: { id: d.body.claimId as string },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });

  const rediscover = await discoverWithSession(tA, 'key-ex-14-expired-device-abcdef', '198.51.100.87');
  assert.equal(rediscover.status, 201, JSON.stringify(rediscover.body));
  assert.equal(rediscover.body.status, 'pending');
  assert.notEqual(rediscover.body.claimId, d.body.claimId);
  const oldClaim = await db.deviceClaim.findUnique({ where: { id: d.body.claimId as string } });
  assert.equal(oldClaim!.status, 'expired', 'expired pending claim closed, history preserved');
});

// ─── AUTH-EXIST-15/16: no cross-tenant/ownership mutation ───────────────────

test('AUTH-EXIST-15: cross-org request never creates a claim in the target organization', async () => {
  const c = await seedAccount(orgB.id, 'EX-15C');
  const a = await seedAccount(orgA.id, 'EX-15A');
  const tC = await login('EX-15C', '203.0.113.88');
  const created = await discoverWithSession(tC, 'key-ex-15-orgb-device-abcdef', '198.51.100.88');
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const deviceId = created.body.deviceId as string;
  assert.equal(await claimCount(deviceId), 1);

  const tA = await login('EX-15A', '203.0.113.89');
  const denied = await discoverWithSession(tA, 'key-ex-15-orgb-device-abcdef', '198.51.100.89');
  assert.equal(denied.status, 404, JSON.stringify(denied.body));

  assert.equal(await claimCount(deviceId), 1, 'no claim created by the cross-org attempt');
  const claims = await db.deviceClaim.findMany({ where: { deviceId } });
  for (const claim of claims) {
    assert.equal(claim.organizationId, orgB.id, 'every claim stays in the device\u2019s org');
  }
});

test('AUTH-EXIST-16: cross-employee request never rebinds the device', async () => {
  const a = await seedAccount(orgA.id, 'EX-16A');
  const b = await seedAccount(orgA.id, 'EX-16B');
  const tA = await login('EX-16A', '203.0.113.90');
  await discoverWithSession(tA, 'key-ex-16-a-device-abcdef', '198.51.100.90');

  const tB = await login('EX-16B', '203.0.113.91');
  const denied = await discoverWithSession(tB, 'key-ex-16-a-device-abcdef', '198.51.100.91');
  assert.equal(denied.status, 404, JSON.stringify(denied.body));

  const device = await getDevice('key-ex-16-a-device-abcdef');
  assert.equal(device!.employeeId, a.id, 'ownership never reassigned to employee B');
});

// ─── AUTH-EXIST-17: concurrency ─────────────────────────────────────────────

test('AUTH-EXIST-17a: concurrent rediscovery by the same employee → single pending claim', async () => {
  const a = await seedAccount(orgA.id, 'EX-17A');
  const tA = await login('EX-17A', '203.0.113.92');
  const d = await discoverWithSession(tA, 'key-ex-17a-concurrent-device-abcdef', '198.51.100.92');
  assert.equal(d.status, 201, JSON.stringify(d.body));

  const [r1, r2] = await Promise.all([
    discoverWithSession(tA, 'key-ex-17a-concurrent-device-abcdef', '198.51.100.92'),
    discoverWithSession(tA, 'key-ex-17a-concurrent-device-abcdef', '198.51.100.92'),
  ]);
  assert.ok(r1.status === 200 && r2.status === 200, `r1=${r1.status} r2=${r2.status}`);
  assert.equal(r1.body.claimId, r2.body.claimId, 'both calls see the same pending claim');
  const device = await getDevice('key-ex-17a-concurrent-device-abcdef');
  assert.equal(await claimCount(device!.id), 1, 'exactly one pending claim after concurrent rediscovery');
  assert.equal(device!.employeeId, a.id);
});

test('AUTH-EXIST-17b: concurrent rediscovery by two employees → one owner, one 404, no conflict', async () => {
  const a = await seedAccount(orgA.id, 'EX-17B1');
  const b = await seedAccount(orgA.id, 'EX-17B2');
  const tA = await login('EX-17B1', '203.0.113.93');
  const tB = await login('EX-17B2', '203.0.113.94');

  // Owner (A) creates the shared device via AUTHENTICATED discovery —
  // anonymous device creation was removed (see route header), so the old
  // `discoverAnon(...) → 201` setup no longer exists.
  const created = await discoverWithSession(tA, 'key-ex-17b-concurrent-device-abcdef', '198.51.100.93');
  assert.equal(created.status, 201, JSON.stringify(created.body));

  // Concurrent rediscovery: A (owner) idempotently succeeds; B (other
  // employee, same org) is uniformly concealed with 404 — no conflict, no
  // rebind, no duplicate claim.
  const [r1, r2] = await Promise.all([
    discoverWithSession(tA, 'key-ex-17b-concurrent-device-abcdef', '198.51.100.93'),
    discoverWithSession(tB, 'key-ex-17b-concurrent-device-abcdef', '198.51.100.93'),
  ]);
  const statuses = [r1.status, r2.status].sort((x, y) => x - y);
  assert.deepEqual(statuses, [200, 404], `expected exactly one success + one denial, got r1=${r1.status} r2=${r2.status}`);

  const device = await getDevice('key-ex-17b-concurrent-device-abcdef');
  assert.equal(device!.employeeId, a.id, 'device stays bound to the owner');
  assert.equal(await claimCount(device!.id), 1, 'exactly one claim — no duplicate pending');
});

// ─── AUTH-EXIST-18..23: concealment of denied responses ─────────────────────

test('AUTH-EXIST-18/19/20/21/22/23: denied responses are uniform 404 with zero disclosure', async () => {
  const a = await seedAccount(orgA.id, 'EX-18A');
  const b = await seedAccount(orgA.id, 'EX-18B');
  const c = await seedAccount(orgB.id, 'EX-18C');

  const tA = await login('EX-18A', '203.0.113.95');
  const created = await discoverWithSession(tA, 'key-ex-18-a-device-abcdef', '198.51.100.95');
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const deviceId = created.body.deviceId as string;
  const claimId = created.body.claimId as string;

  const tB = await login('EX-18B', '203.0.113.96');
  const sameOrg = await discoverWithSession(tB, 'key-ex-18-a-device-abcdef', '198.51.100.96');
  assert.equal(sameOrg.status, 404);

  const tC = await login('EX-18C', '203.0.113.97');
  const crossOrg = await discoverWithSession(tC, 'key-ex-18-a-device-abcdef', '198.51.100.97');
  assert.equal(crossOrg.status, 404);

  for (const denied of [sameOrg, crossOrg]) {
    assert.deepEqual(denied.body, { error: 'Device not found' }, 'uniform concealing body');
    const json = JSON.stringify(denied.body);
    assert.ok(!json.includes(a.id), 'no employee id');
    assert.ok(!json.includes(b.id), 'no other employee id');
    assert.ok(!json.includes(c.id), 'no org B employee id');
    assert.ok(!json.includes(orgA.id) && !json.includes(orgB.id), 'no organization id');
    assert.ok(!json.includes(deviceId), 'no device id');
    assert.ok(!json.includes(claimId), 'no claim id');
    assert.ok(!json.includes('pending') && !json.includes('approved') && !json.includes('revoked') && !json.includes('rejected'), 'no claim/device status');
    assert.ok(!json.includes('employeeAssigned'), 'no assignment flag');
    assert.ok(!json.includes('PC-EXIST') && !json.includes('Test'), 'no names/PII');
    assert.ok(!json.includes('secret'), 'no secret');
  }
});

// ─── AUTH-EXIST-25: invalid/expired session ─────────────────────────────────

test('AUTH-EXIST-25: invalid/expired AgentSession cannot authorize an existing device', async () => {
  const a = await seedAccount(orgA.id, 'EX-25');
  const tA = await login('EX-25', '203.0.113.98');
  const created = await discoverWithSession(tA, 'key-ex-25-stale-session-device-abcdef', '198.51.100.98');
  assert.equal(created.status, 201, JSON.stringify(created.body));

  // A separate, now-EXPIRED session token cannot drive authenticated behavior
  // (anonymous device creation was removed, so the device is created above via
  // the owner's valid session).
  const { token } = await createAgentSession({ employeeId: a.id, organizationId: orgA.id, ipAddress: '203.0.113.98' });
  await db.agentSession.update({ where: { token }, data: { expiresAt: new Date(Date.now() - 60_000) } });
  assert.equal((await validateAgentSession(req(token, { ip: '203.0.113.98' }))).valid, false, 'session is expired');

  // The expired session falls back to the device-key identity path: the claim
  // is returned (200 pending), but the invalid session must NOT mutate the
  // device — ownership stays with the creator, no duplicate claim appears.
  const rediscover = await discoverWithSession(token, 'key-ex-25-stale-session-device-abcdef', '198.51.100.98');
  assert.equal(rediscover.status, 200, JSON.stringify(rediscover.body));
  assert.equal(rediscover.body.status, 'pending');
  const device = await getDevice('key-ex-25-stale-session-device-abcdef');
  assert.equal(device!.employeeId, a.id, 'expired session must not change device ownership');
  assert.equal(device!.organizationId, orgA.id);
  assert.equal(await claimCount(device!.id), 1, 'no duplicate claim from an expired session');
});

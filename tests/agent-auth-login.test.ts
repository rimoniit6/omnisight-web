/**
 * Phase 3 — Agent Authentication (POST /api/agent/login + AgentSession).
 *
 * End-to-end server tests for the secure Agent login flow:
 *   login (AgentAccount credentials) → AgentSession (login-only token)
 *     → authenticated /api/agent/discover (server-derived employee+org)
 *     → PENDING DeviceClaim → cancel/rediscover → (admin approve) → device
 *     → PATH A authenticate → device-bound AgentToken.
 *
 * Covers the master prompt's AUTH-1..25 plus two hardening cases (G1 suspended
 * organization, G2 login session cannot reach device routes).
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_agentauth).
 * Run: npx tsx --test tests/agent-auth-login.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation (must be set BEFORE any app module import) ──────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_agentauth';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-agentauth-0123456789abcdef';
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
let verifyJWT: (token: string) => Promise<unknown>;

type LoginApi = typeof import('../src/app/api/agent/login/route');
type LogoutApi = typeof import('../src/app/api/agent/logout/route');
type DiscoverApi = typeof import('../src/app/api/agent/discover/route');
type AuthApi = typeof import('../src/app/api/agent/authenticate/route');
type ApproveApi = typeof import('../src/app/api/device-claims/[id]/approve/route');
type CancelApi = typeof import('../src/app/api/device-claims/[id]/cancel/route');
type HeartbeatApi = typeof import('../src/app/api/agent/heartbeat/route');

let loginApi: LoginApi;
let logoutApi: LogoutApi;
let discoverApi: DiscoverApi;
let authApi: AuthApi;
let approveApi: ApproveApi;
let cancelApi: CancelApi;
let heartbeatApi: HeartbeatApi;

let createAgentAccount: (typeof import('../src/lib/agent-account'))['createAgentAccount'];
let verifyAgentCredential: (typeof import('../src/lib/agent-account'))['verifyAgentCredential'];
let createAgentSession: (typeof import('../src/lib/agent/session'))['createAgentSession'];
let validateAgentSession: (typeof import('../src/lib/agent/session'))['validateAgentSession'];
let validateAgentToken: (typeof import('../src/lib/agent/auth'))['validateAgentToken'];

const PASSWORD = 'Str0ng!Pass123x';
let orgA: { id: string };
let orgB: { id: string };

before(async () => {
  db = (await import('../src/lib/db')).db;
  ({ signJWT, verifyJWT } = await import('../src/lib/auth'));
  loginApi = await import('../src/app/api/agent/login/route');
  logoutApi = await import('../src/app/api/agent/logout/route');
  discoverApi = await import('../src/app/api/agent/discover/route');
  authApi = await import('../src/app/api/agent/authenticate/route');
  approveApi = await import('../src/app/api/device-claims/[id]/approve/route');
  cancelApi = await import('../src/app/api/device-claims/[id]/cancel/route');
  heartbeatApi = await import('../src/app/api/agent/heartbeat/route');
  ({ createAgentAccount, verifyAgentCredential } = await import('../src/lib/agent-account'));
  ({ createAgentSession, validateAgentSession } = await import('../src/lib/agent/session'));
  ({ validateAgentToken } = await import('../src/lib/agent/auth'));

  orgA = await db.organization.create({ data: { name: 'Auth Org A', slug: 'auth-org-a' } });
  orgB = await db.organization.create({ data: { name: 'Auth Org B', slug: 'auth-org-b' } });
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

async function seedAccount(orgId: string, code: string, opts: { status?: 'active' | 'disabled' } = {}) {
  const emp = await seedEmployee(orgId, code);
  const acct = await createAgentAccount({ employeeId: emp.id, agentId: code, password: PASSWORD, status: opts.status ?? 'active' });
  return { emp, acct };
}

async function doLogin(agentId: string, password: string, extra: Record<string, unknown> = {}, ip = '203.0.113.50'): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await loginApi.POST(req(null, { method: 'POST', body: { agentId, password, ...extra }, ip }));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

function discoverBody(deviceKey: string, hostname = 'PC-AUTH') {
  return { deviceKey, hostname, os: 'Windows 11', osVersion: '23H2', processor: 'x64', memory: '16GB', agentVersion: '1.3.0', arch: 'x64' };
}

/** POST /api/agent/discover carrying an AgentSession bearer (Phase 3 PATH C). */
async function discoverWithSession(token: string, deviceKey: string, ip = '198.51.100.10') {
  const res = await discoverApi.POST(req(token, { method: 'POST', body: discoverBody(deviceKey), ip }));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function approve(admin: string, claimId: string, employeeId: string) {
  const res = await approveApi.POST(
    req(admin, { method: 'POST', body: { employeeId, projectIds: [] }, ip: '198.51.100.9' }),
    { params: Promise.resolve({ id: claimId }) }
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function cancel(claimId: string, deviceKey: string, secret: string) {
  const res = await cancelApi.POST(
    req(null, { method: 'POST', body: { deviceKey, secret }, ip: '198.51.100.11' }),
    { params: Promise.resolve({ id: claimId }) }
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

// ─── AUTH-1/2/3/17/18: login contract ───────────────────────────────────────

test('AUTH-1: valid credentials → 200 + session token', async () => {
  const { emp } = await seedAccount(orgA.id, 'AUTH-1');
  const { status, body } = await doLogin('AUTH-1', PASSWORD, {}, '203.0.113.1');
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.ok(typeof body.token === 'string' && (body.token as string).length >= 20);
  assert.ok(body.expiresAt);
  assert.equal((body.employee as Record<string, unknown>).employeeId, 'AUTH-1');
  // Not a device token — login issues an AgentSession, never a device AgentToken.
  const tokenRow = await db.agentToken.findUnique({ where: { token: body.token as string } });
  assert.equal(tokenRow, null, 'login must NOT create a device AgentToken');
  const sessionRow = await db.agentSession.findUnique({ where: { token: body.token as string } });
  assert.ok(sessionRow, 'login persisted an AgentSession row');
  assert.equal(sessionRow!.employeeId, emp.id);
});

test('AUTH-2: wrong password → uniform 401', async () => {
  await seedAccount(orgA.id, 'AUTH-2');
  const { status, body } = await doLogin('AUTH-2', 'Wr0ng-Pass!x', {}, '203.0.113.2');
  assert.equal(status, 401);
  assert.equal(body.error, 'Invalid credentials');
  assert.equal(body.token, undefined);
});

test('AUTH-3: unknown Agent ID → uniform 401', async () => {
  const { status, body } = await doLogin('NO-SUCH-AGENT', PASSWORD, {}, '203.0.113.3');
  assert.equal(status, 401);
  assert.equal(body.error, 'Invalid credentials');
});

test('AUTH-17: AUTH-2 and AUTH-3 return IDENTICAL responses (no enumeration)', async () => {
  const r2 = await doLogin('AUTH-2', 'Wr0ng-Pass!x', {}, '203.0.113.4');
  const r3 = await doLogin('NO-SUCH-AGENT-2', PASSWORD, {}, '203.0.113.5');
  assert.equal(r2.status, r3.status);
  assert.deepEqual(r2.body, r3.body, 'missing-account and wrong-password must be indistinguishable');
});

test('AUTH-18: passwordHash / password never appear in the response', async () => {
  await seedAccount(orgA.id, 'AUTH-18');
  const { status, body } = await doLogin('AUTH-18', PASSWORD, {}, '203.0.113.18');
  assert.equal(status, 200);
  const json = JSON.stringify(body);
  assert.ok(!json.includes('passwordHash'), 'no passwordHash');
  assert.ok(!json.toLowerCase().includes('password'), 'no password field');
  assert.ok(!json.includes(PASSWORD), 'no password value');
  assert.ok(!json.includes('$2'), 'no bcrypt hash leaked');
});

test('AUTH-4: disabled account → uniform 401', async () => {
  await seedAccount(orgA.id, 'AUTH-4', { status: 'disabled' });
  const { status, body } = await doLogin('AUTH-4', PASSWORD, {}, '203.0.113.6');
  assert.equal(status, 401);
  assert.equal(body.error, 'Invalid credentials');
});

// ─── AUTH-5/6/7: lockout ────────────────────────────────────────────────────

test('AUTH-6 + AUTH-5: five failed logins lock the account; even the correct password is denied', async () => {
  const { emp } = await seedAccount(orgA.id, 'AUTH-6');
  for (let i = 0; i < 5; i++) {
    const r = await doLogin('AUTH-6', 'Wr0ng-Pass!x', {}, '203.0.113.7');
    assert.equal(r.status, 401);
  }
  // Locked: the correct password is now rejected with the same uniform 401.
  const locked = await doLogin('AUTH-6', PASSWORD, {}, '203.0.113.7');
  assert.equal(locked.status, 401);
  assert.equal(locked.body.error, 'Invalid credentials');
  // The lock is real server-side state.
  const verify = await verifyAgentCredential({ agentId: 'AUTH-6', password: PASSWORD });
  assert.equal(verify.ok, false);
  if (!verify.ok) assert.equal(verify.locked, true, 'account is in lockout');
  // Brute force must NOT have disabled the account.
  const acct = await db.agentAccount.findUnique({ where: { employeeId: emp.id } });
  assert.equal(acct!.status, 'active');
});

// ─── AUTH-8/9/10/11: token integrity & separation ───────────────────────────

test('AUTH-8: an expired session is rejected (discover cannot bind any org without a valid session)', async () => {
  const { emp } = await seedAccount(orgA.id, 'AUTH-8');
  const { token } = await createAgentSession({ employeeId: emp.id, organizationId: orgA.id, ipAddress: '203.0.113.9' });
  await db.agentSession.update({
    where: { token },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });
  const res = await validateAgentSession(req(token, { ip: '203.0.113.9' }));
  assert.equal(res.valid, false, 'expired session must fail closed');
  // No implicit tenant fallback: an anonymous discover without a valid session
  // is refused (422) — it must NEVER bind to the first organization.
  const d = await discoverWithSession(token, 'key-auth-8-expired-device-abcdef', '198.51.100.12');
  assert.equal(d.status, 422, 'invalid session → no org selection → 422, never 201');
  assert.equal(d.body.employeeAssigned, undefined, 'no employee identity is ever assigned');
  assert.equal(d.body.secret, undefined, 'no claim secret is ever issued');
  // Zero writes: no device, no claim for the attempted identity.
  assert.equal(await db.device.count({ where: { agentKey: 'key-auth-8-expired-device-abcdef' } }), 0);
  assert.equal(await db.deviceClaim.count(), 0);
});

test('AUTH-9: an unknown / malformed token is rejected', async () => {
  const res = await validateAgentSession(req('this-is-a-totally-invalid-opaque-token', { ip: '203.0.113.10' }));
  assert.equal(res.valid, false);
  const short = await validateAgentSession(req('short', { ip: '203.0.113.10' }));
  assert.equal(short.valid, false);
});

test('AUTH-10: an Admin JWT cannot be used as an Agent session', async () => {
  const admin = await adminToken(orgA.id, 'u-auth10-admin');
  const res = await validateAgentSession(req(admin, { ip: '203.0.113.11' }));
  assert.equal(res.valid, false, 'admin JWT must never pass validateAgentSession');
  // And it cannot bind a device to the admin's identity via discover — with no
  // valid session the anonymous path is refused (422),
  // so the JWT holder cannot enroll a device into ANY organization.
  const d = await discoverWithSession(admin, 'key-auth-10-adminjwt-device-abcdef', '198.51.100.13');
  assert.equal(d.status, 422, 'no valid session → 422, never 201');
  assert.equal(d.body.employeeAssigned, undefined, 'admin JWT must not assign the device to an employee');
  assert.equal(await db.device.count({ where: { agentKey: 'key-auth-10-adminjwt-device-abcdef' } }), 0);
});

test('AUTH-11: an Agent session cannot authenticate as an Admin (JWT)', async () => {
  const { emp } = await seedAccount(orgA.id, 'AUTH-11');
  const { token } = await createAgentSession({ employeeId: emp.id, organizationId: orgA.id, ipAddress: '203.0.113.12' });
  const jwt = await verifyJWT(token);
  assert.equal(jwt, null, 'an AgentSession is not a signed admin JWT');
});

// ─── AUTH-12/13/14/15: server-derived identity ──────────────────────────────

test('AUTH-12/13/15: client-supplied organizationId is ignored; token org is server-derived', async () => {
  const { emp } = await seedAccount(orgA.id, 'AUTH-13');
  // Try to point login at org B — the body must be ignored entirely.
  const login = await doLogin('AUTH-13', PASSWORD, { organizationId: orgB.id, employeeId: 'someone-else' }, '203.0.113.13');
  assert.equal(login.status, 200);
  const token = login.body.token as string;
  const valid = await validateAgentSession(req(token, { ip: '203.0.113.13' }));
  assert.equal(valid.valid, true);
  assert.equal(valid.employee!.id, emp.id, 'employee derived from AgentAccount, never the body');
  assert.equal(valid.employee!.organizationId, orgA.id, 'organizationId is server-derived from AgentAccount→Employee');
  assert.notEqual(valid.employee!.organizationId, orgB.id, 'client org B never appears in the token');
});

test('AUTH-14: client-supplied employeeId is ignored — identity comes from AgentAccount', async () => {
  const { emp } = await seedAccount(orgA.id, 'AUTH-14');
  await seedEmployee(orgA.id, 'AUTH-14-VICTIM');
  const login = await doLogin('AUTH-14', PASSWORD, { employeeId: 'AUTH-14-VICTIM' }, '203.0.113.14');
  assert.equal(login.status, 200);
  assert.equal((login.body.employee as Record<string, unknown>).employeeId, 'AUTH-14', 'identity from AgentAccount, not the body');
  const valid = await validateAgentSession(req(login.body.token as string, { ip: '203.0.113.14' }));
  assert.equal(valid.employee!.id, emp.id, 'session is bound to the AgentAccount owner, not the spoofed employeeId');
});

// ─── AUTH-16 + G1/G2: fail-closed hardening ─────────────────────────────────

test('AUTH-16: disabling the AgentAccount invalidates an in-flight session', async () => {
  const { emp } = await seedAccount(orgA.id, 'AUTH-16');
  const { token } = await createAgentSession({ employeeId: emp.id, organizationId: orgA.id, ipAddress: '203.0.113.16' });
  const before = await validateAgentSession(req(token, { ip: '203.0.113.16' }));
  assert.equal(before.valid, true);
  await db.agentAccount.update({ where: { employeeId: emp.id }, data: { status: 'disabled' } });
  const after = await validateAgentSession(req(token, { ip: '203.0.113.16' }));
  assert.equal(after.valid, false, 'disabled account must fail closed mid-session');
});

test('G1: login is denied for an inactive (suspended) organization — uniform 401', async () => {
  const { emp } = await seedAccount(orgA.id, 'AUTH-SUSP-1');
  await db.organization.update({ where: { id: orgA.id }, data: { status: 'suspended' } });
  const r = await doLogin('AUTH-SUSP-1', PASSWORD, {}, '203.0.113.17');
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'Invalid credentials');
  await db.organization.update({ where: { id: orgA.id }, data: { status: 'active' } });
});

test('G2: a login AgentSession cannot reach device routes (validateAgentToken rejects it)', async () => {
  const { emp } = await seedAccount(orgA.id, 'AUTH-G2');
  const { token } = await createAgentSession({ employeeId: emp.id, organizationId: orgA.id, ipAddress: '203.0.113.19' });
  // The session is valid for validateAgentSession (discover/login scope)…
  assert.equal((await validateAgentSession(req(token, { ip: '203.0.113.19' }))).valid, true);
  // …but it is NOT a device AgentToken — validateAgentToken fails closed.
  const device = await validateAgentToken(req(token, { ip: '203.0.113.19' }));
  assert.equal(device.valid, false, 'session must never authorize heartbeat/activity/screenshot');
  // Confirmed via a real device route (heartbeat).
  const beat = await heartbeatApi.POST(req(token, { method: 'POST', body: { timestamp: new Date().toISOString() }, ip: '203.0.113.19' }));
  assert.equal(beat.status, 401);
});
// ─── AUTH-20/21/22/23: discover integration & lifecycle ─────────────────────

test('AUTH-20: login → discover creates a PENDING claim bound to the correct employee + org', async () => {
  const { emp } = await seedAccount(orgA.id, 'AUTH-20');
  const login = await doLogin('AUTH-20', PASSWORD, {}, '203.0.113.20');
  assert.equal(login.status, 200);

  const d = await discoverWithSession(login.body.token as string, 'key-auth-20-discover-device-abcdef', '198.51.100.20');
  assert.equal(d.status, 201, JSON.stringify(d.body));
  assert.equal(d.body.status, 'pending');
  assert.ok(d.body.claimId);
  assert.ok(d.body.secret, 'one-time claim secret issued for approval');

  const device = await db.device.findFirst({ where: { agentKey: 'key-auth-20-discover-device-abcdef' } });
  assert.ok(device);
  assert.equal(device!.employeeId, emp.id, 'device bound immediately to the authenticated employee');
  assert.equal(device!.organizationId, orgA.id, 'device created in the employee org (server-derived)');

  const claim = await db.deviceClaim.findUnique({ where: { id: d.body.claimId as string } });
  assert.equal(claim!.status, 'pending');
  assert.equal(claim!.organizationId, orgA.id);
});

test('AUTH-21: an agent from Org A cannot create a claim for Org B', async () => {
  const { emp } = await seedAccount(orgA.id, 'AUTH-21');
  const login = await doLogin('AUTH-21', PASSWORD, {}, '203.0.113.21');
  const d = await discoverWithSession(login.body.token as string, 'key-auth-21-crossorg-device-abcdef', '198.51.100.21');
  assert.equal(d.status, 201);

  const device = await db.device.findFirst({ where: { agentKey: 'key-auth-21-crossorg-device-abcdef' } });
  assert.equal(device!.organizationId, orgA.id, 'device bound to the employee org, never client-chosen org');
  assert.notEqual(device!.organizationId, orgB.id);

  // An Org B admin cannot approve the Org A claim (cross-org isolation).
  const adminB = await adminToken(orgB.id, 'u-auth21-admin-b');
  const ar = await approve(adminB, d.body.claimId as string, emp.id);
  assert.notEqual(ar.status, 200, 'cross-org admin must be denied');
});

test('AUTH-22: cancel → rediscover still issues a fresh PENDING claim', async () => {
  const { emp } = await seedAccount(orgA.id, 'AUTH-22');
  const login = await doLogin('AUTH-22', PASSWORD, {}, '203.0.113.22');
  const d = await discoverWithSession(login.body.token as string, 'key-auth-22-cancel-device-abcdef', '198.51.100.22');
  const claimId = d.body.claimId as string;
  const secret = d.body.secret as string;
  const deviceKey = 'key-auth-22-cancel-device-abcdef';

  const c = await cancel(claimId, deviceKey, secret);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const cancelled = await db.deviceClaim.findUnique({ where: { id: claimId } });
  assert.equal(cancelled!.status, 'cancelled', 'history preserved');

  // Rediscover with the still-valid session → a NEW pending claim.
  const d2 = await discoverWithSession(login.body.token as string, deviceKey, '198.51.100.22');
  assert.equal(d2.status, 201, JSON.stringify(d2.body));
  assert.equal(d2.body.status, 'pending');
  assert.notEqual(d2.body.claimId, claimId, 'fresh claim issued');
  const fresh = await db.deviceClaim.findUnique({ where: { id: d2.body.claimId as string } });
  assert.equal(fresh!.status, 'pending');
});

test('AUTH-23: an approved DeviceClaim lifecycle remains intact (approve → authenticate → device route)', async () => {
  const { emp } = await seedAccount(orgA.id, 'AUTH-23');
  const login = await doLogin('AUTH-23', PASSWORD, {}, '203.0.113.23');
  const d = await discoverWithSession(login.body.token as string, 'key-auth-23-approve-device-abcdef', '198.51.100.23');
  const adminA = await adminToken(orgA.id, 'u-auth23-admin');
  const ar = await approve(adminA, d.body.claimId as string, emp.id);
  assert.equal(ar.status, 200, JSON.stringify(ar.body));

  // Rediscover of an approved device returns approved (no duplicate claim).
  const afterApprove = await discoverWithSession(login.body.token as string, 'key-auth-23-approve-device-abcdef', '198.51.100.23');
  assert.equal(afterApprove.body.status, 'approved');

  // PATH A authenticate with the claim secret → device-bound AgentToken.
  const auth = await authApi.POST(req(null, { method: 'POST', body: { deviceId: d.body.deviceId, deviceSecret: d.body.secret, agentVersion: '1.3.0' }, ip: '198.51.100.23' }));
  const authBody = (await auth.json().catch(() => ({}))) as Record<string, unknown>;
  assert.equal(auth.status, 200, JSON.stringify(authBody));
  // A device-bound token works on a device route (heartbeat).
  const beat = await heartbeatApi.POST(req(authBody.token as string, { method: 'POST', body: { timestamp: new Date().toISOString() }, ip: '198.51.100.23' }));
  assert.equal(beat.status, 200);
});

// ─── AUTH-24/25: logout ────────────────────────────────────────────────────

test('AUTH-24: logout revokes the AgentSession server-side', async () => {
  const { emp } = await seedAccount(orgA.id, 'AUTH-24');
  const login = await doLogin('AUTH-24', PASSWORD, {}, '203.0.113.24');
  const token = login.body.token as string;
  assert.equal((await validateAgentSession(req(token, { ip: '203.0.113.24' }))).valid, true);

  const out = await logoutApi.POST(req(token, { method: 'POST', body: {}, ip: '203.0.113.24' }));
  assert.equal(out.status, 200);

  const row = await db.agentSession.findUnique({ where: { token } });
  assert.equal(row, null, 'session row deleted on logout');
  assert.equal((await validateAgentSession(req(token, { ip: '203.0.113.24' }))).valid, false);
  // The AgentAccount is untouched — login remains possible afterwards.
  const acct = await db.agentAccount.findUnique({ where: { employeeId: emp.id } });
  assert.equal(acct!.status, 'active');
});

test('AUTH-25: login works again after logout', async () => {
  await seedAccount(orgA.id, 'AUTH-25');
  const first = await doLogin('AUTH-25', PASSWORD, {}, '203.0.113.25');
  assert.equal(first.status, 200);
  await logoutApi.POST(req(first.body.token as string, { method: 'POST', body: {}, ip: '203.0.113.25' }));

  const again = await doLogin('AUTH-25', PASSWORD, {}, '203.0.113.25');
  assert.equal(again.status, 200, 're-login after logout');
  assert.ok(again.body.token);
  assert.equal(await db.agentSession.count({ where: { token: again.body.token as string } }), 1);
});
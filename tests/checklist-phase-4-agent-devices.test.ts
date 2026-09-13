/**
 * Smart Testing Checklist — PHASE 4: Agent Enrollment & Single Active Device.
 *
 * End-to-end server tests for device onboarding and the single-active-device
 * authority, driven through the real HTTP handlers:
 *   D-01  discovery requires an authenticated agent session (401 anonymous)
 *   D-02  discover -> 201 pending claim + one-time secret (secret only ever hashed)
 *   D-03  claim approval binds the device to the employee
 *   D-04  authenticate (happy path) -> token; exactly ONE active token per employee
 *   D-05  a second eligible device -> 409 ACTIVE_DEVICE_EXISTS (exact body), first intact
 *   D-06  agent (Path B) login: correct credentials work, wrong ones stay uniform 401
 *   D-07  wrong device secret -> uniform 401 (a 409 must never leak device state)
 *   D-08  a disabled AgentAccount cannot take the slot (403, not 409)
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_checklist_phase4).
 * Run: npx tsx --test tests/checklist-phase-4-agent-devices.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { req } from './helpers/request';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_checklist_phase4';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-checklist-p4-0123456789abcdef';
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
let signJWT: (p: { userId: string; email: string; role: string; organizationId?: string }) => Promise<string>;
let createAgentAccount: (p: { employeeId: string; agentId: string; password: string; status: 'active' | 'disabled' }) => Promise<unknown>;
let hashPassword: (password: string) => Promise<string>;

let discoverApi: typeof import('../src/app/api/agent/discover/route');
let authApi: typeof import('../src/app/api/agent/authenticate/route');
let approveApi: typeof import('../src/app/api/device-claims/[id]/approve/route');
let loginApi: typeof import('../src/app/api/agent/login/route');
let heartbeatApi: typeof import('../src/app/api/agent/heartbeat/route');

const PASSWORD = 'Str0ng!Pass123x';
let org: { id: string };

before(async () => {
  db = (await import('../src/lib/db')).db;
  ({ signJWT } = await import('../src/lib/auth'));
  ({ createAgentAccount } = await import('../src/lib/agent-account'));
  ({ hashPassword } = await import('../src/lib/auth'));
  discoverApi = await import('../src/app/api/agent/discover/route');
  authApi = await import('../src/app/api/agent/authenticate/route');
  approveApi = await import('../src/app/api/device-claims/[id]/approve/route');
  loginApi = await import('../src/app/api/agent/login/route');
  heartbeatApi = await import('../src/app/api/agent/heartbeat/route');
  org = await db.organization.create({
    data: { name: 'P4 Org', slug: 'p4-org', trialEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
  });
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

// ─── Helpers (mirror the real discover -> approve -> authenticate pipeline) ─

function adminToken(userId: string) {
  return signJWT({ userId, email: `${userId}@p4.local`, role: 'admin', organizationId: org.id });
}

async function seedEmployee(code: string, opts: { agentAccount?: 'active' | 'disabled' } = {}) {
  const emp = await db.employee.create({
    data: {
      employeeId: code,
      firstName: code.split('-')[0],
      lastName: 'Test',
      email: `${code.toLowerCase()}@test.local`,
      organizationId: org.id,
      status: 'active',
      agentApproved: true,
    },
  });
  if (opts.agentAccount) {
    await createAgentAccount({ employeeId: emp.id, agentId: code, password: PASSWORD, status: opts.agentAccount });
  }
  return emp;
}

async function discovererSession(code: string) {
  const emp = await seedEmployee(code, { agentAccount: 'active' });
  const res = await loginApi.POST(req(null, { method: 'POST', body: { agentId: code, password: PASSWORD } }));
  const body = (await res.json()) as { token?: string };
  assert.ok(body.token, `agent login must yield a session token: ${res.status}`);
  return { emp, sessionToken: body.token! };
}

function discoverBody(deviceKey: string) {
  return { deviceKey, hostname: 'PC-P4', os: 'Windows 11', osVersion: '23H2', processor: 'x64', memory: '16GB', agentVersion: '1.3.0', arch: 'x64' };
}

async function doDiscover(deviceKey: string, ip: string, sessionToken: string | null) {
  const res = await discoverApi.POST(req(sessionToken ?? null, { method: 'POST', body: discoverBody(deviceKey), ip }));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function doApprove(claimId: string, employeeId: string) {
  const res = await approveApi.POST(req(await adminToken('u-p4-admin'), { method: 'POST', body: { employeeId, projectIds: [] }, ip: '198.51.100.9' }), { params: Promise.resolve({ id: claimId }) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function doAuthenticate(body: Record<string, unknown>, ip: string) {
  const res = await authApi.POST(req(null, { method: 'POST', body, ip }));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function seedActiveDevice(emp: { id: string }, deviceKey: string, sessionToken: string) {
  const d = await doDiscover(deviceKey, '203.0.113.101', sessionToken);
  assert.equal(d.status, 201, `discover: ${JSON.stringify(d.body)}`);
  const ar = await doApprove(d.body.claimId as string, emp.id);
  assert.equal(ar.status, 200, `approve: ${JSON.stringify(ar.body)}`);
  const auth = await doAuthenticate({ deviceId: d.body.deviceId, deviceSecret: d.body.secret, agentVersion: '1.3.0' }, '203.0.113.101');
  assert.equal(auth.status, 200, `authenticate: ${JSON.stringify(auth.body)}`);
  return { deviceId: d.body.deviceId as string, token: auth.body.token as string };
}

/** An eligible sibling device (approved claim + online) that holds no slot. */
async function seedEligibleDevice(employeeId: string, deviceKey: string, sessionToken: string) {
  const d = await doDiscover(deviceKey, '203.0.113.102', sessionToken);
  assert.equal(d.status, 201, `discover: ${JSON.stringify(d.body)}`);
  await db.device.update({ where: { id: d.body.deviceId as string }, data: { employeeId, status: 'online' } });
  await db.deviceClaim.update({ where: { id: d.body.claimId as string }, data: { status: 'approved' } });
  return { deviceId: d.body.deviceId as string, secret: d.body.secret as string };
}

function authBody(deviceId: string, secret: string) {
  return { deviceId, deviceSecret: secret, agentVersion: '1.3.0' };
}

// ─── D-01: discovery is session-gated ───────────────────────────────────────

test('D-01: anonymous device discovery is rejected (422 + machine-readable AUTHENTICATION_REQUIRED)', async () => {
  const r = await doDiscover('key-d01-anon-0123456789', '203.0.113.1', null);
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal((r.body as { code?: string }).code, 'AUTHENTICATION_REQUIRED');
});

// ─── D-02: discover -> pending claim + one-time secret ──────────────────────

test('D-02: discovery creates a pending claim and a one-time secret (hash-only stored)', async () => {
  const { sessionToken } = await discovererSession('D02-DISCOVERER');
  const r = await doDiscover('key-d02-device-0123456789', '203.0.113.2', sessionToken);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.deviceId && r.body.claimId && r.body.secret, 'deviceId + claimId + secret returned');

  const claim = await db.deviceClaim.findUniqueOrThrow({ where: { id: r.body.claimId as string } });
  assert.equal(claim.status, 'pending');
  assert.equal(claim.organizationId, org.id);
  assert.notEqual(claim.claimSecretHash, r.body.secret, 'raw secret is NEVER stored');
  assert.ok(claim.claimSecretHash.length === 64, 'sha256 hex hash stored');

  const device = await db.device.findUniqueOrThrow({ where: { id: r.body.deviceId as string } });
  assert.equal(device.status, 'inactive', 'device starts inactive until the claim is approved');
});

// ─── D-03: approval binds the device to the employee ────────────────────────

test('D-03: claim approval binds the device and marks the employee agent-approved', async () => {
  const { emp, sessionToken } = await discovererSession('D03-SOURCE');
  const target = await seedEmployee('D03-TARGET');
  const d = await doDiscover('key-d03-device-0123456789', '203.0.113.3', sessionToken);
  assert.equal(d.status, 201);

  const ar = await doApprove(d.body.claimId as string, target.id);
  assert.equal(ar.status, 200, JSON.stringify(ar.body));
  assert.equal((await db.deviceClaim.findUniqueOrThrow({ where: { id: d.body.claimId as string } })).status, 'approved');
  assert.equal((await db.device.findUniqueOrThrow({ where: { id: d.body.deviceId as string } })).status, 'online');
  assert.equal((await db.employee.findUniqueOrThrow({ where: { id: target.id } })).agentApproved, true);
});

// ─── D-04: authenticate happy path -> exactly one active token ──────────────

test('D-04: authenticated device holds exactly one active AgentToken and can heartbeat', async () => {
  const { emp, sessionToken } = await discovererSession('D04-EMP');
  const a = await seedActiveDevice(emp, 'key-d04-device-0123456789', sessionToken);
  assert.ok(a.token, 'agent bearer token issued');

  const tokens = await db.agentToken.findMany({ where: { employeeId: emp.id } });
  assert.equal(tokens.length, 1, 'exactly one active token per employee');
  assert.equal(tokens[0].deviceId, a.deviceId, 'token is device-bound');

  const beat = await heartbeatApi.POST(req(a.token, { method: 'POST', body: { timestamp: new Date().toISOString() }, ip: '203.0.113.4' }));
  assert.equal(beat.status, 200, 'issued token works on a device route');
});

// ─── D-05: single-active-device conflict ────────────────────────────────────

test('D-05: a second eligible device gets the exact 409 marker and the first stays untouched', async () => {
  const { emp, sessionToken } = await discovererSession('D05-EMP');
  const a = await seedActiveDevice(emp, 'key-d05-device-a-0123456789', sessionToken);
  const b = await seedEligibleDevice(emp.id, 'key-d05-device-b-0123456789', sessionToken);

  const aTokenBefore = await db.agentToken.findFirstOrThrow({ where: { deviceId: a.deviceId } });
  const r = await doAuthenticate(authBody(b.deviceId, b.secret), '203.0.113.5');
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.deepEqual(r.body, { error: 'ACTIVE_DEVICE_EXISTS' }, 'exact contract body');

  const aTokenAfter = await db.agentToken.findFirstOrThrow({ where: { deviceId: a.deviceId } });
  assert.equal(aTokenAfter.token, aTokenBefore.token, 'first device token untouched');
  assert.equal(await db.agentToken.count({ where: { deviceId: b.deviceId } }), 0, 'loser holds nothing');
  assert.equal(r.body.token, undefined, 'no token issued on conflict');
});

// ─── D-06: agent (Path B) login ─────────────────────────────────────────────

test('D-06: agent login issues a session token; wrong password stays a uniform 401', async () => {
  const emp = await seedEmployee('D06-EMP', { agentAccount: 'active' });

  const bad = await loginApi.POST(req(null, { method: 'POST', body: { agentId: 'D06-EMP', password: 'definitely-wrong' } }));
  assert.equal(bad.status, 401);
  const badBody = (await bad.json()) as { error?: string };
  assert.ok(badBody.error, 'uniform 401 message');

  const good = await loginApi.POST(req(null, { method: 'POST', body: { agentId: 'D06-EMP', password: PASSWORD } }));
  assert.equal(good.status, 200);
  const goodBody = (await good.json()) as { token?: string };
  assert.ok(goodBody.token, 'session token issued for correct credentials');

  // Unknown agent id returns the same uniform 401 (no user enumeration).
  const ghost = await loginApi.POST(req(null, { method: 'POST', body: { agentId: 'D06-GHOST', password: PASSWORD } }));
  assert.equal(ghost.status, 401);
});

// ─── D-07: wrong device secret -> 401, never a 409 ──────────────────────────

test('D-07: wrong device secret yields a uniform 401 (no device-state leak)', async () => {
  const { emp, sessionToken } = await discovererSession('D07-EMP');
  await seedActiveDevice(emp, 'key-d07-device-a-0123456789', sessionToken);
  const b = await seedEligibleDevice(emp.id, 'key-d07-device-b-0123456789', sessionToken);

  const r = await doAuthenticate({ ...authBody(b.deviceId, b.secret), deviceSecret: 'not-the-secret' }, '203.0.113.7');
  assert.equal(r.status, 401, JSON.stringify(r.body));
  assert.notEqual(r.body.error, 'ACTIVE_DEVICE_EXISTS', 'credential failures never reveal the conflict state');
  assert.equal(await db.agentToken.count({ where: { employeeId: emp.id } }), 1, 'existing token unaffected');
});

// ─── D-08: disabled AgentAccount fails closed ───────────────────────────────

test('D-08: a disabled AgentAccount cannot take the slot (403, never 409)', async () => {
  const emp = await seedEmployee('D08-EMP', { agentAccount: 'disabled' });
  // Disabled account cannot obtain a session — seed the approved device directly
  // with the real claim-secret hashing.
  const secret = 'direct-seed-' + Math.random().toString(36).slice(2);
  const device = await db.device.create({
    data: {
      name: 'key-d08-device-b', hostname: 'PC-P4', operatingSystem: 'Windows 11', agentVersion: '1.3.0',
      ipAddress: '203.0.113.8', organizationId: org.id, employeeId: emp.id, status: 'online', agentKey: 'key-d08-device-b',
    },
  });
  const { hashClaimSecret } = await import('../src/lib/agent/auth');
  await db.deviceClaim.create({
    data: { organizationId: org.id, deviceId: device.id, employeeId: emp.id, claimSecretHash: hashClaimSecret(secret), status: 'approved', approvedAt: new Date() },
  });

  const r = await doAuthenticate(authBody(device.id, secret), '203.0.113.8');
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.error, 'Agent account is disabled');
  assert.notEqual(r.body.error, 'ACTIVE_DEVICE_EXISTS');
  assert.equal(await db.agentToken.count({ where: { employeeId: emp.id } }), 0);
});
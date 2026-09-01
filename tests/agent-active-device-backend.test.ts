/**
 * Phase 5/STEP 5 — Active-device conflict backend contract (409 ACTIVE_DEVICE_EXISTS).
 *
 * End-to-end server tests for the single-active-device activation authority
 * (src/lib/agent/activation.ts + POST /api/agent/authenticate):
 *
 *   B-01  another eligible device holds the slot → 409 + zero kick
 *   B-02  the 409 is zero-mutation (exhaustive before/after snapshot)
 *   B-03  concurrent authentication → exactly one winner, one 409
 *   B-04  same-device re-login replaces ONLY its own token
 *   B-05  an expired token never blocks another device
 *   B-06  an ineligible/revoked/deleted device never blocks
 *   B-07  invalid credentials stay a uniform 401 (never 409)
 *   B-08  a disabled AgentAccount stays blocked (403, never 409)
 *   B-09  inactive org/employee/device fail closed (never 409)
 *   B-10  cross-device isolation — B's failure cannot touch A's token
 *   HTTP  the exact 409 body contract + unrelated 409s carry no marker
 *   CR-01  STEP 8 guards: PATH A + PATH B authenticate with NO AgentAccount
 *          row (absent = allowed; only present-but-DISABLED fails closed)
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_agentconflict).
 * Run: npx tsx --test tests/agent-active-device-backend.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation (must be set BEFORE any app module import) ──────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_agentconflict';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-agentconflict-0123456789abcdef';
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

type DiscoverApi = typeof import('../src/app/api/agent/discover/route');
type AuthApi = typeof import('../src/app/api/agent/authenticate/route');
type ApproveApi = typeof import('../src/app/api/device-claims/[id]/approve/route');
type CancelApi = typeof import('../src/app/api/device-claims/[id]/cancel/route');
type HeartbeatApi = typeof import('../src/app/api/agent/heartbeat/route');

let discoverApi: DiscoverApi;
let authApi: AuthApi;
let approveApi: ApproveApi;
let cancelApi: CancelApi;
let heartbeatApi: HeartbeatApi;

let createAgentAccount: (typeof import('../src/lib/agent-account'))['createAgentAccount'];
let hashPassword: (password: string) => Promise<string>;
let generateClaimSecret: () => string;
let hashClaimSecret: (secret: string) => string;
const PASSWORD = 'Str0ng!Pass123x';
let org: { id: string };
let authLoginApi: typeof import('../src/app/api/agent/login/route');

before(async () => {
  db = (await import('../src/lib/db')).db;
  ({ signJWT } = await import('../src/lib/auth'));
  discoverApi = await import('../src/app/api/agent/discover/route');
  authApi = await import('../src/app/api/agent/authenticate/route');
  approveApi = await import('../src/app/api/device-claims/[id]/approve/route');
  cancelApi = await import('../src/app/api/device-claims/[id]/cancel/route');
  heartbeatApi = await import('../src/app/api/agent/heartbeat/route');
  authLoginApi = await import('../src/app/api/agent/login/route');
  ({ createAgentAccount } = await import('../src/lib/agent-account'));
  ({ hashPassword } = await import('../src/lib/auth'));
  ({ generateClaimSecret, hashClaimSecret } = await import('../src/lib/agent/auth'));

  org = await db.organization.create({ data: { name: 'Conflict Org', slug: 'conflict-org' } });
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

async function seedEmployee(orgId: string, code: string, opts: { status?: 'active' | 'inactive'; agentAccount?: 'active' } = {}) {
  const emp = await db.employee.create({
    data: {
      employeeId: code,
      firstName: code.split('-')[0],
      lastName: 'Test',
      email: `${code.toLowerCase()}@test.local`,
      organizationId: orgId,
      status: opts.status ?? 'active',
      agentApproved: true,
    },
  });
  if (opts.agentAccount === 'active') {
    await createAgentAccount({ employeeId: emp.id, agentId: code, password: PASSWORD, status: 'active' });
  }
  return emp;
}

/** Legacy PATH B employee: bcrypt agentPassword + active AgentAccount. */
async function seedPathBEmployee(orgId: string, code: string) {
  const emp = await seedEmployee(orgId, code);
  await db.employee.update({
    where: { id: emp.id },
    data: { agentPassword: await hashPassword(PASSWORD) },
  });
  await createAgentAccount({ employeeId: emp.id, agentId: code, password: PASSWORD, status: 'active' });
  return emp;
}

function discoverBody(deviceKey: string, hostname = 'PC-CONFLICT') {
  return { deviceKey, hostname, os: 'Windows 11', osVersion: '23H2', processor: 'x64', memory: '16GB', agentVersion: '1.3.0', arch: 'x64' };
}

/** Create an employee + AgentAccount and login to get a session token. */
async function setupAuthenticatedDiscoverer(employeeId: string) {
  const emp = await seedEmployee(employeeId, { agentAccount: 'active' });
  const loginRes = await authLoginApi.POST(req(null, {
    body: { agentId: employeeId, password: PASSWORD },
  }));
  const loginBody = await loginRes.json() as { token?: string };
  return { emp, sessionToken: loginBody.token ?? null };
}

/** POST /api/agent/discover (authenticated) → 201 pending + one-time secret. */
async function doDiscover(deviceKey: string, ip: string, sessionToken?: string) {
  const res = await discoverApi.POST(req(sessionToken ?? null, { method: 'POST', body: discoverBody(deviceKey), ip }));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** POST /api/agent/authenticate — the HTTP contract under test. */
async function doAuthenticate(body: Record<string, unknown>, ip: string) {
  const res = await authApi.POST(req(null, { method: 'POST', body, ip }));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function doApprove(admin: string, claimId: string, employeeId: string) {
  const res = await approveApi.POST(
    req(admin, { method: 'POST', body: { employeeId, projectIds: [] }, ip: '198.51.100.9' }),
    { params: Promise.resolve({ id: claimId }) }
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Full REAL pipeline for an active device: discover → approve → authenticate. */
async function seedActiveDevice(orgId: string, emp: { id: string }, deviceKey: string, ip: string, sessionToken?: string) {
  const d = await doDiscover(deviceKey, ip, sessionToken);
  assert.equal(d.status, 201, `discover: ${JSON.stringify(d.body)}`);
  const ar = await doApprove(await adminToken(orgId, 'u-conflict-admin'), d.body.claimId as string, emp.id);
  assert.equal(ar.status, 200, `approve: ${JSON.stringify(ar.body)}`);
  const auth = await doAuthenticate(
    { deviceId: d.body.deviceId, deviceSecret: d.body.secret, agentVersion: '1.3.0' },
    ip
  );
  assert.equal(auth.status, 200, `authenticate: ${JSON.stringify(auth.body)}`);
  return { deviceId: d.body.deviceId as string, token: auth.body.token as string, secret: d.body.secret as string };
}

/**
 * An eligible sibling device WITHOUT the admin-approve side effect
 * (approve deactivates the employee's other online devices). This seeds the
 * exact state the activation predicate is designed for: two eligible devices,
 * one holding the slot. Uses the real claim-secret hashing from the route.
 */
async function seedEligibleDevice(orgId: string, employeeId: string, deviceKey: string, ip: string, sessionToken?: string) {
  const d = await doDiscover(deviceKey, ip, sessionToken);
  assert.equal(d.status, 201, `discover: ${JSON.stringify(d.body)}`);
  const secret = d.body.secret as string;
  await db.device.update({
    where: { id: d.body.deviceId as string },
    data: { employeeId, status: 'online' },
  });
  await db.deviceClaim.update({
    where: { id: d.body.claimId as string },
    data: { status: 'approved' },
  });
  return { deviceId: d.body.deviceId as string, secret };
}

async function snapshotEmployeeTokens(employeeId: string) {
  return db.agentToken.findMany({
    where: { employeeId },
    orderBy: { id: 'asc' },
    select: { id: true, token: true, deviceId: true, expiresAt: true, ipAddress: true },
  });
}

function authBody(deviceId: string, secret: string, extra: Record<string, unknown> = {}) {
  return { deviceId, deviceSecret: secret, agentVersion: '1.3.0', ...extra };
}

// ─── B-01: another eligible device is active ─────────────────────────────────

test('B-01: second eligible device → 409 ACTIVE_DEVICE_EXISTS, first device untouched', async () => {
  const emp = await seedEmployee(org.id, 'B01-EMP', { agentAccount: 'active' });
  const loginRes = await authLoginApi.POST(req(null, { body: { agentId: 'B01-EMP', password: PASSWORD } }));
  const sessionToken = (await loginRes.json() as { token?: string }).token ?? undefined;
  const a = await seedActiveDevice(org.id, emp, 'key-b01-device-a-0123456789', '203.0.113.101', sessionToken);
  const b = await seedEligibleDevice(org.id, emp.id, 'key-b01-device-b-0123456789', '203.0.113.102', sessionToken);

  const aTokenBefore = await db.agentToken.findFirst({ where: { deviceId: a.deviceId } });
  const aDeviceBefore = await db.device.findUnique({ where: { id: a.deviceId } });
  assert.ok(aTokenBefore, 'device A must hold a valid token');

  const r = await doAuthenticate(authBody(b.deviceId, b.secret), '203.0.113.102');
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error, 'ACTIVE_DEVICE_EXISTS');
  assert.equal(r.body.token, undefined, 'no token may be issued');

  // Device A is NOT kicked: token row identical, device row identical.
  const aTokenAfter = await db.agentToken.findFirst({ where: { deviceId: a.deviceId } });
  assert.equal(aTokenAfter!.id, aTokenBefore!.id, 'A token must never be replaced');
  assert.equal(aTokenAfter!.token, aTokenBefore!.token, 'A token value must never change');
  assert.equal(aTokenAfter!.expiresAt.getTime(), aTokenBefore!.expiresAt.getTime());
  const aDeviceAfter = await db.device.findUnique({ where: { id: a.deviceId } });
  assert.equal(aDeviceAfter!.status, aDeviceBefore!.status, 'A device status unchanged');
  assert.equal(aDeviceAfter!.lastHeartbeat?.getTime(), aDeviceBefore!.lastHeartbeat?.getTime(), 'A lastHeartbeat unchanged');

  // Device B received nothing.
  const bTokens = await db.agentToken.findMany({ where: { deviceId: b.deviceId } });
  assert.equal(bTokens.length, 0, 'B must receive no AgentToken');
  const bDevice = await db.device.findUnique({ where: { id: b.deviceId } });
  assert.equal(bDevice!.status, 'online', 'B status unchanged');
});

// ─── B-02: 409 is zero-mutation ─────────────────────────────────────────────

test('B-02: the 409 transaction is zero-mutation (exhaustive snapshot)', async () => {
  const emp = await seedEmployee(org.id, 'B02-EMP', { agentAccount: 'active' });
  const loginRes = await authLoginApi.POST(req(null, { body: { agentId: 'B02-EMP', password: PASSWORD } }));
  const sessionToken = (await loginRes.json() as { token?: string }).token ?? undefined;
  const a = await seedActiveDevice(org.id, emp, 'key-b02-device-a-0123456789', '203.0.113.201', sessionToken);
  const b = await seedEligibleDevice(org.id, emp.id, 'key-b02-device-b-0123456789', '203.0.113.202', sessionToken);

  const before = {
    tokens: JSON.stringify(await snapshotEmployeeTokens(emp.id)),
    devices: JSON.stringify(
      await db.device.findMany({ where: { id: { in: [a.deviceId, b.deviceId] } }, orderBy: { id: 'asc' } })
    ),
    claims: JSON.stringify(
      await db.deviceClaim.findMany({ where: { deviceId: { in: [a.deviceId, b.deviceId] } }, orderBy: { id: 'asc' } })
    ),
    employee: JSON.stringify(await db.employee.findUnique({ where: { id: emp.id } })),
    auditCount: await db.auditLog.count({ where: { organizationId: org.id } }),
  };

  const r = await doAuthenticate(authBody(b.deviceId, b.secret), '203.0.113.203');
  assert.equal(r.status, 409);

  const after = {
    tokens: JSON.stringify(await snapshotEmployeeTokens(emp.id)),
    devices: JSON.stringify(
      await db.device.findMany({ where: { id: { in: [a.deviceId, b.deviceId] } }, orderBy: { id: 'asc' } })
    ),
    claims: JSON.stringify(
      await db.deviceClaim.findMany({ where: { deviceId: { in: [a.deviceId, b.deviceId] } }, orderBy: { id: 'asc' } })
    ),
    employee: JSON.stringify(await db.employee.findUnique({ where: { id: emp.id } })),
    auditCount: await db.auditLog.count({ where: { organizationId: org.id } }),
  };

  assert.equal(after.tokens, before.tokens, 'no AgentToken row may change on a 409');
  assert.equal(after.devices, before.devices, 'no Device row may change on a 409');
  assert.equal(after.claims, before.claims, 'no DeviceClaim row may change on a 409');
  assert.equal(after.employee, before.employee, 'no Employee row may change on a 409');
  assert.equal(after.auditCount, before.auditCount, 'no audit row may be written on a 409');
});

// ─── B-03: concurrent authentication ────────────────────────────────────────

test('B-03: concurrent auth from two eligible devices → exactly one winner, one 409', async () => {
  const emp = await seedEmployee(org.id, 'B03-EMP', { agentAccount: 'active' });
  const loginRes = await authLoginApi.POST(req(null, { body: { agentId: 'B03-EMP', password: PASSWORD } }));
  const sessionToken = (await loginRes.json() as { token?: string }).token ?? undefined;
  const a = await seedEligibleDevice(org.id, emp.id, 'key-b03-device-a-0123456789', '203.0.113.301', sessionToken);
  const b = await seedEligibleDevice(org.id, emp.id, 'key-b03-device-b-0123456789', '203.0.113.302', sessionToken);

  const [ra, rb] = await Promise.all([
    doAuthenticate(authBody(a.deviceId, a.secret), '203.0.113.301'),
    doAuthenticate(authBody(b.deviceId, b.secret), '203.0.113.302'),
  ]);

  const statuses = [ra.status, rb.status].sort();
  assert.deepEqual(statuses, [200, 409], `expected one winner + one conflict, got ${JSON.stringify([ra, rb])}`);
  const loser = ra.status === 409 ? ra : rb;
  assert.equal(loser.body.error, 'ACTIVE_DEVICE_EXISTS');

  // Exactly one valid active token — never two, never an orphan.
  const tokens = await snapshotEmployeeTokens(emp.id);
  assert.equal(tokens.length, 1, 'exactly one valid active AgentToken may exist');
  const winnerBody = ra.status === 200 ? ra.body : rb.body;
  assert.equal(tokens[0].token, winnerBody.token, 'the winner holds the only token');

  // The winner's device got the slot; the loser's device is untouched.
  const loserDevice = await db.device.findUnique({ where: { id: (loser.body.deviceId as string | undefined) ?? (ra.status === 409 ? a.deviceId : b.deviceId) } });
  assert.ok(loserDevice, 'loser device still exists');
  const loserTokens = await db.agentToken.count({ where: { deviceId: loserDevice!.id } });
  assert.equal(loserTokens, 0, 'the loser must hold no token');
});

// ─── B-04: same-device re-login ─────────────────────────────────────────────

test('B-04: same-device re-login replaces ONLY its own token', async () => {
  const emp = await seedEmployee(org.id, 'B04-EMP', { agentAccount: 'active' });
  const loginRes = await authLoginApi.POST(req(null, { body: { agentId: 'B04-EMP', password: PASSWORD } }));
  const sessionToken = (await loginRes.json() as { token?: string }).token ?? undefined;
  const a = await seedActiveDevice(org.id, emp, 'key-b04-device-a-0123456789', '203.0.113.401', sessionToken);
  const b = await seedEligibleDevice(org.id, emp.id, 'key-b04-device-b-0123456789', '203.0.113.402', sessionToken);

  const oldToken = await db.agentToken.findFirst({ where: { deviceId: a.deviceId } });
  assert.ok(oldToken);
  const oldBCount = await db.agentToken.count({ where: { deviceId: b.deviceId } });
  const bDeviceBefore = await db.device.findUnique({ where: { id: b.deviceId } });

  const r = await doAuthenticate(authBody(a.deviceId, a.secret), '203.0.113.401');
  assert.equal(r.status, 200, `same-device re-login must succeed: ${JSON.stringify(r.body)}`);
  assert.notEqual(r.body.token, oldToken!.token, 'a fresh token is issued');

  // Exactly one valid active token remains, and it is A's new one.
  const tokens = await snapshotEmployeeTokens(emp.id);
  assert.equal(tokens.length, 1, 'exactly one token after re-login');
  assert.notEqual(tokens[0].id, oldToken!.id, 'the device\'s OWN old token row is replaced (deleted + fresh)');
  assert.equal(await db.agentToken.count({ where: { id: oldToken!.id } }), 0, 'old token row deleted');
  assert.equal(tokens[0].token, r.body.token);

  // Device B is unaffected.
  assert.equal(await db.agentToken.count({ where: { deviceId: b.deviceId } }), oldBCount, 'B holds no token');
  const bDeviceAfter = await db.device.findUnique({ where: { id: b.deviceId } });
  assert.equal(bDeviceAfter!.status, bDeviceBefore!.status, 'B device row untouched');
  assert.equal(bDeviceAfter!.lastHeartbeat?.getTime(), bDeviceBefore!.lastHeartbeat?.getTime(), 'B lastHeartbeat untouched');
});

// ─── B-05: expired token never blocks ───────────────────────────────────────

test('B-05: an expired token does not block another eligible device', async () => {
  const emp = await seedEmployee(org.id, 'B05-EMP', { agentAccount: 'active' });
  const loginRes = await authLoginApi.POST(req(null, { body: { agentId: 'B05-EMP', password: PASSWORD } }));
  const sessionToken = (await loginRes.json() as { token?: string }).token ?? undefined;
  const a = await seedActiveDevice(org.id, emp, 'key-b05-device-a-0123456789', '203.0.113.501', sessionToken);
  await db.agentToken.updateMany({
    where: { deviceId: a.deviceId },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });
  const b = await seedEligibleDevice(org.id, emp.id, 'key-b05-device-b-0123456789', '203.0.113.502', sessionToken);

  const r = await doAuthenticate(authBody(b.deviceId, b.secret), '203.0.113.502');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.notEqual(r.body.error, 'ACTIVE_DEVICE_EXISTS', 'expired A must never produce a false conflict');
  const bToken = await db.agentToken.findFirst({ where: { deviceId: b.deviceId } });
  assert.ok(bToken, 'B acquired the slot');
});

// ─── B-06: ineligible/revoked/deleted device never blocks ───────────────────

test('B-06: a revoked device and a deleted device never trigger a false 409', async () => {
  // Revoked-device variant.
  const empR = await seedEmployee(org.id, 'B06R-EMP', { agentAccount: 'active' });
  const loginResR = await authLoginApi.POST(req(null, { body: { agentId: 'B06R-EMP', password: PASSWORD } }));
  const tokenR = (await loginResR.json() as { token?: string }).token ?? undefined;
  const aR = await seedActiveDevice(org.id, empR, 'key-b06r-device-a-0123456789', '203.0.113.601', tokenR);
  await db.device.update({ where: { id: aR.deviceId }, data: { status: 'revoked' } });
  const bR = await seedEligibleDevice(org.id, empR.id, 'key-b06r-device-b-0123456789', '203.0.113.602', tokenR);
  const rR = await doAuthenticate(authBody(bR.deviceId, bR.secret), '203.0.113.602');
  assert.equal(rR.status, 200, `revoked A must not block: ${JSON.stringify(rR.body)}`);
  assert.notEqual(rR.body.error, 'ACTIVE_DEVICE_EXISTS');

  // Deleted-device variant (orphaned token).
  const empD = await seedEmployee(org.id, 'B06D-EMP', { agentAccount: 'active' });
  const loginResD = await authLoginApi.POST(req(null, { body: { agentId: 'B06D-EMP', password: PASSWORD } }));
  const tokenD = (await loginResD.json() as { token?: string }).token ?? undefined;
  const aD = await seedActiveDevice(org.id, empD, 'key-b06d-device-a-0123456789', '203.0.113.603', tokenD);
  await db.device.delete({ where: { id: aD.deviceId } });
  const bD = await seedEligibleDevice(org.id, empD.id, 'key-b06d-device-b-0123456789', '203.0.113.604', tokenD);
  const rD = await doAuthenticate(authBody(bD.deviceId, bD.secret), '203.0.113.604');
  assert.equal(rD.status, 200, `orphaned A token must not block: ${JSON.stringify(rD.body)}`);
  assert.notEqual(rD.body.error, 'ACTIVE_DEVICE_EXISTS');
});

// ─── B-08: disabled AgentAccount stays blocked ──────────────────────────────

test('B-08: a disabled AgentAccount fails closed with 403, never 409', async () => {
  const emp = await seedEmployee(org.id, 'B08-EMP');
  await createAgentAccount({ employeeId: emp.id, agentId: 'B08-EMP', password: PASSWORD, status: 'disabled' });
  const loginRes = await authLoginApi.POST(req(null, { body: { agentId: 'B08-EMP', password: PASSWORD } }));
  const token = (await loginRes.json() as { token?: string }).token ?? undefined;
  const b = await seedEligibleDevice(org.id, emp.id, 'key-b08-device-b-0123456789', '203.0.113.801', token);
  const r = await doAuthenticate(authBody(b.deviceId, b.secret), '203.0.113.801');
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.error, 'Agent account is disabled');
  assert.notEqual(r.body.error, 'ACTIVE_DEVICE_EXISTS');
  assert.equal(await db.agentToken.count({ where: { employeeId: emp.id } }), 0);
});

// ─── B-09: inactive org/employee/device fail closed ─────────────────────────

test('B-09: inactive employee, suspended org and inactive device never produce a false 409', async () => {
  // Inactive employee.
  const empI = await seedEmployee(org.id, 'B09I-EMP', { status: 'inactive' });
  await createAgentAccount({ employeeId: empI.id, agentId: 'B09I-EMP', password: PASSWORD, status: 'active' });
  const loginResI = await authLoginApi.POST(req(null, { body: { agentId: 'B09I-EMP', password: PASSWORD } }));
  const tokenI = (await loginResI.json() as { token?: string }).token ?? undefined;
  const bI = await seedEligibleDevice(org.id, empI.id, 'key-b09i-device-b-0123456789', '203.0.113.901', tokenI);
  const rI = await doAuthenticate(authBody(bI.deviceId, bI.secret), '203.0.113.901');
  assert.equal(rI.status, 403, JSON.stringify(rI.body));
  assert.notEqual(rI.body.error, 'ACTIVE_DEVICE_EXISTS');

  // Suspended org (G1-style: suspend, verify, restore).
  const empO = await seedEmployee(org.id, 'B09O-EMP');
  await createAgentAccount({ employeeId: empO.id, agentId: 'B09O-EMP', password: PASSWORD, status: 'active' });
  const loginResO = await authLoginApi.POST(req(null, { body: { agentId: 'B09O-EMP', password: PASSWORD } }));
  const tokenO = (await loginResO.json() as { token?: string }).token ?? undefined;
  const bO = await seedEligibleDevice(org.id, empO.id, 'key-b09o-device-b-0123456789', '203.0.113.902', tokenO);
  await db.organization.update({ where: { id: org.id }, data: { status: 'suspended' } });
  try {
    const rO = await doAuthenticate(authBody(bO.deviceId, bO.secret), '203.0.113.902');
    assert.equal(rO.status, 403, JSON.stringify(rO.body));
    assert.notEqual(rO.body.error, 'ACTIVE_DEVICE_EXISTS');
  } finally {
    await db.organization.update({ where: { id: org.id }, data: { status: 'active' } });
  }

  // Inactive device.
  const empD = await seedEmployee(org.id, 'B09D-EMP');
  await createAgentAccount({ employeeId: empD.id, agentId: 'B09D-EMP', password: PASSWORD, status: 'active' });
  const loginResD = await authLoginApi.POST(req(null, { body: { agentId: 'B09D-EMP', password: PASSWORD } }));
  const tokenD = (await loginResD.json() as { token?: string }).token ?? undefined;
  const bD = await seedEligibleDevice(org.id, empD.id, 'key-b09d-device-b-0123456789', '203.0.113.903', tokenD);
  await db.device.update({ where: { id: bD.deviceId }, data: { status: 'inactive' } });
  const rD = await doAuthenticate(authBody(bD.deviceId, bD.secret), '203.0.113.903');
  assert.equal(rD.status, 403, JSON.stringify(rD.body));
  assert.notEqual(rD.body.error, 'ACTIVE_DEVICE_EXISTS');
  assert.equal(await db.agentToken.count({ where: { employeeId: empD.id } }), 0);
});

// ─── B-10: cross-device isolation ───────────────────────────────────────────

test('B-10: B cannot revoke, replace or mutate A token; A stays usable', async () => {
  const emp = await seedEmployee(org.id, 'B10-EMP', { agentAccount: 'active' });
  const loginRes = await authLoginApi.POST(req(null, { body: { agentId: 'B10-EMP', password: PASSWORD } }));
  const sessionToken = (await loginRes.json() as { token?: string }).token ?? undefined;
  const a = await seedActiveDevice(org.id, emp, 'key-b10-device-a-0123456789', '203.0.113.1001', sessionToken);
  const b = await seedEligibleDevice(org.id, emp.id, 'key-b10-device-b-0123456789', '203.0.113.1002', sessionToken);

  const aTokenBefore = await db.agentToken.findFirst({ where: { deviceId: a.deviceId } });
  const r = await doAuthenticate(authBody(b.deviceId, b.secret), '203.0.113.1002');
  assert.equal(r.status, 409);

  const aTokenAfter = await db.agentToken.findFirst({ where: { deviceId: a.deviceId } });
  assert.deepEqual(
    {
      id: aTokenAfter!.id,
      token: aTokenAfter!.token,
      deviceId: aTokenAfter!.deviceId,
      expiresAt: aTokenAfter!.expiresAt.getTime(),
      ipAddress: aTokenAfter!.ipAddress,
    },
    {
      id: aTokenBefore!.id,
      token: aTokenBefore!.token,
      deviceId: aTokenBefore!.deviceId,
      expiresAt: aTokenBefore!.expiresAt.getTime(),
      ipAddress: aTokenBefore!.ipAddress,
    },
    'B\'s failed attempt must not mutate A\'s token in any way'
  );

  // A's token still works on a real device route — proof it was never kicked.
  const beat = await heartbeatApi.POST(req(a.token, { method: 'POST', body: { timestamp: new Date().toISOString() }, ip: '203.0.113.1003' }));
  assert.equal(beat.status, 200, 'A must remain fully usable after B\'s 409');
});

// ─── CRITICAL-01 regression guards ──────────────────────────────────────────
// The STEP 5/6 active-device work added an AgentAccount eligibility pre-check
// that rejected employees WITHOUT an AgentAccount row (403 'Agent account is
// disabled'). Zero-touch PATH A onboarding never creates AgentAccount rows
// (device-claims/approve only sets employee.agentApproved), so legitimate
// devices could not authenticate. The correct boundary (matching validateAgentToken /
// validateAgentSession): an ABSENT account is fine; only a present-but-DISABLED
// account fails closed. These guards keep that boundary pinned: they use
// employees with NO AgentAccount row at all.

test('CRITICAL-01: PATH A device claim authenticates WITHOUT an AgentAccount row', async () => {
  const emp = await seedEmployee(org.id, 'CR01A-EMP'); // no AgentAccount created
  const loginRes = await authLoginApi.POST(req(null, { body: { agentId: 'CR01A-EMP', password: PASSWORD } }));
  const sessionToken = (await loginRes.json() as { token?: string }).token ?? undefined;
  const a = await seedActiveDevice(org.id, emp, 'key-cr01a-device-0123456789', '203.0.113.2010', sessionToken);
  assert.ok(a.token, 'PATH A must issue a token for an approved device with no AgentAccount');
  assert.equal(
    await db.agentAccount.count({ where: { employeeId: emp.id } }),
    0,
    'fixture sanity: the employee really has no AgentAccount row'
  );

  // The issued token is usable on a protected route (validateAgentToken must
  // accept an absent AgentAccount too — heartbeat proves it end to end).
  const beat = await heartbeatApi.POST(
    req(a.token, { method: 'POST', body: { timestamp: new Date().toISOString() }, ip: '203.0.113.2011' })
  );
  assert.equal(beat.status, 200, 'token must work on heartbeat without an AgentAccount');
});





// ─── TASK 3: the exact HTTP contract ────────────────────────────────────────

test('HTTP: 409 response is exactly { error: "ACTIVE_DEVICE_EXISTS" }', async () => {
  const emp = await seedEmployee(org.id, 'HTTP-EMP', { agentAccount: 'active' });
  const loginRes = await authLoginApi.POST(req(null, { body: { agentId: 'HTTP-EMP', password: PASSWORD } }));
  const sessionToken = (await loginRes.json() as { token?: string }).token ?? undefined;
  await seedActiveDevice(org.id, emp, 'key-http-device-a-0123456789', '203.0.113.1101', sessionToken);
  const b = await seedEligibleDevice(org.id, emp.id, 'key-http-device-b-0123456789', '203.0.113.1102', sessionToken);

  const res = await authApi.POST(req(null, {
    method: 'POST',
    body: authBody(b.deviceId, b.secret),
    ip: '203.0.113.1102',
  }));
  assert.equal(res.status, 409);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  assert.deepEqual(body, { error: 'ACTIVE_DEVICE_EXISTS' }, 'the body must be exactly the marker object');
});

test('HTTP: an unrelated 409 (claim cancel) carries no ACTIVE_DEVICE_EXISTS marker', async () => {
  const emp = await seedEmployee(org.id, 'HTTP2-EMP', { agentAccount: 'active' });
  const loginRes = await authLoginApi.POST(req(null, { body: { agentId: 'HTTP2-EMP', password: PASSWORD } }));
  const sessionToken = (await loginRes.json() as { token?: string }).token ?? undefined;
  const d = await doDiscover('key-http2-device-a-0123456789', '203.0.113.1103', sessionToken);
  assert.equal(d.status, 201);
  // Simulate the claim having resolved (approved) — cancel must 409.
  await db.deviceClaim.update({ where: { id: d.body.claimId as string }, data: { status: 'approved' } });

  const res = await cancelApi.POST(
    req(null, {
      method: 'POST',
      body: { deviceKey: 'key-http2-device-a-0123456789', secret: d.body.secret },
      ip: '203.0.113.1104',
    }),
    { params: Promise.resolve({ id: d.body.claimId as string }) }
  );
  assert.equal(res.status, 409, 'cancelling a resolved claim is a legitimate 409');
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  assert.notEqual(body.error, 'ACTIVE_DEVICE_EXISTS', 'only the authenticate route may carry the marker');
  assert.ok(typeof body.error === 'string' && !(body.error as string).includes('ACTIVE_DEVICE_EXISTS'));
});

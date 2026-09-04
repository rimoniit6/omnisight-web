/**
 * Phase 3 — Agent ↔ Web ATTACK tests (deployment-mode Phase 3 boundaries).
 *
 * Every test asserts actual endpoint behavior — no weakened assertions:
 *
 *   P3A-01  Cross-org enrollment: an Org A login session cannot discover or
 *           claim an Org B device (concealing 404, zero state change).
 *   P3A-02  Enrollment org spoof: organizationId/deploymentMode sent in the
 *           discover body are ignored — the device is created under the
 *           session's server-derived organization.
 *   P3A-03  Anonymous enrollment (no session, unknown device) is refused —
 *           an employee must authenticate first.
 *   P3A-04  Token expiry recovery: expired AgentToken → 401; device re-auth
 *           (PATH A) issues a fresh token and operations resume. The agent is
 *           never permanently offline, and no permanent JWT is involved.
 *   P3A-05  Command org-mismatch attack: a command row bound to this device
 *           id under ANOTHER organization is never delivered or claimed.
 *   P3A-06  Auth org spoof: organizationId/deploymentMode in the
 *           /api/agent/authenticate body cannot select a tenant — the token
 *           is bound to the claim's server-derived organization.
 *
 * Runs against a THROWAWAY PostgreSQL database.
 * Run: npx tsx --test tests/agent-phase3-attack.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_p3attack';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-p3-attack-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@p3-attack.test';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.STORAGE_DRIVER = 'local';

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

const PASSWORD = 'Phase3Attack!123';
const AGENT_ID = 'P3A-EMP';

let orgA: { id: string };
let orgB: { id: string }; // PRIVATE tenant — Org A must never reach into it
let empA: { id: string; employeeId: string };
let empB: { id: string };
let devA: { id: string };
let devB: { id: string };
const devBKey = 'p3a-device-orgb-0001';
let sessionToken: string;

before(async () => {
  db = (await import('../src/lib/db')).db;
  const { createAgentAccount } = await import('../src/lib/agent-account');
  const { generateClaimSecret, hashClaimSecret } = await import('../src/lib/agent/auth');

  orgA = await db.organization.create({ data: { name: 'Attack Tenant A', slug: 'p3a-orga' } });
  orgB = await db.organization.create({
    data: { name: 'Attack Tenant B', slug: 'p3a-orgb', deploymentMode: 'PRIVATE' },
  });

  empA = await db.employee.create({
    data: {
      employeeId: 'P3A-EMP-A',
      firstName: 'Tenant',
      lastName: 'A',
      email: 'a@p3a.test',
      organizationId: orgA.id,
      status: 'active',
      agentApproved: true,
    },
  });
  empB = await db.employee.create({
    data: {
      employeeId: 'P3A-EMP-B',
      firstName: 'Tenant',
      lastName: 'B',
      email: 'b@p3a.test',
      organizationId: orgB.id,
      status: 'active',
      agentApproved: true,
    },
  });

  devA = await db.device.create({
    data: {
      name: 'Tenant-A-Device',
      hostname: 'a-device',
      agentKey: 'p3a-device-orga-0001',
      organizationId: orgA.id,
      employeeId: empA.id,
      status: 'online',
      lastHeartbeat: new Date(),
    },
  });
  devB = await db.device.create({
    data: {
      name: 'Tenant-B-Device',
      hostname: 'b-device',
      agentKey: devBKey,
      organizationId: orgB.id,
      employeeId: empB.id,
      status: 'online',
      lastHeartbeat: new Date(),
    },
  });

  // Org B's device already owns an approved claim (its own enrollment).
  await db.deviceClaim.create({
    data: {
      organizationId: orgB.id,
      deviceId: devB.id,
      claimSecretHash: hashClaimSecret(generateClaimSecret()),
      status: 'approved',
      employeeId: empB.id,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });

  // Org A employee has an AgentAccount (created by the admin) → login works.
  await createAgentAccount({ employeeId: empA.id, agentId: AGENT_ID, password: PASSWORD, status: 'active' });
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
  } catch { /* best-effort */ }
});

function agentReq(token: string, opts: { method?: string; body?: unknown; url?: string } = {}): NextRequest {
  const headers: Record<string, string> = { 'authorization': `Bearer ${token}` };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(opts.url || 'http://localhost:3000/api/agent', {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function body(res: Response): Promise<any> {
  return res.json();
}

/** POST /api/agent/login → session token for the seeded Org A employee. */
async function loginAsA(): Promise<string> {
  const loginApi = await import('../src/app/api/agent/login/route');
  const res = await loginApi.POST(agentReq('', {
    method: 'POST',
    body: { agentId: AGENT_ID, password: PASSWORD },
  }));
  assert.equal(res.status, 200, 'login succeeds');
  const payload = await body(res);
  assert.equal(payload.employee.employeeId, empA.employeeId, 'server-derived employee identity');
  return payload.token;
}

/**
 * Create an APPROVED claim that is unambiguously the newest for the device
 * (older approved/pending claims are expired first so claim-history ordering
 * can never pick a stale secret).
 */
async function freshApprovedClaim(deviceId: string, empId: string, orgId: string, secret: string): Promise<void> {
  const { hashClaimSecret } = await import('../src/lib/agent/auth');
  await db.deviceClaim.updateMany({
    where: { deviceId, status: { in: ['approved', 'pending'] } },
    data: { status: 'expired' },
  });
  await db.deviceClaim.create({
    data: {
      organizationId: orgId,
      deviceId,
      claimSecretHash: hashClaimSecret(secret),
      status: 'approved',
      employeeId: empId,
      approvedAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
}

// ─── P3A-01: cross-org enrollment attack ─────────────────────────────────

test('P3A-01: Org A session cannot discover Org B device (concealing 404, zero state change)', async () => {
  sessionToken = await loginAsA();
  const discoverApi = await import('../src/app/api/agent/discover/route');

  const claimsBefore = await db.deviceClaim.count({ where: { deviceId: devB.id } });

  const res = await discoverApi.POST(agentReq(sessionToken, {
    method: 'POST',
    body: {
      deviceKey: devBKey,
      hostname: 'b-device',
      os: 'Windows',
      agentVersion: '1.1.0',
      // Spoof attempt: pretend to be Org B's tenant too.
      organizationId: orgB.id,
      deploymentMode: 'PRIVATE',
    },
  }));

  // Concealing 404 — indistinguishable from "device not found".
  assert.equal(res.status, 404, 'cross-org device discover is denied');
  assert.match((await body(res)).error ?? '', /not found/i);

  // Zero state change: device still owned by Org B, no new claim, no audit.
  const devAfter = await db.device.findUnique({ where: { id: devB.id } });
  assert.equal(devAfter!.organizationId, orgB.id, 'device remains Org B owned');
  assert.equal(devAfter!.employeeId, empB.id, 'device remains bound to Org B employee');
  const claimsAfter = await db.deviceClaim.count({ where: { deviceId: devB.id } });
  assert.equal(claimsAfter, claimsBefore, 'no new claim row created for Org B device');
});

// ─── P3A-02: enrollment org spoof is ignored ─────────────────────────────

test('P3A-02: discover ignores body organizationId/deploymentMode — device joins the SESSION org', async () => {
  const discoverApi = await import('../src/app/api/agent/discover/route');
  const res = await discoverApi.POST(agentReq(sessionToken, {
    method: 'POST',
    body: {
      deviceKey: 'p3a-new-device-orga-0001',
      hostname: 'new-a-device',
      os: 'Windows',
      agentVersion: '1.1.0',
      organizationId: orgB.id, // spoofed tenant
      deploymentMode: 'PRIVATE', // spoofed mode
    },
  }));
  assert.equal(res.status, 201, 'legitimate enrollment succeeds');
  const payload = await body(res);
  const dev = await db.device.findUnique({ where: { id: payload.deviceId } });
  assert.ok(dev, 'device created');
  assert.equal(dev!.organizationId, orgA.id, 'device was created under the SESSION organization (Org A)');
  assert.equal(dev!.employeeId, empA.id, 'device bound to the authenticated employee');
  const claim = await db.deviceClaim.findUnique({ where: { id: payload.claimId } });
  assert.equal(claim!.organizationId, orgA.id, 'claim under Org A, never Org B');
  // No device/claim may exist under the spoofed tenant from this request.
  const bClaimCount = await db.deviceClaim.count({ where: { organizationId: orgB.id, status: 'pending' } });
  assert.equal(bClaimCount, 0, 'no pending claim was created under spoofed Org B');
});

// ─── P3A-03: anonymous enrollment refused ────────────────────────────────

test('P3A-03: anonymous discover (no session, unknown device) is refused', async () => {
  const discoverApi = await import('../src/app/api/agent/discover/route');
  const res = await discoverApi.POST(agentReq('', {
    method: 'POST',
    body: { deviceKey: 'p3a-anonymous-device-0001', hostname: 'anon' },
  }));
  assert.equal(res.status, 422, 'anonymous enrollment requires employee sign-in');
  assert.match((await body(res)).code ?? '', /AUTHENTICATION_REQUIRED/);
});

// ─── P3A-04: token expiry recovery (safe refresh, never permanent offline) ─

test('P3A-04: expired token → 401; PATH A re-auth resumes operations', async () => {
  const authenticateApi = await import('../src/app/api/agent/authenticate/route');
  const heartbeatApi = await import('../src/app/api/agent/heartbeat/route');
  const { generateClaimSecret } = await import('../src/lib/agent/auth');

  // Tenant A device claim, approved — device-credential auth (PATH A).
  const secret = generateClaimSecret();
  await freshApprovedClaim(devA.id, empA.id, orgA.id, secret);

  // 1) Initial authenticate → 24h token.
  const first = await authenticateApi.POST(agentReq('', {
    method: 'POST',
    body: {
      deviceId: devA.id,
      deviceSecret: secret,
      os: 'Windows',
      osVersion: '11',
      agentVersion: '1.1.0',
      organizationId: orgB.id, // spoof — must be ignored
      deploymentMode: 'PRIVATE', // spoof — must be ignored
    },
  }));
  assert.equal(first.status, 200, 'device credential auth succeeds');
  const token1 = (await body(first)).token as string;
  assert.ok(token1 && token1.length >= 20, 'issued a real token (not a permanent JWT)');
  const stored1 = await db.agentToken.findUnique({ where: { token: token1 } });
  assert.equal(stored1!.organizationId, orgA.id, 'token bound to the CLAIM organization, never the spoofed body org');

  // Heartbeat works with the fresh token.
  assert.equal(
    (await heartbeatApi.POST(agentReq(token1, { method: 'POST', body: { timestamp: new Date().toISOString() } }))).status,
    200,
    'heartbeat with fresh token'
  );

  // 2) Expire the token (24h lifecycle reached).
  await db.agentToken.update({ where: { token: token1 }, data: { expiresAt: new Date(Date.now() - 60_000) } });

  const expired = await heartbeatApi.POST(agentReq(token1, { method: 'POST', body: { timestamp: new Date().toISOString() } }));
  assert.equal(expired.status, 401, 'expired token rejected');
  assert.match((await body(expired)).error ?? '', /expired/i);
  // The expired token is cleaned up server-side.
  assert.equal(await db.agentToken.count({ where: { token: token1 } }), 0, 'expired token deleted');

  // 3) Safe refresh: the SAME device credential re-authenticates (the agent's
  //    refresh path) and operations resume — not permanently offline.
  const again = await authenticateApi.POST(agentReq('', {
    method: 'POST',
    body: { deviceId: devA.id, deviceSecret: secret, os: 'Windows', agentVersion: '1.1.0' },
  }));
  assert.equal(again.status, 200, 're-authentication succeeds after expiry');
  const token2 = (await body(again)).token as string;
  assert.notEqual(token2, token1, 'a fresh token is issued');

  const resumed = await heartbeatApi.POST(agentReq(token2, { method: 'POST', body: { timestamp: new Date().toISOString() } }));
  assert.equal(resumed.status, 200, 'operations resume after re-auth');
  const beat = await body(resumed);
  assert.equal(beat.success, true);
});

// ─── P3A-05: command org-mismatch attack ─────────────────────────────────

test('P3A-05: command row bound to this device under ANOTHER org is never delivered', async () => {
  const commandsApi = await import('../src/app/api/agent/commands/route');
  const authenticateApi = await import('../src/app/api/agent/authenticate/route');
  const { generateClaimSecret } = await import('../src/lib/agent/auth');

  // Give Tenant A's device a live token bound to ITS org (same-device re-login
  // revokes any earlier token from P3A-04).
  const freshSecret = generateClaimSecret();
  await freshApprovedClaim(devA.id, empA.id, orgA.id, freshSecret);
  const authRes = await authenticateApi.POST(agentReq('', {
    method: 'POST',
    body: { deviceId: devA.id, deviceSecret: freshSecret, agentVersion: '1.1.0' },
  }));
  assert.equal(authRes.status, 200, 'device re-auth for commands test');
  const tokA = (await body(authRes)).token as string;

  // The attack row: Tenant A's device id, but Tenant B's organization.
  const evil = await db.agentCommand.create({
    data: {
      organizationId: orgB.id,
      employeeId: empB.id,
      deviceId: devA.id,
      commandType: 'webcam.start',
      payload: JSON.stringify({ reason: 'cross-org attempt' }),
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  const res = await commandsApi.GET(agentReq(tokA));
  assert.equal(res.status, 200);
  const payload = await body(res);
  assert.equal(payload.data.length, 0, 'cross-org command is never returned');

  // And it was never claimed/consumed — still PENDING, so an admin can see it.
  const row = await db.agentCommand.findUnique({ where: { id: evil.id } });
  assert.equal(row!.status, 'PENDING', 'attack command untouched');
});

// ─── P3A-06: auth org spoof cannot select a tenant ──────────────────────

test('P3A-06: /api/agent/authenticate ignores body org/mode — token binds to the claim org', async () => {
  const authenticateApi = await import('../src/app/api/agent/authenticate/route');
  const { generateClaimSecret } = await import('../src/lib/agent/auth');

  // Fresh approved claim for Tenant A's device with a known secret.
  const secret = generateClaimSecret();
  await freshApprovedClaim(devA.id, empA.id, orgA.id, secret);

  const res = await authenticateApi.POST(agentReq('', {
    method: 'POST',
    body: {
      deviceId: devA.id,
      deviceSecret: secret,
      organizationId: orgB.id, // attempt to authenticate into Tenant B
      deploymentMode: 'MANAGED', // attempt to claim a different mode
    },
  }));
  assert.equal(res.status, 200, 'auth succeeds for the real claim');
  const payload = await body(res);
  const token = await db.agentToken.findUnique({ where: { token: payload.token } });
  assert.ok(token, 'token persisted');
  assert.equal(token!.organizationId, orgA.id, 'token is bound to Tenant A — the client cannot choose a tenant');
  assert.equal(token!.employeeId, empA.id, 'token bound to the claim employee');
  assert.notEqual(token!.organizationId, orgB.id, 'no cross-tenant token');
});

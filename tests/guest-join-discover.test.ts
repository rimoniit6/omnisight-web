/**
 * GUEST-01..09 — Desktop Agent "Join as Guest" → POST /api/agent/discover.
 *
 * Regression suite for the anonymous guest-join contract. The Desktop Agent's
 * "Join as Guest" button re-runs the zero-touch anonymous discovery (no
 * AgentSession) with the org enrollment code that was provisioned into the
 * agent build (AGENT_ENROLLMENT_CODE at build time / WL_ENROLLMENT_CODE at
 * runtime). The server derives the organization SOLELY from that code for a
 * brand-new anonymous device — a missing or invalid code is a fail-closed 422
 * and ZERO rows are written (no "first org" fallback). The admin then approves
 * the pending claim in GUEST mode, which creates a synthesized guest identity
 * (no AgentAccount, no consent), and the device authenticates via PATH A.
 *
 * Coverage map:
 *   GUEST-01 valid Join as Guest (discover → approve guest → PATH A auth)
 *   GUEST-02 missing required field        (400)
 *   GUEST-03 malformed request             (400 — invalid JSON / wrong types)
 *   GUEST-04 expired guest / expired claim (approve → 422; fresh re-claim)
 *   GUEST-05 revoked guest                 (fail closed; token invalidated)
 *   GUEST-06 invalid guest token/secret    (401 / 403 pending)
 *   GUEST-07 cross-organization guest      (foreign admin → 404; org binding)
 *   GUEST-08 replay attempt                (reRegister with live token ignored)
 *   GUEST-09 normal agent discover flow    (Phase 3 authenticated session)
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_guest_join).
 * Run: npx tsx --test tests/guest-join-discover.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation (must be set BEFORE any app module import) ──────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_guest_join';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-guest-join-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

before(() => {
  if (process.env.GUEST_JOIN_TEST_MIGRATED_DB !== '1') {
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
type AuthApi = typeof import('../src/app/api/agent/authenticate/route');
type ApproveApi = typeof import('../src/app/api/device-claims/[id]/approve/route');
type GuestRevokeApi = typeof import('../src/app/api/guests/[id]/revoke/route');
type LoginApi = typeof import('../src/app/api/agent/login/route');

let discoverApi: DiscoverApi;
let authApi: AuthApi;
let approveApi: ApproveApi;
let guestRevokeApi: GuestRevokeApi;
let loginApi: LoginApi;
let validateAgentToken: (req: Request) => Promise<{
  valid: boolean;
  employee?: { id: string; employeeId: string; firstName: string; lastName: string; organizationId: string };
  deviceId?: string;
  error?: string;
}>;
let hashEnrollmentCode: (code: string) => string;
let createAgentAccount: (input: { employeeId: string; agentId: string; password: string }) => Promise<unknown>;

let orgA: { id: string };
let orgB: { id: string };
const ENROLL_CODE_A = 'test-enroll-code-gj-a-0123456789abcdef';
const ENROLL_CODE_B = 'test-enroll-code-gj-b-0123456789abcdef';
const AGENT_PASSWORD = 'Guest-Join-Test-Pass-123';

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  const agentAuthLib = await import('../src/lib/agent/auth');
  validateAgentToken = agentAuthLib.validateAgentToken;
  hashEnrollmentCode = agentAuthLib.hashEnrollmentCode;
  createAgentAccount = (await import('../src/lib/agent-account')).createAgentAccount;

  const [dApi, aApi, apApi, gvApi, lApi] = await Promise.all([
    import('../src/app/api/agent/discover/route'),
    import('../src/app/api/agent/authenticate/route'),
    import('../src/app/api/device-claims/[id]/approve/route'),
    import('../src/app/api/guests/[id]/revoke/route'),
    import('../src/app/api/agent/login/route'),
  ]);
  discoverApi = dApi;
  authApi = aApi;
  approveApi = apApi;
  guestRevokeApi = gvApi;
  loginApi = lApi;

  // Two orgs, each with its OWN enrollment code hash (never plaintext).
  orgA = await db.organization.create({ data: { name: 'Guest Join Org A', slug: 'guest-join-a' } });
  orgB = await db.organization.create({ data: { name: 'Guest Join Org B', slug: 'guest-join-b' } });
  await db.organizationSetting.createMany({
    data: [
      { organizationId: orgA.id, key: 'agent_enrollment_code', value: hashEnrollmentCode(ENROLL_CODE_A), category: 'agent' },
      { organizationId: orgB.id, key: 'agent_enrollment_code', value: hashEnrollmentCode(ENROLL_CODE_B), category: 'agent' },
    ],
  });
});

after(async () => {
  await db.$disconnect();
  if (process.env.GUEST_JOIN_TEST_MIGRATED_DB !== '1') {
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

function adminTokenFor(org: { id: string }, userId: string) {
  return signJWT({ userId, email: `admin@${org.id.slice(-6)}.local`, role: 'admin', organizationId: org.id });
}

/** The exact body the Desktop Agent sends on "Join as Guest" (discoverDevice). */
function joinAsGuestBody(deviceKey: string, hostname: string, opts: { enrollmentCode?: string; reRegister?: boolean } = {}) {
  return {
    deviceKey,
    hostname,
    os: 'Windows 11',
    osVersion: '23H2',
    processor: 'x64',
    memory: '16GB',
    agentVersion: '1.1.0',
    arch: 'x64',
    ...opts,
  };
}

async function discover(deviceKey: string, hostname: string, ip: string, opts: { enrollmentCode?: string; reRegister?: boolean } = {}) {
  const res = await discoverApi.POST(req(null, {
    method: 'POST',
    body: joinAsGuestBody(deviceKey, hostname, opts),
    ip,
  }));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Admin approves the claim in GUEST mode (the "Join as Guest" completion). */
async function approveGuest(adminToken: string, claimId: string) {
  const res = await approveApi.POST(
    req(adminToken, { method: 'POST', body: { mode: 'guest' }, ip: '198.51.100.40' }),
    { params: Promise.resolve({ id: claimId }) }
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** PATH A device-credential authentication. */
async function authenticateDevice(deviceId: string, deviceSecret: string, ip: string) {
  const res = await authApi.POST(req(null, {
    method: 'POST',
    body: { deviceId, deviceSecret, agentVersion: '1.1.0' },
    ip,
  }));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/**
 * Full guest-join setup used by several tests: anonymous discover with the
 * org code → admin approves as GUEST → PATH A authenticate.
 */
async function setupActiveGuest(label: string, ip: string, code = ENROLL_CODE_A, deviceKey = `key-gj-${label.toLowerCase()}-device-abcdef`) {
  const d = await discover(deviceKey, `GUEST-PC-${label}`, ip, { enrollmentCode: code, reRegister: true });
  assert.equal(d.status, 201, `discover: ${JSON.stringify(d.body)}`);
  const admin = await adminTokenFor(orgA, `u-${label.toLowerCase()}-admin`);
  const ap = await approveGuest(admin, d.body.claimId as string);
  assert.equal(ap.status, 200, `approve guest: ${JSON.stringify(ap.body)}`);
  const auth = await authenticateDevice(d.body.deviceId as string, d.body.secret as string, ip);
  assert.equal(auth.status, 200, `PATH A auth: ${JSON.stringify(auth.body)}`);
  return { admin, deviceKey, claim: d.body as Record<string, string>, token: auth.body.token as string };
}

// ─── GUEST-01: valid Join as Guest ──────────────────────────────────────────

test('GUEST-01: valid Join as Guest — anonymous discover + guest approval + PATH A auth', async () => {
  const d = await discover('key-gj-0001-join-device-abcdef', 'GUEST-PC-01', '203.0.113.1', {
    enrollmentCode: ENROLL_CODE_A,
    reRegister: true,
  });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  assert.equal(d.body.status, 'pending');
  assert.equal(typeof d.body.deviceId, 'string');
  assert.equal(typeof d.body.claimId, 'string');
  assert.ok((d.body.secret as string).length >= 40, 'one-time secret must be cryptographically long');
  assert.equal(d.body.employeeAssigned, undefined, 'anonymous discover carries no employee');

  const admin = await adminTokenFor(orgA, 'u-g1-admin');
  const ap = await approveGuest(admin, d.body.claimId as string);
  assert.equal(ap.status, 200, JSON.stringify(ap.body));

  // The synthesized guest identity is created — no employee credentials.
  const guest = await db.guest.findFirst({ where: { deviceId: d.body.deviceId as string }, include: { employee: true } });
  assert.ok(guest, 'Guest row must exist');
  assert.equal(guest.status, 'ACTIVE');
  assert.equal(guest.employee.type, 'guest');
  assert.match(guest.employee.employeeId, /^GUEST-[0-9A-F]{12}$/);
  assert.match(guest.employee.email, /@guests\.invalid$/);
  assert.equal(guest.employee.agentApproved, true, 'device credential path requires agentApproved');
  assert.equal(await db.agentAccount.count({ where: { employeeId: guest.employeeId } }), 0, 'guest NEVER gets an AgentAccount');
  assert.equal(await db.consent.count({ where: { employeeId: guest.employeeId } }), 0, 'approval NEVER grants consent');

  // PATH A authentication with the one-time secret → working device token.
  const auth = await authenticateDevice(d.body.deviceId as string, d.body.secret as string, '203.0.113.1');
  assert.equal(auth.status, 200, JSON.stringify(auth.body));
  assert.equal(auth.body.success, true);
  assert.equal(auth.body.employeeId, guest.employee.employeeId);

  const check = await validateAgentToken(new Request('http://localhost:3000/api/agent/heartbeat', {
    headers: { authorization: `Bearer ${auth.body.token}` },
  }));
  assert.equal(check.valid, true, 'guest device token must pass the real route gate');
  assert.equal(check.deviceId, d.body.deviceId);
  assert.equal(check.employee!.id, guest.employeeId);
});

// ─── GUEST-02: missing required field ───────────────────────────────────────

test('GUEST-02: missing required fields are rejected with 400', async () => {
  const ip = '203.0.113.2';

  const noKey = await discoverApi.POST(req(null, { method: 'POST', body: { hostname: 'PC' }, ip }));
  assert.equal(noKey.status, 400);

  const shortKey = await discoverApi.POST(req(null, { method: 'POST', body: { deviceKey: 'short', hostname: 'PC' }, ip }));
  assert.equal(shortKey.status, 400);

  const emptyHost = await discoverApi.POST(req(null, { method: 'POST', body: { deviceKey: 'key-gj-0002-missing-fields-abcdef', hostname: '' }, ip }));
  assert.equal(emptyHost.status, 400);

  // Nothing may be written for a rejected request.
  assert.equal(await db.device.count({ where: { hostname: 'PC' } }), 0);
});

// ─── GUEST-03: malformed request ────────────────────────────────────────────

test('GUEST-03: malformed requests are 400 — invalid JSON and wrong field types', async () => {
  const ip = '203.0.113.3';

  // Non-JSON body must be a client error (400), never a 500.
  const badJson = await discoverApi.POST(new NextRequest('http://localhost:3000/api/agent/discover', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: '{not-valid-json',
  }));
  assert.equal(badJson.status, 400, 'malformed JSON body must be 400');
  const parsed = (await badJson.json().catch(() => ({}))) as { error?: string };
  assert.match(String(parsed.error ?? ''), /json/i);

  // Wrong field types.
  const numKey = await discoverApi.POST(req(null, { method: 'POST', body: { deviceKey: 12345, hostname: 'PC' }, ip }));
  assert.equal(numKey.status, 400);

  const numHost = await discoverApi.POST(req(null, { method: 'POST', body: { deviceKey: 'key-gj-0003-wrong-types-abcdef', hostname: 42 }, ip }));
  assert.equal(numHost.status, 400);
});

// ─── GUEST-04: expired guest / expired claim ────────────────────────────────

test('GUEST-04: an expired claim can never be approved (422) and the device re-registers fresh', async () => {
  const d = await discover('key-gj-0004-expired-device-abcdef', 'GUEST-PC-04', '203.0.113.4', {
    enrollmentCode: ENROLL_CODE_A,
    reRegister: true,
  });
  assert.equal(d.status, 201);

  // Force the claim past its 30-day redemption window.
  await db.deviceClaim.update({
    where: { id: d.body.claimId as string },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });

  const admin = await adminTokenFor(orgA, 'u-g4-admin');
  const ap = await approveGuest(admin, d.body.claimId as string);
  assert.equal(ap.status, 422, 'expired claim must not be approvable');
  assert.match(String(ap.body.error ?? ''), /expired/i);
  assert.equal(await db.guest.count({ where: { deviceId: d.body.deviceId as string } }), 0, 'no guest may be created from an expired claim');

  // Re-discover: the expired pending claim is closed and a FRESH claim (new
  // secret) is issued — the secure recovery path for the guest device.
  const again = await discover('key-gj-0004-expired-device-abcdef', 'GUEST-PC-04', '203.0.113.4', { enrollmentCode: ENROLL_CODE_A });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.notEqual(again.body.claimId, d.body.claimId, 'a fresh claim supersedes the expired one');
  assert.ok((again.body.secret as string).length >= 40, 'a fresh one-time secret is issued');
  assert.equal((await db.deviceClaim.findUnique({ where: { id: d.body.claimId as string } }))!.status, 'expired');
});

// ─── GUEST-05: revoked guest ────────────────────────────────────────────────

test('GUEST-05: a revoked guest fails closed — re-auth 403 revoked, token invalidated', async () => {
  const { claim, token } = await setupActiveGuest('G5', '203.0.113.5');
  const guest = await db.guest.findFirst({ where: { deviceId: claim.deviceId as string } });
  assert.ok(guest);

  const admin = await adminTokenFor(orgA, 'u-g5-admin');
  const revoke = await guestRevokeApi.POST(
    req(admin, { method: 'POST', body: { reason: 'E2E revoke' }, ip: '198.51.100.5' }),
    { params: Promise.resolve({ id: guest.id }) }
  );
  assert.equal(revoke.status, 200, JSON.stringify(await revoke.json().catch(() => ({}))));

  assert.equal((await db.guest.findUnique({ where: { id: guest.id } }))!.status, 'REVOKED');

  // Re-authentication with the still-valid claim secret must fail closed: the
  // guest revoke deactivates the device (claim stays approved, device goes
  // inactive), so PATH A rejects at the device-eligibility gate — 403, no
  // token, and the device stays inactive.
  const reAuth = await authenticateDevice(claim.deviceId as string, claim.secret as string, '203.0.113.5');
  assert.equal(reAuth.status, 403);
  assert.equal(reAuth.body.token, undefined);
  assert.equal((await db.device.findUnique({ where: { id: claim.deviceId as string } }))!.status, 'inactive');

  // The previously-issued token is invalidated immediately.
  const check = await validateAgentToken(new Request('http://localhost:3000/api/agent/activity', {
    headers: { authorization: `Bearer ${token}` },
  }));
  assert.equal(check.valid, false, 'revoked guest token must fail closed');
});

// ─── GUEST-06: invalid guest token / secret ─────────────────────────────────

test('GUEST-06: a wrong claim secret is 401; a pending (unapproved) claim is 403', async () => {
  // Wrong secret against an approved guest device → 401.
  const { claim } = await setupActiveGuest('G6a', '203.0.113.6');
  const wrongSecret = await authenticateDevice(claim.deviceId as string, 'wrong-secret-value', '203.0.113.6');
  assert.equal(wrongSecret.status, 401);

  // A pending claim (never approved) cannot authenticate → 403 pending.
  const d = await discover('key-gj-0006-pending-device-abcdef', 'GUEST-PC-06', '203.0.113.6', {
    enrollmentCode: ENROLL_CODE_A,
    reRegister: true,
  });
  assert.equal(d.status, 201);
  const pendingAuth = await authenticateDevice(d.body.deviceId as string, d.body.secret as string, '203.0.113.6');
  assert.equal(pendingAuth.status, 403);
  assert.equal(pendingAuth.body.status, 'pending');
  assert.equal(pendingAuth.body.token, undefined);
});

// ─── GUEST-07: cross-organization guest ─────────────────────────────────────

test('GUEST-07: cross-org isolation — foreign admins are concealed (404); orgs bind via their own code', async () => {
  // Device discovered with org A's code.
  const d = await discover('key-gj-0007-crossorg-device-abcdef', 'GUEST-PC-07', '203.0.113.7', {
    enrollmentCode: ENROLL_CODE_A,
    reRegister: true,
  });
  assert.equal(d.status, 201);

  // Org B's admin cannot see or approve org A's claim → uniform 404.
  const foreignAdmin = await adminTokenFor(orgB, 'u-g7-foreign');
  const foreign = await approveGuest(foreignAdmin, d.body.claimId as string);
  assert.equal(foreign.status, 404, 'cross-org approve must be concealed');

  // A device presenting org B's code binds to org B — org A's admin cannot
  // approve it either.
  const dB = await discover('key-gj-0007b-orgb-device-abcdef', 'GUEST-PC-07B', '203.0.113.7', {
    enrollmentCode: ENROLL_CODE_B,
    reRegister: true,
  });
  assert.equal(dB.status, 201);
  const deviceB = await db.device.findUnique({ where: { id: dB.body.deviceId as string } });
  assert.equal(deviceB!.organizationId, orgB.id, 'device must bind to the code-owner org');

  const adminA = await adminTokenFor(orgA, 'u-g7-admin-a');
  const crossApprove = await approveGuest(adminA, dB.body.claimId as string);
  assert.equal(crossApprove.status, 404, 'org A admin must not approve org B device');
});

// ─── GUEST-08: replay attempt ───────────────────────────────────────────────

test('GUEST-08: reRegister replay on a live guest device is ignored (DoS guard)', async () => {
  const replayKey = 'key-gj-0008-replay-device-abcdef';
  const { claim, token } = await setupActiveGuest('G8', '203.0.113.8', ENROLL_CODE_A, replayKey);

  // An attacker replaying reRegister (agentKey is client-supplied, not a
  // secret) must not kill the working guest device or force re-approval. The
  // replay uses the SAME device identity as the live device.
  const replay = await discover(replayKey, 'GUEST-PC-08', '203.0.113.8', {
    enrollmentCode: ENROLL_CODE_A,
    reRegister: true,
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.status, 'approved', 'live guest device stays approved');
  assert.equal(replay.body.claimId, claim.claimId, 'no fresh claim is issued');
  assert.equal(replay.body.secret, undefined, 'no new one-time secret is minted');
  assert.equal(
    await db.deviceClaim.count({ where: { deviceId: claim.deviceId as string, status: 'pending' } }),
    0,
    'no pending claim appears for re-approval'
  );

  // The live token is unaffected by the replay itself (the replay is a no-op
  // for an approved device with a valid token).
  const check = await validateAgentToken(new Request('http://localhost:3000/api/agent/heartbeat', {
    headers: { authorization: `Bearer ${token}` },
  }));
  assert.equal(check.valid, true, 'live token must remain valid after the replay');

  // The device's existing secret still authenticates — nothing was broken.
  // (PATH A mints a fresh token under the one-token-per-employee policy, so
  // the setup token above is superseded after this call — checked before.)
  const still = await authenticateDevice(claim.deviceId as string, claim.secret as string, '203.0.113.8');
  assert.equal(still.status, 200, 'original guest secret still works after the replay');
});

// ─── GUEST-09: normal agent discover flow (Phase 3) ─────────────────────────

test('GUEST-09: normal agent discover (authenticated AgentSession) is unaffected by guest hardening', async () => {
  const emp = await db.employee.create({
    data: {
      employeeId: 'GJ9-EMP',
      firstName: 'GJ9',
      lastName: 'Emp',
      email: 'gj9@test.local',
      organizationId: orgA.id,
      status: 'active',
      agentApproved: false,
    },
  });
  await createAgentAccount({ employeeId: emp.id, agentId: 'GJ9-EMP', password: AGENT_PASSWORD });

  const login = await loginApi.POST(req(null, { method: 'POST', body: { agentId: 'GJ9-EMP', password: AGENT_PASSWORD }, ip: '203.0.113.9' }));
  const loginBody = (await login.json().catch(() => ({}))) as Record<string, unknown>;
  assert.equal(login.status, 200, JSON.stringify(loginBody));

  // Authenticated discover binds employee + org from the session — no
  // enrollment code needed.
  const res = await discoverApi.POST(req(loginBody.token as string, {
    method: 'POST',
    body: joinAsGuestBody('key-gj-0009-login-device-abcdef', 'EMP-PC-09'),
    ip: '203.0.113.9',
  }));
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.status, 'pending');

  const device = await db.device.findUnique({ where: { id: body.deviceId as string } });
  assert.equal(device!.organizationId, orgA.id);
  assert.equal(device!.employeeId, emp.id, 'authenticated discover binds the employee immediately');

  // Normal employee-mode approval + PATH A auth still works.
  const admin = await adminTokenFor(orgA, 'u-g9-admin');
  const ap = await approveApi.POST(
    req(admin, { method: 'POST', body: { employeeId: emp.id, projectIds: [] }, ip: '198.51.100.9' }),
    { params: Promise.resolve({ id: body.claimId as string }) }
  );
  assert.equal(ap.status, 200, JSON.stringify(await ap.json().catch(() => ({}))));

  const auth = await authenticateDevice(body.deviceId as string, body.secret as string, '203.0.113.9');
  assert.equal(auth.status, 200, JSON.stringify(auth.body));
  const check = await validateAgentToken(new Request('http://localhost:3000/api/agent/heartbeat', {
    headers: { authorization: `Bearer ${auth.body.token}` },
  }));
  assert.equal(check.valid, true, 'normal employee device token must work');
});

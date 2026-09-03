/**
 * workload/62 — Employee "Cancel registration" + fresh re-request lifecycle.
 *
 * Covers the fix for the "Registering but no PENDING in admin" defect:
 *   - DeviceClaim.deviceId unique (1:1) was the root cause — re-registration
 *     (expired/rejected/cancelled → fresh claim) hit P2002 → 500 and the
 *     device could never appear again. History is now 1:N.
 *   - A device can cancel its OWN pending registration (claim-secret
 *     authenticated) → CANCELLED (auditable) → automatic re-discovery creates
 *     a NEW pending claim with a NEW id + one-time secret.
 *   - Cancellation is idempotent; approved/rejected/revoked cannot be
 *     cancelled; no cross-device cancellation; polling never silently undoes
 *     an admin rejection.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_claimcancel).
 * Run: npx tsx --test tests/claim-cancel.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { req } from './helpers/request';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_claimcancel';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-claimcancel-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

before(() => {
  if (process.env.CLAIM_CANCEL_TEST_MIGRATED_DB !== '1') {
    execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
    execSync('npx prisma migrate deploy', {
      env: { ...process.env, DATABASE_URL: TEST_DB_URL },
      stdio: 'pipe',
    });
  }
});

type DbModule = typeof import('../src/lib/db');
let db: DbModule['db'];
let signJWT: (payload: { userId: string; email: string; role: string; organizationId?: string }) => Promise<string>;

type DiscoverApi = typeof import('../src/app/api/agent/discover/route');
type ClaimsApi = typeof import('../src/app/api/device-claims/route');
type ClaimApproveApi = typeof import('../src/app/api/device-claims/[id]/approve/route');
type ClaimRejectApi = typeof import('../src/app/api/device-claims/[id]/reject/route');
type ClaimCancelApi = typeof import('../src/app/api/device-claims/[id]/cancel/route');

let discoverApi: DiscoverApi;
let claimsApi: ClaimsApi;
let claimApproveApi: ClaimApproveApi;
let claimRejectApi: ClaimRejectApi;
let claimCancelApi: ClaimCancelApi;

let org: { id: string };
let authLoginApi: typeof import('../src/app/api/agent/login/route');
let hashPassword: (password: string) => Promise<string>;
let createAgentAccount: (typeof import('../src/lib/agent-account'))['createAgentAccount'];
const PASSWORD = 'TestPass-123!';

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  hashPassword = (await import('../src/lib/auth')).hashPassword;
  createAgentAccount = (await import('../src/lib/agent-account')).createAgentAccount;

  const [dApi, cApi, caApi, crApi, ccApi, loginApi] = await Promise.all([
    import('../src/app/api/agent/discover/route'),
    import('../src/app/api/device-claims/route'),
    import('../src/app/api/device-claims/[id]/approve/route'),
    import('../src/app/api/device-claims/[id]/reject/route'),
    import('../src/app/api/device-claims/[id]/cancel/route'),
    import('../src/app/api/agent/login/route'),
  ]);
  discoverApi = dApi;
  claimsApi = cApi;
  claimApproveApi = caApi;
  claimRejectApi = crApi;
  claimCancelApi = ccApi;
  authLoginApi = loginApi;

  org = await db.organization.create({ data: { name: 'Cancel Org', slug: 'cancel-org' } });
});

after(async () => {
  await db.$disconnect();
  if (process.env.CLAIM_CANCEL_TEST_MIGRATED_DB !== '1') {
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


function tokenFor(role: string, userId: string) {
  return signJWT({ userId, email: `${role}@${org.id.slice(-6)}.local`, role, organizationId: org.id });
}

async function seedEmployee(code: string) {
  // setupAuth() already creates the employee for the same code — find-or-create
  // so tests that call both do not trip the employeeId unique constraint.
  const existing = await db.employee.findUnique({ where: { employeeId: code } });
  if (existing) return existing;
  return db.employee.create({
    data: {
      employeeId: code,
      firstName: code.split('-')[0],
      lastName: 'Test',
      email: `${code.toLowerCase()}@test.local`,
      organizationId: org.id,
      status: 'active',
      agentApproved: false,
    },
  });
}

function discoverBody(deviceKey: string, hostname = 'PC-CANCEL') {
  return { deviceKey, hostname, os: 'Windows 11', agentVersion: '1.2.0', reRegister: true };
}

/** Setup an employee with AgentAccount and login to get a session token. */
async function setupAuth(employeeId: string) {
  const emp = await db.employee.create({
    data: { employeeId, firstName: 'Cancel', lastName: 'Test', email: `${employeeId.toLowerCase()}@test.local`, organizationId: org.id, status: 'active', agentApproved: false },
  });
  const pwHash = await hashPassword(PASSWORD);
  await createAgentAccount({ employeeId: emp.id, agentId: employeeId, password: PASSWORD, status: 'active' });
  const loginRes = await authLoginApi.POST(req(null, { body: { agentId: employeeId, password: PASSWORD } }));
  const sessionToken = (await loginRes.json() as { token?: string }).token ?? null;
  return { emp, sessionToken };
}

/** Fresh discovery → pending claim + one-time secret. */
async function discover(deviceKey: string, ip: string, sessionToken?: string | null, reRegister = true) {
  const res = await discoverApi.POST(
    req(sessionToken ?? null, { method: 'POST', body: { ...discoverBody(deviceKey), reRegister }, ip })
  );
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

async function cancel(claimId: string, deviceKey: string, secret: string, ip = '203.0.113.50') {
  const res = await claimCancelApi.POST(
    req(null, { method: 'POST', body: { deviceKey, secret }, ip }),
    { params: Promise.resolve({ id: claimId }) }
  );
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

async function approve(adminToken: string, claimId: string, employeeId: string) {
  const res = await claimApproveApi.POST(
    req(adminToken, { method: 'POST', body: { employeeId, projectIds: [] }, ip: '198.51.100.9' }),
    { params: Promise.resolve({ id: claimId }) }
  );
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

// ─── C-1: discovery → pending (the core path that must always work) ────────

test('CC-1: fresh discover creates a PENDING claim with the right identity', async () => {
  const { sessionToken } = await setupAuth('CC1-EMP');
  const { status, body } = await discover('key-cc-0001-device-identity-abcdef', '203.0.113.1', sessionToken);
  assert.equal(status, 201);
  assert.equal(body.status, 'pending');
  assert.ok(body.claimId);
  assert.ok(body.deviceId);
  assert.ok((body.secret as string).length >= 40);

  const claim = await db.deviceClaim.findUnique({ where: { id: body.claimId as string } });
  assert.ok(claim);
  assert.equal(claim.status, 'pending');
  assert.equal(claim.organizationId, org.id);
  assert.equal(claim.deviceId, body.deviceId);
  assert.match(claim.claimSecretHash, /^[0-9a-f]{64}$/, 'secret stored hashed, never plaintext');

  // Admin list API returns it (this is the row the Zero-Touch Devices tab shows).
  const admin = await tokenFor('admin', 'u-cc1-admin');
  const res = await claimsApi.GET(req(admin, { url: 'http://localhost:3000/api/device-claims?status=pending&pageSize=50' }));
  const parsed = await res.json();
  const found = parsed.data.find((c: { id: string }) => c.id === body.claimId);
  assert.ok(found, 'pending claim must be visible in the admin claims list');
  assert.equal(found.status, 'pending');
});

// ─── C-2: employee cancel semantics ─────────────────────────────────────────

test('CC-2: device cancels its OWN pending claim → CANCELLED with audit fields', async () => {
  const { sessionToken } = await setupAuth('CC2-EMP');
  const key = 'key-cc-0002-self-cancel-abcdef';
  const { body } = await discover(key, '203.0.113.2', sessionToken);
  assert.equal(body.status, 'pending');

  const before = await db.auditLog.count({ where: { organizationId: org.id, resource: 'device' } });
  const res = await cancel(body.claimId as string, key, body.secret as string);
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const claim = await db.deviceClaim.findUnique({ where: { id: body.claimId as string } });
  assert.equal(claim!.status, 'cancelled');
  assert.ok(claim!.cancelledAt, 'cancelledAt recorded');
  assert.equal(claim!.cancellationReason, 'employee_agent');
  assert.equal(claim!.cancelledByDeviceId, body.deviceId);
  assert.equal((await db.device.findUnique({ where: { id: body.deviceId as string } }))!.status, 'inactive');

  const after = await db.auditLog.count({ where: { organizationId: org.id, resource: 'device' } });
  assert.ok(after > before, 'cancellation writes an audit log entry');
});

test('CC-3: cancellation is idempotent — a second cancel returns success without re-mutating', async () => {
  const { sessionToken } = await setupAuth('CC3-EMP');
  const key = 'key-cc-0003-idempotent-abcdef';
  const { body } = await discover(key, '203.0.113.3', sessionToken);
  const first = await cancel(body.claimId as string, key, body.secret as string);
  assert.equal(first.status, 200);
  const second = await cancel(body.claimId as string, key, body.secret as string);
  assert.equal(second.status, 200, 'idempotent success for already-cancelled');
  assert.equal((second.body.data as { status?: string } | undefined)?.status, 'cancelled');
  const claim = await db.deviceClaim.findUnique({ where: { id: body.claimId as string } });
  assert.equal(claim!.status, 'cancelled');
  assert.equal(claim!.cancellationReason, 'employee_agent', 'reason not overwritten by second call');
});

test('CC-4: wrong secret cannot cancel (401) — another device cannot cancel (404)', async () => {
  const { sessionToken } = await setupAuth('CC4-EMP');
  const keyA = 'key-cc-0004a-wrong-secret-abcdef';
  const keyB = 'key-cc-0004b-other-device-abcdef';
  const { body } = await discover(keyA, '203.0.113.4', sessionToken);
  await discover(keyB, '203.0.113.4', sessionToken);

  const wrongSecret = await cancel(body.claimId as string, keyA, 'wrong-secret-value');
  assert.equal(wrongSecret.status, 401, 'wrong claim secret must be rejected');

  const otherDevice = await cancel(body.claimId as string, keyB, 'x'.repeat(43));
  assert.equal(otherDevice.status, 404, 'a different deviceKey cannot cancel someone else claim');

  const claim = await db.deviceClaim.findUnique({ where: { id: body.claimId as string } });
  assert.equal(claim!.status, 'pending', 'claim unchanged by failed attempts');
});

test('CC-5: APPROVED claim cannot be cancelled (409) — employee cannot cancel an active device', async () => {
  const { sessionToken } = await setupAuth('CC5-EMP');
  const key = 'key-cc-0005-approved-cancel-abcdef';
  const emp = await seedEmployee('CC5-EMP');
  const { body } = await discover(key, '203.0.113.5', sessionToken);
  const admin = await tokenFor('admin', 'u-cc5-admin');
  const ar = await approve(admin, body.claimId as string, emp.id);
  assert.equal(ar.status, 200);

  const res = await cancel(body.claimId as string, key, body.secret as string);
  assert.equal(res.status, 409, 'approved claims must not be cancellable');

  const claim = await db.deviceClaim.findUnique({ where: { id: body.claimId as string } });
  assert.equal(claim!.status, 'approved', 'approval untouched');
  assert.equal((await db.device.findUnique({ where: { id: body.deviceId as string } }))!.status, 'online');
});

test('CC-6: cancelled claim cannot be approved or rejected (guarded transitions)', async () => {
  const { sessionToken } = await setupAuth('CC6-EMP');
  const key = 'key-cc-0006-cancelled-approve-abcdef';
  const emp = await seedEmployee('CC6-EMP');
  const { body } = await discover(key, '203.0.113.6', sessionToken);
  await cancel(body.claimId as string, key, body.secret as string);

  const admin = await tokenFor('admin', 'u-cc6-admin');
  const ar = await approve(admin, body.claimId as string, emp.id);
  assert.equal(ar.status, 400, 'approving a cancelled claim must fail');
  assert.match(String(ar.body.error ?? ''), /already "cancelled"/);

  const rr = await claimRejectApi.POST(
    req(admin, { method: 'POST', body: {}, ip: '198.51.100.6' }),
    { params: Promise.resolve({ id: body.claimId as string }) }
  );
  assert.equal(rr.status, 400, 'rejecting a cancelled claim must fail');
});

// ─── C-3: fresh re-request after cancel (the automatic re-discovery flow) ───

test('CC-7: after cancel, a fresh discover creates a NEW pending claim (new id + new secret)', async () => {
  const { sessionToken } = await setupAuth('CC7-EMP');
  const key = 'key-cc-0007-fresh-request-abcdef';
  const first = await discover(key, '203.0.113.7', sessionToken);
  assert.equal(first.status, 201);
  await cancel(first.body.claimId as string, key, first.body.secret as string);

  // Agent auto re-discovers (reRegister intent) — same device, NEW claim.
  const second = await discover(key, '203.0.113.7', sessionToken);
  assert.equal(second.status, 201, 'fresh claim must be issued after cancel');
  assert.notEqual(second.body.claimId, first.body.claimId, 'new claim id — never reused');
  assert.equal(second.body.deviceId, first.body.deviceId, 'same physical device');
  assert.notEqual(second.body.secret, first.body.secret, 'new one-time secret');

  // Exactly one PENDING claim for the device; the cancelled one stays in history.
  const pendingCount = await db.deviceClaim.count({ where: { deviceId: first.body.deviceId as string, status: 'pending' } });
  assert.equal(pendingCount, 1, 'no duplicate pending claims');
  const cancelledCount = await db.deviceClaim.count({ where: { deviceId: first.body.deviceId as string, status: 'cancelled' } });
  assert.equal(cancelledCount, 1, 'cancelled claim preserved in history');

  // The NEW claim is approvable and the device becomes active.
  const emp = await seedEmployee('CC7-EMP');
  const admin = await tokenFor('admin', 'u-cc7-admin');
  const ar = await approve(admin, second.body.claimId as string, emp.id);
  assert.equal(ar.status, 200, 'fresh claim must be approvable');
});

test('CC-8: rapid re-discover does not create duplicate pending claims', async () => {
  const { sessionToken } = await setupAuth('CC8-EMP');
  const key = 'key-cc-0008-rapid-retry-abcdef';
  const first = await discover(key, '203.0.113.8', sessionToken);
  await cancel(first.body.claimId as string, key, first.body.secret as string);

  const results = await Promise.all([
    discover(key, '203.0.113.8', sessionToken),
    discover(key, '203.0.113.8', sessionToken),
    discover(key, '203.0.113.8', sessionToken),
  ]);
  // The serialized per-device transaction guarantees a single pending claim.
  const pendingClaims = await db.deviceClaim.findMany({
    where: { deviceId: first.body.deviceId as string, status: 'pending' },
  });
  assert.equal(pendingClaims.length, 1, 'exactly one pending claim survives concurrent retries');
  assert.ok(results.every((r) => r.status === 201 || r.status === 200));
});

// ─── C-4: expired / rejected lifecycle re-registration ──────────────────────

test('CC-9: EXPIRED pending claim → fresh discover issues a new claim (the P2002 regression)', async () => {
  const { sessionToken } = await setupAuth('CC9-EMP');
  const key = 'key-cc-0009-expired-rereg-abcdef';
  const first = await discover(key, '203.0.113.9', sessionToken);
  assert.equal(first.status, 201);

  // Simulate the 30-day expiry: force the claim into the past.
  await db.deviceClaim.update({
    where: { id: first.body.claimId as string },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });

  const second = await discover(key, '203.0.113.9', sessionToken);
  // MUST NOT be a 500 (the old P2002 unique violation) — a fresh claim is issued.
  assert.notEqual(second.status, 500, 'expired re-registration must not 500');
  assert.equal(second.status, 201);
  assert.notEqual(second.body.claimId, first.body.claimId, 'new claim id after expiry');
  assert.ok(second.body.secret, 'new one-time secret after expiry');

  const expired = await db.deviceClaim.findUnique({ where: { id: first.body.claimId as string } });
  assert.equal(expired!.status, 'expired', 'old claim closed as expired');
  const pendingCount = await db.deviceClaim.count({ where: { deviceId: first.body.deviceId as string, status: 'pending' } });
  assert.equal(pendingCount, 1);
});

test('CC-10: REJECTED claim is surfaced during polling, and re-registers only with explicit intent', async () => {
  const { sessionToken } = await setupAuth('CC10-EMP');
  const key = 'key-cc-0010-rejected-rereg-abcdef';
  const first = await discover(key, '203.0.113.10', sessionToken);
  const admin = await tokenFor('admin', 'u-cc10-admin');
  const rr = await claimRejectApi.POST(
    req(admin, { method: 'POST', body: { reason: 'Not an employee device' }, ip: '198.51.100.10' }),
    { params: Promise.resolve({ id: first.body.claimId as string }) }
  );
  assert.equal(rr.status, 200);

  // Polling (NO reRegister) must surface the rejection — never silently undo it.
  const poll = await discover(key, '203.0.113.10', sessionToken, false);
  assert.equal(poll.body.status, 'rejected', 'polling surfaces rejection');
  assert.equal(poll.body.claimId, first.body.claimId);

  // Explicit re-registration intent → fresh pending claim.
  const second = await discover(key, '203.0.113.10', sessionToken, true);
  assert.equal(second.status, 201);
  assert.notEqual(second.body.claimId, first.body.claimId);
  assert.equal(second.body.status, 'pending');
});

test('CC-11: REVOKED device never auto re-registers — fail closed even with reRegister intent', async () => {
  const { sessionToken } = await setupAuth('CC11-EMP');
  const key = 'key-cc-0011-revoked-rereg-abcdef';
  const emp = await seedEmployee('CC11-EMP');
  const { body } = await discover(key, '203.0.113.11', sessionToken);
  const admin = await tokenFor('admin', 'u-cc11-admin');
  const ar = await approve(admin, body.claimId as string, emp.id);
  assert.equal(ar.status, 200);

  const revoke = await import('../src/app/api/device-claims/[id]/revoke/route');
  const rv = await revoke.POST(
    req(admin, { method: 'POST', body: { reason: 'Stolen laptop' }, ip: '198.51.100.11' }),
    { params: Promise.resolve({ id: body.claimId as string }) }
  );
  assert.equal(rv.status, 200);

  // Even an explicit reRegister attempt must NOT create a fresh claim.
  const retry = await discover(key, '203.0.113.11', sessionToken, true);
  assert.equal(retry.body.status, 'revoked', 'revoked device fails closed');
  assert.equal(retry.body.claimId, body.claimId);
  const claims = await db.deviceClaim.findMany({ where: { deviceId: body.deviceId as string } });
  assert.equal(claims.length, 1, 'no fresh claim created for a revoked device');
});

// ─── C-5: cancel does not weaken org isolation / RBAC / consent ─────────────

test('CC-12: admin cannot cancel via the employee endpoint; unauthenticated cancel is 401/400', async () => {
  const { sessionToken } = await setupAuth('CC12-EMP');
  const key = 'key-cc-0012-rbac-abcdef';
  const { body } = await discover(key, '203.0.113.12', sessionToken);

  // No deviceKey → 400; no secret → 400.
  const noKey = await claimCancelApi.POST(req(null, { method: 'POST', body: { secret: 'x' }, ip: '203.0.113.12' }), { params: Promise.resolve({ id: body.claimId as string }) });
  assert.equal(noKey.status, 400);
  const noSecret = await claimCancelApi.POST(req(null, { method: 'POST', body: { deviceKey: key }, ip: '203.0.113.12' }), { params: Promise.resolve({ id: body.claimId as string }) });
  assert.equal(noSecret.status, 400);

  // Admin session WITHOUT the claim secret cannot cancel (401) — the device
  // credential is the only valid cancellation identity.
  const admin = await tokenFor('admin', 'u-cc12-admin');
  const adminTry = await claimCancelApi.POST(req(admin, { method: 'POST', body: { deviceKey: key, secret: 'guess' }, ip: '203.0.113.12' }), { params: Promise.resolve({ id: body.claimId as string }) });
  assert.equal(adminTry.status, 401);
});

test('CC-13: approval still never grants consent — cancel/re-request flow unchanged', async () => {
  const { sessionToken } = await setupAuth('CC13-EMP');
  const key = 'key-cc-0013-consent-abcdef';
  const emp = await seedEmployee('CC13-EMP');
  const first = await discover(key, '203.0.113.13', sessionToken);
  await cancel(first.body.claimId as string, key, first.body.secret as string);
  const second = await discover(key, '203.0.113.13', sessionToken);
  const admin = await tokenFor('admin', 'u-cc13-admin');
  const ar = await approve(admin, second.body.claimId as string, emp.id);
  assert.equal(ar.status, 200);

  const consentRows = await db.consent.count({ where: { employeeId: emp.id } });
  assert.equal(consentRows, 0, 'approval must never create consent rows');
});

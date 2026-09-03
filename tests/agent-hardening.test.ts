/**
 * Desktop Agent Hardening (P2) — server-side regression tests.
 *
 * Covers the four P2 fixes from omnisight-agent-FINAL-AUDIT.md:
 *   P2-2  POST /api/agent/activity — server-authoritative type/category
 *         allowlist + timestamp/duration validation (422, no partial writes).
 *   P2-3  POST /api/agent/discover — anonymous zero-touch devices require an
 *         admin-issued enrollment code; NO "first organization" fallback.
 *   P2-4  POST /api/agent/anomaly — canonical validateAgentToken() auth and
 *         server-derived device attribution.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_agenthardening).
 * Run: npx tsx --test tests/agent-hardening.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';
import { req } from './helpers/request';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_agenthardening';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-agenthardening-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

before(() => {
  if (process.env.AGENT_HARDENING_TEST_MIGRATED_DB !== '1') {
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
let hashPassword: (p: string) => Promise<string>;
let applyConsentTransition: (typeof import('../src/lib/consent'))['applyConsentTransition'];
import type { ConsentStatus } from '../src/lib/consent';

type DiscoverApi = typeof import('../src/app/api/agent/discover/route');
type AuthApi = typeof import('../src/app/api/agent/authenticate/route');
type ClaimApproveApi = typeof import('../src/app/api/device-claims/[id]/approve/route');
type ClaimRevokeApi = typeof import('../src/app/api/device-claims/[id]/revoke/route');
type ActivityApi = typeof import('../src/app/api/agent/activity/route');
type AnomalyApi = typeof import('../src/app/api/agent/anomaly/route');
type LoginApi = typeof import('../src/app/api/agent/login/route');

let discoverApi: DiscoverApi;
let authApi: AuthApi;
let claimApproveApi: ClaimApproveApi;
let claimRevokeApi: ClaimRevokeApi;
let activityApi: ActivityApi;
let anomalyApi: AnomalyApi;
let loginApi: LoginApi;

let orgA: { id: string };
let orgB: { id: string };

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  hashPassword = (await import('../src/lib/auth')).hashPassword;
  applyConsentTransition = (await import('../src/lib/consent')).applyConsentTransition;

  const [dApi, aApi, caApi, crvApi, actApi, anApi, lApi] = await Promise.all([
    import('../src/app/api/agent/discover/route'),
    import('../src/app/api/agent/authenticate/route'),
    import('../src/app/api/device-claims/[id]/approve/route'),
    import('../src/app/api/device-claims/[id]/revoke/route'),
    import('../src/app/api/agent/activity/route'),
    import('../src/app/api/agent/anomaly/route'),
    import('../src/app/api/agent/login/route'),
  ]);
  discoverApi = dApi;
  authApi = aApi;
  claimApproveApi = caApi;
  claimRevokeApi = crvApi;
  activityApi = actApi;
  anomalyApi = anApi;
  loginApi = lApi;

  orgA = await db.organization.create({ data: { name: 'Hardening Org A', slug: 'hard-a' } });
  orgB = await db.organization.create({ data: { name: 'Hardening Org B', slug: 'hard-b' } });
});

after(async () => {
  await db.$disconnect();
  if (process.env.AGENT_HARDENING_TEST_MIGRATED_DB !== '1') {
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


function tokenFor(role: string, userId: string, orgId: string = orgA.id) {
  return signJWT({ userId, email: `${role}-${userId}@${orgId.slice(-6)}.local`, role, organizationId: orgId });
}

async function seedEmployee(code: string, orgId: string = orgA.id) {
  return db.employee.create({
    data: {
      employeeId: code,
      firstName: code.split('-')[0],
      lastName: 'Test',
      email: `${code.toLowerCase()}@test.local`,
      organizationId: orgId,
      status: 'active',
      agentApproved: false,
    },
  });
}

function discoverBody(deviceKey: string, extra: Record<string, unknown> = {}) {
  return {
    deviceKey,
    hostname: 'PC-HARD',
    os: 'Windows 11',
    osVersion: '23H2',
    processor: 'x64',
    memory: '16GB',
    agentVersion: '1.2.0',
    arch: 'x64',
    ...extra,
  };
}

async function discover(deviceKey: string, ip: string, extra: Record<string, unknown> = {}, sessionToken?: string | null) {
  const res = await discoverApi.POST(req(sessionToken ?? null, { method: 'POST', body: discoverBody(deviceKey, extra), ip }));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function createAndLogin(employeeId: string, orgId: string = orgA.id) {
  const emp = await seedEmployee(employeeId, orgId);
  const pw = 'TestPass-123!';
  const { createAgentAccount } = await import('../src/lib/agent-account');
  const { hashPassword: hp } = await import('../src/lib/auth');
  const pwHash = await hp(pw);
  await createAgentAccount({ employeeId: emp.id, agentId: employeeId, password: pw, status: 'active' });
  const loginRes = await loginApi.POST(req(null, { body: { agentId: employeeId, password: pw } }));
  const sessionToken = (await loginRes.json() as { token?: string }).token ?? null;
  return { emp, sessionToken };
}

async function approve(adminToken: string, claimId: string, employeeId: string) {
  const res = await claimApproveApi.POST(
    req(adminToken, { method: 'POST', body: { employeeId, projectIds: [] }, ip: '198.51.100.9' }),
    { params: Promise.resolve({ id: claimId }) }
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function publishPolicy(orgId: string, consentType: string, version: string) {
  const existing = await db.consentPolicy.findFirst({ where: { organizationId: orgId, consentType, version } });
  if (existing) return existing;
  return db.consentPolicy.create({
    data: {
      organizationId: orgId,
      consentType,
      title: `${consentType} policy`,
      content: 'Test policy',
      version,
      status: 'published',
      effectiveAt: new Date(),
      publishedAt: new Date(),
    },
  });
}

async function setConsent(employeeId: string, orgId: string, consentType: string, to: 'granted' | 'revoked') {
  const existing = await db.consent.findFirst({ where: { employeeId, consentType } });
  await db.$transaction(async (tx) => {
    if (existing) {
      await applyConsentTransition(tx, { id: existing.id, status: existing.status as ConsentStatus, consentType, organizationId: orgId }, to, { performedBy: 'test' });
    } else {
      const created = await tx.consent.create({ data: { employeeId, consentType, status: 'pending', organizationId: orgId } });
      await applyConsentTransition(tx, { id: created.id, status: 'pending', consentType, organizationId: orgId }, to, { performedBy: 'test' });
    }
  });
}

/** Full authenticated setup into org A: discover(session) -> approve -> PATH A auth -> token. */
async function setupActiveDevice(label: string, ip: string) {
  const { emp, sessionToken } = await createAndLogin(`${label}-EMP`);
  const { body } = await discover(`key-hard-${label.toLowerCase()}-device-abcdef`, ip, {}, sessionToken);
  assert.equal(body.status, 'pending', JSON.stringify(body));
  const admin = await tokenFor('admin', `u-${label}-admin`);
  const ar = await approve(admin, body.claimId as string, emp.id);
  assert.equal(ar.status, 200, JSON.stringify(ar.body));
  const res = await authApi.POST(req(null, { method: 'POST', body: { deviceId: body.deviceId, deviceSecret: body.secret, agentVersion: '1.2.0' }, ip }));
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  assert.equal(res.status, 200, JSON.stringify(parsed));
  return { emp, claim: body as Record<string, string>, token: parsed.token as string };
}

async function uploadActivity(token: string, activities: unknown[], ip = '203.0.113.99') {
  const res = await activityApi.POST(req(token, { method: 'POST', body: { activities }, ip }));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

// ─── P2-2: activity validation ──────────────────────────────────────────────

test('AH-01: valid activity accepted (200) and persisted', async () => {
  const { emp, token } = await setupActiveDevice('AH01', '203.0.113.1');
  await publishPolicy(orgA.id, 'activity_tracking', 'v1');
  await setConsent(emp.id, orgA.id, 'activity_tracking', 'granted');

  const past = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(); // legit offline
  const { status, body } = await uploadActivity(token, [
    { type: 'application', applicationName: 'Code.exe', category: 'productive', duration: 60, timestamp: past },
    { type: 'idle', category: 'unproductive', duration: 10 },
  ]);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.count, 2);
  const rows = await db.activity.findMany({ where: { employeeId: emp.id } });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => ['application', 'idle'].includes(r.type)));
});

test('AH-02: invalid category rejected (422), nothing persisted', async () => {
  const { emp, token } = await setupActiveDevice('AH02', '203.0.113.2');
  await publishPolicy(orgA.id, 'activity_tracking', 'v1');
  await setConsent(emp.id, orgA.id, 'activity_tracking', 'granted');

  const { status, body } = await uploadActivity(token, [
    { type: 'application', applicationName: 'Code.exe', category: 'napping', duration: 60 },
  ]);
  assert.equal(status, 422, JSON.stringify(body));
  assert.match(String(body.error ?? ''), /category/i);
  assert.equal(await db.activity.count({ where: { employeeId: emp.id } }), 0);
});

test('AH-03: invalid type rejected (422), nothing persisted', async () => {
  const { emp, token } = await setupActiveDevice('AH03', '203.0.113.3');
  await publishPolicy(orgA.id, 'activity_tracking', 'v1');
  await setConsent(emp.id, orgA.id, 'activity_tracking', 'granted');

  const { status, body } = await uploadActivity(token, [
    { type: 'banana', applicationName: 'Code.exe', duration: 60 },
  ]);
  assert.equal(status, 422, JSON.stringify(body));
  assert.match(String(body.error ?? ''), /type/i);
  assert.equal(await db.activity.count({ where: { employeeId: emp.id } }), 0);
});

test('AH-04: empty category rejected (422)', async () => {
  const { emp, token } = await setupActiveDevice('AH04', '203.0.113.4');
  await publishPolicy(orgA.id, 'activity_tracking', 'v1');
  await setConsent(emp.id, orgA.id, 'activity_tracking', 'granted');

  const { status, body } = await uploadActivity(token, [
    { type: 'application', applicationName: 'Code.exe', category: '', duration: 60 },
  ]);
  assert.equal(status, 422, JSON.stringify(body));
  assert.equal(await db.activity.count({ where: { employeeId: emp.id } }), 0);
});

test('AH-05: empty type rejected (422)', async () => {
  const { emp, token } = await setupActiveDevice('AH05', '203.0.113.5');
  await publishPolicy(orgA.id, 'activity_tracking', 'v1');
  await setConsent(emp.id, orgA.id, 'activity_tracking', 'granted');

  const { status, body } = await uploadActivity(token, [
    { type: '', applicationName: 'Code.exe', duration: 60 },
  ]);
  assert.equal(status, 422, JSON.stringify(body));
  assert.equal(await db.activity.count({ where: { employeeId: emp.id } }), 0);
});

test('AH-06: future timestamp rejected (422)', async () => {
  const { emp, token } = await setupActiveDevice('AH06', '203.0.113.6');
  await publishPolicy(orgA.id, 'activity_tracking', 'v1');
  await setConsent(emp.id, orgA.id, 'activity_tracking', 'granted');

  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { status, body } = await uploadActivity(token, [
    { type: 'application', applicationName: 'Code.exe', duration: 60, timestamp: future },
  ]);
  assert.equal(status, 422, JSON.stringify(body));
  assert.match(String(body.error ?? ''), /future/i);
  assert.equal(await db.activity.count({ where: { employeeId: emp.id } }), 0);
});

test('AH-07: valid historical offline timestamp accepted (200)', async () => {
  const { emp, token } = await setupActiveDevice('AH07', '203.0.113.7');
  await publishPolicy(orgA.id, 'activity_tracking', 'v1');
  await setConsent(emp.id, orgA.id, 'activity_tracking', 'granted');

  const old = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const { status, body } = await uploadActivity(token, [
    { type: 'website', url: 'github.com', duration: 120, timestamp: old },
  ]);
  assert.equal(status, 200, JSON.stringify(body));
  const row = await db.activity.findFirst({ where: { employeeId: emp.id } });
  assert.ok(row, 'row persisted');
  assert.equal(row!.timestamp.toISOString().slice(0, 10), old.slice(0, 10), 'offline timestamp preserved');
});

test('AH-08: negative duration rejected (422)', async () => {
  const { emp, token } = await setupActiveDevice('AH08', '203.0.113.8');
  await publishPolicy(orgA.id, 'activity_tracking', 'v1');
  await setConsent(emp.id, orgA.id, 'activity_tracking', 'granted');

  const { status, body } = await uploadActivity(token, [
    { type: 'application', applicationName: 'Code.exe', duration: -5 },
  ]);
  assert.equal(status, 422, JSON.stringify(body));
  assert.equal(await db.activity.count({ where: { employeeId: emp.id } }), 0);
});

test('AH-09: oversized duration rejected (422) — no silent clamp', async () => {
  const { emp, token } = await setupActiveDevice('AH09', '203.0.113.9');
  await publishPolicy(orgA.id, 'activity_tracking', 'v1');
  await setConsent(emp.id, orgA.id, 'activity_tracking', 'granted');

  const { status, body } = await uploadActivity(token, [
    { type: 'application', applicationName: 'Code.exe', duration: 100000 },
  ]);
  assert.equal(status, 422, JSON.stringify(body));
  assert.equal(await db.activity.count({ where: { employeeId: emp.id } }), 0);
});

test('AH-10: malformed duration (string instead of number) rejected (422)', async () => {
  const { emp, token } = await setupActiveDevice('AH10', '203.0.113.10');
  await publishPolicy(orgA.id, 'activity_tracking', 'v1');
  await setConsent(emp.id, orgA.id, 'activity_tracking', 'granted');

  const { status, body } = await uploadActivity(token, [
    { type: 'application', applicationName: 'Code.exe', duration: '60' },
  ]);
  assert.equal(status, 422, JSON.stringify(body));
  assert.equal(await db.activity.count({ where: { employeeId: emp.id } }), 0);
});

test('AH-11: one invalid item rejects the WHOLE batch (no partial writes)', async () => {
  const { emp, token } = await setupActiveDevice('AH11', '203.0.113.11');
  await publishPolicy(orgA.id, 'activity_tracking', 'v1');
  await setConsent(emp.id, orgA.id, 'activity_tracking', 'granted');

  const { status, body } = await uploadActivity(token, [
    { type: 'application', applicationName: 'Code.exe', category: 'productive', duration: 60 },
    { type: 'bogus', applicationName: 'Evil.exe', duration: 60 },
  ]);
  assert.equal(status, 422, JSON.stringify(body));
  assert.equal(await db.activity.count({ where: { employeeId: emp.id } }), 0, 'valid item must not be written');
});

// ─── P3-01: server-side string length caps (reject, never truncate) ────────

test('AH-12: oversized applicationName rejected (422), nothing persisted', async () => {
  const { emp, token } = await setupActiveDevice('AH12', '203.0.113.12');
  await publishPolicy(orgA.id, 'activity_tracking', 'v1');
  await setConsent(emp.id, orgA.id, 'activity_tracking', 'granted');

  const { status, body } = await uploadActivity(token, [
    { type: 'application', applicationName: 'A'.repeat(256), category: 'productive', duration: 60 },
  ]);
  assert.equal(status, 422, JSON.stringify(body));
  assert.match(String(body.error ?? ''), /applicationName/i);
  assert.equal(await db.activity.count({ where: { employeeId: emp.id } }), 0);
});

test('AH-13: oversized title and url rejected (422), nothing persisted', async () => {
  const { emp, token } = await setupActiveDevice('AH13', '203.0.113.13');
  await publishPolicy(orgA.id, 'activity_tracking', 'v1');
  await setConsent(emp.id, orgA.id, 'activity_tracking', 'granted');

  const longTitle = { type: 'application', applicationName: 'Code.exe', title: 'T'.repeat(513), category: 'neutral', duration: 30 };
  const longUrl = { type: 'application', applicationName: 'Code.exe', url: 'U'.repeat(2049), category: 'neutral', duration: 30 };
  for (const item of [longTitle, longUrl]) {
    const { status, body } = await uploadActivity(token, [item]);
    assert.equal(status, 422, JSON.stringify(body));
    assert.match(String(body.error ?? ''), /maximum length/i);
  }
  assert.equal(await db.activity.count({ where: { employeeId: emp.id } }), 0);
});

test('AH-14: boundary lengths accepted (200) — 512 title, 2048 url, 255 app name', async () => {
  const { emp, token } = await setupActiveDevice('AH14', '203.0.113.14');
  await publishPolicy(orgA.id, 'activity_tracking', 'v1');
  await setConsent(emp.id, orgA.id, 'activity_tracking', 'granted');

  const { status, body } = await uploadActivity(token, [
    { type: 'application', applicationName: 'A'.repeat(255), title: 'T'.repeat(512), url: 'U'.repeat(2048), category: 'productive', duration: 45 },
  ]);
  assert.equal(status, 200, JSON.stringify(body));
  const row = await db.activity.findFirst({ where: { employeeId: emp.id } });
  assert.equal(row!.applicationName!.length, 255);
  assert.equal(row!.title!.length, 512);
  assert.equal(row!.url!.length, 2048);
});

test('AH-15: oversized request body rejected with 413 before JSON parsing', async () => {
  const { emp, token } = await setupActiveDevice('AH15', '203.0.113.15');
  await publishPolicy(orgA.id, 'activity_tracking', 'v1');
  await setConsent(emp.id, orgA.id, 'activity_tracking', 'granted');

  // Explicitly advertise a content-length above the 1 MB body cap. The guard
  // runs BEFORE JSON parsing, so the request is rejected without ever
  // materializing the payload.
  // Explicitly advertise a content-length above the 1 MB body cap. The guard
  // runs BEFORE JSON parsing, so the request is rejected without ever
  // materializing the payload.
  const oversizedBody = JSON.stringify({
    activities: [{ type: 'application', applicationName: 'X', category: 'neutral', duration: 10 }],
  });
  const bigHeaders: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'content-length': String(2 * 1024 * 1024),
  };
  const bigRes = await activityApi.POST(new NextRequest('http://localhost:3000/api/agent/activity', {
    method: 'POST',
    headers: bigHeaders,
    body: oversizedBody,
  }));
  assert.equal(bigRes.status, 413, 'oversized content-length must be rejected before parsing');
  assert.equal(await db.activity.count({ where: { employeeId: emp.id } }), 0);
});

// ─── Anonymous discovery removed (zero-touch enrollment code removed) ────────

test('AH-20: anonymous discover without session → 422 (enrollment code removed)', async () => {
  const beforeDevices = await db.device.count();
  const beforeClaims = await db.deviceClaim.count();
  const { status, body } = await discover('key-hard-0020-no-session-abcdef', '203.0.113.20');
  assert.equal(status, 422, JSON.stringify(body));
  assert.equal(await db.device.count(), beforeDevices, 'no device may be created');
  assert.equal(await db.deviceClaim.count(), beforeClaims, 'no claim may be created');
});

test('AH-21: anonymous discover with any body → 422 (no anonymous enrollment)', async () => {
  const { status } = await discover('key-hard-0021-anon-blocked-abcdef', '203.0.113.21');
  assert.equal(status, 422);
});

test('AH-22: anonymous discover with hostile organizationId → 422 (no anonymous enrollment)', async () => {
  const { status } = await discover('key-hard-0022-hostile-org-abcdef', '203.0.113.22', { organizationId: orgB.id });
  assert.equal(status, 422);
});

test('AH-23: authenticated discover creates device in correct org', async () => {
  const { sessionToken } = await createAndLogin('AH23-EMP', orgA.id);
  const { status, body } = await discover('key-hard-0023-auth-discover-abcdef', '203.0.113.23', {}, sessionToken);
  assert.equal(status, 201, JSON.stringify(body));
  const device = await db.device.findUnique({ where: { id: body.deviceId as string } });
  assert.ok(device);
  assert.equal(device!.organizationId, orgA.id, 'device bound to authenticated employee org');
});

test('AH-24: authenticated discover with hostile organizationId in body → ignored (org from session)', async () => {
  const { sessionToken } = await createAndLogin('AH24-EMP', orgA.id);
  const { status, body } = await discover('key-hard-0024-auth-hostile-abcdef', '203.0.113.24', {
    organizationId: orgB.id, // hostile: try to force org B
  }, sessionToken);
  assert.equal(status, 201, JSON.stringify(body));
  const device = await db.device.findUnique({ where: { id: body.deviceId as string } });
  assert.equal(device!.organizationId, orgA.id, 'org must come from session, never the body');
});

test('AH-25: re-discover of existing device works without session (existing device path)', async () => {
  const { sessionToken } = await createAndLogin('AH25-EMP', orgA.id);
  const first = await discover('key-hard-0025-rebind-abcdef', '203.0.113.25', {}, sessionToken);
  assert.equal(first.status, 201);

  // Same device, no session → existing device path handles it
  const again = await discover('key-hard-0025-rebind-abcdef', '203.0.113.25');
  assert.equal(again.status, 200, JSON.stringify(again.body));
  const device = await db.device.findUnique({ where: { id: first.body.deviceId as string } });
  assert.equal(device!.organizationId, orgA.id, 'existing device retains its org');
});

test('AH-26: authenticated discover (Phase 3) is org-scoped WITHOUT any enrollment code', async () => {
  const emp = await seedEmployee('AH26-EMP');
  await db.agentAccount.create({
    data: {
      employeeId: emp.id,
      agentId: 'ah26-agent',
      passwordHash: await hashPassword('Str0ng!Passw0rd2026'),
      status: 'active',
    },
  });

  const login = await loginApi.POST(
    req(null, { method: 'POST', body: { agentId: 'ah26-agent', password: 'Str0ng!Passw0rd2026' }, ip: '203.0.113.26' })
  );
  const loginBody = (await login.json().catch(() => ({}))) as Record<string, unknown>;
  assert.equal(login.status, 200, JSON.stringify(loginBody));

  // NO enrollment code in the body — the AgentSession derives org A.
  const withSession = await discoverApi.POST(
    req(loginBody.token as string, { method: 'POST', body: discoverBody('key-hard-0026-session-abcdef'), ip: '203.0.113.26' })
  );
  const body = (await withSession.json().catch(() => ({}))) as Record<string, unknown>;
  assert.equal(withSession.status, 201, JSON.stringify(body));
  const device = await db.device.findUnique({ where: { id: body.deviceId as string } });
  assert.ok(device);
  assert.equal(device!.organizationId, orgA.id, 'authenticated discover binds the session org');
  assert.equal(device!.employeeId, emp.id, 'authenticated discover binds the session employee');
});

// ─── P2-4: anomaly authentication ───────────────────────────────────────────

test('AH-30: anomaly with missing token → 401', async () => {
  const res = await anomalyApi.POST(req(null, { method: 'POST', body: { type: 'idle', title: 'x', description: 'y' }, ip: '203.0.113.30' }));
  assert.equal(res.status, 401);
});

test('AH-31: anomaly with an invalid token → 401', async () => {
  const res = await anomalyApi.POST(req('not-a-valid-token-xxxxx', { method: 'POST', body: { type: 'idle', title: 'x', description: 'y' }, ip: '203.0.113.31' }));
  assert.equal(res.status, 401);
});

test('AH-32: anomaly with a REVOKED device token → 401 (fail closed)', async () => {
  const { emp, claim, token } = await setupActiveDevice('AH32', '203.0.113.32');
  const admin = await tokenFor('admin', 'u-ah32-admin');
  const rv = await claimRevokeApi.POST(
    req(admin, { method: 'POST', body: { reason: 'Test revoke' }, ip: '198.51.100.32' }),
    { params: Promise.resolve({ id: claim.claimId }) }
  );
  assert.equal(rv.status, 200);

  const res = await anomalyApi.POST(req(token, { method: 'POST', body: { type: 'idle', title: 'x', description: 'y' }, ip: '203.0.113.32' }));
  assert.equal(res.status, 401, 'revoked device token must fail closed');
  assert.equal(await db.anomaly.count({ where: { employeeId: emp.id } }), 0);
});

test('AH-33: anomaly with an EXPIRED token → 401', async () => {
  const { emp } = await setupActiveDevice('AH33', '203.0.113.33');
  // Insert a token that is already expired (validateAgentToken deletes it).
  await db.agentToken.create({
    data: {
      token: `expired-token-${Date.now()}-abcdefghijklmnopqrstuvwxyz0123456789`,
      expiresAt: new Date(Date.now() - 60_000),
      employee: { connect: { id: emp.id } },
      organization: { connect: { id: emp.organizationId } },
    },
  });
  const expired = await db.agentToken.findFirst({ where: { employeeId: emp.id, expiresAt: { lt: new Date() } } });
  const res = await anomalyApi.POST(req(expired!.token, { method: 'POST', body: { type: 'idle', title: 'x', description: 'y' }, ip: '203.0.113.33' }));
  assert.equal(res.status, 401, 'expired token must fail closed');
});

test('AH-34: anomaly with a VALID token → 201, attributed to the token employee/org/device', async () => {
  const { emp, token } = await setupActiveDevice('AH34', '203.0.113.34');
  const device = await db.device.findFirst({ where: { employeeId: emp.id } });

  const res = await anomalyApi.POST(req(token, {
    method: 'POST',
    body: { type: 'excessive_idle', severity: 'medium', title: 'Long idle', description: 'Detected extended idle', score: 70 },
    ip: '203.0.113.34',
  }));
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.ok(body.anomalyId);

  const row = await db.anomaly.findUnique({ where: { id: body.anomalyId as string } });
  assert.ok(row);
  assert.equal(row!.employeeId, emp.id, 'employee derived from token');
  assert.equal(row!.organizationId, orgA.id, 'org derived from token');
  assert.equal(row!.deviceId, device!.id, 'device derived from token');
  assert.equal(row!.severity, 'medium');
  assert.equal(row!.score, 70);
});

test('AH-35: client-supplied deviceId is IGNORED — attribution stays server-derived', async () => {
  const { emp, token } = await setupActiveDevice('AH35', '203.0.113.35');
  const device = await db.device.findFirst({ where: { employeeId: emp.id } });

  const res = await anomalyApi.POST(req(token, {
    method: 'POST',
    body: { type: 'policy_breach', title: 'Foreign attempt', description: 'x', deviceId: 'foreign-device-id-000' },
    ip: '203.0.113.35',
  }));
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  assert.equal(res.status, 201, JSON.stringify(body));

  const row = await db.anomaly.findUnique({ where: { id: body.anomalyId as string } });
  assert.equal(row!.deviceId, device!.id, 'stored device must be the authenticated device, never the client value');
  assert.equal(row!.organizationId, orgA.id);
});

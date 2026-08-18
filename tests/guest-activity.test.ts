/**
 * GUEST-ACT-01..07 — Guest Agent activity pipeline (server-side regression).
 *
 * Guest approval auto-grants standard monitoring consent (monitoring +
 * activity_tracking, bound to the org's current published policies). These
 * tests prove the consent-gated activity flow end-to-end while keeping every
 * security invariant intact:
 *
 *   GUEST-ACT-01  Authenticated guest activity accepted when properly
 *                 authorized (auto-granted consent → 200, row persisted).
 *   GUEST-ACT-02  Guest without required consent rejected (revoked consent
 *                 → 403, no rows — consent is never bypassed).
 *   GUEST-ACT-03  Cross-org guest activity rejected (org B admin sees zero
 *                 rows for org A's guest — tenant isolation).
 *   GUEST-ACT-04  Invalid device token rejected (garbage bearer → 401).
 *   GUEST-ACT-05  Activity persisted with server-derived organization/device
 *                 identity (client-supplied ids ignored; identity comes from
 *                 the verified token).
 *   GUEST-ACT-06  Admin Activities API returns valid guest activity.
 *   GUEST-ACT-07  Normal Employee Agent activity still works (employee-mode
 *                 approval does NOT auto-grant consent; consent remains the
 *                 gate and uploads succeed once granted).
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_guestact).
 * Run: npx tsx --test tests/guest-activity.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_guestact';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-guestact-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

before(() => {
  if (process.env.GUESTACT_TEST_MIGRATED_DB !== '1') {
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
type ActivityApi = typeof import('../src/app/api/agent/activity/route');
type ActivitiesApi = typeof import('../src/app/api/activities/route');
let discoverApi: DiscoverApi;
let authApi: AuthApi;
let approveApi: ApproveApi;
let activityApi: ActivityApi;
let activitiesApi: ActivitiesApi;
let hashEnrollmentCode: (code: string) => string;
let hasActiveConsent: (employeeId: string, consentType: string) => Promise<boolean>;
import type { ConsentStatus } from '../src/lib/consent';
type ApplyConsentTransition = (typeof import('../src/lib/consent'))['applyConsentTransition'];
let applyConsentTransition: ApplyConsentTransition;

let orgA: { id: string };
let orgB: { id: string };
const ENROLL_A = 'test-enroll-guestact-a-0123456789abcdef';
const ENROLL_B = 'test-enroll-guestact-b-0123456789abcdef';

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  const agentAuthLib = await import('../src/lib/agent/auth');
  hashEnrollmentCode = agentAuthLib.hashEnrollmentCode;
  hasActiveConsent = (await import('../src/lib/consent')).hasActiveConsent;
  applyConsentTransition = (await import('../src/lib/consent')).applyConsentTransition;

  const [dApi, aApi, apApi, actApi, actsApi] = await Promise.all([
    import('../src/app/api/agent/discover/route'),
    import('../src/app/api/agent/authenticate/route'),
    import('../src/app/api/device-claims/[id]/approve/route'),
    import('../src/app/api/agent/activity/route'),
    import('../src/app/api/activities/route'),
  ]);
  discoverApi = dApi;
  authApi = aApi;
  approveApi = apApi;
  activityApi = actApi;
  activitiesApi = actsApi;

  orgA = await db.organization.create({ data: { name: 'GuestAct Org A', slug: 'guestact-a' } });
  orgB = await db.organization.create({ data: { name: 'GuestAct Org B', slug: 'guestact-b' } });
  await db.organizationSetting.create({ data: { organizationId: orgA.id, key: 'agent_enrollment_code', value: hashEnrollmentCode(ENROLL_A), category: 'agent' } });
  await db.organizationSetting.create({ data: { organizationId: orgB.id, key: 'agent_enrollment_code', value: hashEnrollmentCode(ENROLL_B), category: 'agent' } });
  // Published policies — required for the consent auto-grant to bind.
  await publishPolicy(orgA.id, 'monitoring', 'v1');
  await publishPolicy(orgA.id, 'activity_tracking', 'v1');
  await publishPolicy(orgA.id, 'screenshot', 'v1');
  await publishPolicy(orgB.id, 'monitoring', 'v1');
  await publishPolicy(orgB.id, 'activity_tracking', 'v1');
});

after(async () => {
  await db.$disconnect();
  if (process.env.GUESTACT_TEST_MIGRATED_DB !== '1') {
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

function adminToken(org: { id: string }, label: string) {
  return signJWT({ userId: `u-${label}`, email: `admin-${label}@${org.id.slice(-6)}.local`, role: 'admin', organizationId: org.id });
}

function discoverBody(deviceKey: string, enrollmentCode: string, hostname = 'PC-GUESTACT') {
  return { deviceKey, hostname, os: 'Windows 11', osVersion: '23H2', processor: 'x64', memory: '16GB', agentVersion: '1.2.0', arch: 'x64', enrollmentCode };
}

async function discover(deviceKey: string, enrollmentCode: string, ip: string) {
  const res = await discoverApi.POST(req(null, { method: 'POST', body: discoverBody(deviceKey, enrollmentCode), ip }));
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

async function approveGuest(adminTokenStr: string, claimId: string) {
  const res = await approveApi.POST(
    req(adminTokenStr, { method: 'POST', body: { mode: 'guest' }, ip: '198.51.100.9' }),
    { params: Promise.resolve({ id: claimId }) }
  );
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

async function approveEmployee(adminTokenStr: string, claimId: string, employeeId: string) {
  const res = await approveApi.POST(
    req(adminTokenStr, { method: 'POST', body: { mode: 'employee', employeeId }, ip: '198.51.100.9' }),
    { params: Promise.resolve({ id: claimId }) }
  );
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

/** Full guest setup: discover -> approve as guest -> PATH A authenticate. */
async function setupActiveGuest(label: string, org: { id: string }, enroll: string, ip: string) {
  const { body } = await discover(`key-ga-${label.toLowerCase()}-device-abcdef`, enroll, ip);
  const admin = await adminToken(org, `ga-${label}-admin`);
  const ar = await approveGuest(admin, body.claimId as string);
  assert.equal(ar.status, 200, JSON.stringify(ar.body));
  const res = await authApi.POST(req(null, { method: 'POST', body: { deviceId: body.deviceId, deviceSecret: body.secret, agentVersion: '1.2.0' }, ip }));
  const parsed = await res.json().catch(() => ({})) as Record<string, unknown>;
  assert.equal(res.status, 200, JSON.stringify(parsed));
  return { claim: body as Record<string, string>, token: parsed.token as string };
}

async function publishPolicy(orgId: string, consentType: string, version: string) {
  const existing = await db.consentPolicy.findFirst({ where: { organizationId: orgId, consentType, version } });
  if (existing) return existing;
  return db.consentPolicy.create({
    data: { organizationId: orgId, consentType, title: `${consentType} policy`, content: 'Test policy', version, status: 'published', effectiveAt: new Date(), publishedAt: new Date() },
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

function activityPayload(overrides: Record<string, unknown> = {}) {
  return {
    activities: [{
      type: 'application',
      applicationName: 'chrome.exe',
      title: 'Example - Chrome',
      category: 'productive',
      duration: 10,
      timestamp: new Date().toISOString(),
      ...overrides,
    }],
  };
}

async function uploadActivity(token: string, body: unknown, ip: string) {
  const res = await activityApi.POST(req(token, { method: 'POST', url: 'http://localhost:3000/api/agent/activity', body, ip }));
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

interface ActivityFeedRow {
  employeeId: string;
  employee: { firstName: string; lastName: string };
  device: { id: string; name: string };
  [k: string]: unknown;
}
interface ActivitiesFeed {
  data?: ActivityFeedRow[];
  total?: number;
  [k: string]: unknown;
}

async function getActivities(token: string | null, qs = '') {
  const res = await activitiesApi.GET(req(token, { url: `http://localhost:3000/api/activities${qs}` }));
  return { status: res.status, json: await res.json().catch(() => ({})) as ActivitiesFeed };
}

// ─── GUEST-ACT-01 ───────────────────────────────────────────────────────────

test('GUEST-ACT-01: authenticated Guest activity accepted when properly authorized (auto-granted consent)', async () => {
  const { claim, token } = await setupActiveGuest('01', orgA, ENROLL_A, '203.0.113.1');
  const guest = await db.guest.findFirst({ where: { deviceId: claim.deviceId } });
  const employeeId = guest!.employeeId;

  // Approval auto-granted the consent — no extra admin step needed.
  assert.equal(await hasActiveConsent(employeeId, 'activity_tracking'), true, 'activity_tracking auto-granted');
  assert.equal(await hasActiveConsent(employeeId, 'monitoring'), true, 'monitoring auto-granted');

  const res = await uploadActivity(token, activityPayload(), '203.0.113.1');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.count, 1);

  const row = await db.activity.findFirst({ where: { employeeId } });
  assert.ok(row, 'activity row persisted');
  assert.equal(row!.type, 'application');
  assert.equal(row!.applicationName, 'chrome.exe');
  assert.equal(row!.employeeId, employeeId, 'attributed to guest employee');
  assert.equal(row!.deviceId, claim.deviceId, 'attributed to the guest device');
});

// ─── GUEST-ACT-02 ───────────────────────────────────────────────────────────

test('GUEST-ACT-02: guest without required consent rejected (revoked consent → 403, no rows)', async () => {
  const { claim, token } = await setupActiveGuest('02', orgA, ENROLL_A, '203.0.113.2');
  const guest = await db.guest.findFirst({ where: { deviceId: claim.deviceId } });
  const employeeId = guest!.employeeId;

  await setConsent(employeeId, orgA.id, 'activity_tracking', 'revoked');
  assert.equal(await hasActiveConsent(employeeId, 'activity_tracking'), false, 'consent revoked');

  const res = await uploadActivity(token, activityPayload(), '203.0.113.2');
  assert.equal(res.status, 403, 'fail-closed without consent');
  assert.equal(await db.activity.count({ where: { employeeId } }), 0, 'no rows written');
});

// ─── GUEST-ACT-03 ───────────────────────────────────────────────────────────

test('GUEST-ACT-03: cross-org Guest activity rejected — org B sees zero rows for org A guest', async () => {
  const { claim, token } = await setupActiveGuest('03', orgA, ENROLL_A, '203.0.113.3');
  const guest = await db.guest.findFirst({ where: { deviceId: claim.deviceId } });
  const employeeId = guest!.employeeId;

  const res = await uploadActivity(token, activityPayload(), '203.0.113.3');
  assert.equal(res.status, 200, 'org A guest uploads into org A');
  assert.equal(await db.activity.count({ where: { employeeId } }), 1);

  // Org B admin: the guest employeeId is foreign → zero rows (never another
  // org's data), and the unfiltered feed is also empty (no org B activity).
  const adminB = await adminToken(orgB, 'ga-03-b');
  const scoped = await getActivities(adminB, `?employeeId=${employeeId}&pageSize=100`);
  assert.equal(scoped.status, 200);
  assert.equal(scoped.json.total, 0, 'org B cannot see org A guest activity');
  const allB = await getActivities(adminB, '?pageSize=100');
  assert.equal(allB.json.total, 0, 'org B feed is empty');
});

// ─── GUEST-ACT-04 ───────────────────────────────────────────────────────────

test('GUEST-ACT-04: invalid device token rejected (401)', async () => {
  const res = await uploadActivity('garbage-not-a-real-token-abcdefghijklmnop', activityPayload(), '203.0.113.4');
  assert.equal(res.status, 401, 'invalid bearer rejected');
});

// ─── GUEST-ACT-05 ───────────────────────────────────────────────────────────

test('GUEST-ACT-05: activity persisted with server-derived organization/device identity', async () => {
  const { claim, token } = await setupActiveGuest('05', orgA, ENROLL_A, '203.0.113.5');
  const guest = await db.guest.findFirst({ where: { deviceId: claim.deviceId }, include: { employee: true } });
  const employeeId = guest!.employeeId;

  // A hostile/broken client tries to dictate its own identity — the server
  // must ignore every client-supplied identity field and use the token's.
  const res = await uploadActivity(token, activityPayload({
    employeeId: 'attacker-employee-id',
    organizationId: orgB.id,
    deviceId: 'attacker-device-id',
    organization: { id: orgB.id },
  }), '203.0.113.5');
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const row = await db.activity.findFirst({ where: { employeeId } });
  assert.ok(row, 'row persisted under the guest employee');
  assert.equal(row!.employeeId, employeeId, 'server-derived employee (token)');
  assert.equal(row!.deviceId, claim.deviceId, 'server-derived device (token)');
  const emp = await db.employee.findUnique({ where: { id: employeeId } });
  assert.equal(emp!.organizationId, orgA.id, 'server-derived organization (employee binding)');
});

// ─── GUEST-ACT-06 ───────────────────────────────────────────────────────────

test('GUEST-ACT-06: Admin Activities API returns valid Guest activity', async () => {
  const { claim, token } = await setupActiveGuest('06', orgA, ENROLL_A, '203.0.113.6');
  const guest = await db.guest.findFirst({ where: { deviceId: claim.deviceId }, include: { employee: true } });
  const employeeId = guest!.employeeId;

  const res = await uploadActivity(token, activityPayload(), '203.0.113.6');
  assert.equal(res.status, 200);

  const adminA = await adminToken(orgA, 'ga-06-a');
  const feed = await getActivities(adminA, `?employeeId=${employeeId}&pageSize=100`);
  assert.equal(feed.status, 200);
  const rows = (feed.json.data ?? []).filter((r) => r.employeeId === employeeId);
  assert.ok(rows.length >= 1, 'guest activity visible in Admin Activities API');
  assert.equal(rows[0].employee.firstName, 'Guest', 'guest identity rendered');
  assert.equal(rows[0].device.id, claim.deviceId, 'device identity rendered');
});

// ─── GUEST-ACT-07 ───────────────────────────────────────────────────────────

test('GUEST-ACT-07: normal Employee Agent activity still works — employee approval does NOT auto-grant consent', async () => {
  const employee = await db.employee.create({
    data: {
      employeeId: 'EMP-GA-07',
      firstName: 'Alice',
      lastName: 'Smith',
      email: 'alice.smith@guestact.local',
      status: 'active',
      type: 'employee',
      organizationId: orgA.id,
    },
  });

  const { body } = await discover('key-ga-07-employee-device-abcdef', ENROLL_A, '203.0.113.7');
  const admin = await adminToken(orgA, 'ga-07-admin');
  const ar = await approveEmployee(admin, body.claimId as string, employee.id);
  assert.equal(ar.status, 200, JSON.stringify(ar.body));

  // Employee-mode approval must NOT touch consent — the employee's own
  // consent state is the gate (unchanged behavior).
  assert.equal(await db.consent.count({ where: { employeeId: employee.id } }), 0, 'employee approval grants no consent');
  assert.equal(await hasActiveConsent(employee.id, 'activity_tracking'), false);

  const authRes = await authApi.POST(req(null, { method: 'POST', body: { deviceId: body.deviceId, deviceSecret: body.secret, agentVersion: '1.2.0' }, ip: '203.0.113.7' }));
  const parsed = await authRes.json().catch(() => ({})) as Record<string, unknown>;
  assert.equal(authRes.status, 200, JSON.stringify(parsed));
  const token = parsed.token as string;

  // Without consent → 403 (same gate as guests).
  const denied = await uploadActivity(token, activityPayload(), '203.0.113.7');
  assert.equal(denied.status, 403, 'employee without consent rejected');

  // With consent → 200 (unchanged employee pipeline).
  await setConsent(employee.id, orgA.id, 'activity_tracking', 'granted');
  assert.equal(await hasActiveConsent(employee.id, 'activity_tracking'), true);
  const ok = await uploadActivity(token, activityPayload(), '203.0.113.7');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const row = await db.activity.findFirst({ where: { employeeId: employee.id } });
  assert.ok(row, 'employee activity persisted');
  assert.equal(row!.deviceId, body.deviceId, 'attributed to the employee device');
});

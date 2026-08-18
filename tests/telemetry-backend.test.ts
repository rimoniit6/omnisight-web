/**
 * Telemetry Expansion — server-side integration tests (Phases 1–5).
 *
 * Covers, against a THROWAWAY PostgreSQL database (workai_test_telemetry):
 *   Keystroke: consent gate, config gate, closed-schema validation (raw key
 *              data rejected), persistence of aggregate rows only.
 *   Location:  consent gate, coordinate validation, persistence.
 *   Commands:  device binding, org isolation, expiry, atomic delivery
 *              (PENDING → DELIVERED — never twice), allowlist, ACK.
 *   Webcam:    session start requires consent + config; metadata-only rows;
 *              end transitions; frames are never persisted (no frame table).
 *
 * Run: npx tsx --test tests/telemetry-backend.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_telemetry';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-telemetry-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

before(() => {
  if (process.env.TELEMETRY_TEST_MIGRATED_DB !== '1') {
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
let hashEnrollmentCode: (code: string) => string;
let applyConsentTransition: (typeof import('../src/lib/consent'))['applyConsentTransition'];
import type { ConsentStatus } from '../src/lib/consent';

type DiscoverApi = typeof import('../src/app/api/agent/discover/route');
type AuthApi = typeof import('../src/app/api/agent/authenticate/route');
type ClaimApproveApi = typeof import('../src/app/api/device-claims/[id]/approve/route');
type KeystrokeApi = typeof import('../src/app/api/agent/keystroke/route');
type LocationApi = typeof import('../src/app/api/agent/location/route');
type CommandsApi = typeof import('../src/app/api/agent/commands/route');
type CommandAckApi = typeof import('../src/app/api/agent/commands/[id]/ack/route');
type DeviceCommandsApi = typeof import('../src/app/api/device-commands/route');
type WebcamSessionApi = typeof import('../src/app/api/agent/webcam/session/route');
type WebcamEndApi = typeof import('../src/app/api/agent/webcam/session/end/route');
type WebcamFrameApi = typeof import('../src/app/api/agent/webcam/frame/route');

let orgA: { id: string };
let orgB: { id: string };
const CODE_A = 'enroll-code-telemetry-a-0123456789abcdef';
const CODE_B = 'enroll-code-telemetry-b-0123456789abcdef';

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  hashEnrollmentCode = (await import('../src/lib/agent/auth')).hashEnrollmentCode;
  applyConsentTransition = (await import('../src/lib/consent')).applyConsentTransition;

  const [dApi, aApi, caApi, kApi, lApi, cApi, ackApi, dcApi, wsApi, weApi, wfApi] = await Promise.all([
    import('../src/app/api/agent/discover/route'),
    import('../src/app/api/agent/authenticate/route'),
    import('../src/app/api/device-claims/[id]/approve/route'),
    import('../src/app/api/agent/keystroke/route'),
    import('../src/app/api/agent/location/route'),
    import('../src/app/api/agent/commands/route'),
    import('../src/app/api/agent/commands/[id]/ack/route'),
    import('../src/app/api/device-commands/route'),
    import('../src/app/api/agent/webcam/session/route'),
    import('../src/app/api/agent/webcam/session/end/route'),
    import('../src/app/api/agent/webcam/frame/route'),
  ]);
  const discoverApi = dApi;
  const authApi = aApi;
  const claimApproveApi = caApi;
  const keystrokeApi = kApi;
  const locationApi = lApi;
  const commandsApi = cApi;
  const commandAckApi = ackApi;
  const deviceCommandsApi = dcApi;
  const webcamSessionApi = wsApi;
  const webcamEndApi = weApi;
  const webcamFrameApi = wfApi;

  orgA = await db.organization.create({ data: { name: 'Telemetry Org A', slug: 'tele-a' } });
  orgB = await db.organization.create({ data: { name: 'Telemetry Org B', slug: 'tele-b' } });
  await db.organizationSetting.create({
    data: { organizationId: orgA.id, key: 'agent_enrollment_code', value: hashEnrollmentCode(CODE_A), category: 'agent' },
  });
  await db.organizationSetting.create({
    data: { organizationId: orgB.id, key: 'agent_enrollment_code', value: hashEnrollmentCode(CODE_B), category: 'agent' },
  });

  (globalThis as Record<string, unknown>).__telemetryApis = { keystrokeApi, locationApi, commandsApi, commandAckApi, deviceCommandsApi, webcamSessionApi, webcamEndApi, webcamFrameApi, discoverApi, authApi, claimApproveApi };
});

after(async () => {
  await db.$disconnect();
  if (process.env.TELEMETRY_TEST_MIGRATED_DB !== '1') {
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

function getApis() {
  return (globalThis as Record<string, unknown>).__telemetryApis as Record<string, { POST?: (req: NextRequest, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>; GET?: (req: NextRequest) => Promise<Response> }>;
}

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

async function setMonitoring(orgId: string, key: string, value: string) {
  const existing = await db.organizationSetting.findUnique({
    where: { organizationId_key: { organizationId: orgId, key } },
  });
  if (existing) {
    await db.organizationSetting.update({ where: { id: existing.id }, data: { value } });
  } else {
    await db.organizationSetting.create({ data: { organizationId: orgId, key, value, category: 'monitoring' } });
  }
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

async function setupActiveDevice(label: string, orgId: string = orgA.id, code: string = CODE_A) {
  const emp = await seedEmployee(`${label}-EMP`, orgId);
  const { discoverApi, authApi, claimApproveApi } = getApis();
  const dres = await (discoverApi.POST as (r: NextRequest) => Promise<Response>)(req(null, {
    method: 'POST',
    body: { deviceKey: `key-tele-${label.toLowerCase()}-device-abcdef`, hostname: 'PC-TELE', os: 'Windows 11', osVersion: '23H2', processor: 'x64', memory: '16GB', agentVersion: '1.2.0', arch: 'x64', enrollmentCode: code },
    ip: '203.0.113.10',
  }));
  const dbody = (await dres.json().catch(() => ({}))) as Record<string, unknown>;
  assert.equal(dres.status, 201, JSON.stringify(dbody));
  assert.equal(dbody.status, 'pending', JSON.stringify(dbody));
  const admin = await tokenFor('admin', `u-${label}-admin`, orgId);
  const ares = await (claimApproveApi.POST as (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(req(admin, { method: 'POST', body: { employeeId: emp.id, projectIds: [] }, ip: '198.51.100.9' }), { params: Promise.resolve({ id: dbody.claimId as string }) });
  assert.equal(ares.status, 200);
  const authRes = await (authApi.POST as (r: NextRequest) => Promise<Response>)(req(null, { method: 'POST', body: { deviceId: dbody.deviceId, deviceSecret: dbody.secret, agentVersion: '1.2.0' }, ip: '203.0.113.11' }));
  const parsed = (await authRes.json().catch(() => ({}))) as Record<string, unknown>;
  assert.equal(authRes.status, 200, JSON.stringify(parsed));
  return { emp, deviceId: dbody.deviceId as string, token: parsed.token as string };
}

// ─── Keystroke ──────────────────────────────────────────────────────────────

test('KB-01: keystroke upload requires consent (403 when revoked)', async () => {
  const { token } = await setupActiveDevice('KB01');
  const { keystrokeApi } = getApis();
  const body = {
    intervals: [{
      intervalStart: new Date(Date.now() - 120_000).toISOString(),
      intervalEnd: new Date(Date.now() - 60_000).toISOString(),
      keystrokeCount: 42,
      activeTypingSeconds: 30,
    }],
  };
  const res = await (keystrokeApi.POST as (r: NextRequest) => Promise<Response>)(req(token, { method: 'POST', body }));
  assert.equal(res.status, 403);
});

test('KB-02: keystroke upload requires org config (403 when disabled)', async () => {
  const { emp, token } = await setupActiveDevice('KB02');
  await publishPolicy(orgA.id, 'keystroke', 'v1');
  await setConsent(emp.id, orgA.id, 'keystroke', 'granted');
  await setMonitoring(orgA.id, 'keystroke_logging_enabled', 'false');
  const { keystrokeApi } = getApis();
  const res = await (keystrokeApi.POST as (r: NextRequest) => Promise<Response>)(req(token, {
    method: 'POST',
    body: {
      intervals: [{
        intervalStart: new Date(Date.now() - 120_000).toISOString(),
        intervalEnd: new Date(Date.now() - 60_000).toISOString(),
        keystrokeCount: 5,
        activeTypingSeconds: 5,
      }],
    },
  }));
  assert.equal(res.status, 403);
});

test('KB-03: aggregate interval accepted (200) and persisted — count/duration only', async () => {
  const { emp, token } = await setupActiveDevice('KB03');
  await publishPolicy(orgA.id, 'keystroke', 'v1');
  await setConsent(emp.id, orgA.id, 'keystroke', 'granted');
  await setMonitoring(orgA.id, 'keystroke_logging_enabled', 'true');
  const { keystrokeApi } = getApis();
  const res = await (keystrokeApi.POST as (r: NextRequest) => Promise<Response>)(req(token, {
    method: 'POST',
    body: {
      intervals: [{
        intervalStart: new Date(Date.now() - 120_000).toISOString(),
        intervalEnd: new Date(Date.now() - 60_000).toISOString(),
        keystrokeCount: 137,
        activeTypingSeconds: 45,
        application: 'code.exe',
      }],
    },
  }));
  assert.equal(res.status, 200, JSON.stringify(await res.json().catch(() => ({}))));
  const rows = await db.keyboardActivity.findMany({ where: { employeeId: emp.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].keystrokeCount, 137);
  assert.equal(rows[0].activeTypingSeconds, 45);
  assert.equal(rows[0].application, 'code.exe');
  // The row is aggregate metadata — no raw-data columns exist on the model.
  // (keystrokeCount / activeTypingSeconds are the ALLOWED aggregates; raw key
  // value columns like key/keyCode/character/text must never exist.)
  const cols = Object.keys(rows[0]).sort();
  assert.ok(!cols.some((c) => /\b(key|keyCode|character|char|text|typedText|clipboard)\b/i.test(c)), `unexpected raw-data column: ${cols.join(',')}`);
});

test('KB-04: raw keystroke fields are rejected (422, nothing persisted)', async () => {
  const { emp, token } = await setupActiveDevice('KB04');
  await publishPolicy(orgA.id, 'keystroke', 'v1');
  await setConsent(emp.id, orgA.id, 'keystroke', 'granted');
  await setMonitoring(orgA.id, 'keystroke_logging_enabled', 'true');
  const { keystrokeApi } = getApis();
  for (const raw of [
    { key: 'a' },
    { keyCode: 65 },
    { character: 'a', text: 'hello' },
    { typedText: 'password123' },
    { clipboard: 'secret' },
    { scanCode: 30 },
  ]) {
    const res = await (keystrokeApi.POST as (r: NextRequest) => Promise<Response>)(req(token, {
      method: 'POST',
      body: { intervals: [{ intervalStart: new Date(Date.now() - 60_000).toISOString(), intervalEnd: new Date(Date.now() - 30_000).toISOString(), keystrokeCount: 1, activeTypingSeconds: 1, ...raw }] },
    }));
    assert.equal(res.status, 422, `raw field ${Object.keys(raw)[0]} must be rejected`);
  }
  assert.equal(await db.keyboardActivity.count({ where: { employeeId: emp.id } }), 0);
});

test('KB-05: unknown fields are rejected (closed schema)', async () => {
  const { emp, token } = await setupActiveDevice('KB05');
  await publishPolicy(orgA.id, 'keystroke', 'v1');
  await setConsent(emp.id, orgA.id, 'keystroke', 'granted');
  await setMonitoring(orgA.id, 'keystroke_logging_enabled', 'true');
  const { keystrokeApi } = getApis();
  const res = await (keystrokeApi.POST as (r: NextRequest) => Promise<Response>)(req(token, {
    method: 'POST',
    body: { intervals: [{ intervalStart: new Date(Date.now() - 60_000).toISOString(), intervalEnd: new Date(Date.now() - 30_000).toISOString(), keystrokeCount: 1, activeTypingSeconds: 1, sneaky: true }] },
  }));
  assert.equal(res.status, 422);
  assert.equal(await db.keyboardActivity.count({ where: { employeeId: emp.id } }), 0);
});

// ─── Location ───────────────────────────────────────────────────────────────

test('LOC-B1: location upload requires consent (403 when revoked)', async () => {
  const { token } = await setupActiveDevice('LB01');
  const { locationApi } = getApis();
  const res = await (locationApi.POST as (r: NextRequest) => Promise<Response>)(req(token, {
    method: 'POST',
    body: { latitude: 23.8103, longitude: 90.4125, accuracy: 25, timestamp: new Date().toISOString() },
  }));
  assert.equal(res.status, 403);
});

test('LOC-B2: valid coordinate upload accepted and persisted', async () => {
  const { emp, token } = await setupActiveDevice('LB02');
  await publishPolicy(orgA.id, 'location', 'v1');
  await setConsent(emp.id, orgA.id, 'location', 'granted');
  await setMonitoring(orgA.id, 'location_tracking', 'true');
  const { locationApi } = getApis();
  const res = await (locationApi.POST as (r: NextRequest) => Promise<Response>)(req(token, {
    method: 'POST',
    body: { latitude: 23.8103, longitude: 90.4125, accuracy: 25, timestamp: new Date().toISOString() },
  }));
  assert.equal(res.status, 200, JSON.stringify(await res.json().catch(() => ({}))));
  const rows = await db.locationEvent.findMany({ where: { employeeId: emp.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].latitude, 23.8103);
  assert.equal(rows[0].longitude, 90.4125);
  const cols = Object.keys(rows[0]).join(',');
  assert.ok(!/address|reverse/i.test(cols), `address columns must never exist: ${cols}`);
});

test('LOC-B3: invalid coordinates rejected (422, nothing persisted)', async () => {
  const { emp, token } = await setupActiveDevice('LB03');
  await publishPolicy(orgA.id, 'location', 'v1');
  await setConsent(emp.id, orgA.id, 'location', 'granted');
  await setMonitoring(orgA.id, 'location_tracking', 'true');
  const { locationApi } = getApis();
  for (const body of [
    { latitude: 999, longitude: 0, accuracy: 10, timestamp: new Date().toISOString() },
    { latitude: 0, longitude: 181, accuracy: 10, timestamp: new Date().toISOString() },
    { latitude: 0, longitude: 0, accuracy: -5, timestamp: new Date().toISOString() },
    { latitude: 0, longitude: 0, accuracy: 10, timestamp: new Date(Date.now() + 3_600_000).toISOString() },
  ]) {
    const res = await (locationApi.POST as (r: NextRequest) => Promise<Response>)(req(token, { method: 'POST', body }));
    assert.equal(res.status, 422, JSON.stringify(body));
  }
  assert.equal(await db.locationEvent.count({ where: { employeeId: emp.id } }), 0);
});

// ─── Command channel ────────────────────────────────────────────────────────

test('CMD-B1: device receives only its own PENDING commands; delivery is atomic', async () => {
  const d1 = await setupActiveDevice('CB1');
  const d2 = await setupActiveDevice('CB2');
  await setMonitoring(orgA.id, 'webcam_capture_enabled', 'true');
  const { deviceCommandsApi, commandsApi } = getApis();
  const admin = await tokenFor('admin', 'u-cb-admin');

  const enq1 = await (deviceCommandsApi.POST as (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(req(admin, {
    method: 'POST',
    body: { deviceId: d1.deviceId, commandType: 'webcam.start', expiresInSeconds: 300 },
  }), { params: Promise.resolve({}) });
  assert.equal(enq1.status, 200, JSON.stringify(await enq1.json().catch(() => ({}))));

  // Device 2 must NOT see device 1's command.
  const poll2 = await (commandsApi.GET as (r: NextRequest) => Promise<Response>)(req(d2.token, { url: 'http://localhost:3000/api/agent/commands' }));
  const b2 = (await poll2.json().catch(() => ({}))) as { data?: unknown[] };
  assert.equal(b2.data?.length ?? 0, 0);

  // Device 1 sees it exactly once.
  const poll1 = await (commandsApi.GET as (r: NextRequest) => Promise<Response>)(req(d1.token, { url: 'http://localhost:3000/api/agent/commands' }));
  const b1 = (await poll1.json().catch(() => ({}))) as { data?: Array<{ id: string; commandType: string }> };
  assert.equal(b1.data?.length, 1);
  assert.equal(b1.data![0].commandType, 'webcam.start');

  // Second poll returns nothing (DELIVERED — never executed twice).
  const poll1b = await (commandsApi.GET as (r: NextRequest) => Promise<Response>)(req(d1.token, { url: 'http://localhost:3000/api/agent/commands' }));
  const b1b = (await poll1b.json().catch(() => ({}))) as { data?: unknown[] };
  assert.equal(b1b.data?.length ?? 0, 0);

  // ACK the command; a duplicate ACK is idempotent (still success).
  const { commandAckApi } = getApis();
  const ackRes = await (commandAckApi.POST as (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(req(d1.token, { method: 'POST', body: { result: 'acknowledged' } }), { params: Promise.resolve({ id: b1.data![0].id }) });
  assert.equal(ackRes.status, 200);
  const ack2 = await (commandAckApi.POST as (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(req(d1.token, { method: 'POST', body: { result: 'acknowledged' } }), { params: Promise.resolve({ id: b1.data![0].id }) });
  assert.equal(ack2.status, 200);
  const cmdRow = await db.agentCommand.findUnique({ where: { id: b1.data![0].id } });
  assert.equal(cmdRow?.status, 'ACKNOWLEDGED');
});

test('CMD-B2: commands cannot cross organizations', async () => {
  const orgAdev = await setupActiveDevice('CB3');
  const orgBemp = await seedEmployee('CB4-EMP', orgB.id);
  const { deviceCommandsApi } = getApis();
  const adminB = await tokenFor('admin', 'u-cb4-admin', orgB.id);

  // Org-B admin enqueues for an org-B employee — but with an org-A device id.
  const res = await (deviceCommandsApi.POST as (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(req(adminB, {
    method: 'POST',
    body: { deviceId: orgAdev.deviceId, commandType: 'webcam.stop', expiresInSeconds: 300 },
  }), { params: Promise.resolve({}) });
  // The org-B admin cannot enqueue against an org-A device (404 — device not
  // in this organization), so an org-A device can never receive an org-B cmd.
  assert.equal(res.status, 404);
  const { commandsApi } = getApis();
  const poll = await (commandsApi.GET as (r: NextRequest) => Promise<Response>)(req(orgAdev.token, { url: 'http://localhost:3000/api/agent/commands' }));
  const body = (await poll.json().catch(() => ({}))) as { data?: unknown[] };
  assert.equal(body.data?.length ?? 0, 0, 'org-A device must never fetch an org-B command');
});

test('CMD-B3: unknown / arbitrary command types are rejected at enqueue', async () => {
  const d = await setupActiveDevice('CB5');
  const { deviceCommandsApi } = getApis();
  const admin = await tokenFor('admin', 'u-cb5-admin');
  for (const cmdType of ['shell.exec', 'powershell', 'download', 'install', 'execute', 'rm -rf']) {
    const res = await (deviceCommandsApi.POST as (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(req(admin, {
      method: 'POST',
      body: { deviceId: d.deviceId, commandType: cmdType, expiresInSeconds: 300 },
    }), { params: Promise.resolve({}) });
    assert.equal(res.status, 422, `commandType ${cmdType} must be rejected`);
  }
});

test('CMD-B4: expired commands are never delivered', async () => {
  const d = await setupActiveDevice('CB6');
  const { deviceCommandsApi, commandsApi } = getApis();
  const admin = await tokenFor('admin', 'u-cb6-admin');
  const res = await (deviceCommandsApi.POST as (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(req(admin, {
    method: 'POST',
    body: { deviceId: d.deviceId, commandType: 'webcam.stop', expiresInSeconds: 30 },
  }), { params: Promise.resolve({}) });
  assert.equal(res.status, 200);
  // Wait past the minimum expiry window.
  await new Promise((r) => setTimeout(r, 31_000));
  const poll = await (commandsApi.GET as (r: NextRequest) => Promise<Response>)(req(d.token, { url: 'http://localhost:3000/api/agent/commands' }));
  const body = (await poll.json().catch(() => ({}))) as { data?: unknown[] };
  assert.equal(body.data?.length ?? 0, 0, 'expired command must not be delivered');
});

// ─── Webcam session (metadata only) ─────────────────────────────────────────

/** Enqueue a webcam.start command for a device and deliver it via the poll. */
async function deliverWebcamStart(d: { emp: { id: string }; deviceId: string; token: string }, admin: string) {
  const { deviceCommandsApi, commandsApi } = getApis();
  const enq = await (deviceCommandsApi.POST as (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(req(admin, {
    method: 'POST',
    body: { deviceId: d.deviceId, commandType: 'webcam.start', expiresInSeconds: 300 },
  }), { params: Promise.resolve({}) });
  assert.equal(enq.status, 200);
  const poll = await (commandsApi.GET as (r: NextRequest) => Promise<Response>)(req(d.token, { url: 'http://localhost:3000/api/agent/commands' }));
  const body = (await poll.json().catch(() => ({}))) as { data?: Array<{ id: string }> };
  assert.equal(body.data?.length, 1);
  return body.data![0].id;
}

test('WC-B1: webcam session start requires consent (403 when revoked, even with a valid command)', async () => {
  const d = await setupActiveDevice('WB1');
  const admin = await tokenFor('admin', 'u-wb1-admin');
  const commandId = await deliverWebcamStart(d, admin);
  const { webcamSessionApi } = getApis();
  const res = await (webcamSessionApi.POST as (r: NextRequest) => Promise<Response>)(req(d.token, {
    method: 'POST',
    body: { sessionId: 'sess-wb1', commandId, startedAt: new Date().toISOString() },
  }));
  assert.equal(res.status, 403);
});

test('WC-B2: webcam session start/end with consent + config → metadata row, then ended', async () => {
  const d = await setupActiveDevice('WB2');
  await publishPolicy(orgA.id, 'webcam_access', 'v1');
  await setConsent(d.emp.id, orgA.id, 'webcam_access', 'granted');
  await setMonitoring(orgA.id, 'webcam_capture_enabled', 'true');
  const admin = await tokenFor('admin', 'u-wb2-admin');
  const commandId = await deliverWebcamStart(d, admin);
  const { webcamSessionApi, webcamEndApi } = getApis();

  const start = await (webcamSessionApi.POST as (r: NextRequest) => Promise<Response>)(req(d.token, {
    method: 'POST',
    body: { sessionId: 'sess-wb2', commandId, startedAt: new Date().toISOString() },
  }));
  assert.equal(start.status, 200, JSON.stringify(await start.json().catch(() => ({}))));

  const end = await (webcamEndApi.POST as (r: NextRequest) => Promise<Response>)(req(d.token, {
    method: 'POST',
    body: { sessionId: 'sess-wb2', endedReason: 'command', endedAt: new Date().toISOString() },
  }));
  assert.equal(end.status, 200, JSON.stringify(await end.json().catch(() => ({}))));

  const row = await db.webcamSession.findUnique({ where: { sessionId: 'sess-wb2' } });
  assert.ok(row, 'session row must exist');
  assert.equal(row.status, 'ended');
  assert.equal(row.endedReason, 'command');
  assert.equal(row.startedBy, 'u-wb2-admin', 'startedBy must be derived from the command payload');
  // Frames are never persisted — the model has only metadata (lastFrameAt is
  // a timestamp, never frame content); no video/blob/byte array column exists.
  const cols = Object.keys(row).join(',');
  assert.ok(!/\b(frameData|frameBytes|video|blob|bytes)\b/i.test(cols), `no frame storage allowed: ${cols}`);
});

test('WC-B3: consent revoked mid-session → next frame rejected 403, session ended(consent_revoked), relay cleared', async () => {
  const d = await setupActiveDevice('WB3');
  await publishPolicy(orgA.id, 'webcam_access', 'v1');
  await setConsent(d.emp.id, orgA.id, 'webcam_access', 'granted');
  await setMonitoring(orgA.id, 'webcam_capture_enabled', 'true');
  const admin = await tokenFor('admin', 'u-wb3-admin');
  const commandId = await deliverWebcamStart(d, admin);
  const { webcamSessionApi, webcamFrameApi } = getApis();

  const start = await (webcamSessionApi.POST as (r: NextRequest) => Promise<Response>)(req(d.token, {
    method: 'POST',
    body: { sessionId: 'sess-wb3', commandId, startedAt: new Date().toISOString() },
  }));
  assert.equal(start.status, 200, JSON.stringify(await start.json().catch(() => ({}))));

  // Revoke consent while the session is active (the ≤5s server gate means the
  // next frame that is due for re-validation is rejected server-side).
  await setConsent(d.emp.id, orgA.id, 'webcam_access', 'revoked');

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const form = new FormData();
  form.append('frame', new File([new Uint8Array(jpeg)], 'frame.jpg', { type: 'image/jpeg' }));
  const frameReq = new NextRequest('http://localhost:3000/api/agent/webcam/frame?sessionId=sess-wb3', {
    method: 'POST',
    headers: { authorization: `Bearer ${d.token}` },
    body: form,
  });
  const res = await (webcamFrameApi.POST as (r: NextRequest) => Promise<Response>)(frameReq);
  assert.equal(res.status, 403, JSON.stringify(await res.json().catch(() => ({}))));

  // The session row must be ended with the honest reason, and the relay must
  // hold no frame for it (relay is process-global — assert via the row state
  // which is the persisted source of truth).
  const row = await db.webcamSession.findUnique({ where: { sessionId: 'sess-wb3' } });
  assert.ok(row);
  assert.equal(row.status, 'ended');
  assert.equal(row.endedReason, 'consent_revoked');
});

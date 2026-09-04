/**
 * Admin Panel Telemetry — server-side integration tests.
 *
 * Covers the four employee-telemetry admin surfaces (websites, keyboard,
 * location, webcam) against a THROWAWAY PostgreSQL database
 * (workai_test_admintelemetry):
 *
 *   - RBAC: manager+ read scope; anonymous → 401; org-bound users only.
 *   - Org isolation (IDOR): org A's admin can never read org B's telemetry
 *     (foreign employee ids → 404).
 *   - Employee scoping: every route is keyed to the authenticated org.
 *   - Privacy shapes: keyboard returns ONLY aggregate fields; websites return
 *     ONLY bare domains (a full-URL legacy row is normalized defensively);
 *     location returns coordinates only (no address columns).
 *   - Pagination/validation: bad page/pageSize/date → 422.
 *   - Webcam: status exposes active session metadata + consent/config/device
 *     state; webcam.start via the admin device-commands route requires
 *     admin+ (manager → 403) and an allowlisted commandType.
 *
 * Run: npx tsx --test tests/admin-telemetry-backend.test.ts
 */
import { test, before, after } from 'node:test';

// Tests share one throwaway DB and mutate rows — Node's test runner runs
// tests concurrently within a file, so force serial execution to keep the
// per-test seeds deterministic and leak-free.
function st(name: string, fn: () => void | Promise<void>) {
  test(name, { concurrency: false }, fn);
}
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';
import { req } from './helpers/request';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_admintelemetry';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-admintelemetry-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

before(() => {
  if (process.env.ADMIN_TELEMETRY_TEST_MIGRATED_DB !== '1') {
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

let orgA: { id: string };
let orgB: { id: string };

before(async () => {
  db = (await import('../src/lib/db')).db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  orgA = await db.organization.create({ data: { name: 'AdminTele Org A', slug: 'admtele-a' } });
  orgB = await db.organization.create({ data: { name: 'AdminTele Org B', slug: 'admtele-b' } });
});

after(async () => {
  await db.$disconnect();
  if (process.env.ADMIN_TELEMETRY_TEST_MIGRATED_DB !== '1') {
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


function tokenFor(role: string, userId: string, orgId: string) {
  return signJWT({ userId, email: `${role}-${userId}@${orgId.slice(-6)}.local`, role, organizationId: orgId });
}

async function seedEmployee(label: string, orgId: string) {
  return db.employee.create({
    data: {
      employeeId: `${label}-EMP`,
      firstName: label,
      lastName: 'Test',
      email: `${label.toLowerCase()}@test.local`,
      organizationId: orgId,
      status: 'active',
      agentApproved: false,
    },
  });
}

async function seedDevice(employeeId: string, orgId: string, name = 'TestPC') {
  return db.device.create({
    data: {
      name,
      hostname: 'pc-' + name.toLowerCase(),
      status: 'online',
      lastHeartbeat: new Date(),
      organizationId: orgId,
      employeeId,
    },
  });
}

async function seedTelemetry(employeeId: string, orgId: string) {
  const now = new Date();
  await db.keyboardActivity.createMany({
    data: [
      {
        employeeId,
        organizationId: orgId,
        intervalStart: new Date(now.getTime() - 3600_000),
        intervalEnd: now,
        keystrokeCount: 120,
        activeTypingSeconds: 60,
        application: 'code.exe',
      },
      {
        employeeId,
        organizationId: orgId,
        intervalStart: new Date(now.getTime() - 7200_000),
        intervalEnd: new Date(now.getTime() - 3600_000),
        keystrokeCount: 40,
        activeTypingSeconds: 30,
        application: 'chrome.exe',
      },
    ],
  });
  await db.locationEvent.createMany({
    data: [
      { employeeId, organizationId: orgId, latitude: 23.8103, longitude: 90.4125, accuracy: 25, recordedAt: now },
      { employeeId, organizationId: orgId, latitude: 23.8104, longitude: 90.4126, accuracy: 30, recordedAt: new Date(now.getTime() - 3600_000) },
    ],
  });
  await db.activity.createMany({
    data: [
      {
        employeeId,
        organizationId: orgId,
        type: 'website',
        url: 'github.com',
        title: 'GitHub',
        category: 'productive',
        duration: 600,
        timestamp: now,
      },
      {
        employeeId,
        organizationId: orgId,
        type: 'website',
        url: 'https://www.youtube.com/watch?v=abc',
        title: 'YouTube',
        category: 'unproductive',
        duration: 300,
        timestamp: new Date(now.getTime() - 1800_000),
      },
    ],
  });
}

async function callGet(route: string, token: string | null, path: string) {
  const mod = (await import(route)) as { GET: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response> };
  const url = `http://localhost:3000${path}`;
  // The [id] segment must be passed as the route param — the URL path alone
  // is not parsed by the route handler (Next.js supplies it via `params`).
  const id = path.split('/')[3];
  return mod.GET(req(token, { url }), { params: Promise.resolve({ id }) });
}

// ─── RBAC / auth ────────────────────────────────────────────────────────────

st('AT-01: unauthenticated telemetry read → 401', async () => {
  const empA = await seedEmployee('AT01', orgA.id);
  for (const sub of ['keyboard', 'location', 'websites', 'webcam']) {
    const res = await callGet(`../src/app/api/employees/[id]/${sub}/route`, null, `/api/employees/${empA.id}/${sub}`);
    assert.equal(res.status, 401, sub);
  }
});

st('AT-02: org-bound manager can read telemetry (200)', async () => {
  const empA = await seedEmployee('AT02', orgA.id);
  const manager = await tokenFor('manager', 'u-at02-mgr', orgA.id);
  const res = await callGet('../src/app/api/employees/[id]/keyboard/route', manager, `/api/employees/${empA.id}/keyboard`);
  assert.equal(res.status, 200);
});

// ─── IDOR / org isolation ───────────────────────────────────────────────────

st('AT-03: org A admin cannot read org B telemetry (foreign employee → 404)', async () => {
  const empB = await seedEmployee('AT03', orgB.id);
  await seedTelemetry(empB.id, orgB.id);
  const adminA = await tokenFor('admin', 'u-at03-admin', orgA.id);
  for (const sub of ['keyboard', 'location', 'websites', 'webcam']) {
    const res = await callGet(`../src/app/api/employees/[id]/${sub}/route`, adminA, `/api/employees/${empB.id}/${sub}`);
    assert.equal(res.status, 404, `${sub} must conceal the foreign employee`);
  }
});

st('AT-04: org B admin CAN read org B telemetry (200)', async () => {
  const empB = await seedEmployee('AT04', orgB.id);
  await seedTelemetry(empB.id, orgB.id);
  const adminB = await tokenFor('admin', 'u-at04-admin', orgB.id);
  const res = await callGet('../src/app/api/employees/[id]/keyboard/route', adminB, `/api/employees/${empB.id}/keyboard`);
  assert.equal(res.status, 200);
});

// ─── Keyboard ───────────────────────────────────────────────────────────────

st('AT-10: keyboard returns aggregate fields only (closed shape)', async () => {
  const empA = await seedEmployee('AT10', orgA.id);
  await seedTelemetry(empA.id, orgA.id);
  const adminA = await tokenFor('admin', 'u-at10-admin', orgA.id);
  const res = await callGet('../src/app/api/employees/[id]/keyboard/route', adminA, `/api/employees/${empA.id}/keyboard`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    data: Array<Record<string, unknown>>;
    summary: { totalKeystrokes: number; totalActiveTypingSeconds: number; intervals: number };
    byDay: unknown[];
    byApplication: unknown[];
  };
  assert.equal(body.summary.totalKeystrokes, 160);
  assert.equal(body.summary.totalActiveTypingSeconds, 90);
  assert.equal(body.summary.intervals, 2);
  assert.equal(body.data.length, 2);
  assert.equal(body.byApplication.length, 2);
  for (const row of body.data) {
    const keys = Object.keys(row).sort();
    assert.deepEqual(keys, ['activeTypingSeconds', 'application', 'id', 'intervalEnd', 'intervalStart', 'keystrokeCount']);
  }
});

st('AT-11: keyboard rejects bad pagination (422)', async () => {
  const empA = await seedEmployee('AT11', orgA.id);
  const adminA = await tokenFor('admin', 'u-at11-admin', orgA.id);
  const res = await callGet('../src/app/api/employees/[id]/keyboard/route', adminA, `/api/employees/${empA.id}/keyboard?pageSize=500`);
  assert.equal(res.status, 422);
  const res2 = await callGet('../src/app/api/employees/[id]/keyboard/route', adminA, `/api/employees/${empA.id}/keyboard?from=not-a-date`);
  assert.equal(res2.status, 422);
});

// ─── Location ───────────────────────────────────────────────────────────────

st('AT-20: location returns latest + history with coordinates only', async () => {
  const empA = await seedEmployee('AT20', orgA.id);
  await seedTelemetry(empA.id, orgA.id);
  const adminA = await tokenFor('admin', 'u-at20-admin', orgA.id);
  const res = await callGet('../src/app/api/employees/[id]/location/route', adminA, `/api/employees/${empA.id}/location`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    latest: { latitude: number; longitude: number; accuracy: number | null; recordedAt: string };
    history: Array<Record<string, unknown>>;
    total: number;
  };
  assert.ok(body.latest, 'latest fix present');
  assert.equal(body.latest.latitude, 23.8103);
  assert.equal(body.total, 2);
  assert.equal(body.history.length, 2);
  for (const row of body.history) {
    assert.deepEqual(Object.keys(row).sort(), ['accuracy', 'id', 'latitude', 'longitude', 'recordedAt', 'source']);
  }
});

st('AT-21: location invalid date → 422', async () => {
  const empA = await seedEmployee('AT21', orgA.id);
  const adminA = await tokenFor('admin', 'u-at21-admin', orgA.id);
  const res = await callGet('../src/app/api/employees/[id]/location/route', adminA, `/api/employees/${empA.id}/location?to=banana`);
  assert.equal(res.status, 422);
});

// ─── Websites ───────────────────────────────────────────────────────────────

st('AT-30: websites returns bare domains only — full URLs normalized', async () => {
  const empA = await seedEmployee('AT30', orgA.id);
  await seedTelemetry(empA.id, orgA.id);
  const adminA = await tokenFor('admin', 'u-at30-admin', orgA.id);
  const res = await callGet('../src/app/api/employees/[id]/websites/route', adminA, `/api/employees/${empA.id}/websites`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<{ domain: string; visits: number; totalSeconds: number }>; summary: { totalSeconds: number } };
  const domains = body.data.map((d) => d.domain).sort();
  // The legacy full-URL row (https://www.youtube.com/watch?v=abc) MUST come
  // back as a bare domain with no path/query.
  assert.deepEqual(domains, ['github.com', 'youtube.com']);
  assert.equal(body.summary.totalSeconds, 900);
  for (const row of body.data) {
    assert.ok(!row.domain.includes('://'), `no URL prefix allowed: ${row.domain}`);
    assert.ok(!row.domain.includes('/'), `no path allowed: ${row.domain}`);
    assert.ok(!row.domain.includes('?'), `no query allowed: ${row.domain}`);
  }
});

// ─── Webcam ─────────────────────────────────────────────────────────────────

st('AT-40: webcam status exposes consent/config/device state and active session', async () => {
  const empA = await seedEmployee('AT40', orgA.id);
  const device = await seedDevice(empA.id, orgA.id);
  await db.webcamSession.create({
    data: {
      sessionId: 'sess-at40-abcdef',
      employeeId: empA.id,
      deviceId: device.id,
      organizationId: orgA.id,
      commandId: 'cmd-at40',
      status: 'active',
      startedBy: 'u-at40-admin',
    },
  });
  const adminA = await tokenFor('admin', 'u-at40-admin', orgA.id);
  const res = await callGet('../src/app/api/employees/[id]/webcam/route', adminA, `/api/employees/${empA.id}/webcam`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    consentGranted: boolean;
    configEnabled: boolean;
    devices: Array<{ id: string; status: string }>;
    activeSession: { sessionId: string } | null;
  };
  assert.equal(body.consentGranted, false, 'no consent seeded → false (UI shows NO CONSENT, never guesses)');
  assert.equal(body.configEnabled, false, 'no config seeded → false');
  assert.equal(body.devices.length, 1);
  assert.equal(body.devices[0].status, 'online');
  assert.equal(body.activeSession?.sessionId, 'sess-at40-abcdef');
});

st('AT-41: webcam start command requires admin (manager → 403)', async () => {
  const empA = await seedEmployee('AT41', orgA.id);
  const device = await seedDevice(empA.id, orgA.id);
  const manager = await tokenFor('manager', 'u-at41-mgr', orgA.id);
  const mod = (await import('../src/app/api/device-commands/route')) as {
    POST: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
  };
  const res = await mod.POST(req(manager, { method: 'POST', body: { deviceId: device.id, commandType: 'webcam.start' } }), { params: Promise.resolve({}) });
  assert.equal(res.status, 403);
});

st('AT-42: webcam start command rejects arbitrary commandType (422)', async () => {
  const empA = await seedEmployee('AT42', orgA.id);
  const device = await seedDevice(empA.id, orgA.id);
  const adminA = await tokenFor('admin', 'u-at42-admin', orgA.id);
  const mod = (await import('../src/app/api/device-commands/route')) as {
    POST: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
  };
  const res = await mod.POST(req(adminA, { method: 'POST', body: { deviceId: device.id, commandType: 'rm -rf' } }), { params: Promise.resolve({}) });
  assert.equal(res.status, 422);
});

st('AT-43: webcam start command is device-org-scoped (foreign device → 404)', async () => {
  const empB = await seedEmployee('AT43', orgB.id);
  const deviceB = await seedDevice(empB.id, orgB.id);
  const adminA = await tokenFor('admin', 'u-at43-admin', orgA.id);
  const mod = (await import('../src/app/api/device-commands/route')) as {
    POST: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
  };
  const res = await mod.POST(req(adminA, { method: 'POST', body: { deviceId: deviceB.id, commandType: 'webcam.stop' } }), { params: Promise.resolve({}) });
  assert.equal(res.status, 404, 'org A admin must not command org B devices');
});

st('AT-44: audit log records the webcam command with the real actor', async () => {
  const empA = await seedEmployee('AT44', orgA.id);
  const device = await seedDevice(empA.id, orgA.id);
  const adminA = await tokenFor('admin', 'u-at44-admin', orgA.id);
  const mod = (await import('../src/app/api/device-commands/route')) as {
    POST: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
  };
  const res = await mod.POST(req(adminA, { method: 'POST', body: { deviceId: device.id, commandType: 'webcam.start' } }), { params: Promise.resolve({}) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { commandId: string };
  const cmd = await db.agentCommand.findUnique({ where: { id: body.commandId } });
  assert.ok(cmd, 'command row created');
  assert.equal(cmd?.commandType, 'webcam.start');
  assert.equal(cmd?.status, 'PENDING');
  const audit = await db.auditLog.findFirst({ where: { resource: 'device_command', resourceId: body.commandId } });
  assert.ok(audit, 'audit row exists');
  assert.equal(audit?.userId, 'u-at44-admin', 'actor is the authenticated admin, never a placeholder');
});

st('AT-45: webcam frame relay has its own rate budget (never starves control writes)', async () => {
  // Live-found bug: the ~10fps frame relay (600 POST/min) exhausted the shared
  // 120/min agentWrite bucket, so the agent's end-session POST got 429'd and
  // the session was orphaned as "active". Longest-prefix wins, so the frame
  // path must carry its own budget ABOVE the generic agent-write rule.
  const proxy = await import('../src/proxy');
  const rules = proxy.__RATE_RULES_FOR_TESTS as Array<{
    prefix: string;
    methods?: string[];
    limit: number;
    keyBy: string;
  }>;
  const frameRule = rules.find((r) => r.prefix === '/api/agent/webcam/frame');
  const agentWrite = rules.find((r) => r.prefix === '/api/agent');
  assert.ok(frameRule, 'dedicated /api/agent/webcam/frame rule exists');
  assert.ok(frameRule.methods?.includes('POST'), 'frame rule applies to POST');
  assert.equal(frameRule.keyBy, 'agentToken', 'frame rule is per-agent-token');
  assert.ok(
    frameRule.limit > (agentWrite?.limit ?? 0),
    `frame budget (${frameRule.limit}) exceeds the generic agent-write budget (${agentWrite?.limit})`
  );
  assert.ok(frameRule.limit >= 600, 'frame budget supports ~10fps relay');
});

st('AT-46: stale-session convergence closes a silent session but keeps a fresh one', async () => {
  const empA = await seedEmployee('AT46', orgA.id);
  const device = await seedDevice(empA.id, orgA.id);
  // Silent session: lastFrameAt older than the 90s grace → converged to ended.
  // Created AFTER the fresh one so it is the newest active session the status
  // route evaluates (production has one active session per device).
  await db.webcamSession.create({
    data: {
      sessionId: 'sess-at46-fresh',
      employeeId: empA.id,
      deviceId: device.id,
      organizationId: orgA.id,
      commandId: 'cmd-at46-1',
      status: 'active',
      startedBy: 'u-at46-admin',
    },
  });
  const stale = await db.webcamSession.create({
    data: {
      sessionId: 'sess-at46-stale',
      employeeId: empA.id,
      deviceId: device.id,
      organizationId: orgA.id,
      commandId: 'cmd-at46-2',
      status: 'active',
      startedBy: 'u-at46-admin',
      lastFrameAt: new Date(Date.now() - 120_000),
    },
  });
  const adminA = await tokenFor('admin', 'u-at46-admin', orgA.id);
  const res = await callGet('../src/app/api/employees/[id]/webcam/route', adminA, `/api/employees/${empA.id}/webcam`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { activeSession: { sessionId: string } | null };
  assert.equal(body.activeSession, null, 'stale (newest) session converged → no active session reported');
  const staleRow = await db.webcamSession.findUnique({ where: { id: stale.id } });
  assert.equal(staleRow?.status, 'ended', 'silent session converged to ended');
  assert.equal(staleRow?.endedReason, 'disconnect');
  const freshRow = await db.webcamSession.findFirst({ where: { sessionId: 'sess-at46-fresh' } });
  assert.equal(freshRow?.status, 'active', 'fresh session (null lastFrameAt) never converged');
});

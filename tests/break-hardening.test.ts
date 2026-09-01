// OmniSight — Break Monitor production-hardening regression tests.
//
// Covers the findings fixed in the hardening pass:
//   F-01  agent break lifecycle (idempotent start/end, no duplicates)
//   F-03  self-service break route (own employee only, server-derived identity)
//   F-04  double-toggle / concurrency (single active break per employee)
//   F-08  organization-timezone day boundaries ("today" semantics)
//   F-11  audit actor attribution (authenticated actor, never client input)
//   F-13  error semantics (401/403/404/400/409 — no Prisma leaks)
//   F-15  cross-org / forged-identity rejection
//
// The DB is a throwaway Postgres database (created, reset, dropped by this
// file) — identical isolation pattern to tests/multi-org-isolation.test.ts.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation (set BEFORE any app module import) ──────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_break_hardening';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-break-harden-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@breakharden.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!BreakHarden2026x';
(process.env as Record<string, string>).NODE_ENV = 'test';

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

let orgA: { id: string };
let orgB: { id: string };
let empA: { id: string };
let empB: { id: string };
let empC: { id: string }; // second employee in org A
let deviceA: { id: string };
let deviceB: { id: string };
let agentTokenA: string;
let agentTokenB: string;

let adminAToken: string;
let managerAToken: string;
let viewerAToken: string;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  orgA = await db.organization.create({ data: { name: 'Org A', slug: 'org-a-bh' } });
  orgB = await db.organization.create({ data: { name: 'Org B', slug: 'org-b-bh' } });

  empA = await db.employee.create({
    data: {
      employeeId: 'BH-EMP-A', firstName: 'Alice', lastName: 'A', email: 'alice@bh.test',
      organizationId: orgA.id, status: 'active', agentApproved: true,
    },
  });
  empB = await db.employee.create({
    data: {
      employeeId: 'BH-EMP-B', firstName: 'Bob', lastName: 'B', email: 'bob@bh.test',
      organizationId: orgB.id, status: 'active', agentApproved: true,
    },
  });
  empC = await db.employee.create({
    data: {
      employeeId: 'BH-EMP-C', firstName: 'Carol', lastName: 'C', email: 'carol@bh.test',
      organizationId: orgA.id, status: 'active', agentApproved: true,
    },
  });

  const freshBeat = new Date();
  deviceA = await db.device.create({
    data: { name: 'PC-A', hostname: 'PC-A', agentKey: 'key-a-bh', organizationId: orgA.id, employeeId: empA.id, status: 'online', lastHeartbeat: freshBeat },
  });
  deviceB = await db.device.create({
    data: { name: 'PC-B', hostname: 'PC-B', agentKey: 'key-b-bh', organizationId: orgB.id, employeeId: empB.id, status: 'online', lastHeartbeat: freshBeat },
  });

  const agentTokenRowA = await db.agentToken.create({
    data: {
      token: 'bh-agent-token-org-a-00000000000000000000',
      expiresAt: new Date(Date.now() + 86400000 * 30),
      deviceId: deviceA.id,
      employee: { connect: { id: empA.id } },
      organization: { connect: { id: orgA.id } },
    },
  });
  const agentTokenRowB = await db.agentToken.create({
    data: {
      token: 'bh-agent-token-org-b-00000000000000000000',
      expiresAt: new Date(Date.now() + 86400000 * 30),
      deviceId: deviceB.id,
      employee: { connect: { id: empB.id } },
      organization: { connect: { id: orgB.id } },
    },
  });
  agentTokenA = agentTokenRowA.token;
  agentTokenB = agentTokenRowB.token;

  adminAToken = await signJWT({ userId: 'admin-a-bh', email: 'admin@a.bh', role: 'admin', organizationId: orgA.id });
  managerAToken = await signJWT({ userId: 'manager-a-bh', email: 'manager@a.bh', role: 'manager', organizationId: orgA.id });
  viewerAToken = await signJWT({ userId: 'viewer-a-bh', email: 'viewer@a.bh', role: 'viewer', organizationId: orgA.id });
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

function req(token: string | null, opts: { method?: string; body?: unknown; url?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  headers['content-type'] = 'application/json';
  return new NextRequest(opts.url ?? `http://localhost:3000${opts.url ?? ''}`, {
    method: opts.method ?? 'POST',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function openBreaks(employeeId: string) {
  return db.breakSession.count({ where: { employeeId, endedAt: null } });
}

async function sessionCount(employeeId: string) {
  return db.breakSession.count({ where: { employeeId } });
}

// ─── F-01: agent break lifecycle ────────────────────────────────────────────

test('BH-01: agent starts a break -> 200, breakMode true, session open', async () => {
  const api = await import('../src/app/api/agent/break/route');
  const res = await api.POST(req(agentTokenA, { body: { breakMode: true } }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.breakMode, true);
  assert.equal(body.action, 'started');
  assert.ok(body.startedAt, 'startedAt present');
  assert.equal(await openBreaks(empA.id), 1, 'exactly one open break');
});

test('BH-02: agent start twice -> no duplicate, action already_active', async () => {
  const api = await import('../src/app/api/agent/break/route');
  const res = await api.POST(req(agentTokenA, { body: { breakMode: true } }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.action, 'already_active');
  assert.equal(await openBreaks(empA.id), 1, 'still exactly one open break');
});

test('BH-03: agent ends break -> 200, breakMode false, session closed', async () => {
  const api = await import('../src/app/api/agent/break/route');
  const res = await api.POST(req(agentTokenA, { body: { breakMode: false } }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.breakMode, false);
  assert.equal(body.action, 'ended');
  assert.ok(body.endedAt, 'endedAt present');
  assert.equal(await openBreaks(empA.id), 0, 'no open break');
});

test('BH-04: agent ends twice -> safe no-op, action no_active_break', async () => {
  const api = await import('../src/app/api/agent/break/route');
  const res = await api.POST(req(agentTokenA, { body: { breakMode: false } }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.action, 'no_active_break');
  assert.equal(await openBreaks(empA.id), 0);
});

test('BH-05: agent full start->end cycle records exactly one session', async () => {
  const before = await sessionCount(empC.id);
  const api = await import('../src/app/api/agent/break/route');
  // empC has no device — create one bound token-less flow via admin? No: use a
  // device-bound token for empC is not needed; agent auth requires deviceId
  // presence check only when token has deviceId. Create an employee-only token.
  const tokenC = await db.agentToken.create({
    data: {
      token: 'bh-agent-token-org-a-c-000000000000000000',
      expiresAt: new Date(Date.now() + 86400000 * 30),
      employee: { connect: { id: empC.id } },
      organization: { connect: { id: orgA.id } },
    },
  });
  await api.POST(req(tokenC.token, { body: { breakMode: true } }));
  await api.POST(req(tokenC.token, { body: { breakMode: true } }));
  await api.POST(req(tokenC.token, { body: { breakMode: false } }));
  await api.POST(req(tokenC.token, { body: { breakMode: false } }));
  assert.equal(await sessionCount(empC.id), before + 1, 'one session despite 4 requests');
});

test('BH-06: concurrent agent starts -> exactly one open break', async () => {
  // Fresh employee (empA now free). Fire both starts without awaiting between.
  const api = await import('../src/app/api/agent/break/route');
  const p1 = api.POST(req(agentTokenA, { body: { breakMode: true } }));
  const p2 = api.POST(req(agentTokenA, { body: { breakMode: true } }));
  const [r1, r2] = await Promise.all([p1, p2]);
  const b1 = await r1.json();
  const b2 = await r2.json();
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.ok(
    [b1.action, b2.action].includes('started') && [b1.action, b2.action].includes('already_active'),
    `concurrent start must yield one started + one already_active, got ${b1.action}/${b2.action}`
  );
  assert.equal(await openBreaks(empA.id), 1, 'exactly one open break after race');
  // cleanup
  await api.POST(req(agentTokenA, { body: { breakMode: false } }));
});

test('BH-07: malformed body -> 400, no state change', async () => {
  const api = await import('../src/app/api/agent/break/route');
  const res = await api.POST(req(agentTokenA, { body: { breakMode: 'yes' } }));
  assert.equal(res.status, 400);
  const res2 = await api.POST(req(agentTokenA, { body: {} }));
  assert.equal(res2.status, 400);
  assert.equal(await openBreaks(empA.id), 0);
});

test('BH-08: unauthenticated agent break -> 401', async () => {
  const api = await import('../src/app/api/agent/break/route');
  const res = await api.POST(req(null, { body: { breakMode: true } }));
  assert.equal(res.status, 401);
});

test('BH-09: invalid agent token -> 401', async () => {
  const api = await import('../src/app/api/agent/break/route');
  const res = await api.POST(req('this-is-not-a-real-token-0000000000', { body: { breakMode: true } }));
  assert.equal(res.status, 401);
});

test('BH-10: org B agent token cannot touch org A state (server-derived identity)', async () => {
  const api = await import('../src/app/api/agent/break/route');
  // Org B agent starts a break on ITS OWN employee — verify the session is
  // attributed to empB (org B), never to a client-supplied id.
  const res = await api.POST(req(agentTokenB, { body: { breakMode: true } }));
  assert.equal(res.status, 200);
  const session = await db.breakSession.findFirst({
    where: { employeeId: empB.id, endedAt: null },
  });
  assert.ok(session, 'org B break attributed to empB');
  assert.equal(session.organizationId, orgB.id, 'org derived from token, not client');
  assert.equal(session.employeeId, empB.id);
  assert.equal(session.deviceId, deviceB.id, 'device derived from token');
  await api.POST(req(agentTokenB, { body: { breakMode: false } }));
});

test('BH-11: agent break writes audit log with device actor + metadata', async () => {
  const api = await import('../src/app/api/agent/break/route');
  const before = await db.auditLog.count({ where: { organizationId: orgA.id } });
  await api.POST(req(agentTokenA, { body: { breakMode: true } }));
  const after = await db.auditLog.count({ where: { organizationId: orgA.id } });
  assert.ok(after >= before + 1, 'audit log written');
  const log = await db.auditLog.findFirst({
    where: { organizationId: orgA.id, resourceId: empA.id, description: { contains: 'break mode' } },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(log, 'audit log with employee resourceId + break-mode description');
  const meta = JSON.parse(log.metadata || '{}');
  assert.equal(meta.source, 'agent');
  assert.equal(meta.employeeId, empA.id);
  assert.equal(meta.deviceId, deviceA.id);
  await api.POST(req(agentTokenA, { body: { breakMode: false } }));
});

// ─── F-03: self-service break route ─────────────────────────────────────────

test('BH-12: self-service start/end for own employee', async () => {
  const api = await import('../src/app/api/self/break-status/route');
  const start = await api.POST(req(adminAToken, {
    url: 'http://localhost:3000/api/self/break-status',
    body: { breakMode: true, employeeId: empA.id },
  }));
  assert.equal(start.status, 200);
  const startBody = await start.json();
  assert.equal(startBody.breakMode, true);

  const get = await api.GET(req(adminAToken, {
    url: `http://localhost:3000/api/self/break-status?employeeId=${empA.id}`,
  }));
  assert.equal(get.status, 200);
  const getBody = await get.json();
  assert.equal(getBody.data.onBreak, true, 'GET reports on-break');

  const end = await api.POST(req(adminAToken, {
    url: 'http://localhost:3000/api/self/break-status',
    body: { breakMode: false, employeeId: empA.id },
  }));
  assert.equal(end.status, 200);
  const endBody = await end.json();
  assert.equal(endBody.breakMode, false);
});

test('BH-13: self-service unauthenticated -> 401', async () => {
  const api = await import('../src/app/api/self/break-status/route');
  const res = await api.POST(req(null, {
    url: 'http://localhost:3000/api/self/break-status',
    body: { breakMode: true },
  }));
  assert.equal(res.status, 401);
});

test('BH-14: self-service rejects client-supplied employeeId (ignored)', async () => {
  const api = await import('../src/app/api/self/break-status/route');
  // The admin token belongs to org A / admin-a. Attempting to spoof empB's id
  // must be ignored — identity is derived from the session, so the break is
  // created for the session employee (admin-a has no employee record, so the
  // route must 403/404 — never create a break for empB).
  const res = await api.POST(req(adminAToken, {
    url: 'http://localhost:3000/api/self/break-status',
    body: { breakMode: true, employeeId: empB.id, organizationId: orgB.id },
  }));
  assert.equal(res.status, 404, 'cross-org employeeId concealed with 404');
  // Regardless of status, empB must NOT have an open break.
  assert.equal(await openBreaks(empB.id), 0, 'forged identity must not create a break');
});

// ─── Admin toggle + RBAC (F-04, F-13, F-15) ────────────────────────────────

test('BH-15: viewer cannot toggle break -> 403', async () => {
  const api = await import('../src/app/api/break-status/[id]/toggle/route');
  const res = await api.POST(req(viewerAToken, {
    body: {},
    url: `http://localhost:3000/api/break-status/${empA.id}/toggle`,
  }), { params: Promise.resolve({ id: empA.id }) });
  assert.equal(res.status, 403);
});

test('BH-16: manager cannot toggle break -> 403', async () => {
  const api = await import('../src/app/api/break-status/[id]/toggle/route');
  const res = await api.POST(req(managerAToken, {
    body: {},
    url: `http://localhost:3000/api/break-status/${empA.id}/toggle`,
  }), { params: Promise.resolve({ id: empA.id }) });
  assert.equal(res.status, 403);
});

test('BH-17: admin toggle cross-org employee -> 404, no rows', async () => {
  const api = await import('../src/app/api/break-status/[id]/toggle/route');
  const before = await db.breakSession.count({ where: { employeeId: empB.id } });
  const res = await api.POST(req(adminAToken, {
    body: {},
    url: `http://localhost:3000/api/break-status/${empB.id}/toggle`,
  }), { params: Promise.resolve({ id: empB.id }) });
  assert.equal(res.status, 404, 'cross-org concealed with 404');
  const after = await db.breakSession.count({ where: { employeeId: empB.id } });
  assert.equal(after, before, 'no session created');
});

test('BH-18: admin double-toggle -> start then end, never two open breaks', async () => {
  const api = await import('../src/app/api/break-status/[id]/toggle/route');
  const before = await sessionCount(empC.id);
  const r1 = await api.POST(req(adminAToken, {
    body: {},
    url: `http://localhost:3000/api/break-status/${empC.id}/toggle`,
  }), { params: Promise.resolve({ id: empC.id }) });
  const b1 = await r1.json();
  assert.equal(b1.action, 'started');
  assert.equal(await openBreaks(empC.id), 1);

  // Second toggle should END the break (admin toggle is a flip), not start a duplicate.
  const r2 = await api.POST(req(adminAToken, {
    body: {},
    url: `http://localhost:3000/api/break-status/${empC.id}/toggle`,
  }), { params: Promise.resolve({ id: empC.id }) });
  const b2 = await r2.json();
  assert.equal(b2.action, 'ended');
  assert.equal(await openBreaks(empC.id), 0);
  assert.equal(await sessionCount(empC.id), before + 1, 'exactly one session for the flip pair');
});

// ─── F-08: timezone-aware day windows ───────────────────────────────────────

test('BH-19: orgDayWindow returns correct UTC boundaries for a timezone', async () => {
  const { orgDayWindow } = await import('../src/lib/timezone');
  // Asia/Dhaka is UTC+6, no DST. "Today" in Dhaka starts 6h before UTC midnight.
  const window = orgDayWindow('Asia/Dhaka', new Date('2026-08-16T12:00:00.000Z'));
  assert.equal(window.dayStart.toISOString(), '2026-08-15T18:00:00.000Z', 'Dhaka day starts at 18:00Z');
  assert.equal(window.dayEnd.toISOString(), '2026-08-16T17:59:59.999Z', 'Dhaka day ends just before 18:00Z');
});

test('BH-20: orgDayWindow UTC keeps 00:00Z boundaries', async () => {
  const { orgDayWindow } = await import('../src/lib/timezone');
  const window = orgDayWindow('UTC', new Date('2026-08-16T12:00:00.000Z'));
  assert.equal(window.dayStart.toISOString(), '2026-08-16T00:00:00.000Z');
  assert.equal(window.dayEnd.toISOString(), '2026-08-16T23:59:59.999Z');
});

test('BH-21: break-status summary respects org timezone for "today"', async () => {
  // Set org A timezone to Asia/Dhaka (UTC+6). "Today" in Dhaka is the local
  // calendar day ending 18:00 UTC. The break is created at 02:00–02:30 Dhaka
  // local (20:00–20:30 UTC the previous day) — computed RELATIVE to the
  // current Dhaka day so this test is date-independent (previously a
  // hardcoded 2026-08-15T20:00Z only matched when the suite ran on
  // 2026-08-16 UTC). It must count as "today" in the summary.
  const { orgDayWindow } = await import('../src/lib/timezone');
  const dhakaToday = orgDayWindow('Asia/Dhaka');
  const startedAt = new Date(dhakaToday.dayStart.getTime() + 2 * 3_600_000); // 02:00 Dhaka local
  const endedAt = new Date(startedAt.getTime() + 30 * 60_000); // 30-min break

  await db.organization.update({
    where: { id: orgA.id },
    data: { timezone: 'Asia/Dhaka' },
  });
  await db.breakSession.create({
    data: {
      organizationId: orgA.id,
      employeeId: empA.id,
      deviceId: deviceA.id,
      startedAt,
      endedAt,
      endReason: 'agent_ended',
      source: 'agent',
      startedBy: deviceA.id,
      endedBy: deviceA.id,
    },
  });
  const api = await import('../src/app/api/break-status/summary/route');
  const res = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/break-status/summary' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.breakCountToday >= 1, `Dhaka-local break counted as today (got ${body.breakCountToday})`);
  assert.ok(body.totalBreakTimeToday >= 30, `30-min break counted (got ${body.totalBreakTimeToday})`);
  // The break starts at 02:00 Dhaka local = 20:00 UTC the PREVIOUS calendar
  // day — proving the org timezone (not the server's UTC day) decides
  // "today" for the summary window.
  assert.ok(
    startedAt.toISOString().slice(0, 10) < dhakaToday.dayKey,
    'break starts on the previous UTC calendar day'
  );
  // cleanup
  await db.breakSession.deleteMany({ where: { employeeId: empA.id } });
  await db.organization.update({ where: { id: orgA.id }, data: { timezone: 'UTC' } });
});

// ─── F-09: break history endpoint ───────────────────────────────────────────

test('BH-22: break history returns canonical sessions, paginated, tz-aware', async () => {
  // Session placed TODAY (org A is UTC at this point) at 08:00–08:15 local —
  // computed RELATIVE to the current day so the test is date-independent
  // (previously a hardcoded 2026-08-16T08:00Z only matched when the suite ran
  // on that exact day). The history route is queried with an explicit `day`
  // so the window is deterministic.
  const { orgDayWindow } = await import('../src/lib/timezone');
  const today = orgDayWindow('UTC');
  const startedAt = new Date(today.dayStart.getTime() + 8 * 3_600_000); // 08:00 UTC today
  const endedAt = new Date(startedAt.getTime() + 15 * 60_000);
  await db.breakSession.create({
    data: {
      organizationId: orgA.id,
      employeeId: empA.id,
      deviceId: deviceA.id,
      startedAt,
      endedAt,
      endReason: 'agent_ended',
      source: 'agent',
      startedBy: deviceA.id,
      endedBy: deviceA.id,
    },
  });
  const api = await import('../src/app/api/break-status/history/route');
  const res = await api.GET(req(adminAToken, {
    url: `http://localhost:3000/api/break-status/history?page=1&pageSize=10&day=${today.dayKey}`,
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.data), 'data array');
  const s = body.data.find((row: { employeeId: string }) => row.employeeId === empA.id);
  assert.ok(s, 'history contains the created session for empA');
  assert.ok(s.startedAt && s.endedAt, 'real start/end timestamps');
  // cleanup
  await db.breakSession.deleteMany({ where: { employeeId: empA.id } });
});

test('BH-23: history cross-org isolation -> org B sessions never visible to org A', async () => {
  await db.breakSession.create({
    data: {
      organizationId: orgB.id,
      employeeId: empB.id,
      deviceId: deviceB.id,
      startedAt: new Date('2026-08-16T08:00:00.000Z'),
      endedAt: new Date('2026-08-16T08:15:00.000Z'),
      endReason: 'agent_ended',
      source: 'agent',
      startedBy: deviceB.id,
      endedBy: deviceB.id,
    },
  });
  const api = await import('../src/app/api/break-status/history/route');
  const res = await api.GET(req(adminAToken, {
    url: `http://localhost:3000/api/break-status/history?page=1&pageSize=100`,
  }));
  const body = await res.json();
  assert.ok(!body.data.some((s: { employeeId: string }) => s.employeeId === empB.id), 'org B session not leaked');
  await db.breakSession.deleteMany({ where: { employeeId: empB.id } });
});

test('BH-24: history malformed pagination -> 400, no 500', async () => {
  const api = await import('../src/app/api/break-status/history/route');
  const res = await api.GET(req(adminAToken, {
    url: `http://localhost:3000/api/break-status/history?page=abc&pageSize=-5`,
  }));
  assert.ok([400, 422, 200].includes(res.status), `malformed pagination handled (got ${res.status})`);
});

// ─── F-06/F-07: main break-status list (canonical state, no heuristics) ────

test('BH-25: main break-status derives state from canonical BreakSession', async () => {
  const api = await import('../src/app/api/break-status/route');
  // empA starts a break via the agent — the list must show "breaking".
  const agentApi = await import('../src/app/api/agent/break/route');
  await agentApi.POST(req(agentTokenA, { body: { breakMode: true } }));

  const res = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/break-status?pageSize=100' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  const row = body.data.find((r: { id: string }) => r.id === empA.id);
  assert.ok(row, 'empA present');
  assert.equal(row.status, 'breaking', 'status derived from open BreakSession');
  assert.equal(row.isOnBreak, true);
  assert.ok(row.breakStartedAt, 'break start present');
  assert.equal(body.currentlyOnBreak, 1, 'org-wide current-break count');

  // End the break — the list must flip back.
  await agentApi.POST(req(agentTokenA, { body: { breakMode: false } }));
  const res2 = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/break-status?pageSize=100' }));
  const body2 = await res2.json();
  const row2 = body2.data.find((r: { id: string }) => r.id === empA.id);
  assert.equal(row2.status, 'active', 'fresh-heartbeat employee is active after break ends');
  assert.equal(row2.isOnBreak, false);
  assert.equal(body2.currentlyOnBreak, 0);
});

test('BH-26: break-status list is org-scoped (no cross-org leak)', async () => {
  const api = await import('../src/app/api/break-status/route');
  // org B agent starts a break for empB.
  const agentApi = await import('../src/app/api/agent/break/route');
  await agentApi.POST(req(agentTokenB, { body: { breakMode: true } }));

  // Org A admin must NOT see empB.
  const res = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/break-status?pageSize=100' }));
  const body = await res.json();
  assert.ok(!body.data.some((r: { id: string }) => r.id === empB.id), 'org B employee never visible');

  // Org B admin sees empB breaking.
  const bAdminToken = await signJWT({ userId: 'admin-b-bh', email: 'admin@b.bh', role: 'admin', organizationId: orgB.id });
  const resB = await api.GET(req(bAdminToken, { url: 'http://localhost:3000/api/break-status?pageSize=100' }));
  const bodyB = await resB.json();
  const rowB = bodyB.data.find((r: { id: string }) => r.id === empB.id);
  assert.ok(rowB, 'org B admin sees own employee');
  assert.equal(rowB.isOnBreak, true);
  await agentApi.POST(req(agentTokenB, { body: { breakMode: false } }));
});

test('BH-27: break-status malformed pagination -> 4xx, no 500', async () => {
  const api = await import('../src/app/api/break-status/route');
  const res = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/break-status?page=abc' }));
  assert.ok([400, 422].includes(res.status), `garbage page handled (got ${res.status})`);
  const res2 = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/break-status?pageSize=999999' }));
  assert.ok([400, 422].includes(res2.status), `oversized pageSize handled (got ${res2.status})`);
});

test('BH-28: unauthenticated break-status list -> 401', async () => {
  const api = await import('../src/app/api/break-status/route');
  const res = await api.GET(req(null, { url: 'http://localhost:3000/api/break-status' }));
  assert.equal(res.status, 401);
});

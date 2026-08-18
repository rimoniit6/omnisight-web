/**
 * Global Employee Live Presence — regression tests.
 *
 * Covers:
 *   - the pure presence helpers (freshness window, multi-device ANY, lastSeen)
 *   - the mini-service presence derivation (transition-only events, offline
 *     sweep, boot warm, no spam on repeated heartbeats)
 *   - GET /api/employees/presence (snapshot):
 *       * auth: 401 anonymous, 200 for org-scoped roles (same visibility as
 *         the employees list), empty for org-less super_admin
 *       * tenant isolation: ORG A never sees ORG B; forged organizationId
 *         ignored (session org is authoritative)
 *       * freshness: fresh heartbeat → online, stale/absent → offline
 *       * no activity/screenshot/device detail leakage (ids + booleans only)
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_presence).
 * Run: npx tsx --test tests/presence.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation (must be set BEFORE any app module import) ──────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_presence';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-presence-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

before(() => {
  if (process.env.PRESENCE_TEST_MIGRATED_DB !== '1') {
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
type PresenceApi = typeof import('../src/app/api/employees/presence/route');
let presenceApi: PresenceApi;

const THRESHOLD_MS = 5 * 60 * 1000; // must match src/lib/presence.ts default

function req(token: string | null, url: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  return new NextRequest(new URL(url, 'http://localhost:3000'), { headers });
}

async function getPresence(token: string | null, qs = '') {
  const res = await presenceApi.GET(req(token, `/api/employees/presence${qs}`));
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  presenceApi = await import('../src/app/api/employees/presence/route');
});

after(async () => {
  await db.$disconnect();
  if (process.env.PRESENCE_TEST_MIGRATED_DB !== '1') {
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

let orgAId: string;
let orgBId: string;
let empAId: string;
let empBId: string;
let empAOfflineId: string;
let tokenA: string;
let tokenB: string;
let viewerA: string;
let globalAdmin: string;

test('PR-00: seed ORG A + ORG B with known device/heartbeat state', async () => {
  orgAId = (await db.organization.create({ data: { name: 'PR ORG A', slug: 'pr-org-a', status: 'active' } })).id;
  orgBId = (await db.organization.create({ data: { name: 'PR ORG B', slug: 'pr-org-b', status: 'active' } })).id;
  empAId = (await db.employee.create({ data: { employeeId: 'PR-EMP-A', firstName: 'A', lastName: 'Online', email: 'pr-a@example.com', organizationId: orgAId } })).id;
  empAOfflineId = (await db.employee.create({ data: { employeeId: 'PR-EMP-A2', firstName: 'A2', lastName: 'Offline', email: 'pr-a2@example.com', organizationId: orgAId } })).id;
  empBId = (await db.employee.create({ data: { employeeId: 'PR-EMP-B', firstName: 'B', lastName: 'Online', email: 'pr-b@example.com', organizationId: orgBId } })).id;

  const now = new Date();

  // ORG A: one fresh device (online), one stale device (offline),
  // one employee with NO device at all (offline).
  await db.device.create({
    data: {
      name: 'PR-device-A-fresh',
      organizationId: orgAId,
      employeeId: empAId,
      status: 'online',
      lastHeartbeat: new Date(now.getTime() - 60_000), // 1 min ago → online
    },
  });
  await db.device.create({
    data: {
      name: 'PR-device-A-stale',
      organizationId: orgAId,
      employeeId: empAOfflineId,
      status: 'online', // sticky status — must NOT count as presence
      lastHeartbeat: new Date(now.getTime() - THRESHOLD_MS - 60_000), // stale
    },
  });
  // ORG B: fresh device.
  await db.device.create({
    data: {
      name: 'PR-device-B-fresh',
      organizationId: orgBId,
      employeeId: empBId,
      status: 'online',
      lastHeartbeat: new Date(now.getTime() - 30_000),
    },
  });

  tokenA = await signJWT({ userId: 'u-a', email: 'admin-a@example.com', role: 'admin', organizationId: orgAId });
  tokenB = await signJWT({ userId: 'u-b', email: 'admin-b@example.com', role: 'admin', organizationId: orgBId });
  viewerA = await signJWT({ userId: 'u-av', email: 'viewer-a@example.com', role: 'viewer', organizationId: orgAId });
  globalAdmin = await signJWT({ userId: 'u-g', email: 'super@example.com', role: 'super_admin' });
});

// ─── Pure helpers ───────────────────────────────────────────────────────────

test('PR-01: isHeartbeatFresh — recent → true, stale → false, null → false', async () => {
  const { isHeartbeatFresh, EMPLOYEE_ONLINE_THRESHOLD_MS } = await import('../src/lib/presence');
  assert.equal(EMPLOYEE_ONLINE_THRESHOLD_MS, THRESHOLD_MS, 'threshold must stay 5 minutes');
  const now = new Date();
  assert.equal(isHeartbeatFresh(new Date(now.getTime() - 10_000), now), true);
  assert.equal(isHeartbeatFresh(new Date(now.getTime() - THRESHOLD_MS), now), true); // exactly at boundary
  assert.equal(isHeartbeatFresh(new Date(now.getTime() - THRESHOLD_MS - 1), now), false);
  assert.equal(isHeartbeatFresh(null, now), false);
});

test('PR-02: deriveEmployeePresence — multi-device ANY, max lastSeenAt', async () => {
  const { deriveEmployeePresence } = await import('../src/lib/presence');
  type Row = { employeeId: string | null; lastHeartbeat: Date | null };
  const now = new Date();
  const map = deriveEmployeePresence(
    [
      { employeeId: 'e1', lastHeartbeat: new Date(now.getTime() - 10_000) },
      { employeeId: 'e2', lastHeartbeat: new Date(now.getTime() - THRESHOLD_MS - 1000) },
      { employeeId: 'e3', lastHeartbeat: null },
      { employeeId: null, lastHeartbeat: new Date(now.getTime() - 5_000) }, // unassigned → ignored
      { employeeId: 'e1', lastHeartbeat: new Date(now.getTime() - 200_000) }, // older second device
    ] satisfies Row[],
    now
  );
  assert.equal(map.get('e1')?.online, true);
  assert.equal(map.get('e2')?.online, false);
  assert.equal(map.get('e3')?.online, false);
  assert.equal(map.has('e1'), true);
  assert.equal(map.size, 3, 'unassigned devices are ignored');
  // lastSeenAt = NEWEST heartbeat across devices
  assert.equal(map.get('e1')?.lastSeenAt, new Date(now.getTime() - 10_000).toISOString());
});

// ─── Snapshot API: auth + RBAC ──────────────────────────────────────────────

test('PR-03: snapshot — unauthenticated → 401', async () => {
  const { status } = await getPresence(null);
  assert.equal(status, 401);
});

test('PR-04: snapshot — viewer (same visibility as employees list) → 200', async () => {
  const { status } = await getPresence(viewerA);
  assert.equal(status, 200);
});

test('PR-05: snapshot — org-less super_admin → empty map (no cross-tenant data)', async () => {
  const { status, json } = await getPresence(globalAdmin);
  assert.equal(status, 200);
  assert.deepEqual(json.employees, {});
});

// ─── Snapshot API: correctness + tenant isolation ──────────────────────────

test('PR-06: snapshot — ORG A sees fresh employee online, stale + no-device offline', async () => {
  const { status, json } = await getPresence(tokenA);
  assert.equal(status, 200);
  const employees = json.employees as Record<string, { online: boolean; lastSeenAt: string | null }>;
  assert.equal(employees[empAId]?.online, true, 'fresh heartbeat must be online');
  assert.ok(employees[empAId]?.lastSeenAt, 'lastSeenAt present for online employee');
  assert.equal(employees[empAOfflineId]?.online, false, 'stale heartbeat must be offline');
  assert.ok(employees[empAOfflineId]?.lastSeenAt, 'offline employee still carries lastSeenAt');
  assert.equal(employees[empBId], undefined, 'ORG B employee must not appear in ORG A snapshot');
});

test('PR-07: tenant isolation — ORG B never sees ORG A; forged organizationId ignored', async () => {
  const { json } = await getPresence(tokenB);
  const employees = json.employees as Record<string, { online: boolean }>;
  assert.equal(employees[empBId]?.online, true);
  assert.equal(employees[empAId], undefined, 'ORG A employee leaked into ORG B snapshot');

  // Forged organizationId in the query string must be ignored (session is
  // the only authority) — same payload as the clean ORG A request.
  const forged = await getPresence(tokenA, '?organizationId=some-other-org');
  const forgedEmployees = forged.json.employees as Record<string, { online: boolean }>;
  assert.equal(forgedEmployees[empAId]?.online, true, 'session org still authoritative');
  assert.equal(forgedEmployees[empBId], undefined);
});

test('PR-08: snapshot — forged employeeId cannot alter another employee', async () => {
  // employeeId is not even an input of this endpoint; requesting with a
  // foreign employeeId query must not change the org-scoped result.
  const { json } = await getPresence(tokenA, `?employeeId=${empBId}`);
  const employees = json.employees as Record<string, { online: boolean }>;
  assert.equal(employees[empAId]?.online, true);
  assert.equal(employees[empBId], undefined);
});

test('PR-09: snapshot — payload exposes ids + booleans only (no device/activity detail)', async () => {
  const { json } = await getPresence(tokenA);
  const employees = json.employees as Record<string, { online: boolean; lastSeenAt: string | null }>;
  const sample = employees[empAId];
  assert.deepEqual(Object.keys(sample).sort(), ['lastSeenAt', 'online']);
  assert.equal(typeof sample.online, 'boolean');
  assert.ok(typeof sample.lastSeenAt === 'string' || sample.lastSeenAt === null);
});

// ─── Mini-service presence derivation (transition-only events) ─────────────

type PresenceMap = import('../mini-services/live-updates/presence').PresenceMap;

test('PR-10: offline → online emits ONE event; repeated fresh heartbeats emit none', async () => {
  const mod = await import('../mini-services/live-updates/presence');
  const map: PresenceMap = new Map();
  const now = new Date('2026-08-13T12:00:00.000Z');

  const dev = (hb: Date) => ({
    employeeId: 'e1',
    organizationId: 'orgA',
    lastHeartbeat: hb,
    employeeName: 'Rimon Rana',
  });

  // First fresh heartbeat → offline(unknown) → online transition.
  const e1 = mod.derivePresenceEvents(map, [dev(new Date(now.getTime() - 5_000))], now);
  assert.equal(e1.length, 1);
  assert.equal(e1[0].online, true);
  assert.equal(e1[0].employeeName, 'Rimon Rana');

  // Second fresh heartbeat (still online) → NO event (no spam).
  const e2 = mod.derivePresenceEvents(map, [dev(new Date(now.getTime() - 2_000))], now);
  assert.equal(e2.length, 0, 'a fresh heartbeat on an online employee must not emit');
});

test('PR-11: online → offline via sweep (no new heartbeat) emits exactly one event', async () => {
  const mod = await import('../mini-services/live-updates/presence');
  const map: PresenceMap = new Map();
  const t0 = new Date('2026-08-13T12:00:00.000Z');

  mod.derivePresenceEvents(map, [{ employeeId: 'e2', organizationId: 'orgA', lastHeartbeat: new Date(t0.getTime() - 1_000), employeeName: 'A' }], t0);
  assert.equal(map.get('e2')?.online, true);

  // 5 min later no heartbeat arrived → sweep flips offline.
  const t1 = new Date(t0.getTime() + mod.EMPLOYEE_ONLINE_THRESHOLD_MS + 1_000);
  const events = mod.derivePresenceEvents(map, [], t1);
  assert.equal(events.length, 1);
  assert.equal(events[0].online, false);
  assert.equal(events[0].employeeId, 'e2');
  // lastSeenAt stays at the LAST OBSERVED heartbeat even when offline.
  assert.equal(events[0].lastSeenAt, new Date(t0.getTime() - 1_000).toISOString());

  // And it does not re-emit every poll afterwards.
  const again = mod.derivePresenceEvents(map, [], new Date(t1.getTime() + 10_000));
  assert.equal(again.length, 0, 'offline employee must not re-emit offline every poll');
});

test('PR-12: multi-device — ANY fresh device keeps employee online; all stale → offline', async () => {
  const mod = await import('../mini-services/live-updates/presence');
  const map: PresenceMap = new Map();
  const t0 = new Date('2026-08-13T12:00:00.000Z');

  const dev = (id: string, hb: Date) => ({
    employeeId: 'e3',
    organizationId: 'orgA',
    lastHeartbeat: hb,
    employeeName: 'Multi',
  });

  // Device 1 fresh → online.
  mod.derivePresenceEvents(map, [dev('d1', new Date(t0.getTime() - 10_000))], t0);
  assert.equal(map.get('e3')?.online, true);

  // Device 1 goes stale but device 2 still fresh → stays online, no event.
  const t1 = new Date(t0.getTime() + mod.EMPLOYEE_ONLINE_THRESHOLD_MS + 5_000);
  const e1 = mod.derivePresenceEvents(map, [dev('d2', new Date(t1.getTime() - 5_000))], t1);
  assert.equal(map.get('e3')?.online, true);
  assert.equal(e1.length, 0, 'still online → no transition event');

  // All devices stale → offline.
  const t2 = new Date(t1.getTime() + mod.EMPLOYEE_ONLINE_THRESHOLD_MS + 5_000);
  const e2 = mod.derivePresenceEvents(map, [], t2);
  assert.equal(e2.length, 1);
  assert.equal(e2[0].online, false);
});

test('PR-13: warmPresenceMap populates state without emitting', async () => {
  const mod = await import('../mini-services/live-updates/presence');
  const map: PresenceMap = new Map();
  const now = new Date('2026-08-13T12:00:00.000Z');
  mod.warmPresenceMap(
    map,
    [
      { employeeId: 'e4', organizationId: 'orgA', lastHeartbeat: new Date(now.getTime() - 5_000), employeeName: 'Warm' },
      { employeeId: 'e5', organizationId: 'orgA', lastHeartbeat: new Date(now.getTime() - THRESHOLD_MS - 5_000), employeeName: 'Cold' },
    ],
    now
  );
  assert.equal(map.get('e4')?.online, true);
  assert.equal(map.get('e5')?.online, false);
  // A fresh heartbeat after warm → no spurious event (already online).
  const events = mod.derivePresenceEvents(map, [{ employeeId: 'e4', organizationId: 'orgA', lastHeartbeat: new Date(now.getTime() - 1_000), employeeName: 'Warm' }], now);
  assert.equal(events.length, 0);
});

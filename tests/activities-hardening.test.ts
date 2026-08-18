/**
 * Admin Overview — Activities production hardening — regression tests.
 *
 * Covers every P1/P2 fix from ADMIN-OVERVIEW-ACTIVITIES-FINAL-AUDIT.md:
 *
 *   P1-1  ACT-01..03  NULL-safe internal-agent exclusion: NULL applicationName
 *                     rows (website/idle/screenshot/work_session) preserved,
 *                     only real internal-agent processes hidden, SQL path
 *                     agrees with the JS helper.
 *   P1-2  ACT-04,05   Same-day range + org-local (Asia/Dhaka) day boundaries.
 *   P2-1  ACT-06..08   Strict pagination validation (400/422, capped pageSize).
 *   P2-2  ACT-09,10   Server-side search actually filters, combined with
 *                     pagination and tenant isolation.
 *   P2-3  ACT-11,18   Employee timeline pagination: complete dataset reachable,
 *                     no duplicates/missing rows; export loop == total.
 *   P2-4  ACT-12      summary stats are DB-wide (full matching dataset), never
 *                     the current page.
 *   Security ACT-14,15  Foreign employeeId → zero rows; forged organizationId
 *                     ignored (session org authoritative).
 *   UX/err ACT-16,17  Empty state; invalid dates → 422 (never 500).
 *   Extra  ACT-19      Detail route stats ↔ paginated timeline agreement
 *                     (the original 49-vs-19 divergence).
 *   Extra  ACT-20      Daily route: org-local buckets + days validation.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_activities).
 * Run: npx tsx --test tests/activities-hardening.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';
import { localDayKey } from '../src/lib/timezone';

// ─── Test DB isolation (must be set BEFORE any app module import) ──────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_activities';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-activities-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

before(() => {
  if (process.env.ACTIVITIES_TEST_MIGRATED_DB !== '1') {
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
type ActivitiesApi = typeof import('../src/app/api/activities/route');
let activitiesApi: ActivitiesApi;
type EmployeeActivitiesApi = typeof import('../src/app/api/employees/[id]/activities/route');
let employeeActivitiesApi: EmployeeActivitiesApi;
type DetailApi = typeof import('../src/app/api/employees/[id]/detail/route');
let detailApi: DetailApi;
type DailyApi = typeof import('../src/app/api/activities/daily/route');
let dailyApi: DailyApi;

function req(token: string | null, url: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  return new NextRequest(new URL(url, 'http://localhost:3000'), { headers });
}

async function getActivities(token: string | null, qs = '') {
  const res = await activitiesApi.GET(req(token, `/api/activities${qs}`));
  const json = (await res.json()) as Record<string, any>;
  return { status: res.status, json };
}

async function getEmpActivities(token: string | null, id: string, qs = '') {
  const res = await employeeActivitiesApi.GET(req(token, `/api/employees/${id}/activities${qs}`), {
    params: Promise.resolve({ id }),
  });
  const json = (await res.json()) as Record<string, any>;
  return { status: res.status, json };
}

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  activitiesApi = await import('../src/app/api/activities/route');
  employeeActivitiesApi = await import('../src/app/api/employees/[id]/activities/route');
  detailApi = await import('../src/app/api/employees/[id]/detail/route');
  dailyApi = await import('../src/app/api/activities/daily/route');
});

after(async () => {
  await db.$disconnect();
  if (process.env.ACTIVITIES_TEST_MIGRATED_DB !== '1') {
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
let empManyId: string;
let deviceAId: string;
let tokenA: string;
let viewerA: string;

// Org-local day key (orgs default to Asia/Dhaka, matching the schema).
// The routes bucket by the ORG-LOCAL calendar day — a UTC day key would
// shift after 18:00 UTC (Dhaka midnight) and make these assertions
// time-of-day dependent.
const todayKey = localDayKey(new Date(), 'Asia/Dhaka');

test('ACT-00: seed ORG A + ORG B with employees, devices and mixed activities', async () => {
  orgAId = (await db.organization.create({ data: { name: 'ACT ORG A', slug: 'act-org-a', status: 'active' } })).id;
  orgBId = (await db.organization.create({ data: { name: 'ACT ORG B', slug: 'act-org-b', status: 'active' } })).id;
  empAId = (await db.employee.create({
    data: { employeeId: 'ACT-EMP-A', firstName: 'Alpha', lastName: 'Worker', email: 'alpha@a.example', organizationId: orgAId },
  })).id;
  empBId = (await db.employee.create({
    data: { employeeId: 'ACT-EMP-B', firstName: 'Beta', lastName: 'Other', email: 'beta@b.example', organizationId: orgBId },
  })).id;
  empManyId = (await db.employee.create({
    data: { employeeId: 'ACT-EMP-MANY', firstName: 'Many', lastName: 'Rows', email: 'many@a.example', organizationId: orgAId },
  })).id;
  deviceAId = (await db.device.create({
    data: { name: 'ACT-DEVICE', employeeId: empAId, organizationId: orgAId, status: 'online' },
  })).id;

  // ORG A employee — mixed rows:
  //   - 1 internal-agent row (MUST be excluded)
  //   - 1 normal application row (MUST be included)
  //   - website / idle / screenshot / work_session rows with NULL applicationName
  //     (MUST be included — this was the P1-1 63%-hidden bug)
  await db.activity.createMany({
    data: [
      { type: 'application', applicationName: 'WorkLensAIAgent.exe', category: 'neutral', duration: 100, employeeId: empAId, deviceId: deviceAId, timestamp: new Date() },
      { type: 'application', applicationName: 'chrome.exe', category: 'productive', duration: 200, employeeId: empAId, deviceId: deviceAId, timestamp: new Date() },
      { type: 'website', applicationName: null, url: 'github.com', category: 'productive', duration: 300, employeeId: empAId, deviceId: deviceAId, timestamp: new Date() },
      { type: 'idle', applicationName: null, category: 'neutral', duration: 400, employeeId: empAId, deviceId: deviceAId, timestamp: new Date() },
      { type: 'screenshot', applicationName: null, category: 'neutral', duration: 50, employeeId: empAId, deviceId: deviceAId, timestamp: new Date() },
      { type: 'work_session', applicationName: null, category: 'neutral', duration: 600, employeeId: empAId, deviceId: deviceAId, timestamp: new Date() },
    ],
  });

  // ORG B employee — a few rows (used for tenant isolation).
  await db.activity.createMany({
    data: [
      { type: 'application', applicationName: 'excel.exe', category: 'productive', duration: 111, employeeId: empBId, timestamp: new Date() },
      { type: 'website', applicationName: null, url: 'b.example', category: 'neutral', duration: 222, employeeId: empBId, timestamp: new Date() },
    ],
  });

  // ORG A "many rows" employee — 120 application rows for pagination/export tests.
  await db.activity.createMany({
    data: Array.from({ length: 120 }, (_, i) => ({
      type: 'application' as const,
      applicationName: `app-${i}.exe`,
      category: (i % 2 === 0 ? 'productive' : 'neutral') as 'productive' | 'neutral',
      duration: 60,
      employeeId: empManyId,
      timestamp: new Date(Date.now() - i * 60000),
    })),
  });

  tokenA = await signJWT({ userId: 'u-a', email: 'admin@a.example', role: 'admin', organizationId: orgAId });
  await signJWT({ userId: 'u-b', email: 'admin@b.example', role: 'admin', organizationId: orgBId });
  viewerA = await signJWT({ userId: 'u-v', email: 'viewer@a.example', role: 'viewer', organizationId: orgAId });
});

// ── P1-1 NULL-safe exclusion ───────────────────────────────────────────────

test('ACT-01: NULL applicationName rows are preserved (website/idle/screenshot/work_session)', async () => {
  const { status, json } = await getActivities(tokenA, '?employeeId=' + empAId);
  assert.equal(status, 200);
  const types = json.data.map((a: any) => a.type);
  assert.ok(types.includes('website'), 'website row with NULL appName must be visible');
  assert.ok(types.includes('idle'), 'idle row with NULL appName must be visible');
  assert.ok(types.includes('screenshot'), 'screenshot row with NULL appName must be visible');
  assert.ok(types.includes('work_session'), 'work_session row with NULL appName must be visible');
  assert.ok(types.includes('application'), 'application row must be visible');
});

test('ACT-02: internal-agent rows are excluded (WorkLensAIAgent.exe)', async () => {
  const { status, json } = await getActivities(tokenA, '?employeeId=' + empAId);
  assert.equal(status, 200);
  const apps = json.data.map((a: any) => (a.applicationName || '').toLowerCase());
  assert.ok(!apps.includes('worklensaiagent.exe'), 'internal agent row must be excluded');
  assert.equal(json.total, 5, '5 visible rows (chrome + 4 NULL-appName), 1 internal hidden');
});

test('ACT-03: mixed rows — only actual internal rows excluded, summary matches', async () => {
  const { status, json } = await getActivities(tokenA, '?employeeId=' + empAId);
  assert.equal(status, 200);
  // 5 rows visible, durations 200+300+400+50+600 = 1550
  assert.equal(json.summary.total, 5);
  assert.equal(json.summary.totalDuration, 1550);
  assert.equal(json.summary.productiveTime, 500, 'chrome 200 + website 300');
  assert.equal(json.summary.unproductiveTime, 0);
});

// ── P1-2 org-local date semantics ──────────────────────────────────────────

test('ACT-04: same-day from/to includes the whole day (end-of-day boundary)', async () => {
  // All seeded rows are "now" — today's org-local day must be fully covered.
  const { status, json } = await getActivities(tokenA, `?employeeId=${empAId}&from=${todayKey}&to=${todayKey}`);
  assert.equal(status, 200);
  assert.equal(json.total, 5, 'same-day range must include today\'s 5 rows');
});

test('ACT-05: Asia/Dhaka boundary — 00:30 local lands in the new local day, not the previous', async () => {
  // Org A timezone = Asia/Dhaka (+06). 2026-08-12T18:30:00Z == 2026-08-13 00:30 +06.
  await db.organization.update({ where: { id: orgAId }, data: { timezone: 'Asia/Dhaka' } });
  const boundary = new Date('2026-08-12T18:30:00.000Z');
  await db.activity.create({
    data: { type: 'application', applicationName: 'boundary.exe', category: 'neutral', duration: 30, employeeId: empAId, timestamp: boundary },
  });
  try {
    const inNewDay = await getActivities(tokenA, `?employeeId=${empAId}&from=2026-08-13&to=2026-08-13`);
    assert.equal(inNewDay.status, 200);
    assert.ok(inNewDay.json.data.some((a: any) => a.applicationName === 'boundary.exe'), '00:30 +06 must be in the 13th local day');

    const inPrevDay = await getActivities(tokenA, `?employeeId=${empAId}&from=2026-08-12&to=2026-08-12`);
    assert.equal(inPrevDay.status, 200);
    assert.ok(!inPrevDay.json.data.some((a: any) => a.applicationName === 'boundary.exe'), 'must not leak into the 12th local day');
  } finally {
    // Delete the probe row FIRST so a later reset failure can never leak it,
    // then restore the org's default timezone (field is non-nullable).
    await db.activity.deleteMany({ where: { applicationName: 'boundary.exe' } });
    await db.organization.update({ where: { id: orgAId }, data: { timezone: 'Asia/Dhaka' } });
  }
});

// ── P2-1 pagination validation ─────────────────────────────────────────────

test('ACT-06: invalid page returns 422 (never 500)', async () => {
  for (const qs of ['?page=abc', '?page=-1', '?page=0', '?page=1.5']) {
    const { status, json } = await getActivities(tokenA, qs);
    assert.equal(status, 422, `${qs} must 422`);
    assert.ok(json.error, '422 body must carry an error message');
  }
});

test('ACT-07: invalid pageSize returns 422', async () => {
  for (const qs of ['?pageSize=abc', '?pageSize=0', '?pageSize=-5']) {
    const { status } = await getActivities(tokenA, qs);
    assert.equal(status, 422, `${qs} must 422`);
  }
});

test('ACT-08: excessive pageSize is rejected (no unbounded query)', async () => {
  const { status, json } = await getActivities(tokenA, '?pageSize=999999');
  assert.equal(status, 422);
  assert.match(json.error, /at most/);
});

// ── P2-2 server-side search ────────────────────────────────────────────────

test('ACT-09: search actually filters (application name / website / employee)', async () => {
  const byApp = await getActivities(tokenA, '?search=chrome');
  assert.equal(byApp.json.total, 1);
  assert.equal(byApp.json.data[0].applicationName, 'chrome.exe');

  const byUrl = await getActivities(tokenA, '?search=github');
  assert.equal(byUrl.json.total, 1);
  assert.equal(byUrl.json.data[0].url, 'github.com');

  const byName = await getActivities(tokenA, '?search=alpha');
  assert.equal(byName.json.total, 5, 'employee firstName match covers all Alpha rows');
});

test('ACT-10: search + pagination combine correctly', async () => {
  // empManyId has 120 rows named app-0..app-119; search for 'app-1' matches
  // app-1, app-10..app-19 and app-100..app-119 (31 rows) — page them.
  const page1 = await getActivities(tokenA, `?employeeId=${empManyId}&search=app-1&page=1&pageSize=10`);
  assert.equal(page1.status, 200);
  assert.equal(page1.json.total, 31);
  assert.equal(page1.json.data.length, 10);
  const page4 = await getActivities(tokenA, `?employeeId=${empManyId}&search=app-1&page=4&pageSize=10`);
  assert.equal(page4.json.data.length, 1, 'last page holds the remainder');
  // No overlap between pages.
  const ids1 = new Set(page1.json.data.map((a: any) => a.id));
  const ids4 = new Set(page4.json.data.map((a: any) => a.id));
  assert.equal([...ids1].filter((id) => ids4.has(id)).length, 0, 'pages must not overlap');
});

// ── P2-3 employee timeline pagination ──────────────────────────────────────

test('ACT-11: employee timeline is fully paginated — no silent cap, no dups', async () => {
  let page = 1;
  const seen = new Set<string>();
  let pages = 0;
  for (;;) {
    const { status, json } = await getEmpActivities(tokenA, empManyId, `?page=${page}&pageSize=50`);
    assert.equal(status, 200);
    if (page === 1) assert.equal(json.total, 120, 'complete dataset count');
    for (const a of json.data) {
      assert.ok(!seen.has(a.id), `no duplicate row across pages (${a.id})`);
      seen.add(a.id);
    }
    pages += 1;
    if (!json.totalPages || page >= json.totalPages) break;
    page += 1;
  }
  assert.equal(pages, 3, '120 rows / 50 per page = 3 pages');
  assert.equal(seen.size, 120, 'all 120 rows reachable');
});

test('ACT-12: summary stats are DB-wide, never page-level', async () => {
  const { status, json } = await getActivities(tokenA, `?employeeId=${empManyId}&pageSize=15`);
  assert.equal(status, 200);
  assert.equal(json.data.length, 15, 'page holds 15 rows');
  assert.equal(json.summary.total, 120, 'summary counts the FULL dataset, not the page');
  assert.equal(json.summary.totalDuration, 7200, '120 rows × 60s');
  // productiveTime = even-indexed rows (60 rows × 60s)
  assert.equal(json.summary.productiveTime, 3600);
});

// ── Security: tenant isolation + RBAC ──────────────────────────────────────

test('ACT-13: anonymous → 401', async () => {
  const { status } = await getActivities(null, '');
  assert.equal(status, 401);
});

test('ACT-14: foreign employeeId returns zero rows (no cross-org leak)', async () => {
  const { status, json } = await getActivities(tokenA, '?employeeId=' + empBId);
  assert.equal(status, 200);
  assert.equal(json.total, 0, 'ORG A admin must not see ORG B employee activities');
  assert.deepEqual(json.data, []);
});

test('ACT-15: forged organizationId is ignored (session org authoritative)', async () => {
  const base = await getActivities(tokenA, '');
  const forged = await getActivities(tokenA, '?organizationId=' + orgBId);
  assert.equal(forged.status, 200);
  assert.equal(forged.json.total, base.json.total, 'forged org must not change scope');
  assert.equal(forged.json.total, 125, '125 rows visible to ORG A (5 + 120), no ORG B rows');
});

test('ACT-16: empty state — zero matching rows returns honest empty payload', async () => {
  const { status, json } = await getActivities(tokenA, '?search=zzzz-no-such-term');
  assert.equal(status, 200);
  assert.equal(json.total, 0);
  assert.deepEqual(json.data, []);
  assert.equal(json.summary.total, 0);
});

test('ACT-17: invalid dates return 422 (never 500)', async () => {
  for (const qs of ['?from=notadate', '?to=2026-13-45', '?dateFrom=abc', '?dateTo=2026-02-30']) {
    const { status, json } = await getActivities(tokenA, qs);
    assert.equal(status, 422, `${qs} must 422`);
    assert.ok(json.error);
  }
});

test('ACT-18: export-style full paging sums to the complete dataset', async () => {
  let page = 1;
  let total = 0;
  let count = 0;
  for (;;) {
    const { status, json } = await getEmpActivities(tokenA, empManyId, `?page=${page}&pageSize=100`);
    assert.equal(status, 200);
    if (page === 1) total = json.total;
    count += json.data.length;
    if (!json.totalPages || page >= json.totalPages) break;
    page += 1;
  }
  assert.equal(total, 120);
  assert.equal(count, 120, 'page-loop export must contain every row exactly once');
});

// ── Extra: detail route ↔ timeline agreement (the 49-vs-19 divergence) ─────

test('ACT-19: employee-detail range.totalActivities agrees with the paginated timeline total', async () => {
  // empA has 5 visible rows (plus the internal row which both paths exclude).
  const { status, json } = await getEmpActivities(tokenA, empAId, '?page=1&pageSize=50');
  assert.equal(status, 200);
  assert.equal(json.total, 5);

  const detailRes = await detailApi.GET(req(tokenA, `/api/employees/${empAId}/detail`), {
    params: Promise.resolve({ id: empAId }),
  });
  const detail = await detailRes.json();
  assert.equal(detailRes.status, 200);
  assert.equal(detail.range.totalActivities, 5, 'detail stats must agree with the timeline (NULL rows included)');
  assert.equal(detail.activitiesTotal, 5, 'detail pagination metadata agrees');
});

// ── Extra: daily route (org-local buckets + validation) ────────────────────

test('ACT-20: daily route — org-local buckets, valid days range, invalid days → 422', async () => {
  await db.organization.update({ where: { id: orgAId }, data: { timezone: 'Asia/Dhaka' } });
  try {
    const res = await dailyApi.GET(req(tokenA, `/api/activities/daily?days=7&employeeId=${empAId}`));
    const json = (await res.json()) as Record<string, any>;
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(json.daily));
    assert.equal(json.daily.length, 7, '7 org-local day keys');
    const sumCount = json.daily.reduce((s: number, d: any) => s + d.activityCount, 0);
    assert.equal(sumCount, 5, 'empA visible rows land in today\'s org-local bucket');
    for (const qs of ['?days=abc', '?days=0', '?days=-1', '?days=999999']) {
      const bad = await dailyApi.GET(req(tokenA, '/api/activities/daily' + qs));
      assert.equal(bad.status, 422, `${qs} must 422`);
    }
  } finally {
    // Restore the org's default timezone (field is non-nullable).
    await db.organization.update({ where: { id: orgAId }, data: { timezone: 'Asia/Dhaka' } });
  }
});

test('ACT-21: viewer role can read activities (org-scoped, same data)', async () => {
  const { status, json } = await getActivities(viewerA, '?employeeId=' + empAId);
  assert.equal(status, 200);
  assert.equal(json.total, 5, 'viewer sees the same org-scoped data as admin');
});

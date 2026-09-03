/**
 * Phase 4 — WorkDaySummary aggregation.
 *
 * Covers:
 *  - Pure engine: category totals, active invariant, idle, break-mirror +
 *    internal-agent exclusions, type counts, day attribution across the org
 *    timezone boundary, working/outside-hours split (incl. overnight windows),
 *    invalid durations, break-overlap clipping.
 *  - DB integration: end-to-end rebuild, idempotent re-runs, concurrent
 *    aggregation, tenant isolation, employee isolation, deterministic rebuild
 *    after data changes, retention purge on the activity window, no fabricated
 *    days, rule-change invariance.
 *  - API: org-scoped GET (RBAC, range validation, cross-org employee 404),
 *    rebuild POST (RBAC, validation, future-day rejection, 90-day bound).
 *  - Consistency: summary totals equal dashboard-style raw aggregation over
 *    the same org-local days.
 *
 * Every DB test uses a FRESH org/employee so row counts are exact. Runs
 * against a THROWAWAY PostgreSQL database (workai_test_workday).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation (set BEFORE any app module import) ──────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_workday';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-workday-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@workday.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!WorkDay2026x';
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

const DHAKA = 'Asia/Dhaka'; // UTC+6, no DST — stable arithmetic
const NY = 'America/New_York'; // DST — boundary tests

let orgSeq = 0;

async function freshOrg(tz = DHAKA) {
  orgSeq += 1;
  return db.organization.create({
    data: { name: `WorkDay Org ${orgSeq}`, slug: `workday-org-${orgSeq}-${Date.now()}`, timezone: tz },
  });
}

async function freshEmp(organizationId: string, tag = 'e') {
  orgSeq += 1;
  return db.employee.create({
    data: {
      employeeId: `emp-${tag}-${Date.now()}-${orgSeq}`,
      firstName: 'Fi',
      lastName: `xture ${orgSeq}`,
      email: `fix${orgSeq}@workday.test`,
      organizationId,
    },
  });
}

function req(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(url, init);
}
function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
});

after(async () => {
  await db.$disconnect();
});

// ==================== Pure engine ====================

test('WD-1: category totals, active invariant, idle, exclusions, type counts', async () => {
  const { aggregateEmployeeDay } = await import('../src/lib/workday/summary');
  // Day 2026-09-03 in Asia/Dhaka = [2026-09-02T18:00Z, 2026-09-03T18:00Z).
  const t = (utc: string) => new Date(utc);
  const totals = aggregateEmployeeDay({
    dayKey: '2026-09-03',
    timezone: DHAKA,
    workStartMinutes: 9 * 60,
    workEndMinutes: 18 * 60,
    breakSeconds: 0,
    activities: [
      // productive app row at local 09:00 (window start) → working
      { type: 'application', title: 'Code', applicationName: 'Code.exe', category: 'productive', duration: 60, timestamp: t('2026-09-03T03:00:00Z') },
      // neutral website row at local 11:00 → working
      { type: 'website', title: 'github.com', applicationName: null, category: 'neutral', duration: 60, timestamp: t('2026-09-03T05:00:00Z') },
      // unproductive app row at local 02:30 → OUTSIDE the window
      { type: 'application', title: 'game', applicationName: 'game.exe', category: 'unproductive', duration: 60, timestamp: t('2026-09-02T20:30:00Z') },
      // idle row at local 13:00 → idle seconds, never active
      { type: 'idle', title: null, applicationName: null, category: 'idle', duration: 120, timestamp: t('2026-09-03T07:00:00Z') },
      // break-mirror marker (duration 0) — excluded from counts entirely
      { type: 'idle', title: 'Break Mode Started', applicationName: null, category: 'idle', duration: 0, timestamp: t('2026-09-03T07:05:00Z') },
      // internal agent row — never the employee's work
      { type: 'application', title: 'agent', applicationName: 'omnisightagent.exe', category: 'productive', duration: 999, timestamp: t('2026-09-03T04:00:00Z') },
      // uncategorized screenshot event → counted, no time
      { type: 'screenshot', title: null, applicationName: null, category: null, duration: 10, timestamp: t('2026-09-03T06:00:00Z') },
    ],
  });
  assert.equal(totals.productiveSeconds, 60);
  assert.equal(totals.neutralSeconds, 60);
  assert.equal(totals.unproductiveSeconds, 60);
  assert.equal(totals.activeSeconds, 180); // p+n+u invariant
  assert.equal(totals.workingSeconds, 120); // productive 09:00 + neutral 11:00
  assert.equal(totals.outsideHoursSeconds, 60); // unproductive 02:30
  assert.equal(totals.idleSeconds, 120);
  assert.equal(totals.activityCount, 5); // break mirror + internal agent excluded
  assert.equal(totals.websiteActivityCount, 1);
  assert.equal(totals.applicationActivityCount, 2); // internal agent row not counted
});

test('WD-2: a row is attributed to the org-local day of its timestamp, never split', async () => {
  const { aggregateEmployeeDay } = await import('../src/lib/workday/summary');
  // 2026-09-02T23:30Z = 2026-09-03 05:30 in Dhaka — belongs to the 03rd, not the 02nd.
  const row = {
    type: 'application' as const,
    title: 'x',
    applicationName: 'x.exe',
    category: 'productive' as const,
    duration: 60,
    timestamp: new Date('2026-09-02T23:30:00Z'),
  };
  const day02 = aggregateEmployeeDay({ dayKey: '2026-09-02', timezone: DHAKA, workStartMinutes: 540, workEndMinutes: 1080, breakSeconds: 0, activities: [row] });
  assert.equal(day02.activityCount, 0); // row is NOT on the 02nd locally
  assert.equal(day02.productiveSeconds, 0);
  const day03 = aggregateEmployeeDay({ dayKey: '2026-09-03', timezone: DHAKA, workStartMinutes: 540, workEndMinutes: 1080, breakSeconds: 0, activities: [row] });
  assert.equal(day03.activityCount, 1);
  assert.equal(day03.productiveSeconds, 60);
  // The same instant belongs to the PREVIOUS day in a UTC org — never shared.
  const utc = aggregateEmployeeDay({ dayKey: '2026-09-02', timezone: 'UTC', workStartMinutes: 540, workEndMinutes: 1080, breakSeconds: 0, activities: [row] });
  assert.equal(utc.productiveSeconds, 60);
});

test('WD-3: working/outside split at window edges + overnight windows', async () => {
  const { aggregateEmployeeDay } = await import('../src/lib/workday/summary');
  const mk = (utc: string, dur: number) => ({
    type: 'application' as const,
    title: 'x',
    applicationName: 'x.exe',
    category: 'productive' as const,
    duration: dur,
    timestamp: new Date(utc),
  });
  // UTC org, window 09:00–18:00. Local time == UTC.
  const base = { timezone: 'UTC', dayKey: '2026-09-03', workStartMinutes: 540, workEndMinutes: 1080, breakSeconds: 0 };
  const at = (h: number, m: number) => mk(`2026-09-03T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`, 60);
  const r845 = aggregateEmployeeDay({ ...base, activities: [at(8, 59)] });
  assert.equal(r845.workingSeconds, 0);
  assert.equal(r845.outsideHoursSeconds, 60);
  const r900 = aggregateEmployeeDay({ ...base, activities: [at(9, 0)] });
  assert.equal(r900.workingSeconds, 60);
  assert.equal(r900.outsideHoursSeconds, 0);
  const r1759 = aggregateEmployeeDay({ ...base, activities: [at(17, 59)] });
  assert.equal(r1759.workingSeconds, 60);
  const r1800 = aggregateEmployeeDay({ ...base, activities: [at(18, 0)] });
  assert.equal(r1800.outsideHoursSeconds, 60);
  // Overnight window 22:00–06:00: rows at 23:00 AND at 02:00 are working.
  const overnight = { ...base, workStartMinutes: 22 * 60, workEndMinutes: 6 * 60 };
  const r2300 = aggregateEmployeeDay({ ...overnight, activities: [at(23, 0)] });
  assert.equal(r2300.workingSeconds, 60);
  const r0200 = aggregateEmployeeDay({ ...overnight, activities: [mk('2026-09-03T02:00:00Z', 60)] });
  assert.equal(r0200.workingSeconds, 60);
  const r1200 = aggregateEmployeeDay({ ...overnight, activities: [at(12, 0)] });
  assert.equal(r1200.workingSeconds, 0);
  assert.equal(r1200.outsideHoursSeconds, 60);
  // Idle rows never flow into working/outside.
  const idleAt = aggregateEmployeeDay({ ...base, activities: [{ type: 'idle', title: null, applicationName: null, category: 'idle', duration: 120, timestamp: at(10, 0).timestamp }] });
  assert.equal(idleAt.workingSeconds, 0);
  assert.equal(idleAt.idleSeconds, 120);
});

test('WD-4: invalid durations and unknown categories never distort totals', async () => {
  const { aggregateEmployeeDay } = await import('../src/lib/workday/summary');
  const totals = aggregateEmployeeDay({
    dayKey: '2026-09-03',
    timezone: 'UTC',
    workStartMinutes: 540,
    workEndMinutes: 1080,
    breakSeconds: 0,
    activities: [
      { type: 'application', title: 'a', applicationName: 'a.exe', category: 'productive', duration: -5, timestamp: new Date('2026-09-03T10:00:00Z') },
      { type: 'application', title: 'b', applicationName: 'b.exe', category: 'productive', duration: Number.NaN, timestamp: new Date('2026-09-03T10:00:00Z') },
      { type: 'application', title: 'c', applicationName: 'c.exe', category: null, duration: 100, timestamp: new Date('2026-09-03T10:00:00Z') },
      { type: 'application', title: 'd', applicationName: 'd.exe', category: 'productive', duration: 30, timestamp: new Date('2026-09-03T10:00:00Z') },
    ],
  });
  assert.equal(totals.productiveSeconds, 30); // only the valid row counts
  assert.equal(totals.activeSeconds, 30);
  assert.equal(totals.activityCount, 4); // counted but never timed
});

test('WD-5: break overlap clipping (open sessions, day bounds, no overlap)', async () => {
  const { breakSessionOverlapSeconds } = await import('../src/lib/workday/summary');
  const dayStart = new Date('2026-09-02T18:00:00Z'); // Dhaka local midnight 09-03
  const dayEnd = new Date('2026-09-03T17:59:59.999Z');
  const now = new Date('2026-09-03T10:00:00Z');
  // Closed session fully inside the day.
  assert.equal(breakSessionOverlapSeconds({ startedAt: new Date('2026-09-02T19:00:00Z'), endedAt: new Date('2026-09-02T19:30:00Z') }, dayStart, dayEnd, now), 1800);
  // Session crossing day start → clipped to the day (18:00Z→19:10Z = 70 min).
  assert.equal(breakSessionOverlapSeconds({ startedAt: new Date('2026-09-02T17:00:00Z'), endedAt: new Date('2026-09-02T19:10:00Z') }, dayStart, dayEnd, now), 70 * 60);
  // Open session → clipped to now (no future time counted).
  assert.equal(breakSessionOverlapSeconds({ startedAt: new Date('2026-09-03T08:00:00Z'), endedAt: null }, dayStart, dayEnd, now), 2 * 3600);
  // Session fully outside the day → 0.
  assert.equal(breakSessionOverlapSeconds({ startedAt: new Date('2026-09-04T02:00:00Z'), endedAt: new Date('2026-09-04T03:00:00Z') }, dayStart, dayEnd, now), 0);
});

test('WD-6: DST fall-back day keeps every real second (25h day, no fabrication)', async () => {
  const { localDayKey } = await import('../src/lib/timezone');
  // US fall-back: 2026-11-01 in America/New_York. A row in the repeated hour.
  const row1 = new Date('2026-11-01T05:30:00Z'); // 01:30 EDT (first pass)
  const row2 = new Date('2026-11-01T06:30:00Z'); // 01:30 EST (second pass)
  assert.equal(localDayKey(row1, NY), '2026-11-01');
  assert.equal(localDayKey(row2, NY), '2026-11-01');
  const { aggregateEmployeeDay } = await import('../src/lib/workday/summary');
  const totals = aggregateEmployeeDay({
    dayKey: '2026-11-01',
    timezone: NY,
    workStartMinutes: 0,
    workEndMinutes: 1440,
    breakSeconds: 0,
    activities: [
      { type: 'application', title: 'a', applicationName: 'a.exe', category: 'productive', duration: 60, timestamp: row1 },
      { type: 'application', title: 'a', applicationName: 'a.exe', category: 'productive', duration: 60, timestamp: row2 },
    ],
  });
  assert.equal(totals.productiveSeconds, 120);
});

// ==================== DB integration ====================

/**
 * Seeds the canonical Dhaka scenario for local day 2026-09-03:
 *  - Code.exe productive 60s @ 09:00 local (working)
 *  - github.com neutral 60s @ 11:00 local (working)
 *  - game.exe unproductive 60s @ 02:30 local (outside hours)
 *  - idle 120s @ 13:00 local
 *  - a 30-minute break 13:00–13:30 local (BreakSession)
 * Returns the dayKey + exact expected totals.
 */
async function seedDhakaScenario() {
  const orgRow = await freshOrg(DHAKA);
  const emp = await freshEmp(orgRow.id);
  await db.activity.createMany({
    data: [
      { employeeId: emp.id, type: 'application', title: 'Code', applicationName: 'Code.exe', category: 'productive', duration: 60, timestamp: new Date('2026-09-03T03:00:00Z') },
      { employeeId: emp.id, type: 'website', title: 'github.com', applicationName: null, category: 'neutral', duration: 60, timestamp: new Date('2026-09-03T05:00:00Z') },
      { employeeId: emp.id, type: 'application', title: 'game', applicationName: 'game.exe', category: 'unproductive', duration: 60, timestamp: new Date('2026-09-02T20:30:00Z') },
      { employeeId: emp.id, type: 'idle', title: null, applicationName: null, category: 'idle', duration: 120, timestamp: new Date('2026-09-03T07:00:00Z') },
    ],
  });
  await db.breakSession.create({
    data: { organizationId: orgRow.id, employeeId: emp.id, source: 'agent', startedAt: new Date('2026-09-03T07:00:00Z'), endedAt: new Date('2026-09-03T07:30:00Z') },
  });
  return {
    orgId: orgRow.id,
    employeeId: emp.id,
    dayKey: '2026-09-03',
    expected: {
      productiveSeconds: 60,
      neutralSeconds: 60,
      unproductiveSeconds: 60,
      idleSeconds: 120,
      activeSeconds: 180,
      workingSeconds: 120,
      outsideHoursSeconds: 60,
      breakSeconds: 1800,
      activityCount: 4,
      websiteActivityCount: 1,
      applicationActivityCount: 2,
    },
  };
}

async function summaryRow(orgId: string, employeeId: string, workDate: string) {
  return db.workDaySummary.findUnique({
    where: { organizationId_employeeId_workDate: { organizationId: orgId, employeeId, workDate } },
  });
}

test('WD-7: end-to-end rebuild writes exactly the expected summary row', async () => {
  const { rebuildDaysForOrg } = await import('../src/lib/jobs/workday-summary');
  const { orgId, employeeId, dayKey, expected } = await seedDhakaScenario();
  const res = await rebuildDaysForOrg(orgId, [dayKey]);
  assert.equal(res.errors.length, 0);
  assert.equal(res.upserted, 1);
  const summary = await summaryRow(orgId, employeeId, dayKey);
  assert.ok(summary);
  for (const [k, v] of Object.entries(expected)) {
    assert.equal((summary as unknown as Record<string, unknown>)[k], v, `field ${k}`);
  }
});

test('WD-8: duplicate aggregation is idempotent — reruns produce one identical row', async () => {
  const { rebuildDaysForOrg } = await import('../src/lib/jobs/workday-summary');
  const { orgId, employeeId, dayKey } = await seedDhakaScenario();
  const first = await rebuildDaysForOrg(orgId, [dayKey]);
  const second = await rebuildDaysForOrg(orgId, [dayKey]);
  assert.equal(first.upserted, 1);
  assert.equal(second.upserted, 1);
  const rows = await db.workDaySummary.findMany({ where: { organizationId: orgId, employeeId, workDate: dayKey } });
  assert.equal(rows.length, 1); // unique key — never duplicated
  const again = await summaryRow(orgId, employeeId, dayKey);
  assert.equal(again?.productiveSeconds, rows[0].productiveSeconds);
  assert.equal(again?.activeSeconds, rows[0].activeSeconds);
  assert.equal(again?.breakSeconds, rows[0].breakSeconds);
});

test('WD-9: concurrent aggregation is race-safe — one row, identical totals', async () => {
  const { rebuildDaysForOrg } = await import('../src/lib/jobs/workday-summary');
  const { orgId, employeeId, dayKey } = await seedDhakaScenario();
  const [a, b] = await Promise.all([
    rebuildDaysForOrg(orgId, [dayKey]),
    rebuildDaysForOrg(orgId, [dayKey]),
  ]);
  assert.equal(a.errors.length, 0);
  assert.equal(b.errors.length, 0);
  const rows = await db.workDaySummary.findMany({ where: { organizationId: orgId, employeeId, workDate: dayKey } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].productiveSeconds, 60);
  assert.equal(rows[0].breakSeconds, 1800);
});

test('WD-10: rebuild after data change replaces totals — never accumulates', async () => {
  const { rebuildDaysForOrg } = await import('../src/lib/jobs/workday-summary');
  const { orgId, employeeId, dayKey } = await seedDhakaScenario();
  await rebuildDaysForOrg(orgId, [dayKey]);
  // Add more productive work → rebuild must reflect the NEW total exactly once.
  await db.activity.create({
    data: { employeeId, type: 'application', title: 'More', applicationName: 'more.exe', category: 'productive', duration: 120, timestamp: new Date('2026-09-03T06:00:00Z') },
  });
  await rebuildDaysForOrg(orgId, [dayKey]);
  const summary = await summaryRow(orgId, employeeId, dayKey);
  assert.equal(summary?.productiveSeconds, 180); // 60 original + 120 added — exactly once
  assert.equal(summary?.activeSeconds, 300);
});

test('WD-11: tenant isolation — same telemetry, different orgs, independent day buckets', async () => {
  const { rebuildDaysForOrg } = await import('../src/lib/jobs/workday-summary');
  const dhakaOrg = await freshOrg(DHAKA);
  const utcOrg = await freshOrg('UTC');
  const dhakaEmp = await freshEmp(dhakaOrg.id);
  const utcEmp = await freshEmp(utcOrg.id);
  // The SAME instant (2026-09-02T23:30Z) is local day 09-03 in Dhaka but 09-02
  // in UTC. Each org's rebuild must bucket it into its own local day and never
  // write the other org.
  const rows = [
    { type: 'application', title: 'Code', applicationName: 'Code.exe', category: 'productive', duration: 60, timestamp: new Date('2026-09-02T23:30:00Z') },
  ];
  await db.activity.createMany({ data: [{ ...rows[0], employeeId: dhakaEmp.id }, { ...rows[0], employeeId: utcEmp.id }] });
  await rebuildDaysForOrg(dhakaOrg.id, ['2026-09-03']);
  await rebuildDaysForOrg(utcOrg.id, ['2026-09-02']);
  const dhakaRow = await summaryRow(dhakaOrg.id, dhakaEmp.id, '2026-09-03');
  const utcRow = await summaryRow(utcOrg.id, utcEmp.id, '2026-09-02');
  assert.ok(dhakaRow);
  assert.ok(utcRow);
  assert.equal(dhakaRow.productiveSeconds, 60);
  assert.equal(utcRow.productiveSeconds, 60);
  // No cross-org summary rows exist anywhere.
  assert.equal(await db.workDaySummary.count({ where: { organizationId: dhakaOrg.id, employeeId: utcEmp.id } }), 0);
  assert.equal(await db.workDaySummary.count({ where: { organizationId: utcOrg.id, employeeId: dhakaEmp.id } }), 0);
});

test('WD-12: employee isolation — same org, same day, separate summaries', async () => {
  const { rebuildDaysForOrg } = await import('../src/lib/jobs/workday-summary');
  const orgRow = await freshOrg(DHAKA);
  const emp1 = await freshEmp(orgRow.id);
  const emp2 = await freshEmp(orgRow.id);
  await db.activity.createMany({
    data: [
      { employeeId: emp1.id, type: 'application', title: 'A', applicationName: 'a.exe', category: 'productive', duration: 60, timestamp: new Date('2026-09-03T03:00:00Z') },
      { employeeId: emp2.id, type: 'application', title: 'B', applicationName: 'b.exe', category: 'unproductive', duration: 300, timestamp: new Date('2026-09-03T05:00:00Z') },
    ],
  });
  await rebuildDaysForOrg(orgRow.id, ['2026-09-03']);
  const s1 = await summaryRow(orgRow.id, emp1.id, '2026-09-03');
  const s2 = await summaryRow(orgRow.id, emp2.id, '2026-09-03');
  assert.ok(s1);
  assert.ok(s2);
  assert.equal(s1.productiveSeconds, 60);
  assert.equal(s2.unproductiveSeconds, 300);
  assert.equal(s2.productiveSeconds, 0);
});

test('WD-13: no fabrication — empty days produce no summary; break-only days do', async () => {
  const { rebuildDaysForOrg } = await import('../src/lib/jobs/workday-summary');
  const orgRow = await freshOrg(DHAKA);
  const emp = await freshEmp(orgRow.id);
  await rebuildDaysForOrg(orgRow.id, ['2026-09-04']);
  // No telemetry → no fabricated summary for the empty day.
  assert.equal(await db.workDaySummary.count({ where: { organizationId: orgRow.id, employeeId: emp.id, workDate: '2026-09-04' } }), 0);
  // A day with ONLY a break session still gets a summary (breakSeconds).
  await db.breakSession.create({
    data: { organizationId: orgRow.id, employeeId: emp.id, source: 'self_service', startedAt: new Date('2026-09-04T04:00:00Z'), endedAt: new Date('2026-09-04T04:45:00Z') },
  });
  await rebuildDaysForOrg(orgRow.id, ['2026-09-04']);
  const breakOnly = await summaryRow(orgRow.id, emp.id, '2026-09-04');
  assert.ok(breakOnly);
  assert.equal(breakOnly.breakSeconds, 2700);
  assert.equal(breakOnly.activityCount, 0);
  assert.equal(breakOnly.activeSeconds, 0);
});

test('WD-14: rule changes never rewrite history (ingestion-time classification)', async () => {
  const { rebuildDaysForOrg } = await import('../src/lib/jobs/workday-summary');
  const { orgId, employeeId, dayKey } = await seedDhakaScenario();
  await rebuildDaysForOrg(orgId, [dayKey]);
  const before = await summaryRow(orgId, employeeId, dayKey);
  // Add a rule that WOULD re-classify Code.exe as unproductive if applied to
  // stored rows — it must NOT change the frozen summary (Phase 3 semantics:
  // classification is decided at ingestion time and stored on the row).
  await db.categoryRule.create({
    data: { organizationId: orgId, name: 'retro', matchType: 'executable', pattern: 'code.exe', category: 'unproductive', priority: 1 },
  });
  await rebuildDaysForOrg(orgId, [dayKey]);
  const after = await summaryRow(orgId, employeeId, dayKey);
  assert.ok(before && after);
  assert.equal(after.productiveSeconds, before.productiveSeconds);
  assert.equal(after.unproductiveSeconds, before.unproductiveSeconds);
});

test('WD-15: scheduled job is org-scoped, windowed, deterministic', async () => {
  const { runWorkDaySummaryJob } = await import('../src/lib/jobs/workday-summary');
  const pinned = new Date('2026-09-03T06:00:00Z'); // Dhaka local noon
  const s1 = await seedDhakaScenario();
  const s2 = await seedDhakaScenario();
  const result = await runWorkDaySummaryJob({ orgIds: [s1.orgId, s2.orgId], now: pinned, windowDays: 7 });
  assert.equal(result.errors.length, 0);
  assert.equal(result.orgsScanned, 2);
  assert.ok(result.summariesUpserted >= 2);
  assert.equal(result.windowStartKey, '2026-08-28'); // 7-day window ending 09-03 Dhaka
  assert.equal(result.windowEndKey, '2026-09-03');
  const countAfterFirst = await db.workDaySummary.count({ where: { organizationId: { in: [s1.orgId, s2.orgId] } } });
  // Second run — deterministic, no growth.
  const again = await runWorkDaySummaryJob({ orgIds: [s1.orgId, s2.orgId], now: pinned, windowDays: 7 });
  assert.equal(again.errors.length, 0);
  const countAfterSecond = await db.workDaySummary.count({ where: { organizationId: { in: [s1.orgId, s2.orgId] } } });
  assert.equal(countAfterSecond, countAfterFirst);
  // Both scenarios' summaries exist with correct content.
  const r1 = await summaryRow(s1.orgId, s1.employeeId, s1.dayKey);
  const r2 = await summaryRow(s2.orgId, s2.employeeId, s2.dayKey);
  assert.ok(r1 && r2);
  assert.equal(r1.productiveSeconds, 60);
  assert.equal(r2.productiveSeconds, 60);
});

test('WD-16: retention purges old summaries with the activity window (org-local cutoff)', async () => {
  const { runRetentionForOrg } = await import('../src/lib/jobs/retention');
  const orgRow = await freshOrg('UTC');
  const emp = await freshEmp(orgRow.id);
  await db.organizationSetting.create({
    data: { organizationId: orgRow.id, key: 'activity_retention_days', value: '30', category: 'retention' },
  });
  await db.workDaySummary.createMany({
    data: [
      { organizationId: orgRow.id, employeeId: emp.id, workDate: '2026-07-01', productiveSeconds: 1, activeSeconds: 1, activityCount: 1 },
      { organizationId: orgRow.id, employeeId: emp.id, workDate: '2026-09-01', productiveSeconds: 2, activeSeconds: 2, activityCount: 1 },
    ],
  });
  // Cutoff: 2026-09-03T12:00Z minus 30 days = 2026-08-04T12:00Z → org-local day
  // 2026-08-04 → purge workDate < 2026-08-04, keep 2026-08-04 and newer.
  const result = await runRetentionForOrg(orgRow.id, new Date('2026-09-03T12:00:00Z'));
  assert.equal(result.workDaySummaries, 1);
  const remaining = await db.workDaySummary.findMany({ where: { organizationId: orgRow.id } });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].workDate, '2026-09-01');
});

test('WD-17: GET API — org-scoped reads, RBAC, validation, cross-org employee 404', async () => {
  const { GET } = await import('../src/app/api/workday-summaries/route');
  const orgRow = await freshOrg(DHAKA);
  const emp = await freshEmp(orgRow.id);
  const otherOrg = await freshOrg('UTC');
  const otherEmp = await freshEmp(otherOrg.id);
  // Seed one summary row for orgRow so reads have content.
  await db.activity.create({
    data: { employeeId: emp.id, type: 'application', title: 'X', applicationName: 'x.exe', category: 'productive', duration: 60, timestamp: new Date('2026-09-03T03:00:00Z') },
  });
  const { rebuildDaysForOrg } = await import('../src/lib/jobs/workday-summary');
  await rebuildDaysForOrg(orgRow.id, ['2026-09-03']);

  const managerToken = await signJWT({ userId: 'wd-mgr', email: 'mgr@wd.test', role: 'manager', organizationId: orgRow.id });
  const viewerToken = await signJWT({ userId: 'wd-viewer', email: 'viewer@wd.test', role: 'viewer', organizationId: orgRow.id });
  const foreignManager = await signJWT({ userId: 'wd-other-mgr', email: 'othermgr@wd.test', role: 'manager', organizationId: otherOrg.id });

  // Unauth → 401; viewer → 403.
  assert.equal((await GET(req('http://n/api/workday-summaries'))).status, 401);
  assert.equal((await GET(req('http://n/api/workday-summaries', { headers: authHeader(viewerToken) }))).status, 403);
  // Manager reads ONLY their org's rows.
  const mgr = await GET(req('http://n/api/workday-summaries?from=2026-09-01&to=2026-09-05', { headers: authHeader(managerToken) }));
  assert.equal(mgr.status, 200);
  const body = (await mgr.json()) as { data: Array<{ employeeId: string }> };
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].employeeId, emp.id);
  // Range validation → 422.
  assert.equal((await GET(req('http://n/api/workday-summaries?from=2026-09-05&to=2026-09-01', { headers: authHeader(managerToken) }))).status, 422);
  assert.equal((await GET(req('http://n/api/workday-summaries?from=2026-01-01&to=2026-12-31', { headers: authHeader(managerToken) }))).status, 422);
  // Cross-org employee id → 404 (never an empty cross-org result).
  const foreign = await GET(req(`http://n/api/workday-summaries?from=2026-09-01&to=2026-09-05&employeeId=${otherEmp.id}`, { headers: authHeader(managerToken) }));
  assert.equal(foreign.status, 404);
  // The SAME foreign employee read by THEIR manager → 200 (empty is fine).
  const own = await GET(req(`http://n/api/workday-summaries?from=2026-09-01&to=2026-09-05&employeeId=${otherEmp.id}`, { headers: authHeader(foreignManager) }));
  assert.equal(own.status, 200);
});

test('WD-18: rebuild API — RBAC, validation, 90-day bound, future-day rejection', async () => {
  const { POST } = await import('../src/app/api/workday-summaries/rebuild/route');
  const orgRow = await freshOrg(DHAKA);
  const emp = await freshEmp(orgRow.id);
  await db.activity.create({
    data: { employeeId: emp.id, type: 'application', title: 'Y', applicationName: 'y.exe', category: 'productive', duration: 60, timestamp: new Date('2026-09-03T03:00:00Z') },
  });
  const managerToken = await signJWT({ userId: 'wd-mgr2', email: 'mgr2@wd.test', role: 'manager', organizationId: orgRow.id });
  const viewerToken = await signJWT({ userId: 'wd-viewer2', email: 'viewer2@wd.test', role: 'viewer', organizationId: orgRow.id });

  const post = (token: string | null, body: unknown) =>
    POST(req('http://n/api/workday-summaries/rebuild', {
      method: 'POST',
      headers: token ? authHeader(token) : undefined,
      body: JSON.stringify(body),
    }));

  // Unauth → 401; viewer → 403.
  assert.equal((await post(null, { startDate: '2026-09-01', endDate: '2026-09-01' })).status, 401);
  assert.equal((await post(viewerToken, { startDate: '2026-09-01', endDate: '2026-09-01' })).status, 403);
  // Manager → 200 and rows (re)computed deterministically.
  const ok = await post(managerToken, { startDate: '2026-09-02', endDate: '2026-09-03' });
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { data: { summariesUpserted: number; startDate: string; endDate: string } };
  assert.ok(body.data.summariesUpserted >= 1);
  assert.equal(body.data.startDate, '2026-09-02');
  // Invalid dates → 422; inverted → 422; future → 422; >90 days → 422.
  assert.equal((await post(managerToken, { startDate: 'nope', endDate: '2026-09-03' })).status, 422);
  assert.equal((await post(managerToken, { startDate: '2026-09-03', endDate: '2026-09-01' })).status, 422);
  assert.equal((await post(managerToken, { startDate: '2026-09-03', endDate: '2999-01-01' })).status, 422);
  assert.equal((await post(managerToken, { startDate: '2026-01-01', endDate: '2026-09-03' })).status, 422);
});

test('WD-19: dashboard/report consistency — summary totals equal raw aggregation over the same org-local days', async () => {
  const { rebuildDaysForOrg } = await import('../src/lib/jobs/workday-summary');
  const { localDayKey } = await import('../src/lib/timezone');
  const { isInternalAgentProcess } = await import('../src/lib/agent-process');
  const { BREAK_TITLES } = await import('../src/lib/breaks/service');

  const { orgId, employeeId, dayKey } = await seedDhakaScenario();
  await rebuildDaysForOrg(orgId, [dayKey]);

  // Dashboard-style raw aggregation over the org-local day (mirrors the
  // /api/dashboard bucketing): sum category durations of rows whose org-local
  // day matches, excluding internal agent processes and break mirrors.
  const rows = await db.activity.findMany({
    where: { employeeId, timestamp: { gte: new Date('2026-09-02T18:00:00Z'), lt: new Date('2026-09-03T18:00:00Z') } },
    select: { type: true, title: true, applicationName: true, category: true, duration: true, timestamp: true },
  });
  const byDay = new Map<string, { p: number; n: number; u: number; active: number }>();
  for (const r of rows) {
    if (isInternalAgentProcess(r.applicationName)) continue;
    if (r.title && (BREAK_TITLES as readonly string[]).includes(r.title)) continue;
    if (!(Number.isFinite(r.duration) && r.duration > 0)) continue;
    if (r.category === 'idle' || r.type === 'idle') continue;
    const key = localDayKey(r.timestamp, DHAKA);
    const e = byDay.get(key) ?? { p: 0, n: 0, u: 0, active: 0 };
    if (r.category === 'productive') e.p += r.duration;
    else if (r.category === 'neutral') e.n += r.duration;
    else if (r.category === 'unproductive') e.u += r.duration;
    e.active = e.p + e.n + e.u;
    byDay.set(key, e);
  }
  const raw = byDay.get(dayKey);
  assert.ok(raw, 'raw rows exist for the day');

  const summary = await summaryRow(orgId, employeeId, dayKey);
  assert.ok(summary);
  // Dashboard total (p+n+u) == summary active == summary p+n+u.
  assert.equal(raw.p, summary.productiveSeconds);
  assert.equal(raw.n, summary.neutralSeconds);
  assert.equal(raw.u, summary.unproductiveSeconds);
  assert.equal(raw.active, summary.activeSeconds);
  assert.equal(summary.activeSeconds, summary.productiveSeconds + summary.neutralSeconds + summary.unproductiveSeconds);
});

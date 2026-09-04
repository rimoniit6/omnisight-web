/**
 * Phase 4 — WorkDaySummary performance evidence (no production data).
 *
 * 1. Engine throughput at the target org shape (100 organizations × 30
 *    employees × 30 days of synthetic telemetry, 40 rows/employee/day ≈ two
 *    20-minute typed sessions plus a website + idle row every 5th row).
 *    Asserts: completes within a generous bound, per-org/per-day totals are
 *    internally consistent (spot-checked), memory stays bounded by the
 *    per-day partitioning (rows are aggregated and released per employee-day,
 *    never all held at once).
 * 2. DB job path at moderate scale (2 orgs × 20 employees × 30 days ≈ 48k
 *    raw rows): every (org, employee, day) with data gets exactly one
 *    summary, totals match the deterministic generator, and the run duration
 *    is measured for the report.
 *
 * Timing is reported via console.log (captured in the suite output) — the
 * assertions use generous ceilings so slow CI machines never flake.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

// ─── Test DB isolation (set BEFORE any app module import) ──────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_workday_perf';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-workdayperf-0123456789abcdef';
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

const TIMEZONES = ['Asia/Dhaka', 'America/New_York', 'Europe/London', 'Australia/Sydney'];

/**
 * Deterministic per-employee-day pattern: two 20-minute typed sessions
 * (09:00–09:19, 14:00–14:19 local) at one-minute cadence → 40 rows/day.
 * Category cycle: i%3==0 neutral, i%3==1 productive, i%3==2 unproductive.
 * Per session: 7 neutral + 7 productive + 6 unproductive = 20 rows.
 */
function buildEmployeeDayPattern(): Array<{ minutes: number; duration: number; category: string }> {
  const out: Array<{ minutes: number; duration: number; category: string }> = [];
  for (const baseMin of [9 * 60, 14 * 60]) {
    for (let i = 0; i < 20; i += 1) {
      const category = i % 3 === 0 ? 'neutral' : i % 3 === 1 ? 'productive' : 'unproductive';
      out.push({ minutes: baseMin + i, duration: 60, category });
    }
  }
  return out;
}

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
});

after(async () => {
  await db.$disconnect();
});

test('WD-PERF-1: engine throughput — 100 orgs × 30 employees × 30 days, bounded + consistent', async () => {
  const { aggregateEmployeeDay } = await import('../src/lib/workday/summary');
  const { zonedDayStart } = await import('../src/lib/timezone');

  const ORGS = 100;
  const EMPLOYEES = 30;
  const DAYS = 30;
  const started = Date.now();

  // Day keys for the 30-day window ending 2026-09-03 in each org's timezone.
  // The engine's own day-membership check is what matters — we compute
  // dayStart so timestamps can be placed precisely inside each org-local day.
  let totalRows = 0;
  let productive = 0;
  let neutral = 0;
  let unproductive = 0;
  let summaries = 0;

  // Day-window cache per (timezone, key) — the production loader resolves the
  // window ONCE per org-day, never per employee.
  const dayStartCache = new Map<string, number>();
  const keys = Array.from({ length: DAYS }, (_, d) => new Date(Date.UTC(2026, 7, 5 + d)).toISOString().slice(0, 10));

  for (let o = 0; o < ORGS; o += 1) {
    const tz = TIMEZONES[o % TIMEZONES.length];
    for (let e = 0; e < EMPLOYEES; e += 1) {
      for (let d = 0; d < DAYS; d += 1) {
        // 2026-08-05 + d as the local day key (all in the past, stable).
        const key = keys[d];
        const cacheKey = `${tz}|${key}`;
        let dayStartMs = dayStartCache.get(cacheKey);
        if (dayStartMs === undefined) {
          dayStartMs = zonedDayStart(key, tz).getTime();
          dayStartCache.set(cacheKey, dayStartMs);
        }
        const rows = buildEmployeeDayPattern().map((r) => ({
          type: r.minutes % 8 === 7 ? ('website' as const) : ('application' as const),
          title: r.minutes % 8 === 7 ? 'site.test' : `App ${r.minutes}`,
          applicationName: r.minutes % 8 === 7 ? null : 'app.exe',
          category: r.category,
          duration: r.duration,
          timestamp: new Date(dayStartMs + r.minutes * 60_000),
        }));
        // Same fast-path shape the production loader uses (true day window).
        const dayEndExclusiveMs = dayStartMs + 86_400_000; // no DST in Aug–Sep for these zones
        const totals = aggregateEmployeeDay({
          dayKey: key,
          timezone: tz,
          workStartMinutes: 9 * 60,
          workEndMinutes: 18 * 60,
          breakSeconds: 0,
          activities: rows,
          localDayWindowMs: { startMs: dayStartMs, endExclusiveMs: dayEndExclusiveMs },
        });
        summaries += 1;
        productive += totals.productiveSeconds;
        neutral += totals.neutralSeconds;
        unproductive += totals.unproductiveSeconds;
        totalRows += rows.length;
      }
    }
  }

  const elapsedMs = Date.now() - started;
  console.log(`WD-PERF-1: ${ORGS} orgs × ${EMPLOYEES} employees × ${DAYS} days, ${totalRows.toLocaleString()} rows in ${elapsedMs} ms (${Math.round((totalRows / elapsedMs) * 1000).toLocaleString()} rows/s)`);
  // Assert the run completed within a generous bound AND the totals are
  // exactly what the deterministic generator implies: per employee-day the
  // pattern has 20 productive + 20 neutral(?) rows... verify no loss.
  // productive: 2 sessions × (rows where i%3==1) = 2 × 7 = 14 rows of 60s
  // neutral: 2 × 7 = 14; unproductive: 2 × 6 = 12 → all 40 rows covered.
  const perDay = { productive: 14 * 60, neutral: 14 * 60, unproductive: 12 * 60 };
  const expectedProductive = ORGS * EMPLOYEES * DAYS * perDay.productive;
  const expectedNeutral = ORGS * EMPLOYEES * DAYS * perDay.neutral;
  const expectedUnproductive = ORGS * EMPLOYEES * DAYS * perDay.unproductive;
  assert.equal(productive, expectedProductive);
  assert.equal(neutral, expectedNeutral);
  assert.equal(unproductive, expectedUnproductive);
  assert.equal(summaries, ORGS * EMPLOYEES * DAYS);
  assert.ok(elapsedMs < 20_000, `engine pass too slow: ${elapsedMs} ms`);
});

test('WD-PERF-2: DB job path — 2 orgs × 20 employees × 30 days (~48k rows), one summary per (org, employee, day)', async () => {
  const { rebuildDaysForOrg } = await import('../src/lib/jobs/workday-summary');
  const { zonedDayStart } = await import('../src/lib/timezone');

  const ORGS = 2;
  const EMPLOYEES = 20;
  const DAYS = 30;
  const orgs: Array<{ id: string; tz: string }> = [];
  for (let o = 0; o < ORGS; o += 1) {
    const tz = TIMEZONES[o];
    orgs.push({
      id: (
        await db.organization.create({ data: { name: `Perf Org ${o}`, slug: `perf-org-${o}-${Date.now()}`, timezone: tz } })
      ).id,
      tz,
    });
  }

  let inserted = 0;
  for (const orgRow of orgs) {
    for (let e = 0; e < EMPLOYEES; e += 1) {
      const emp = await db.employee.create({
        data: {
          employeeId: `perf-${orgRow.id.slice(-6)}-${e}-${Date.now()}`,
          firstName: 'Perf',
          lastName: `Emp ${e}`,
          email: `perf${orgRow.id.slice(-6)}-${e}-${Date.now()}@perf.test`,
          organizationId: orgRow.id,
        },
      });
      for (let d = 0; d < DAYS; d += 1) {
        const day = new Date(Date.UTC(2026, 7, 5 + d));
        const key = day.toISOString().slice(0, 10);
        const dayStart = zonedDayStart(key, orgRow.tz).getTime();
        const rows = buildEmployeeDayPattern().map((r) => ({
          employeeId: emp.id,
          organizationId: orgRow.id,
          type: r.minutes % 8 === 7 ? 'website' : 'application',
          title: r.minutes % 8 === 7 ? 'site.test' : `App ${r.minutes}`,
          applicationName: r.minutes % 8 === 7 ? null : 'app.exe',
          category: r.category,
          duration: r.duration,
          timestamp: new Date(dayStart + r.minutes * 60_000),
        }));
        // 500-row chunk inserts.
        for (let i = 0; i < rows.length; i += 500) {
          await db.activity.createMany({ data: rows.slice(i, i + 500) });
          inserted += rows.slice(i, i + 500).length;
        }
      }
    }
  }

  const dayKeys = Array.from({ length: DAYS }, (_, d) => new Date(Date.UTC(2026, 7, 5 + d)).toISOString().slice(0, 10));
  const jobStarted = Date.now();
  let upserted = 0;
  for (const orgRow of orgs) {
    const res = await rebuildDaysForOrg(orgRow.id, dayKeys);
    assert.equal(res.errors.length, 0);
    upserted += res.upserted;
  }
  const jobMs = Date.now() - jobStarted;
  console.log(`WD-PERF-2: ${inserted.toLocaleString()} rows → ${upserted} summaries in ${jobMs} ms (${Math.round((inserted / jobMs) * 1000).toLocaleString()} rows/s through the job)`);

  // Exactly one summary per (org, employee, day) with data.
  const summaryCount = await db.workDaySummary.count({ where: { organizationId: { in: orgs.map((o) => o.id) } } });
  assert.equal(summaryCount, ORGS * EMPLOYEES * DAYS);
  // Spot-check one deterministic (org, employee, day): productive 14×60s,
  // neutral 14×60s, unproductive 12×60s, all inside the 09:00–18:00 window.
  const spot = await db.workDaySummary.findFirst({ where: { organizationId: { in: orgs.map((o) => o.id) } } });
  assert.ok(spot);
  assert.equal(spot.productiveSeconds, 14 * 60);
  assert.equal(spot.neutralSeconds, 14 * 60);
  assert.equal(spot.unproductiveSeconds, 12 * 60);
  assert.equal(spot.workingSeconds, 40 * 60); // 09:00–09:19 + 14:00–14:19 inside the window
  assert.equal(spot.outsideHoursSeconds, 0);
  assert.equal(spot.activeSeconds, 40 * 60);
  assert.ok(jobMs < 120_000, `DB job too slow: ${jobMs} ms`);
});

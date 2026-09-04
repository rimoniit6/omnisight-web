/**
 * P2-1 — analytics DB-side aggregation equivalence.
 *
 * The previous /api/analytics materialized every Activity row in the window
 * (with the full employee object) and aggregated in JS. The new route
 * aggregates in PostgreSQL (groupBy / raw SQL). This test proves the output
 * is IDENTICAL by running a faithful port of the OLD in-memory algorithm
 * against the same dataset and deep-comparing every field.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_analyticsagg).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_analyticsagg';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-analyticsagg-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@analyticsagg.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!AnalyticsAgg2026x';
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
let emp1: { id: string }; // Eng, active
let emp2: { id: string }; // Design, active
let emp3: { id: string }; // no department, active
let emp4: { id: string }; // Eng, INACTIVE
let emp5: { id: string }; // Org B (must never leak into Org A)
let adminTokenA: string;

let seedSeq = 0;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  orgA = await db.organization.create({ data: { name: 'Agg Org A', slug: 'agg-org-a', timezone: 'Asia/Dhaka' } });
  orgB = await db.organization.create({ data: { name: 'Agg Org B', slug: 'agg-org-b', timezone: 'UTC' } });

  const deptA1 = await db.department.create({ data: { name: 'Eng', organizationId: orgA.id } });
  const deptA2 = await db.department.create({ data: { name: 'Design', organizationId: orgA.id } });

  const mkEmp = (employeeId: string, firstName: string, deptId: string | null, status: string, orgId: string) =>
    db.employee.create({
      data: { employeeId, firstName, lastName: 'Worker', email: `${employeeId.toLowerCase()}@agg.test`, organizationId: orgId, status, departmentId: deptId },
    });

  emp1 = await mkEmp('AGG-1', 'One', deptA1.id, 'active', orgA.id);
  emp2 = await mkEmp('AGG-2', 'Two', deptA2.id, 'active', orgA.id);
  emp3 = await mkEmp('AGG-3', 'Three', null, 'active', orgA.id);
  emp4 = await mkEmp('AGG-4', 'Four', deptA1.id, 'inactive', orgA.id);
  emp5 = await mkEmp('AGG-5', 'Five', null, 'active', orgB.id);

  // Explicit, strictly-increasing createdAt so the SQL "first row"
  // (ORDER BY createdAt, id) is deterministic AND equals insertion order.
  const mk = async (
    employeeId: string,
    fields: { type: string; applicationName?: string | null; url?: string | null; title?: string | null; category?: string | null; duration: number },
    timestamp: string
  ) => {
    seedSeq += 1;
    // Phase 1: Activity requires direct organizationId — resolve from the employee (same rule as the DB backfill).
    const emp = await db.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { organizationId: true } });
    return db.activity.create({
      data: {
        type: fields.type,
        applicationName: fields.applicationName ?? null,
        url: fields.url ?? null,
        title: fields.title ?? null,
        category: fields.category ?? null,
        duration: fields.duration,
        employeeId,
        organizationId: emp.organizationId,
        timestamp: new Date(timestamp),
        createdAt: new Date(`2026-08-11T00:00:${String(seedSeq).padStart(2, '0')}.000Z`),
      },
    });
  };

  // ── Org A activities (window: 2026-08-10 → 2026-08-12 local Dhaka) ──
  await mk(emp1.id, { type: 'application', applicationName: 'chrome.exe', category: 'productive', duration: 3600 }, '2026-08-10T23:30:00.000Z'); // → Dhaka day 11
  await mk(emp1.id, { type: 'application', applicationName: 'Code.exe', category: 'productive', duration: 1800 }, '2026-08-11T06:00:00.000Z');
  await mk(emp1.id, { type: 'application', applicationName: 'Code.exe', category: 'neutral', duration: 600 }, '2026-08-11T07:00:00.000Z'); // Code.exe mixed → stays 'productive'
  await mk(emp2.id, { type: 'application', applicationName: 'figma.exe', category: 'unproductive', duration: 900 }, '2026-08-11T08:00:00.000Z');
  await mk(emp2.id, { type: 'application', applicationName: 'figma.exe', category: 'unproductive', duration: 300 }, '2026-08-11T09:00:00.000Z');
  await mk(emp3.id, { type: 'website', url: 'https://example.com/docs', category: 'productive', duration: 1200 }, '2026-08-11T10:00:00.000Z');
  await mk(emp3.id, { type: 'application', title: 'Slack – conversation', category: 'neutral', duration: 400 }, '2026-08-11T11:00:00.000Z');
  await mk(emp3.id, { type: 'idle', duration: 60 }, '2026-08-11T12:00:00.000Z'); // all-null key → 'Unknown'
  await mk(emp4.id, { type: 'application', applicationName: 'notepad.exe', category: 'productive', duration: 3600 }, '2026-08-11T05:00:00.000Z'); // inactive emp still counts in trends/topApps
  await mk(emp1.id, { type: 'application', applicationName: 'OmniSightAgent.exe', category: 'productive', duration: 999999 }, '2026-08-11T13:00:00.000Z'); // INTERNAL — excluded everywhere
  await mk(emp2.id, { type: 'application', applicationName: 'chrome.exe', category: 'neutral', duration: 300 }, '2026-08-10T10:00:00.000Z'); // Dhaka day 10
  await mk(emp1.id, { type: 'application', applicationName: 'old.exe', category: 'productive', duration: 99999 }, '2026-07-01T12:00:00.000Z'); // OUT of window

  // ── Org B activity — must never leak into Org A analytics ──
  await mk(emp5.id, { type: 'application', applicationName: 'chrome.exe', category: 'productive', duration: 3600 }, '2026-08-11T06:00:00.000Z');

  adminTokenA = await signJWT({ userId: 'admin-agg', email: 'admin@agg.test', role: 'admin', organizationId: orgA.id });
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

function req(token: string, url: string): NextRequest {
  return new NextRequest(url, { headers: { authorization: `Bearer ${token}` } });
}

// ─── Reference: faithful port of the OLD (pre-P2-1) in-memory algorithm ────
async function oldAnalytics(orgId: string, orgTz: string, startKey: string, endKey: string) {
  const { zonedDayStart, zonedDayEnd, dayKeysBetween, localDayKey } = await import('../src/lib/timezone');
  const { excludeInternalAgentActivities } = await import('../src/lib/agent-process');

  const startDate = zonedDayStart(startKey, orgTz);
  const endDate = zonedDayEnd(endKey, orgTz);
  const cappedDayKeys = dayKeysBetween(startKey, endKey).slice(0, 90);

  const activities = excludeInternalAgentActivities(await db.activity.findMany({
    where: { timestamp: { gte: startDate, lte: endDate }, employee: { organizationId: orgId } },
    include: { employee: { select: { id: true, firstName: true, lastName: true, departmentId: true, organizationId: true } } },
  }));

  const totalDuration = activities.reduce((s, a) => s + a.duration, 0);
  const productiveDuration = activities.filter((a) => a.category === 'productive').reduce((s, a) => s + a.duration, 0);
  const neutralDuration = activities.filter((a) => a.category === 'neutral').reduce((s, a) => s + a.duration, 0);
  const unproductiveDuration = activities.filter((a) => a.category === 'unproductive').reduce((s, a) => s + a.duration, 0);
  const activeEmployees = new Set(activities.map((a) => a.employeeId)).size;

  const productivityTrends = cappedDayKeys.map((key) => {
    const dayActs = activities.filter((a) => localDayKey(a.timestamp, orgTz) === key);
    const total = dayActs.reduce((s, a) => s + a.duration, 0);
    const productive = dayActs.filter((a) => a.category === 'productive').reduce((s, a) => s + a.duration, 0);
    const neutral = dayActs.filter((a) => a.category === 'neutral').reduce((s, a) => s + a.duration, 0);
    const unproductive = dayActs.filter((a) => a.category === 'unproductive').reduce((s, a) => s + a.duration, 0);
    return {
      date: new Date(`${key}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
      dateISO: key,
      score: total > 0 ? Math.round((productive / total) * 100) : 0,
      totalMinutes: Math.round(total / 60),
      productiveMinutes: Math.round(productive / 60),
      neutralMinutes: Math.round(neutral / 60),
      unproductiveMinutes: Math.round(unproductive / 60),
    };
  });

  const departments = await db.department.findMany({ where: { organizationId: orgId }, include: { _count: { select: { employees: true } } } });
  const deptEmployees = await db.employee.findMany({ where: { departmentId: { in: departments.map((d) => d.id) }, status: 'active', organizationId: orgId }, select: { id: true, departmentId: true } });
  const employeesByDept = new Map<string, Set<string>>();
  for (const e of deptEmployees) {
    if (!e.departmentId) continue;
    const set = employeesByDept.get(e.departmentId) ?? new Set<string>();
    set.add(e.id);
    employeesByDept.set(e.departmentId, set);
  }

  const departmentProductivity = departments.map((dept) => {
    const empIds = employeesByDept.get(dept.id) ?? new Set<string>();
    const deptActs = activities.filter((a) => empIds.has(a.employeeId));
    const total = deptActs.reduce((s, a) => s + a.duration, 0);
    const productive = deptActs.filter((a) => a.category === 'productive').reduce((s, a) => s + a.duration, 0);
    const neutral = deptActs.filter((a) => a.category === 'neutral').reduce((s, a) => s + a.duration, 0);
    const unproductive = deptActs.filter((a) => a.category === 'unproductive').reduce((s, a) => s + a.duration, 0);
    return {
      department: dept.name,
      employees: dept._count.employees,
      score: total > 0 ? Math.round((productive / total) * 100) : 0,
      productive: Math.round(productive / 60),
      neutral: Math.round(neutral / 60),
      unproductive: Math.round(unproductive / 60),
    };
  });

  const appMap = new Map<string, { name: string; duration: number; count: number; type: string; category: string }>();
  activities.forEach((a) => {
    const key = a.applicationName || a.url || a.title || 'Unknown';
    const existing = appMap.get(key) || { name: key, duration: 0, count: 0, type: a.type, category: a.category || 'neutral' };
    existing.duration += a.duration;
    existing.count += 1;
    if (a.category === 'productive') existing.category = a.category;
    appMap.set(key, existing);
  });
  const topApps = Array.from(appMap.values())
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 10)
    .map((a) => ({ ...a, durationMinutes: Math.round(a.duration / 60) }));

  return {
    productivityTrends,
    departmentProductivity,
    topApps,
    summary: {
      totalActivities: activities.length,
      avgProductivity: productivityTrends.length > 0
        ? Math.round(productivityTrends.reduce((s, t) => s + t.score, 0) / productivityTrends.length)
        : 0,
      totalProductiveHours: Math.round(productiveDuration / 3600 * 10) / 10,
      activeEmployees,
      workloadDistribution: (() => {
        if (totalDuration === 0) return { productive: 0, neutral: 0, unproductive: 0 };
        const raw = {
          productive: (productiveDuration / totalDuration) * 100,
          neutral: (neutralDuration / totalDuration) * 100,
          unproductive: (unproductiveDuration / totalDuration) * 100,
        };
        const keys = ['productive', 'neutral', 'unproductive'] as const;
        const floored = Object.fromEntries(keys.map(k => [k, Math.floor(raw[k])]));
        const remainders = Object.fromEntries(keys.map(k => [k, raw[k] - floored[k]]));
        let sum = Object.values(floored).reduce((s, v) => s + v, 0);
        const sorted = [...keys].sort((a, b) => (remainders[b] ?? 0) - (remainders[a] ?? 0));
        for (const k of sorted) {
          if (sum >= 100) break;
          floored[k] = (floored[k] ?? 0) + 1;
          sum += 1;
        }
        return floored as Record<string, number>;
      })(),
    },
  };
}

async function newAnalytics(url: string) {
  const api = await import('../src/app/api/analytics/route');
  const res = await api.GET(req(adminTokenA, url));
  assert.equal(res.status, 200);
  const body = await res.json();
  return body.data as {
    productivityTrends: Array<{ date: string; dateISO: string; score: number; totalMinutes: number; productiveMinutes: number; neutralMinutes: number; unproductiveMinutes: number }>;
    departmentProductivity: Array<{ department: string; employees: number; score: number; productive: number; neutral: number; unproductive: number }>;
    topApps: Array<{ name: string; duration: number; count: number; type: string; category: string; durationMinutes: number }>;
    summary: { totalActivities: number; avgProductivity: number; totalProductiveHours: number; activeEmployees: number; workloadDistribution: Record<string, number> };
  };
}

test('AGG-1: DB-side aggregation output is byte-identical to the old in-memory algorithm (3-day window)', async () => {
  const old = await oldAnalytics(orgA.id, 'Asia/Dhaka', '2026-08-10', '2026-08-12');
  const nw = await newAnalytics('http://localhost:3000/api/analytics?startDate=2026-08-10&endDate=2026-08-12');

  assert.equal(nw.summary.totalActivities, 10, '11 Org-A rows in window minus 1 internal-agent row = 10');
  assert.deepEqual(nw.summary, old.summary, 'summary identical');
  assert.deepEqual(nw.productivityTrends, old.productivityTrends, 'productivityTrends identical');
  assert.deepEqual(nw.departmentProductivity, old.departmentProductivity, 'departmentProductivity identical');
  assert.deepEqual(nw.topApps, old.topApps, 'topApps identical');
});

test('AGG-2: identical on a single-day window crossing the UTC/local boundary', async () => {
  const old = await oldAnalytics(orgA.id, 'Asia/Dhaka', '2026-08-11', '2026-08-11');
  const nw = await newAnalytics('http://localhost:3000/api/analytics?startDate=2026-08-11&endDate=2026-08-11');

  assert.deepEqual(nw.summary, old.summary);
  assert.deepEqual(nw.productivityTrends, old.productivityTrends);
  assert.deepEqual(nw.departmentProductivity, old.departmentProductivity);
  assert.deepEqual(nw.topApps, old.topApps);
});

test('AGG-3: out-of-window and cross-org rows never leak (window boundary honored)', async () => {
  const nw = await newAnalytics('http://localhost:3000/api/analytics?startDate=2026-08-11&endDate=2026-08-11');
  // Org A day-11 only: rows 1,2,3,4,5,6,7,8,9 (10 is internal, 11 is day-10, 12 out of window, 13 Org B).
  assert.equal(nw.summary.totalActivities, 9);
  assert.equal(nw.summary.activeEmployees, 4, 'emp1..4 active in day-11 (inactive emp4 still an active user)');
  // Inactive employee's activity is in trends but NOT in the Eng department score.
  const eng = nw.departmentProductivity.find((d) => d.department === 'Eng');
  assert.equal(eng?.score, 90, 'Eng = emp1 only: 5400/6000 → 90');
  const design = nw.departmentProductivity.find((d) => d.department === 'Design');
  assert.equal(design?.score, 0, 'Design = emp2 only, all unproductive');
  // Sanity: topApps excludes the internal agent entirely.
  const names = nw.topApps.map((a) => a.name);
  assert.equal(names.includes('OmniSightAgent.exe'), false, 'internal agent process excluded');
  // 23:30 UTC lands on the Dhaka local day 2026-08-11 → chrome.exe total = 3600+300 = 3900 across days 11+10? No: day-11 window only → 3600.
  const chrome = nw.topApps.find((a) => a.name === 'chrome.exe');
  assert.ok(chrome, 'chrome.exe present');
  assert.equal(chrome.duration, 3600, 'only the 23:30Z row is in the day-11 window');
  assert.equal(chrome.count, 1);
  assert.equal(chrome.category, 'productive');
});

test('AGG-4: org B data is fully concealed from org A analytics', async () => {
  const res = await (await import('../src/app/api/analytics/route')).GET(
    req(adminTokenA, 'http://localhost:3000/api/analytics?startDate=2026-08-11&endDate=2026-08-11')
  );
  const body = await res.json();
  const chrome = (body.data.topApps as Array<{ name: string; duration: number }>).find((a) => a.name === 'chrome.exe');
  assert.equal(chrome?.duration, 3600, 'org B 3600s chrome row must not inflate org A');
});

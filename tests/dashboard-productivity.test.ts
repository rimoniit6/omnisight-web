/**
 * P1-1 — Dashboard `productivityScore`.
 *
 * The KPI must be a REAL server-side value using the canonical formula
 * (productive ÷ total categorized duration × 100) over the SAME 7-day
 * org-local window as the dailyProductivity trend. Previously the client
 * defaulted an always-absent field to 0.
 *
 * Cases (each isolated in its own org so window totals never bleed across):
 *   - empty dataset                    → 0
 *   - only productive in window        → 100
 *   - only unproductive in window      → 0
 *   - partial (mixed)                  → rounded productive share
 *   - out-of-window rows excluded      → window is exactly the trailing 7 days
 *   - other org's activity not counted → organization scope
 *   - response explicitly contains productivityScore, and it matches the
 *     dailyProductivity trend buckets exactly
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_dashprod).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_dashprod';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-dashprod-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@dashprod.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!DashProd2026x';
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
let seq = 0;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
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

/** Fresh org + employee + admin token, fully isolated from other cases. */
async function freshOrg(): Promise<{ orgId: string; empId: string; token: string }> {
  seq += 1;
  const org = await db.organization.create({ data: { name: `Org ${seq}`, slug: `org-${seq}`, timezone: 'UTC' } });
  const emp = await db.employee.create({
    data: { employeeId: `DP-EMP-${seq}`, firstName: 'W', lastName: `E${seq}`, email: `e${seq}@dp.test`, organizationId: org.id, status: 'active' },
  });
  const token = await signJWT({ userId: `admin-${seq}`, email: `a${seq}@dp.test`, role: 'admin', organizationId: org.id });
  return { orgId: org.id, empId: emp.id, token };
}

function req(token: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/dashboard', {
    headers: { authorization: `Bearer ${token}` },
  });
}

async function dashboardData(token: string): Promise<{ productivityScore: number; dailyProductivity: Array<{ productive: number; neutral: number; unproductive: number }> }> {
  const api = await import('../src/app/api/dashboard/route');
  const res = await api.GET(req(token));
  assert.equal(res.status, 200);
  const body = await res.json();
  return (body.data as { productivityScore: number; dailyProductivity: Array<{ productive: number; neutral: number; unproductive: number }> });
}

// Phase 1: Activity requires direct organizationId — resolve from the employee (same rule as the DB backfill).
const mk = async (employeeId: string, category: string, duration: number, timestamp: Date) => {
  const emp = await db.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { organizationId: true } });
  return db.activity.create({
    data: { type: 'application', title: null, applicationName: 'Code', category, duration, employeeId, organizationId: emp.organizationId, timestamp, createdAt: timestamp },
  });
};

const inWindow = (daysAgo: number, hourUtc = 12) =>
  new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - daysAgo, hourUtc, 0, 0, 0));

test('DP-1: empty dataset → productivityScore is present and 0', async () => {
  const { token } = await freshOrg();
  const data = await dashboardData(token);
  assert.ok('productivityScore' in data, 'response must explicitly contain productivityScore');
  assert.equal(data.productivityScore, 0);
});

test('DP-2: only productive in window → 100', async () => {
  const { empId, token } = await freshOrg();
  await mk(empId, 'productive', 3600, inWindow(1));
  await mk(empId, 'productive', 1800, inWindow(2));
  assert.equal((await dashboardData(token)).productivityScore, 100);
});

test('DP-3: only unproductive in window → 0', async () => {
  const { empId, token } = await freshOrg();
  await mk(empId, 'unproductive', 5400, inWindow(1));
  assert.equal((await dashboardData(token)).productivityScore, 0);
});

test('DP-4: mixed categories → rounded productive share', async () => {
  const { empId, token } = await freshOrg();
  // 3600 productive + 1200 neutral + 1200 unproductive = 6000 total → 60%.
  await mk(empId, 'productive', 3600, inWindow(1));
  await mk(empId, 'neutral', 1200, inWindow(1));
  await mk(empId, 'unproductive', 1200, inWindow(2));
  assert.equal((await dashboardData(token)).productivityScore, 60);
});

test('DP-5: out-of-window rows are excluded (7-day window)', async () => {
  const { empId, token } = await freshOrg();
  // 1 day ago: all productive. 10 days ago: all unproductive (must be excluded).
  await mk(empId, 'productive', 7200, inWindow(1));
  await mk(empId, 'unproductive', 9999, inWindow(10));
  assert.equal((await dashboardData(token)).productivityScore, 100);
});

test('DP-6: other org activity is never counted (organization scope)', async () => {
  const a = await freshOrg();
  const b = await freshOrg();
  await mk(a.empId, 'productive', 3600, inWindow(1));
  await mk(b.empId, 'unproductive', 99999, inWindow(1));
  await mk(b.empId, 'neutral', 99999, inWindow(2));
  assert.equal((await dashboardData(b.token)).productivityScore, 0, 'org B is 100% unproductive');
  assert.equal((await dashboardData(a.token)).productivityScore, 100, 'org A unaffected by org B block');
});

test('DP-7: score matches the dailyProductivity trend buckets exactly', async () => {
  const { empId, token } = await freshOrg();
  await mk(empId, 'productive', 5400, inWindow(1));
  await mk(empId, 'neutral', 1800, inWindow(2));
  await mk(empId, 'unproductive', 900, inWindow(3));
  const data = await dashboardData(token);
  const total = data.dailyProductivity.reduce((s, d) => s + d.productive + d.neutral + d.unproductive, 0);
  const productive = data.dailyProductivity.reduce((s, d) => s + d.productive, 0);
  const expected = total > 0 ? Math.round((productive / total) * 100) : 0;
  assert.equal(data.productivityScore, expected, 'KPI and trend chart derive from the same buckets');
});

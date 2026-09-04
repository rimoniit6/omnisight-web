/**
 * P2-2 — bounded export verification.
 *
 * - /api/export validates the shared date range (inverted/malformed → 400).
 * - Activity/time-entry exports without a range default to the last 90 days
 *   (never the whole table), org-scoped via the employee relation.
 * - Filters (employeeId, category, from/to, search) are preserved.
 * - pagedCollect stops at its cap and only materializes one page at a time.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_exportbounded).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_exportbounded';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-exportbounded-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@exportbounded.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!ExportBounded2026x';
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
let managerTokenA: string;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  orgA = await db.organization.create({ data: { name: 'Exp Org A', slug: 'exp-org-a', timezone: 'UTC' } });
  orgB = await db.organization.create({ data: { name: 'Exp Org B', slug: 'exp-org-b', timezone: 'UTC' } });

  const mkEmp = (employeeId: string, orgId: string) =>
    db.employee.create({ data: { employeeId, firstName: employeeId, lastName: 'User', email: `${employeeId.toLowerCase()}@exp.test`, organizationId: orgId, status: 'active' } });
  empA = await mkEmp('EXP-1', orgA.id);
  empB = await mkEmp('EXP-2', orgB.id);

  // Phase 1: Activity requires direct organizationId — resolve from the employee (same rule as the DB backfill).
  const mkAct = async (employeeId: string, applicationName: string, category: string, duration: number, timestamp: Date) => {
    const emp = await db.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { organizationId: true } });
    return db.activity.create({ data: { type: 'application', applicationName, category, duration, employeeId, organizationId: emp.organizationId, timestamp, createdAt: timestamp } });
  };

  const now = Date.now();
  // Recent (inside the default 90-day window):
  await mkAct(empA.id, 'chrome.exe', 'productive', 3600, new Date(now - 2 * 86_400_000));
  await mkAct(empA.id, 'Code.exe', 'neutral', 600, new Date(now - 3 * 86_400_000));
  // Old (outside the default 90-day window):
  await mkAct(empA.id, 'ancient.exe', 'unproductive', 9999, new Date(now - 200 * 86_400_000));
  // Internal agent process (never exported):
  await mkAct(empA.id, 'OmniSightAgent.exe', 'productive', 999999, new Date(now - 1 * 86_400_000));
  // Cross-org (never exported to org A):
  await mkAct(empB.id, 'chrome.exe', 'productive', 3600, new Date(now - 2 * 86_400_000));

  managerTokenA = await signJWT({ userId: 'mgr-exp', email: 'mgr@exp.test', role: 'manager', organizationId: orgA.id });
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

async function exportActivities(url: string) {
  const api = await import('../src/app/api/export/[type]/route');
  const res = await api.GET(req(managerTokenA, url), { params: Promise.resolve({ type: 'activities' }) });
  return res;
}

test('EXP-1: inverted date range returns 400', async () => {
  const res = await exportActivities('http://localhost:3000/api/export/activities?format=csv&columns=employee&from=2026-08-20&to=2026-08-10');
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /must not be after/i);
});

test('EXP-2: malformed date returns 400 (never a silent empty export)', async () => {
  const res = await exportActivities('http://localhost:3000/api/export/activities?format=csv&columns=employee&from=garbage&to=2026-08-10');
  assert.equal(res.status, 400);
});

test('EXP-3: no date range defaults to the last 90 days — ancient rows excluded, internal agent excluded, cross-org excluded', async () => {
  const res = await exportActivities('http://localhost:3000/api/export/activities?format=csv&columns=employee,applicationName,duration&to=');
  assert.equal(res.status, 200);
  const text = await res.text();
  // Only chrome.exe + Code.exe (2 activities). ancient.exe, OmniSightAgent.exe
  // and org B's chrome.exe must never appear.
  assert.ok(text.includes('chrome.exe'), 'recent chrome.exe present');
  assert.ok(text.includes('Code.exe'), 'recent Code.exe present');
  assert.ok(!text.includes('ancient.exe'), '200-day-old activity excluded by the 90-day default window');
  assert.ok(!text.includes('OmniSightAgent.exe'), 'internal agent process excluded');
  assert.equal((text.match(/chrome\.exe/g) || []).length, 1, 'only ONE chrome.exe (org B must be concealed)');
});

test('EXP-4: explicit employeeId + category filters still narrow the export', async () => {
  const res = await exportActivities(
    `http://localhost:3000/api/export/activities?format=csv&columns=employee,applicationName&employeeId=${empA.id}&category=productive&from=2026-01-01&to=2026-12-31`
  );
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('chrome.exe'));
  assert.ok(!text.includes('Code.exe'), 'neutral category filtered out');
});

test('EXP-5: explicit date range overrides the default window (ancient row included)', async () => {
  const res = await exportActivities('http://localhost:3000/api/export/activities?format=csv&columns=applicationName&from=2025-01-01&to=2026-12-31');
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('ancient.exe'), 'explicit wide range includes the old activity');
});

test('EXP-6: unauthorized role (employee) is rejected by handler-level RBAC', async () => {
  const empToken = await signJWT({ userId: 'emp-exp', email: 'emp@exp.test', role: 'employee', organizationId: orgA.id });
  const api = await import('../src/app/api/export/[type]/route');
  const res = await api.GET(req(empToken, 'http://localhost:3000/api/export/activities?format=csv&columns=employee'), { params: Promise.resolve({ type: 'activities' }) });
  assert.equal(res.status, 403);
});

test('EXP-7: pagedCollect stops at the cap and only walks pages until exhausted', async () => {
  const { pagedCollect } = await import('../src/app/api/export/[type]/route');

  // 7 rows served in pages of 3; cap = 5 → exactly 5 kept, and no page beyond
  // the cap is fetched.
  let fetchedPages = 0;
  const allRows = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: `id-${n}`, timestamp: new Date(2026, 0, n) }));
  const first = async () => {
    fetchedPages += 1;
    return allRows.slice(0, 3);
  };
  const next = async (last: { id: string }) => {
    fetchedPages += 1;
    const idx = allRows.findIndex((r) => r.id === last.id);
    return allRows.slice(idx + 1, idx + 1 + 3);
  };

  const out = await pagedCollect(first, next, () => true, 'unit', { cap: 5, pageSize: 3 });
  assert.equal(out.length, 5, 'cap honored');
  assert.deepEqual(out.map((r) => r.id), ['id-1', 'id-2', 'id-3', 'id-4', 'id-5']);
  assert.equal(fetchedPages, 2, 'stops fetching once the cap is reached');

  // Without a cap, all 7 rows are collected across 3 pages.
  const outAll = await pagedCollect(first, next, () => true, 'unit', { pageSize: 3 });
  assert.equal(outAll.length, 7);
  assert.equal(fetchedPages, 5);
});

test('EXP-8: search filter is applied per page and preserved across pages', async () => {
  const { pagedCollect } = await import('../src/app/api/export/[type]/route');
  // 5 rows across pages of 3; the fuzzy filter matches only even rows.
  const rows = [1, 2, 3, 4, 5].map((n) => ({ id: `id-${n}`, timestamp: new Date(2026, 0, n), title: n % 2 === 0 ? 'matchme' : 'other' }));
  let calls = 0;
  const first = async () => {
    calls += 1;
    return rows.slice(0, 3);
  };
  const next = async (last: { id: string }) => {
    calls += 1;
    const idx = rows.findIndex((r) => r.id === last.id);
    return rows.slice(idx + 1, idx + 1 + 3);
  };
  const out = await pagedCollect(first, next, (r: { title: string }) => r.title === 'matchme', 'unit', { cap: 100, pageSize: 3 });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => (r as { id: string }).id), ['id-2', 'id-4']);
  assert.equal(calls, 2, 'one first page + one cursor page (rows 4-5)');
});

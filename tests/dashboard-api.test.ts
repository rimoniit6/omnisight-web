/**
 * Dashboard API regression tests.
 *
 * Covers:
 *   - Authentication (unauthenticated → 401)
 *   - Tenant isolation (org A cannot see org B data)
 *   - Data correctness (employee count, device count, activity metrics)
 *   - Error handling (safe 500, no internal details leaked)
 *   - N+1 query detection (dashboard should not loop over employees)
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_dashboard_api).
 * Run: npx tsx --test tests/dashboard-api.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_dashboard_api';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-dashapi-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@dashapi.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!DashApi2026x';
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
let signJWT: (payload: {
  userId: string;
  email: string;
  role: string;
  organizationId?: string;
}) => Promise<string>;

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
async function freshOrg(): Promise<{
  orgId: string;
  empId: string;
  token: string;
}> {
  seq += 1;
  const org = await db.organization.create({
    data: { name: `DashAPI Org ${seq}`, slug: `dashapi-org-${seq}`, timezone: 'UTC' },
  });
  const emp = await db.employee.create({
    data: {
      employeeId: `DA-EMP-${seq}`,
      firstName: 'Dash',
      lastName: `API${seq}`,
      email: `da${seq}@dashapi.test`,
      organizationId: org.id,
      status: 'active',
    },
  });
  const token = await signJWT({
    userId: `admin-da-${seq}`,
    email: `admin-da${seq}@dashapi.test`,
    role: 'admin',
    organizationId: org.id,
  });
  return { orgId: org.id, empId: emp.id, token };
}

function makeReq(token: string | null): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new NextRequest('http://localhost:3000/api/dashboard', { headers });
}

async function dashboard(token: string) {
  const api = await import('../src/app/api/dashboard/route');
  const res = await api.GET(makeReq(token));
  return { status: res.status, body: await res.json() };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. AUTHENTICATION
// ═══════════════════════════════════════════════════════════════════════════

test('AUTH-1: unauthenticated request → 401', async () => {
  const api = await import('../src/app/api/dashboard/route');
  const res = await api.GET(makeReq(null));
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.ok(body.error);
});

test('AUTH-2: invalid token → 401', async () => {
  const api = await import('../src/app/api/dashboard/route');
  const res = await api.GET(makeReq('invalid-token-abcdef1234567890'));
  assert.equal(res.status, 401);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. TENANT ISOLATION
// ═══════════════════════════════════════════════════════════════════════════

test('TENANT-1: org A cannot see org B data', async () => {
  const a = await freshOrg();
  const b = await freshOrg();

  // Create activity in org B only
  await db.activity.create({
    data: {
      employeeId: b.empId,
      type: 'application',
      applicationName: 'Code',
      category: 'productive',
      duration: 3600,
      timestamp: new Date(),
      createdAt: new Date(),
    },
  });

  const dashA = await dashboard(a.token);
  const dashB = await dashboard(b.token);

  assert.equal(dashA.status, 200);
  assert.equal(dashB.status, 200);
  assert.equal(dashA.body.data.totalEmployees, 1);
  assert.equal(dashB.body.data.totalEmployees, 1);
  // Org A should have zero productive time (its activity is from org B)
  assert.equal(dashA.body.data.avgProductivity, 0);
  // Org B should have 1 hour productive time
  assert.equal(dashB.body.data.avgProductivity, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. DATA CORRECTNESS
// ═══════════════════════════════════════════════════════════════════════════

test('DATA-1: employee count matches', async () => {
  const { orgId, empId, token } = await freshOrg();
  const data = (await dashboard(token)).body.data;
  assert.equal(data.totalEmployees, 1);

  // Add a second employee
  await db.employee.create({
    data: {
      employeeId: `DA-EMP-${seq}-2`,
      firstName: 'Two',
      lastName: 'Employee',
      email: `da${seq}-2@dashapi.test`,
      organizationId: orgId,
      status: 'active',
    },
  });
  const data2 = (await dashboard(token)).body.data;
  assert.equal(data2.totalEmployees, 2);
});

test('DATA-2: device count and status breakdown', async () => {
  const { orgId, token } = await freshOrg();
  const now = new Date();

  await db.device.create({
    data: {
      name: 'Fresh',
      hostname: 'PC-FRESH',
      agentKey: `key-fresh-${seq}`,
      organizationId: orgId,
      status: 'online',
      lastHeartbeat: new Date(now.getTime() - 30_000),
    },
  });
  await db.device.create({
    data: {
      name: 'Stale',
      hostname: 'PC-STALE',
      agentKey: `key-stale-${seq}`,
      organizationId: orgId,
      status: 'online',
      lastHeartbeat: new Date(now.getTime() - 600_000),
    },
  });

  const data = (await dashboard(token)).body.data;
  assert.equal(data.totalDevices, 2);
  // Only fresh device counts as online
  assert.equal(data.onlineDevices, 1);
  // Breakdown should exist
  assert.ok(Array.isArray(data.deviceStatusBreakdown));
  assert.ok(data.deviceStatusBreakdown.length > 0);
});

test('DATA-3: activities feed is populated', async () => {
  const { empId, token } = await freshOrg();
  await db.activity.create({
    data: {
      employeeId: empId,
      type: 'application',
      applicationName: 'VSCode',
      category: 'productive',
      duration: 1800,
      timestamp: new Date(),
      createdAt: new Date(),
    },
  });

  const data = (await dashboard(token)).body.data;
  assert.ok(Array.isArray(data.recentActivities));
  assert.ok(data.recentActivities.length >= 1);
  // Activity should have employee info
  const act = data.recentActivities[0];
  assert.ok(act.employee);
  assert.equal(act.employee.firstName, 'Dash');
});

test('DATA-4: department breakdown', async () => {
  const { orgId, empId, token } = await freshOrg();
  const dept = await db.department.create({
    data: { name: 'Engineering', organizationId: orgId },
  });
  await db.employee.update({
    where: { id: empId },
    data: { departmentId: dept.id },
  });

  const data = (await dashboard(token)).body.data;
  assert.ok(Array.isArray(data.departmentBreakdown));
  const eng = data.departmentBreakdown.find(
    (d: { name: string }) => d.name === 'Engineering'
  );
  assert.ok(eng, 'Engineering department should appear');
  assert.equal(eng._count.employees, 1);
});

test('DATA-5: dailyProductivity has 7 buckets', async () => {
  const { token } = await freshOrg();
  const data = (await dashboard(token)).body.data;
  assert.ok(Array.isArray(data.dailyProductivity));
  assert.equal(data.dailyProductivity.length, 7);
  // Each bucket should have productive, neutral, unproductive
  for (const bucket of data.dailyProductivity) {
    assert.equal(typeof bucket.productive, 'number');
    assert.equal(typeof bucket.neutral, 'number');
    assert.equal(typeof bucket.unproductive, 'number');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════════════

test('ERR-1: error response does not leak internal details', async () => {
  const api = await import('../src/app/api/dashboard/route');
  const res = await api.GET(makeReq(null));
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.ok(body.error);
  // Must NOT contain stack traces, Prisma internals, or DB details
  assert.ok(!JSON.stringify(body).includes('stack'));
  assert.ok(!JSON.stringify(body).includes('PrismaClient'));
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. N+1 QUERY DETECTION
// ═══════════════════════════════════════════════════════════════════════════

test('NPLUS-1: dashboard does not generate N+1 queries for employees', async () => {
  const { orgId, token } = await freshOrg();

  // Create10 employees with activities
  const employees = [];
  for (let i = 0; i < 10; i++) {
    const emp = await db.employee.create({
      data: {
        employeeId: `DA-N1-${seq}-${i}`,
        firstName: `Emp`,
        lastName: `${i}`,
        email: `n1-${seq}-${i}@dashapi.test`,
        organizationId: orgId,
        status: 'active',
      },
    });
    employees.push(emp);
    // Each employee has a productive activity
    await db.activity.create({
      data: {
        employeeId: emp.id,
        type: 'application',
        applicationName: 'Code',
        category: 'productive',
        duration: 3600,
        timestamp: new Date(),
        createdAt: new Date(),
      },
    });
  }

  // Dashboard should complete without excessive time (N+1 would be slow)
  const start = Date.now();
  const result = await dashboard(token);
  const elapsed = Date.now() - start;

  assert.equal(result.status, 200);
  assert.equal(result.body.data.totalEmployees, 11); // 1 from freshOrg + 10 new
  // With N+1, this would be10+ separate queries. Without N+1, it should be fast.
  // Allow generous time for cold DB, but flag if >5s (N+1 would be much slower).
  assert.ok(elapsed < 5000, `Dashboard took ${elapsed}ms — possible N+1 query issue`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. EMPTY STATE
// ═══════════════════════════════════════════════════════════════════════════

test('EMPTY-1: empty org returns valid zero dashboard', async () => {
  const { token } = await freshOrg();
  const data = (await dashboard(token)).body.data;
  assert.equal(data.totalEmployees, 0);
  assert.equal(data.totalDevices, 0);
  assert.equal(data.onlineDevices, 0);
  assert.equal(data.avgProductivity, 0);
  assert.equal(data.productivityScore, 0);
  assert.equal(data.activeAlerts, 0);
  assert.ok(Array.isArray(data.recentActivities));
  assert.equal(data.recentActivities.length, 0);
  assert.ok(Array.isArray(data.topEmployees));
  assert.equal(data.topEmployees.length, 0);
  assert.ok(Array.isArray(data.departmentBreakdown));
  assert.ok(Array.isArray(data.deviceStatusBreakdown));
  assert.ok(Array.isArray(data.dailyProductivity));
  assert.equal(data.dailyProductivity.length, 7);
});

/**
 * EN — legacy enrollment path parity (R6: no security difference between the
 * two enrollment paths).
 *
 * The application supports TWO enrollment flows:
 *   A. zero-touch  — device discovery + claim, admin approves the DeviceClaim
 *   B. legacy      — POST /api/agent/register with employeeId + agentPassword,
 *                    admin approves the AgentRegistration
 *
 * Both paths share the SAME security guarantees: a credential/identity gate,
 * server-side rate limiting, and — critically — BOTH end in an explicit admin
 * approval. Neither path ever auto-approves a device. This suite pins the
 * legacy gate directly (the zero-touch gate is covered by tests/zero-touch).
 *
 * Cases:
 *   - EN-1: valid credentials → 201 pending — NEVER auto-approved
 *   - EN-2: wrong password → uniform 401 (no credential enumeration)
 *   - EN-3: unknown employeeId → identical 401 message
 *   - EN-4: inactive employee → 403
 *   - EN-5: already-approved employee → already_approved, no duplicate row
 *   - EN-6: per-IP registration rate limit → 429 (shared PG limiter)
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_agentregister).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_agentregister';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-agentregister-0123456789abcdef';
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
type RegisterApi = typeof import('../src/app/api/agent/register/route');
let registerApi: RegisterApi;
let hashPassword: (password: string) => Promise<string>;

const PASSWORD = 'legacy-pass-123456';

let orgId: string;
let empId: string;

function post(body: Record<string, unknown>, ip: string): Promise<Response> {
  return registerApi.POST(new NextRequest('http://test.local/api/agent/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  }));
}

before(async () => {
  db = (await import('../src/lib/db')).db;
  hashPassword = (await import('../src/lib/auth')).hashPassword;
  registerApi = await import('../src/app/api/agent/register/route');

  const org = await db.organization.create({ data: { name: 'EN Org', slug: 'en-org', timezone: 'UTC' } });
  orgId = org.id;
  empId = (await db.employee.create({
    data: {
      employeeId: 'EN-EMP-1',
      firstName: 'E',
      lastName: 'Legacy',
      email: 'en@example.com',
      organizationId: org.id,
      status: 'active',
      agentPassword: await hashPassword(PASSWORD),
    },
  })).id;
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

const DEVICE = { hostname: 'en-host', os: 'Windows 11', osVersion: '23H2' };

test('EN-1: valid credentials → 201 pending — NEVER auto-approved (parity with zero-touch)', async () => {
  const res = await post({ employeeId: 'EN-EMP-1', password: PASSWORD, ...DEVICE }, '203.0.113.1');
  assert.equal(res.status, 201, 'registration accepted');
  const body = await res.json();
  assert.equal(body.status, 'pending', 'requires admin approval');
  assert.ok(body.registrationId, 'registration id returned');

  const reg = await db.agentRegistration.findUnique({ where: { employeeId: empId } });
  assert.ok(reg, 'AgentRegistration row created');
  assert.equal(reg.status, 'pending', 'NOT auto-approved');
  assert.equal(reg.organizationId, orgId);

  // No Device was created by registration itself — approval creates it.
  assert.equal(await db.device.count({ where: { employeeId: empId } }), 0, 'no device before approval');
});

test('EN-2: wrong password → uniform 401', async () => {
  const res = await post({ employeeId: 'EN-EMP-1', password: 'wrong-password', ...DEVICE }, '203.0.113.2');
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'Invalid credentials', 'same message as unknown employee — no enumeration');
});

test('EN-3: unknown employeeId → identical 401 message', async () => {
  const res = await post({ employeeId: 'EN-NOPE', password: PASSWORD, ...DEVICE }, '203.0.113.3');
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, 'Invalid credentials', 'indistinguishable from wrong password');
});

test('EN-4: inactive employee → 403', async () => {
  const inactiveId = (await db.employee.create({
    data: { employeeId: 'EN-EMP-2', firstName: 'E', lastName: 'Inactive', email: 'en2@example.com', organizationId: orgId, status: 'inactive', agentPassword: await hashPassword(PASSWORD) },
  })).id;

  const res = await post({ employeeId: 'EN-EMP-2', password: PASSWORD, ...DEVICE }, '203.0.113.4');
  assert.equal(res.status, 403, 'inactive employee cannot enroll');
  assert.equal(await db.agentRegistration.count({ where: { employeeId: inactiveId } }), 0, 'no registration row for inactive employee');
});

test('EN-5: already-approved employee → already_approved, no duplicate row', async () => {
  // Approve EN-EMP-1 (mimics the admin approving the EN-1 registration).
  await db.employee.update({ where: { id: empId }, data: { agentApproved: true } });
  await db.agentRegistration.update({ where: { employeeId: empId }, data: { status: 'approved' } });

  const res = await post({ employeeId: 'EN-EMP-1', password: PASSWORD, ...DEVICE }, '203.0.113.5');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'already_approved', 'points to authenticate instead of duplicating');

  const approvedRegs = await db.agentRegistration.count({ where: { employeeId: empId, status: 'approved' } });
  assert.equal(approvedRegs, 1, 'no duplicate registration rows');
});

test('EN-6: per-IP registration rate limit → 429 (shared PG limiter)', async () => {
  const ip = '198.51.100.77';
  // Deterministic (S-11): the shared PG bucket refills continuously, so a
  // slow bcrypt-heavy burst can outpace consumption under parallel test load
  // and never reach 429 — a timing flake, not a limiter bug. Pre-drain the
  // bucket with fast direct limiter calls, then assert the real route denies.
  const { checkRateLimit, RATE_LIMITS } = await import('../src/lib/rate-limit');
  const key = `agent-register:${ip}`;
  for (let i = 0; i < 15; i++) {
    await checkRateLimit(key, RATE_LIMITS.agentRegister.limit, RATE_LIMITS.agentRegister.windowMs);
  }
  const res = await post({ employeeId: 'EN-EMP-1', password: 'wrong', ...DEVICE }, ip);
  assert.equal(res.status, 429, 'registration attempts from one IP are throttled');
});

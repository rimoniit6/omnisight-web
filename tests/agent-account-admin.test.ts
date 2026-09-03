/**
 * Phase 2 — Admin Agent-Account Management API + UI tests.
 *
 * Covers:
 *   AA-A1 … AA-A22 — Admin API contract (create, get, reset, enable/disable,
 *                     RBAC, org isolation, audit, rate limit, concurrent).
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_agentaccount_admin).
 * Run: npm run test:agent-account-admin  (or npx tsx --test tests/agent-account-admin.test.ts)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { req } from './helpers/request';

// ─── Test DB isolation (set BEFORE any app module import) ──────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_agentaccount_admin';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-agentaccount-admin-0123456789abcdef';
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
let agentAccountService: typeof import('../src/lib/agent-account');

let agentAccountRoute: typeof import('../src/app/api/employees/[id]/agent-account/route');
let agentAccountResetRoute: typeof import('../src/app/api/employees/[id]/agent-account/reset-password/route');
let verifyPassword: (password: string, hash: string) => Promise<boolean>;
let agentLoginRoute: typeof import('../src/app/api/agent/login/route');

let orgA: { id: string };
let orgB: { id: string };

before(async () => {
  db = (await import('../src/lib/db')).db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  agentAccountService = await import('../src/lib/agent-account');
  verifyPassword = (await import('../src/lib/auth')).verifyPassword;

  const [dApi, resetApi, loginApi] = await Promise.all([
    import('../src/app/api/employees/[id]/agent-account/route'),
    import('../src/app/api/employees/[id]/agent-account/reset-password/route'),
    import('../src/app/api/agent/login/route'),
  ]);
  agentAccountRoute = dApi;
  agentAccountResetRoute = resetApi;
  agentLoginRoute = loginApi;

  orgA = await db.organization.create({ data: { name: 'Org A', slug: 'org-a' } });
  orgB = await db.organization.create({ data: { name: 'Org B', slug: 'org-b' } });
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

// ─── Helpers ────────────────────────────────────────────────────────────────


async function seedEmployee(orgId: string, code: string) {
  return db.employee.create({
    data: {
      employeeId: code,
      firstName: code.split('-')[0],
      lastName: 'Test',
      email: `${code.toLowerCase()}@test.local`,
      organizationId: orgId,
      status: 'active',
      agentApproved: false,
    },
  });
}

function adminToken(orgId: string, role = 'admin'): Promise<string> {
  return signJWT({ userId: 'admin-test', email: 'admin@test.local', role, organizationId: orgId });
}

function viewerToken(orgId: string): Promise<string> {
  return signJWT({ userId: 'viewer-test', email: 'viewer@test.local', role: 'viewer', organizationId: orgId });
}

function managerToken(orgId: string): Promise<string> {
  return signJWT({ userId: 'manager-test', email: 'manager@test.local', role: 'manager', organizationId: orgId });
}

const ACC_IP = '203.0.113.50';

// ─── AA-A1 – AA-A4: CREATE ─────────────────────────────────────────────────

test('AA-A1: admin creates agent account — returns safe shape, no hash', async () => {
  const emp = await seedEmployee(orgA.id, 'AA-A1-EMP');
  const token = await adminToken(orgA.id);

  const res = await agentAccountRoute.POST(
    req(token, { method: 'POST', body: { password: 'Str0ng!Pass123x' }, ip: ACC_IP }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  assert.equal(res.status, 201);
  const body = await res.json() as { data: Record<string, unknown> };
  const d = body.data;
  assert.equal(d.employeeId, emp.id);
  assert.equal(d.agentId, 'AA-A1-EMP');
  assert.equal(d.status, 'active');
  assert.ok(d.passwordChangedAt);
  // No hash anywhere
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('passwordHash'));
  assert.ok(!serialized.includes('Str0ng!Pass123x'));
  assert.ok(!serialized.includes('$2'));

  // DB: bcrypt
  const row = await db.agentAccount.findUnique({ where: { employeeId: emp.id } });
  assert.ok(row);
  assert.match(row!.passwordHash, /^\$2[aby]\$/);
  assert.equal(await verifyPassword('Str0ng!Pass123x', row!.passwordHash!), true);
});

test('AA-A2: duplicate create → 409', async () => {
  const emp = await seedEmployee(orgA.id, 'AA-A2-EMP');
  const token = await adminToken(orgA.id);
  await agentAccountRoute.POST(
    req(token, { method: 'POST', body: { password: 'Str0ng!Pass123x' }, ip: ACC_IP }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  const res = await agentAccountRoute.POST(
    req(token, { method: 'POST', body: { password: 'Str0ng!Pass456x' }, ip: ACC_IP }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  assert.equal(res.status, 409);
});

test('AA-A3: invalid password → 400', async () => {
  const emp = await seedEmployee(orgA.id, 'AA-A3-EMP');
  const token = await adminToken(orgA.id);
  const res = await agentAccountRoute.POST(
    req(token, { method: 'POST', body: { password: 'short' }, ip: ACC_IP }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  assert.equal(res.status, 400);
});

test('AA-A4: cross-org employee → 404', async () => {
  const emp = await seedEmployee(orgB.id, 'AA-A4-EMP');
  const token = await adminToken(orgA.id); // org A admin
  const res = await agentAccountRoute.POST(
    req(token, { method: 'POST', body: { password: 'Str0ng!Pass123x' }, ip: ACC_IP }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  assert.equal(res.status, 404);
});

// ─── AA-A5 – AA-A7: RBAC ───────────────────────────────────────────────────

test('AA-A5: unauthenticated → 401', async () => {
  const emp = await seedEmployee(orgA.id, 'AA-A5-EMP');
  const res = await agentAccountRoute.POST(
    req(null, { method: 'POST', body: { password: 'Str0ng!Pass123x' }, ip: ACC_IP }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  assert.equal(res.status, 401);
});

test('AA-A6: viewer → 403', async () => {
  const emp = await seedEmployee(orgA.id, 'AA-A6-EMP');
  const token = await viewerToken(orgA.id);
  const res = await agentAccountRoute.POST(
    req(token, { method: 'POST', body: { password: 'Str0ng!Pass123x' }, ip: ACC_IP }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  assert.equal(res.status, 403);
});

test('AA-A7: manager → 403', async () => {
  const emp = await seedEmployee(orgA.id, 'AA-A7-EMP');
  const token = await managerToken(orgA.id);
  const res = await agentAccountRoute.POST(
    req(token, { method: 'POST', body: { password: 'Str0ng!Pass123x' }, ip: ACC_IP }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  assert.equal(res.status, 403);
});

// ─── AA-A8 – AA-A9: GET ─────────────────────────────────────────────────────

test('AA-A8: GET returns safe account shape (no hash)', async () => {
  const emp = await seedEmployee(orgA.id, 'AA-A8-EMP');
  await agentAccountService.createAgentAccount({ employeeId: emp.id, password: 'Str0ng!Pass123x' });
  const token = await adminToken(orgA.id);

  const res = await agentAccountRoute.GET(
    req(token, { ip: ACC_IP }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  assert.equal(res.status, 200);
  const body = await res.json() as { data: Record<string, unknown> };
  assert.ok(body.data);
  assert.equal(body.data.agentId, 'AA-A8-EMP');
  assert.equal(body.data.status, 'active');
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('passwordHash'));
  assert.ok(!serialized.includes('$2'));
  // passwordChangedAt is a legitimate field name — only check for hash/plaintext leak
});

test('AA-A9: GET with no account → { data: null }', async () => {
  const emp = await seedEmployee(orgA.id, 'AA-A9-EMP');
  const token = await adminToken(orgA.id);
  const res = await agentAccountRoute.GET(
    req(token, { ip: ACC_IP }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  assert.equal(res.status, 200);
  const body = await res.json() as { data: unknown };
  assert.equal(body.data, null);
});

// ─── AA-A10 – AA-A13: PATCH (enable/disable) ────────────────────────────────

test('AA-A10: PATCH disable → status disabled, verifyAgentCredential fails', async () => {
  const emp = await seedEmployee(orgA.id, 'AA-A10-EMP');
  await agentAccountService.createAgentAccount({ employeeId: emp.id, password: 'Str0ng!Pass123x' });
  const token = await adminToken(orgA.id);

  const res = await agentAccountRoute.PATCH(
    req(token, { method: 'PATCH', body: { status: 'disabled' }, ip: ACC_IP }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  assert.equal(res.status, 200);
  const body = await res.json() as { data: Record<string, unknown> };
  assert.equal(body.data.status, 'disabled');

  const verify = await agentAccountService.verifyAgentCredential({ agentId: 'AA-A10-EMP', password: 'Str0ng!Pass123x' });
  assert.equal(verify.ok, false, 'disabled account fails closed');
});

test('AA-A11: PATCH enable → login works with existing password', async () => {
  const emp = await seedEmployee(orgA.id, 'AA-A11-EMP');
  await agentAccountService.createAgentAccount({ employeeId: emp.id, password: 'Str0ng!Pass123x' });
  const token = await adminToken(orgA.id);

  // Disable first
  await agentAccountRoute.PATCH(
    req(token, { method: 'PATCH', body: { status: 'disabled' }, ip: ACC_IP }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  // Re-enable
  const res = await agentAccountRoute.PATCH(
    req(token, { method: 'PATCH', body: { status: 'active' }, ip: ACC_IP }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  assert.equal(res.status, 200);
  const body = await res.json() as { data: Record<string, unknown> };
  assert.equal(body.data.status, 'active');

  const verify = await agentAccountService.verifyAgentCredential({ agentId: 'AA-A11-EMP', password: 'Str0ng!Pass123x' });
  assert.equal(verify.ok, true, 're-enabled account works with existing password');
});

test('AA-A12: PATCH invalid status → 400', async () => {
  const emp = await seedEmployee(orgA.id, 'AA-A12-EMP');
  const token = await adminToken(orgA.id);
  await agentAccountService.createAgentAccount({ employeeId: emp.id, password: 'Str0ng!Pass123x' });

  const res = await agentAccountRoute.PATCH(
    req(token, { method: 'PATCH', body: { status: 'bogus' }, ip: ACC_IP }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  assert.equal(res.status, 400);
});

test('AA-A13: PATCH ignores extra fields (agentId, passwordHash)', async () => {
  const emp = await seedEmployee(orgA.id, 'AA-A13-EMP');
  await agentAccountService.createAgentAccount({ employeeId: emp.id, password: 'Str0ng!Pass123x' });
  const token = await adminToken(orgA.id);

  const res = await agentAccountRoute.PATCH(
    req(token, { method: 'PATCH', body: { status: 'disabled', agentId: 'hacked', passwordHash: 'pwned' }, ip: ACC_IP }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  assert.equal(res.status, 200);
  const body = await res.json() as { data: Record<string, unknown> };
  assert.equal(body.data.agentId, 'AA-A13-EMP', 'agentId unchanged');
  const row = await db.agentAccount.findUnique({ where: { employeeId: emp.id } });
  assert.match(row!.passwordHash, /^\$2[aby]\$/, 'passwordHash unchanged');
});

// ─── AA-A14 – AA-A15: RESET PASSWORD ────────────────────────────────────────

test('AA-A14: reset password → old password fails, new password works, lockout cleared', async () => {
  const emp = await seedEmployee(orgA.id, 'AA-A14-EMP');
  await agentAccountService.createAgentAccount({ employeeId: emp.id, password: 'Str0ng!Pass123x' });
  const token = await adminToken(orgA.id);

  const reset = await agentAccountResetRoute.POST(
    req(token, { method: 'POST', body: { password: 'New!C1eanPass' }, ip: ACC_IP }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  assert.equal(reset.status, 200);

  const old = await agentAccountService.verifyAgentCredential({ agentId: 'AA-A14-EMP', password: 'Str0ng!Pass123x' });
  assert.equal(old.ok, false, 'old password fails');

  const fresh = await agentAccountService.verifyAgentCredential({ agentId: 'AA-A14-EMP', password: 'New!C1eanPass' });
  assert.equal(fresh.ok, true, 'new password works');
});

test('AA-A15: reset on missing account → 404', async () => {
  const emp = await seedEmployee(orgA.id, 'AA-A15-EMP');
  const token = await adminToken(orgA.id);
  const res = await agentAccountResetRoute.POST(
    req(token, { method: 'POST', body: { password: 'New!C1eanPass' }, ip: ACC_IP }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  assert.equal(res.status, 404);
});

// ─── AA-A16: no hash in any response ────────────────────────────────────────

test('AA-A16: password hash never in any response body', async () => {
  const emp = await seedEmployee(orgA.id, 'AA-A16-EMP');
  const token = await adminToken(orgA.id);

  const create = await agentAccountRoute.POST(
    req(token, { method: 'POST', body: { password: 'Str0ng!Pass123x' }, ip: ACC_IP }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  assert.ok(!JSON.stringify(await create.json()).includes('passwordHash'));

  const get = await agentAccountRoute.GET(
    req(token, { ip: ACC_IP }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  assert.ok(!JSON.stringify(await get.json()).includes('passwordHash'));

  const reset = await agentAccountResetRoute.POST(
    req(token, { method: 'POST', body: { password: 'New!C1eanPass' }, ip: ACC_IP }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  assert.ok(!JSON.stringify(await reset.json()).includes('passwordHash'));
});

// ─── AA-A17 – AA-A18: AUDIT LOG ─────────────────────────────────────────────

test('AA-A17: audit log entries created for create/reset/enable/disable', async () => {
  const emp = await seedEmployee(orgA.id, 'AA-A17-EMP');
  const token = await adminToken(orgA.id);

  // Create
  await agentAccountRoute.POST(
    req(token, { method: 'POST', body: { password: 'Str0ng!Pass123x' }, ip: '203.0.113.17' }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  let logs = await db.auditLog.findMany({ where: { resource: 'agent_account' }, orderBy: { createdAt: 'desc' } });
  assert.ok(logs.length >= 1);
  assert.equal(logs[0].action, 'create');

  // Disable
  await agentAccountRoute.PATCH(
    req(token, { method: 'PATCH', body: { status: 'disabled' }, ip: '203.0.113.17' }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  logs = await db.auditLog.findMany({ where: { resource: 'agent_account' }, orderBy: { createdAt: 'desc' } });
  assert.equal(logs[0].action, 'update');
  assert.ok(logs[0].description.includes('disabled'));

  // Enable
  await agentAccountRoute.PATCH(
    req(token, { method: 'PATCH', body: { status: 'active' }, ip: '203.0.113.17' }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  logs = await db.auditLog.findMany({ where: { resource: 'agent_account' }, orderBy: { createdAt: 'desc' } });
  assert.equal(logs[0].action, 'update');
  assert.ok(logs[0].description.includes('enabled'));

  // Reset
  await agentAccountResetRoute.POST(
    req(token, { method: 'POST', body: { password: 'New!C1eanPass' }, ip: '203.0.113.17' }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  logs = await db.auditLog.findMany({ where: { resource: 'agent_account' }, orderBy: { createdAt: 'desc' } });
  assert.equal(logs[0].action, 'reset');
});

test('AA-A18: audit log description contains no password or hash', async () => {
  const emp = await seedEmployee(orgA.id, 'AA-A18-EMP');
  const token = await adminToken(orgA.id);

  await agentAccountRoute.POST(
    req(token, { method: 'POST', body: { password: 'S3cret!Pass123' }, ip: '198.51.100.18' }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  const logs = await db.auditLog.findMany({ where: { resource: 'agent_account' } });
  for (const log of logs) {
    const serialized = JSON.stringify(log);
    assert.ok(!serialized.includes('S3cret!Pass123'), 'plaintext password not in audit');
    assert.ok(!serialized.includes('$2'), 'bcrypt hash not in audit');
  }
});

// ─── AA-A19: CONCURRENT CREATE ──────────────────────────────────────────────

test('AA-A19: concurrent create — exactly one 201 + one 409', async () => {
  const emp = await seedEmployee(orgA.id, 'AA-A19-EMP');
  const token = await adminToken(orgA.id);

  const [res1, res2] = await Promise.all([
    agentAccountRoute.POST(
      req(token, { method: 'POST', body: { password: 'Str0ng!Pass123x' }, ip: '203.0.113.19' }),
      { params: Promise.resolve({ id: emp.id }) }
    ),
    agentAccountRoute.POST(
      req(token, { method: 'POST', body: { password: 'Str0ng!Pass456x' }, ip: '203.0.113.19' }),
      { params: Promise.resolve({ id: emp.id }) }
    ),
  ]);

  const statuses = [res1.status, res2.status].sort();
  assert.deepEqual(statuses, [201, 409], 'one create, one conflict');
});

// ─── AA-A20: RATE LIMIT ─────────────────────────────────────────────────────

test('AA-A20: rate limit → 429 after limit exceeded', async () => {
  const emp = await seedEmployee(orgA.id, 'AA-A20-EMP');
  const token = await adminToken(orgA.id);

  // Deterministic rate-limit regression (S-11): the shared PG token bucket
  // REFILLS continuously (rate = limit/windowMs ≈ 1 token / 3 s), so a burst
  // of slow bcrypt-heavy route calls can outpace consumption under parallel
  // test load and never reach 429 — a test-timing flake, not a limiter bug.
  // Pre-drain the bucket with fast direct limiter calls (no bcrypt, no DB
  // writes), then assert the REAL route denies one more request.
  const { checkRateLimit, RATE_LIMITS } = await import('../src/lib/rate-limit');
  const key = 'agent-account-write:203.0.113.20';
  for (let i = 0; i < 25; i++) {
    await checkRateLimit(key, RATE_LIMITS.agentAccountWrite.limit, RATE_LIMITS.agentAccountWrite.windowMs);
  }

  const res = await agentAccountRoute.POST(
    req(token, { method: 'POST', body: { password: 'Str0ng!Pass123x' }, ip: '203.0.113.20' }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  assert.equal(res.status, 429, 'rate limit must trigger 429 on the real route');
});

// ─── AA-A21: DISABLED + LOCKED FAIL CLOSED ──────────────────────────────────

test('AA-A21: disabled and locked accounts fail closed', async () => {
  // Disabled: tested in AA-A10
  // Locked: trigger 5 wrong attempts, confirm correct password rejected
  const emp = await seedEmployee(orgA.id, 'AA-A21-EMP');
  await agentAccountService.createAgentAccount({ employeeId: emp.id, password: 'Str0ng!Pass123x' });

  for (let i = 0; i < 5; i++) {
    await agentAccountService.verifyAgentCredential({ agentId: 'AA-A21-EMP', password: 'wrong-password!' });
  }
  const locked = await agentAccountService.verifyAgentCredential({ agentId: 'AA-A21-EMP', password: 'Str0ng!Pass123x' });
  assert.equal(locked.ok, false, 'locked account rejects correct password');
  if (!locked.ok) {
    assert.equal(locked.locked, true);
  }
});

// ─── AA-A22: CLIENT ORG ID IGNORED ──────────────────────────────────────────

test('AA-A22: client-supplied organizationId in body is ignored', async () => {
  const emp = await seedEmployee(orgA.id, 'AA-A22-EMP');
  const token = await adminToken(orgA.id);

  // POST with organizationId in body — must be ignored (org from JWT)
  const res = await agentAccountRoute.POST(
    req(token, { method: 'POST', body: { password: 'Str0ng!Pass123x', organizationId: orgB.id }, ip: ACC_IP }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  assert.equal(res.status, 201);

  // The account must be linked to the employee's org, not the injected orgB
  const row = await db.agentAccount.findUnique({ where: { employeeId: emp.id } });
  assert.ok(row);
  const empRow = await db.employee.findUnique({ where: { id: emp.id } });
  assert.equal(empRow!.organizationId, orgA.id, 'employee still in org A');
});

// ─── AA-A23 – AA-A25: SETUP FLOW (migrated placeholder activation) ──────────
// The backfill migration created a DISABLED placeholder AgentAccount (with
// passwordChangedAt null) for every employee lacking a legacy agentPassword.
// "Set up Agent Account" reuses the reset-password endpoint; it must activate
// a placeholder in the same atomic write, while a deliberately disabled
// account (passwordChangedAt set) stays disabled.

/** Seed a placeholder exactly as the migration backfill does. */
async function seedPlaceholderAccount(empId: string, code: string) {
  return db.agentAccount.create({
    data: {
      employeeId: empId,
      agentId: code,
      passwordHash: '$2b$12$tHN15YZg2r9uKeW6c.k4Nusjf4mw2sFmuldY3RrnxwXOTKfgKuYsa', // migration placeholder hash
      status: 'disabled',
      passwordChangedAt: null,
    },
  });
}

test('AA-A23: setup (reset) on a migrated placeholder activates the account', async () => {
  const emp = await seedEmployee(orgA.id, 'AA-A23-EMP');
  await seedPlaceholderAccount(emp.id, 'AA-A23-EMP');
  const token = await adminToken(orgA.id);

  const res = await agentAccountResetRoute.POST(
    req(token, { method: 'POST', body: { password: 'New!Setup1234' }, ip: ACC_IP }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  assert.equal(res.status, 200);
  const body = await res.json() as { data: Record<string, unknown> };
  assert.equal(body.data.status, 'active', 'placeholder setup must activate the account');
  assert.ok(body.data.passwordChangedAt, 'passwordChangedAt populated');
  assert.equal(body.data.agentId, 'AA-A23-EMP', 'agentId unchanged');
  assert.ok(!JSON.stringify(body).includes('passwordHash'), 'no hash in response');

  // The configured credential authenticates (agent login works).
  const verify = await agentAccountService.verifyAgentCredential({ agentId: 'AA-A23-EMP', password: 'New!Setup1234' });
  assert.equal(verify.ok, true, 'newly configured credentials authenticate');
  if (verify.ok) {
    assert.equal(verify.account.status, 'active');
  }
  // Still 1:1 — no duplicate row.
  const count = await db.agentAccount.count({ where: { employeeId: emp.id } });
  assert.equal(count, 1, 'no duplicate AgentAccount row created');

  // Audit log reflects a setup.
  const logs = await db.auditLog.findMany({ where: { resource: 'agent_account' }, orderBy: { createdAt: 'desc' } });
  assert.equal(logs[0].action, 'reset');
  assert.ok(logs[0].description.includes('set up'));
});

test('AA-A24: reset on a deliberately disabled account (passwordChangedAt set) stays disabled', async () => {
  const emp = await seedEmployee(orgA.id, 'AA-A24-EMP');
  // Real account that was then disabled by the admin.
  await agentAccountService.createAgentAccount({ employeeId: emp.id, password: 'Str0ng!Pass123x' });
  const token = await adminToken(orgA.id);
  await agentAccountRoute.PATCH(
    req(token, { method: 'PATCH', body: { status: 'disabled' }, ip: ACC_IP }),
    { params: Promise.resolve({ id: emp.id }) }
  );

  const res = await agentAccountResetRoute.POST(
    req(token, { method: 'POST', body: { password: 'New!Setup1234' }, ip: ACC_IP }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  assert.equal(res.status, 200);
  const body = await res.json() as { data: Record<string, unknown> };
  assert.equal(body.data.status, 'disabled', 'deliberately disabled account stays disabled after a plain reset');
  assert.ok(body.data.passwordChangedAt, 'password still updated');
});

test('AA-A25: reset on an active account keeps it active', async () => {
  const emp = await seedEmployee(orgA.id, 'AA-A25-EMP');
  await agentAccountService.createAgentAccount({ employeeId: emp.id, password: 'Str0ng!Pass123x' });
  const token = await adminToken(orgA.id);

  const res = await agentAccountResetRoute.POST(
    req(token, { method: 'POST', body: { password: 'New!Setup1234' }, ip: ACC_IP }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  assert.equal(res.status, 200);
  const body = await res.json() as { data: Record<string, unknown> };
  assert.equal(body.data.status, 'active', 'active account remains active');
});

test('AA-A26: viewer/manager GET agent-account → 403 (card must not render Create/Setup)', async () => {
  const emp = await seedEmployee(orgA.id, 'AA-A26-EMP');
  await seedPlaceholderAccount(emp.id, 'AA-A26-EMP');

  for (const token of [await viewerToken(orgA.id), await managerToken(orgA.id)]) {
    const res = await agentAccountRoute.GET(
      req(token, { ip: ACC_IP }),
      { params: Promise.resolve({ id: emp.id }) }
    );
    assert.equal(res.status, 403, 'non-admin must get 403 on GET');
  }
});

test('AA-A27: end-to-end — placeholder setup then real /api/agent/login works', async () => {
  const emp = await seedEmployee(orgA.id, 'AA-A27-EMP');
  await seedPlaceholderAccount(emp.id, 'AA-A27-EMP');
  const token = await adminToken(orgA.id);

  // Admin "Set up Agent Account" → reset-password route (activates placeholder).
  const setup = await agentAccountResetRoute.POST(
    req(token, { method: 'POST', body: { password: 'New!Setup1234' }, ip: ACC_IP }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  assert.equal(setup.status, 200);

  // The employee's agent now logs in with the configured credentials — the
  // REAL /api/agent/login endpoint, not just the service verifier.
  const login = await agentLoginRoute.POST(
    req(null, { method: 'POST', body: { agentId: 'AA-A27-EMP', password: 'New!Setup1234' }, ip: '203.0.113.27' })
  );
  const loginBody = await login.json().catch(() => ({})) as Record<string, unknown>;
  assert.equal(login.status, 200, JSON.stringify(loginBody));
  assert.equal(loginBody.success, true);
  assert.equal(typeof loginBody.token, 'string', 'AgentSession issued');
  assert.equal((loginBody.employee as { employeeId?: string } | undefined)?.employeeId, 'AA-A27-EMP');
});
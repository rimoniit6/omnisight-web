/**
 * Security remediation regression suite (S-01 … S-04).
 *
 *   SR-01 (S-01) — consent read APIs are manager+ server-side: viewer/employee
 *                  get 403, unauthenticated 401, manager+ 200; no cross-org
 *                  consent data leaks through filters.
 *   SR-02 (S-02) — audit-log export is bounded: keyset pages, 100k row cap
 *                  with `truncated`, 90-day default window, malformed/inverted
 *                  dates → 400, org-scoped, manager+ only.
 *   SR-03 (S-03) — legacy PATH B agent auth has a per-employee lockout: 5
 *                  failures from ROTATING IPs still lock the account; correct
 *                  password is rejected while locked; lockout expires; success
 *                  resets the counter; response stays the uniform 401.
 *   SR-04 (S-04) — server-authoritative web-session revocation: logout kills
 *                  the token (Test A), revoke-all kills every session (Test B),
 *                  disable kills sessions (Test C), password change revokes
 *                  other sessions only (Test D), expired session rejects
 *                  (Test E).
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_secremediation).
 * Run: npx tsx --test tests/security-remediation.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_secremediation';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secremediation-0123456789abcdef';
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
  sessionId?: string;
}) => Promise<string>;
let hashPassword: (p: string) => Promise<string>;

let consentListRoute: typeof import('../src/app/api/consent/route');
let consentSummaryRoute: typeof import('../src/app/api/consent/summary/route');
let consentLogsRoute: typeof import('../src/app/api/consent/logs/route');
let consentPoliciesRoute: typeof import('../src/app/api/consent/policies/route');
let auditExportRoute: typeof import('../src/app/api/audit-logs/export/route');
let agentLoginRoute: typeof import('../src/app/api/agent/login/route');
let loginRoute: typeof import('../src/app/api/auth/login/route');
let logoutRoute: typeof import('../src/app/api/auth/logout/route');
let meRoute: typeof import('../src/app/api/auth/me/route');
let changePasswordRoute: typeof import('../src/app/api/auth/change-password/route');
let usersIdRoute: typeof import('../src/app/api/auth/users/[id]/route');
let revokeAllRoute: typeof import('../src/app/api/auth/sessions/revoke-all/route');
let adminRevokeRoute: typeof import('../src/app/api/auth/users/[id]/revoke-sessions/route');

let orgA: { id: string };
let orgB: { id: string };

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  const auth = await import('../src/lib/auth');
  signJWT = auth.signJWT;
  hashPassword = auth.hashPassword;

  const [c1, c2, c3, c4, a1, a2, l1, l2, m1, cp1, u1, r1, r2] = await Promise.all([
    import('../src/app/api/consent/route'),
    import('../src/app/api/consent/summary/route'),
    import('../src/app/api/consent/logs/route'),
    import('../src/app/api/consent/policies/route'),
    import('../src/app/api/audit-logs/export/route'),
    import('../src/app/api/agent/login/route'),
    import('../src/app/api/auth/login/route'),
    import('../src/app/api/auth/logout/route'),
    import('../src/app/api/auth/me/route'),
    import('../src/app/api/auth/change-password/route'),
    import('../src/app/api/auth/users/[id]/route'),
    import('../src/app/api/auth/sessions/revoke-all/route'),
    import('../src/app/api/auth/users/[id]/revoke-sessions/route'),
  ]);
  consentListRoute = c1;
  consentSummaryRoute = c2;
  consentLogsRoute = c3;
  consentPoliciesRoute = c4;
  auditExportRoute = a1;
  agentLoginRoute = a2;
  loginRoute = l1;
  logoutRoute = l2;
  meRoute = m1;
  changePasswordRoute = cp1;
  usersIdRoute = u1;
  revokeAllRoute = r1;
  adminRevokeRoute = r2;

  orgA = await db.organization.create({ data: { name: 'Sec Org A', slug: 'sec-org-a' } });
  orgB = await db.organization.create({ data: { name: 'Sec Org B', slug: 'sec-org-b' } });
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

function req(
  token: string | null,
  opts: { method?: string; body?: unknown; url?: string; ip?: string; ua?: string } = {}
): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (opts.ip) headers['x-forwarded-for'] = opts.ip;
  if (opts.ua) headers['user-agent'] = opts.ua;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(opts.url || 'http://localhost:3000/api/test', {
    // GET+body is invalid in Next 16 — a body without an explicit method means POST.
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

function tokenFor(orgId: string, role: string, userId: string, sessionId?: string): Promise<string> {
  return signJWT({ userId, email: `${userId}@sec.local`, role, organizationId: orgId, sessionId });
}

async function seedEmployee(orgId: string, code: string, overrides: Record<string, unknown> = {}) {
  return db.employee.create({
    data: {
      employeeId: code,
      firstName: code.split('-')[0],
      lastName: 'Sec',
      email: `${code.toLowerCase()}@sec.local`,
      organizationId: orgId,
      status: 'active',
      agentApproved: false,
      ...overrides,
    },
  });
}

/** Create a real (login-able) web user. */
async function createWebUser(email: string, password: string, orgId: string | null, role = 'admin') {
  return db.appUser.create({
    data: { email, name: email.split('@')[0], password: await hashPassword(password), role, organizationId: orgId ?? undefined },
  });
}

/** Log in an existing web user via the real login route. */
async function loginUser(email: string, password: string, ip: string): Promise<{ token: string }> {
  const res = await loginRoute.POST(req(null, { method: 'POST', body: { email, password }, ip, ua: 'Mozilla/5.0 SecTest' }));
  assert.equal(res.status, 200, `login should succeed for ${email}`);
  const body = (await res.json()) as { token: string };
  return { token: body.token };
}

// ─── SR-01: S-01 — CONSENT READ APIs manager+ ───────────────────────────────

test('SR-01a: consent reads are manager+ — viewer/employee 403, unauth 401, manager+ 200', async () => {
  const emp = await seedEmployee(orgA.id, 'SR01-EMP');
  await db.consent.create({
    data: { employeeId: emp.id, consentType: 'monitoring', status: 'granted', organizationId: orgA.id },
  });

  const manager = await tokenFor(orgA.id, 'manager', 'sr01-manager');
  const viewer = await tokenFor(orgA.id, 'viewer', 'sr01-viewer');
  const employee = await tokenFor(orgA.id, 'employee', 'sr01-employee');

  // Unauthenticated → 401.
  assert.equal((await consentListRoute.GET(req(null, { url: 'http://x/api/consent' }))).status, 401);

  // viewer + employee → 403 on every read surface.
  for (const t of [viewer, employee]) {
    assert.equal((await consentListRoute.GET(req(t, { url: 'http://x/api/consent' }))).status, 403, 'list');
    assert.equal((await consentSummaryRoute.GET(req(t, { url: 'http://x/api/consent/summary' }))).status, 403, 'summary');
    assert.equal((await consentLogsRoute.GET(req(t, { url: 'http://x/api/consent/logs' }))).status, 403, 'logs');
    assert.equal((await consentPoliciesRoute.GET(req(t, { url: 'http://x/api/consent/policies' }))).status, 403, 'policies');
  }

  // manager → 200 on every read surface.
  assert.equal((await consentListRoute.GET(req(manager, { url: 'http://x/api/consent' }))).status, 200, 'list');
  assert.equal((await consentSummaryRoute.GET(req(manager, { url: 'http://x/api/consent/summary' }))).status, 200, 'summary');
  assert.equal((await consentLogsRoute.GET(req(manager, { url: 'http://x/api/consent/logs' }))).status, 200, 'logs');
  assert.equal((await consentPoliciesRoute.GET(req(manager, { url: 'http://x/api/consent/policies' }))).status, 200, 'policies');
});

test('SR-01b: consent reads are org-scoped — org B data never leaks through org A filters', async () => {
  const empB = await seedEmployee(orgB.id, 'SR01B-EMP');
  await db.consent.create({
    data: { employeeId: empB.id, consentType: 'webcam_access', status: 'revoked', organizationId: orgB.id },
  });

  const managerA = await tokenFor(orgA.id, 'manager', 'sr01b-mgr');

  // employeeId filter pointing at an org-B employee → no rows, never a leak.
  const res = await consentListRoute.GET(
    req(managerA, { url: `http://x/api/consent?employeeId=${empB.id}&page=1&pageSize=10` })
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: unknown[]; total: number };
  assert.equal(body.total, 0, 'org-B consent must not appear in org-A list');
});

// ─── SR-02: S-02 — BOUNDED AUDIT-LOG EXPORT ─────────────────────────────────

test('SR-02a: audit export defaults to last 90 days, keyset-paginates across pages, preserves order', async () => {
  // 2,500 rows: 2,000 fill page 1, 500 spill into page 2 — verifies the
  // (createdAt, id) keyset cursor crosses the page boundary with no dupes/misses.
  const base = Date.now() - 200 * 86_400_000; // ancient (outside default window)
  const recent = Date.now() - 10 * 86_400_000; // inside default window
  const rows = Array.from({ length: 2500 }, (_, i) => ({
    organizationId: orgA.id,
    action: 'login',
    resource: 'auth',
    description: `SR02a-${i}`,
    createdAt: new Date(recent + i), // distinct ms — ordered
  }));
  await db.auditLog.createMany({ data: rows });
  // Ancient row (outside the 90-day default window) must be excluded.
  await db.auditLog.createMany({
    data: [{ organizationId: orgA.id, action: 'login', resource: 'auth', description: 'SR02a-ancient', createdAt: new Date(base) }],
  });
  // Org-B row must be excluded (tenant isolation).
  await db.auditLog.createMany({
    data: [{ organizationId: orgB.id, action: 'login', resource: 'auth', description: 'SR02a-orgb', createdAt: new Date(recent) }],
  });

  const manager = await tokenFor(orgA.id, 'manager', 'sr02a-mgr');
  const res = await auditExportRoute.GET(req(manager, { url: 'http://x/api/audit-logs/export' }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<{ Timestamp: string; Description: string }>; total: number; truncated: boolean };
  assert.equal(body.data.length, 2500, 'all in-window org-A rows exported across pages');
  assert.equal(body.total, 2500);
  assert.equal(body.truncated, false);
  // Newest first (createdAt desc).
  const stamps = body.data.map((d) => new Date(d.Timestamp).getTime());
  for (let i = 1; i < stamps.length; i++) assert.ok(stamps[i - 1] >= stamps[i], 'export is sorted newest-first');
  assert.ok(!body.data.some((d) => d.Description.startsWith('SR02a-ancient')), 'ancient rows excluded by default window');
  assert.ok(!body.data.some((d) => d.Description === 'SR02a-orgb'), 'cross-org rows excluded');
});

test('SR-02b: explicit date range includes ancient rows; malformed/inverted ranges → 400', async () => {
  const manager = await tokenFor(orgA.id, 'manager', 'sr02b-mgr');

  const from = new Date(Date.now() - 300 * 86_400_000).toISOString();
  const to = new Date(Date.now() - 150 * 86_400_000).toISOString();
  await db.auditLog.createMany({
    data: [{ organizationId: orgA.id, action: 'export', resource: 'auth', description: 'SR02b-old', createdAt: new Date(from) }],
  });

  const res = await auditExportRoute.GET(
    req(manager, { url: `http://x/api/audit-logs/export?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` })
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<{ Description: string }> };
  assert.ok(body.data.some((d) => d.Description === 'SR02b-old'), 'explicit range overrides the default window');

  assert.equal((await auditExportRoute.GET(req(manager, { url: 'http://x/api/audit-logs/export?from=not-a-date' }))).status, 400, 'malformed from');
  assert.equal((await auditExportRoute.GET(req(manager, { url: 'http://x/api/audit-logs/export?to=garbage' }))).status, 400, 'malformed to');
  const inverted = await auditExportRoute.GET(
    req(manager, { url: `http://x/api/audit-logs/export?from=${encodeURIComponent(to)}&to=${encodeURIComponent(from)}` })
  );
  assert.equal(inverted.status, 400, 'inverted range rejected');
});

test('SR-02c: audit export honors the 100k cap with truncated flag', async () => {
  const manager = await tokenFor(orgA.id, 'manager', 'sr02c-mgr');
  const now = Date.now();
  const CHUNK = 5000;
  for (let c = 0; c < 21; c++) {
    const rows = Array.from({ length: CHUNK }, (_, i) => ({
      organizationId: orgA.id,
      action: 'login',
      resource: 'auth',
      description: `SR02c-${c}-${i}`,
      createdAt: new Date(now + c * CHUNK + i),
    }));
    await db.auditLog.createMany({ data: rows });
  }

  const res = await auditExportRoute.GET(req(manager, { url: 'http://x/api/audit-logs/export' }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: unknown[]; total: number; truncated: boolean };
  assert.equal(body.data.length, 100_000, 'export capped at MAX_EXPORT_ROWS');
  assert.equal(body.truncated, true, 'truncated flag set when the cap is hit');
});

test('SR-02d: audit export RBAC — viewer 403, unauthenticated 401, cross-org concealed', async () => {
  const viewer = await tokenFor(orgA.id, 'viewer', 'sr02d-viewer');
  assert.equal((await auditExportRoute.GET(req(viewer, { url: 'http://x/api/audit-logs/export' }))).status, 403);
  assert.equal((await auditExportRoute.GET(req(null, { url: 'http://x/api/audit-logs/export' }))).status, 401);

  // Org-B manager exporting gets ONLY org-B rows — org-A rows never leak.
  const managerB = await tokenFor(orgB.id, 'manager', 'sr02d-mgrb');
  const res = await auditExportRoute.GET(req(managerB, { url: 'http://x/api/audit-logs/export' }));
  const body = (await res.json()) as { data: Array<{ Description: string }> };
  assert.ok(body.data.length > 0);
  assert.ok(body.data.every((d) => d.Description.startsWith('SR02a-orgb')), 'org-B export contains only org-B rows');
});

// ─── SR-03: S-03 — PATH B PER-EMPLOYEE LOCKOUT ──────────────────────────────

const PATH_B_PASSWORD = 'Str0ng!PathB2026x';

async function seedPathBEmployee(orgId: string, code: string) {
  const emp = await seedEmployee(orgId, code, { agentApproved: true });
  // Create an AgentAccount for PATH B (agentId + password) login.
  await db.agentAccount.create({
    data: {
      employeeId: emp.id,
      agentId: code,
      passwordHash: await hashPassword(PATH_B_PASSWORD),
      status: 'active',
    },
  });
  return emp;
}

test('SR-03a: 5 wrong passwords from ROTATING IPs lock the account — correct password rejected (uniform 401)', async () => {
  const emp = await seedPathBEmployee(orgA.id, 'SR03A-EMP');

  for (let i = 0; i < 5; i++) {
    const res = await agentLoginRoute.POST(
      req(null, { method: 'POST', body: { agentId: 'SR03A-EMP', password: 'wrong-password' }, ip: `203.0.113.10${i}` })
    );
    assert.equal(res.status, 401, `attempt ${i + 1} is a uniform 401`);
  }

  // AgentAccount tracks lockout state (not Employee).
  const account = await db.agentAccount.findUnique({ where: { agentId: 'SR03A-EMP' }, select: { failedLoginCount: true, lockedUntil: true } });
  assert.ok(account, 'agent account row exists');
  assert.equal(account.failedLoginCount, 5);
  assert.ok(account.lockedUntil && account.lockedUntil.getTime() > Date.now(), 'lockedUntil set in the future');

  // Correct password from yet another IP → still 401 while locked (no IP-rotation bypass).
  const correct = await agentLoginRoute.POST(
    req(null, { method: 'POST', body: { agentId: 'SR03A-EMP', password: PATH_B_PASSWORD }, ip: '203.0.113.199' })
  );
  assert.equal(correct.status, 401, 'correct password rejected during lockout');
  const body = (await correct.json()) as { error: string };
  assert.equal(body.error, 'Invalid credentials', 'lockout is indistinguishable from a wrong password (no oracle)');
});

test('SR-03b: lockout expires; a successful login then resets the counter', async () => {
  const emp = await seedPathBEmployee(orgA.id, 'SR03B-EMP');

  // 4 wrong attempts (below the threshold) → still succeeds.
  for (let i = 0; i < 4; i++) {
    await agentLoginRoute.POST(
      req(null, { method: 'POST', body: { agentId: 'SR03B-EMP', password: 'wrong-password' }, ip: `198.51.100.2${i}` })
    );
  }
  const ok = await agentLoginRoute.POST(
    req(null, { method: 'POST', body: { agentId: 'SR03B-EMP', password: PATH_B_PASSWORD }, ip: '198.51.100.99' })
  );
  assert.equal(ok.status, 200, 'below threshold, correct password still authenticates');

  // Lock the account, then let the lockout expire (simulate time passing).
  const acct = await db.agentAccount.findUnique({ where: { agentId: 'SR03B-EMP' } });
  await db.agentAccount.update({ where: { id: acct!.id }, data: { failedLoginCount: 5, lockedUntil: new Date(Date.now() + 60_000) } });
  const during = await agentLoginRoute.POST(
    req(null, { method: 'POST', body: { agentId: 'SR03B-EMP', password: PATH_B_PASSWORD }, ip: '198.51.100.100' })
  );
  assert.equal(during.status, 401, 'locked → rejected');

  await db.agentAccount.update({ where: { id: acct!.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
  const after = await agentLoginRoute.POST(
    req(null, { method: 'POST', body: { agentId: 'SR03B-EMP', password: PATH_B_PASSWORD }, ip: '198.51.100.101' })
  );
  assert.equal(after.status, 200, 'lockout expiry restores legitimate access');

  const fresh = await db.agentAccount.findUnique({ where: { id: acct!.id }, select: { failedLoginCount: true, lockedUntil: true } });
  assert.ok(fresh, 'agent account row exists');
  assert.equal(fresh.failedLoginCount, 0, 'successful login resets the counter');
  assert.equal(fresh.lockedUntil, null, 'successful login clears the lockout');
});

// ─── SR-04: S-04 — WEB-SESSION REVOCATION ───────────────────────────────────

test('SR-04a (Test A): logout revokes the session — the old token returns 401 on reuse', async () => {
  const email = 'sr04a@sec.local';
  const user = await createWebUser(email, 'Str0ng!Pass2026x', orgA.id);
  const { token } = await loginUser(email, 'Str0ng!Pass2026x', '203.0.113.201');

  // Token works before logout.
  assert.equal((await meRoute.GET(req(token))).status, 200);

  const logout = await logoutRoute.POST(req(token, { method: 'POST', ua: 'Mozilla/5.0 SecTest' }));
  assert.equal(logout.status, 200);

  // Reuse the old (cryptographically still-valid) token → rejected server-side.
  assert.equal((await meRoute.GET(req(token))).status, 401, 'revoked session token is rejected');

  const row = await db.userSession.findFirst({ where: { userId: user.id } });
  assert.ok(row && row.revokedAt !== null, 'session row is revoked');
});

test('SR-04b (Test B): revoke-all kills every session', async () => {
  const email = 'sr04b@sec.local';
  await createWebUser(email, 'Str0ng!Pass2026x', orgA.id);
  const { token: tokenA } = await loginUser(email, 'Str0ng!Pass2026x', '203.0.113.203');
  const { token: tokenB } = await loginUser(email, 'Str0ng!Pass2026x', '203.0.113.204');

  assert.equal((await meRoute.GET(req(tokenA))).status, 200);
  assert.equal((await meRoute.GET(req(tokenB))).status, 200);

  const revoke = await revokeAllRoute.POST(req(tokenA, { method: 'POST' }));
  assert.equal(revoke.status, 200);

  assert.equal((await meRoute.GET(req(tokenA))).status, 401, 'session A dead');
  assert.equal((await meRoute.GET(req(tokenB))).status, 401, 'session B dead');
});

test('SR-04c (Test C): disabling a user revokes existing sessions immediately', async () => {
  const email = 'sr04c@sec.local';
  const victim = await db.appUser.create({
    data: { email, name: 'victim', password: await hashPassword('Str0ng!Pass2026x'), role: 'admin', organizationId: orgA.id },
  });
  const res = await loginRoute.POST(req(null, { method: 'POST', body: { email, password: 'Str0ng!Pass2026x' }, ip: '203.0.113.205' }));
  const { token } = (await res.json()) as { token: string };
  assert.equal((await meRoute.GET(req(token))).status, 200);

  const admin = await tokenFor(orgA.id, 'admin', 'sr04c-admin');
  const put = await usersIdRoute.PUT(
    req(admin, { method: 'PUT', body: { isActive: false }, ip: '203.0.113.206' }),
    { params: Promise.resolve({ id: victim.id }) }
  );
  assert.equal(put.status, 200);

  assert.equal((await meRoute.GET(req(token))).status, 401, 'disabled user session is dead');
  assert.equal((await db.userSession.count({ where: { userId: victim.id, revokedAt: null } })), 0, 'no active sessions remain');

  // A fresh login attempt also fails.
  const relogin = await loginRoute.POST(req(null, { method: 'POST', body: { email, password: 'Str0ng!Pass2026x' }, ip: '203.0.113.207' }));
  assert.equal(relogin.status, 401, 'disabled user cannot log in');
});

test('SR-04d (Test D): password change revokes OTHER sessions, keeps the current one', async () => {
  const email = 'sr04d@sec.local';
  await createWebUser(email, 'Str0ng!Pass2026x', orgA.id);
  const { token: tokenA } = await loginUser(email, 'Str0ng!Pass2026x', '203.0.113.209');
  const { token: tokenB } = await loginUser(email, 'Str0ng!Pass2026x', '203.0.113.210');

  const change = await changePasswordRoute.POST(
    req(tokenA, { method: 'POST', body: { currentPassword: 'Str0ng!Pass2026x', newPassword: 'Br@ndNew!Pass2026' }, ip: '203.0.113.211', ua: 'Mozilla/5.0 SecTest' })
  );
  assert.equal(change.status, 200);

  assert.equal((await meRoute.GET(req(tokenA))).status, 200, 'current session survives password change');
  assert.equal((await meRoute.GET(req(tokenB))).status, 401, 'other sessions revoked by password change');

  // The new password works for a fresh login; the old one does not.
  const fresh = await loginRoute.POST(req(null, { method: 'POST', body: { email, password: 'Br@ndNew!Pass2026' }, ip: '203.0.113.212' }));
  assert.equal(fresh.status, 200);
  const stale = await loginRoute.POST(req(null, { method: 'POST', body: { email, password: 'Str0ng!Pass2026x' }, ip: '203.0.113.213' }));
  assert.equal(stale.status, 401, 'old password rejected after change');
});

test('SR-04e (Test E): expired session row rejects the token; admin force-logout works', async () => {
  const email = 'sr04e@sec.local';
  const victim = await db.appUser.create({
    data: { email, name: 'victim-e', password: await hashPassword('Str0ng!Pass2026x'), role: 'manager', organizationId: orgA.id },
  });
  const res = await loginRoute.POST(req(null, { method: 'POST', body: { email, password: 'Str0ng!Pass2026x' }, ip: '203.0.113.214' }));
  const { token } = (await res.json()) as { token: string };
  assert.equal((await meRoute.GET(req(token))).status, 200);

  // Expire the session row (as if JWT_EXPIRES_IN passed).
  await db.userSession.updateMany({
    where: { userId: victim.id, revokedAt: null },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal((await meRoute.GET(req(token))).status, 401, 'expired session rejected');

  // Admin force-logout (users/[id]/revoke-sessions) revokes a live session.
  const email2 = 'sr04e2@sec.local';
  const victim2 = await db.appUser.create({
    data: { email: email2, name: 'victim-e2', password: await hashPassword('Str0ng!Pass2026x'), role: 'manager', organizationId: orgA.id },
  });
  const res2 = await loginRoute.POST(req(null, { method: 'POST', body: { email: email2, password: 'Str0ng!Pass2026x' }, ip: '203.0.113.215' }));
  const { token: token2 } = (await res2.json()) as { token: string };
  assert.equal((await meRoute.GET(req(token2))).status, 200);

  const admin = await tokenFor(orgA.id, 'admin', 'sr04e-admin');
  const force = await adminRevokeRoute.POST(req(admin, { method: 'POST', ip: '203.0.113.216' }), {
    params: Promise.resolve({ id: victim2.id }),
  });
  assert.equal(force.status, 200);
  assert.equal((await meRoute.GET(req(token2))).status, 401, 'admin force-logout kills the session');
});

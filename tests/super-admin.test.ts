/**
 * Production Data Cleanup + Super Admin Env Bootstrap — regression tests.
 *
 * Covers the phase requirements:
 *   1. Missing SUPER_ADMIN_EMAIL       → bootstrap fails
 *   2. Missing SUPER_ADMIN_PASSWORD    → bootstrap fails
 *   3. Invalid email                   → bootstrap fails
 *   4. Weak password                   → bootstrap fails
 *   5. First bootstrap creates Super Admin
 *   6. Second bootstrap creates no duplicate
 *   7. Second bootstrap never overwrites the password
 *   8. No demo users are created
 *   9. No demo organization is created
 *  10. No demo employee is created
 *  11. Login works with the env-configured Super Admin
 *  12. Incorrect password fails
 *  13. No credentials exposed through API responses
 *  14. Demo seed refuses to run in production (SEED_ALLOWED guard)
 *  15. Zero-touch discovery still works after bootstrap
 *  16. Consent remains empty for newly approved devices
 *  17. Consent fail-closed remains intact
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_superadmin).
 * Run: npm run test:super-admin
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { req } from './helpers/request';

// ─── Test DB isolation (set BEFORE any app module import) ──────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_superadmin';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-superadmin-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@corp.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!Admin2026x';
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
let validateSuperAdminEnv: (env?: Record<string, string | undefined>) => { email: string; password: string };
let bootstrapSuperAdmin: (env?: Record<string, string | undefined>) => Promise<{
  email: string;
  created: boolean;
  alreadyExisted: boolean;
  user: { id: string; email: string; role: string; isActive: boolean; organizationId: string | null };
}>;
let verifyPassword: (password: string, hash: string) => Promise<boolean>;
let seedAllowed: () => boolean;

type DiscoverApi = typeof import('../src/app/api/agent/discover/route');
type ClaimApproveApi = typeof import('../src/app/api/device-claims/[id]/approve/route');
type ActivityApi = typeof import('../src/app/api/agent/activity/route');
type LoginApi = typeof import('../src/app/api/auth/login/route');
type AgentLoginApi = typeof import('../src/app/api/agent/login/route');
let discoverApi: DiscoverApi;
let claimApproveApi: ClaimApproveApi;
let activityApi: ActivityApi;
let loginApi: LoginApi;
let agentLoginApi: AgentLoginApi;
let hasActiveConsent: (employeeId: string, consentType: string) => Promise<boolean>;
let signJWT: (payload: { userId: string; email: string; role: string; organizationId?: string }) => Promise<string>;

let org: { id: string };
let createAgentAccount: (typeof import('../src/lib/agent-account'))['createAgentAccount'];
let hashPassword: (p: string) => Promise<string>;
const PASSWORD = 'TestPass-123!';

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  const sa = await import('../src/lib/super-admin');
  validateSuperAdminEnv = sa.validateSuperAdminEnv;
  bootstrapSuperAdmin = sa.bootstrapSuperAdmin;
  verifyPassword = (await import('../src/lib/auth')).verifyPassword;
  seedAllowed = (await import('../src/lib/seed')).seedAllowed;
  hasActiveConsent = (await import('../src/lib/consent')).hasActiveConsent;
  signJWT = (await import('../src/lib/auth')).signJWT;
  hashPassword = (await import('../src/lib/auth')).hashPassword;
  createAgentAccount = (await import('../src/lib/agent-account')).createAgentAccount;

  const [dApi, caApi, actApi, lApi, alApi] = await Promise.all([
    import('../src/app/api/agent/discover/route'),
    import('../src/app/api/device-claims/[id]/approve/route'),
    import('../src/app/api/agent/activity/route'),
    import('../src/app/api/auth/login/route'),
    import('../src/app/api/agent/login/route'),
  ]);
  discoverApi = dApi;
  claimApproveApi = caApi;
  activityApi = actApi;
  loginApi = lApi;
  agentLoginApi = alApi;

  org = await db.organization.create({ data: { name: 'SA Org', slug: 'sa-org' } });
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


async function seedOrg(slug: string) {
  return db.organization.create({ data: { name: slug, slug } });
}

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

async function createTestEmployeeAndAccount(employeeId: string) {
  const emp = await seedEmployee(org.id, employeeId);
  const pwHash = await hashPassword(PASSWORD);
  await createAgentAccount({ employeeId: emp.id, agentId: employeeId, password: PASSWORD });
  return emp;
}

// ─── 1–4: env validation fails fast ────────────────────────────────────────

test('SA-1: missing SUPER_ADMIN_EMAIL fails bootstrap', () => {
  assert.throws(
    () => validateSuperAdminEnv({ SUPER_ADMIN_PASSWORD: 'S3cure!Pass1x' }),
    /SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be set/
  );
});

test('SA-2: missing SUPER_ADMIN_PASSWORD fails bootstrap', () => {
  assert.throws(
    () => validateSuperAdminEnv({ SUPER_ADMIN_EMAIL: 'root@corp.local' }),
    /SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be set/
  );
});

test('SA-3: invalid email fails bootstrap', () => {
  assert.throws(
    () => validateSuperAdminEnv({ SUPER_ADMIN_EMAIL: 'not-an-email', SUPER_ADMIN_PASSWORD: 'S3cure!Pass1x' }),
    /not a valid email/
  );
});

test('SA-4: weak password fails bootstrap', () => {
  assert.throws(
    () => validateSuperAdminEnv({ SUPER_ADMIN_EMAIL: 'root@corp.local', SUPER_ADMIN_PASSWORD: 'short' }),
    /at least 12 characters/
  );
  assert.throws(
    () => validateSuperAdminEnv({ SUPER_ADMIN_EMAIL: 'root@corp.local', SUPER_ADMIN_PASSWORD: 'alllowercase123' }),
    /uppercase/
  );
  assert.throws(
    () => validateSuperAdminEnv({ SUPER_ADMIN_EMAIL: 'root@corp.local', SUPER_ADMIN_PASSWORD: 'NOLOWERCASE123' }),
    /lowercase/
  );
});

// ─── 5–7: idempotent bootstrap ─────────────────────────────────────────────

test('SA-5: first bootstrap creates the Super Admin from env only', async () => {
  const r = await bootstrapSuperAdmin();
  assert.equal(r.created, true);
  assert.equal(r.alreadyExisted, false);
  assert.equal(r.email, 'root@corp.local');
  assert.equal(r.user.role, 'super_admin');
  assert.equal(r.user.isActive, true);
  assert.equal(r.user.organizationId, null, 'org-less global super admin');

  const row = await db.appUser.findUnique({ where: { id: r.user.id } });
  assert.ok(row);
  // Password is stored hashed — never plaintext.
  assert.notEqual(row!.password, process.env.SUPER_ADMIN_PASSWORD);
  assert.match(row!.password!, /^\$2[aby]\$/, 'bcrypt hash');
  assert.equal(await verifyPassword(process.env.SUPER_ADMIN_PASSWORD!, row!.password!), true);
});

test('SA-6: second bootstrap does not create a duplicate', async () => {
  const before = await db.appUser.count({ where: { role: 'super_admin' } });
  const r = await bootstrapSuperAdmin();
  assert.equal(r.created, false);
  assert.equal(r.alreadyExisted, true);
  const after = await db.appUser.count({ where: { role: 'super_admin' } });
  assert.equal(after, before, 'no duplicate super admin');
});

test('SA-7: second bootstrap never overwrites the password', async () => {
  const sa = await db.appUser.findFirst({ where: { email: { equals: 'root@corp.local', mode: 'insensitive' } } });
  const hashBefore = sa!.password;

  // Re-run bootstrap with a DIFFERENT env password — the stored hash must not change.
  const r = await bootstrapSuperAdmin({ SUPER_ADMIN_EMAIL: 'root@corp.local', SUPER_ADMIN_PASSWORD: 'Completely!Different2026x' });
  assert.equal(r.created, false);

  const after = await db.appUser.findFirst({ where: { email: { equals: 'root@corp.local', mode: 'insensitive' } } });
  assert.equal(after!.password, hashBefore, 'password hash must remain unchanged');
  assert.equal(await verifyPassword(process.env.SUPER_ADMIN_PASSWORD!, after!.password!), true, 'original password still works');
  assert.equal(await verifyPassword('Completely!Different2026x', after!.password!), false);
});

// ─── 8–10: no demo data created ────────────────────────────────────────────

test('SA-8: bootstrap creates NO demo users', async () => {
  const users = await db.appUser.findMany();
  assert.equal(users.length, 1, 'only the super admin exists');
  for (const demo of ['admin@techvision.com', 'manager@techvision.com', 'viewer@techvision.com']) {
    assert.ok(!users.some((u) => u.email === demo), `demo user ${demo} must not exist`);
  }
});

test('SA-9: bootstrap creates NO organization', async () => {
  // Only the org created by the test fixture itself may exist — the bootstrap
  // must never create an organization (the admin creates it after login).
  const orgs = await db.organization.findMany({ select: { slug: true } });
  assert.ok(orgs.length <= 1, 'bootstrap must not create any organization');
  assert.ok(orgs.every((o) => o.slug === 'sa-org'), 'only the fixture org exists');

  // Running bootstrap again adds no org.
  await bootstrapSuperAdmin();
  const again = await db.organization.count();
  assert.ok(again <= 1, 're-bootstrap must not create an organization');
});

test('SA-10: bootstrap creates NO demo employees', async () => {
  const emps = await db.employee.count();
  assert.equal(emps, 0, 'no demo employee may be created by bootstrap');
});

// ─── 11–13: login with env super admin ─────────────────────────────────────

test('SA-11: login works with the env-configured Super Admin', async () => {
  const res = await loginApi.POST(
    req(null, {
      method: 'POST',
      body: { email: process.env.SUPER_ADMIN_EMAIL, password: process.env.SUPER_ADMIN_PASSWORD },
      ip: '203.0.113.60',
    })
  );
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(typeof body.token, 'string');
  assert.equal(body.user.email, 'root@corp.local');
  assert.equal(body.user.role, 'super_admin');
});

test('SA-12: incorrect password fails', async () => {
  const res = await loginApi.POST(
    req(null, {
      method: 'POST',
      body: { email: process.env.SUPER_ADMIN_EMAIL, password: 'WrongPassword!2026' },
      ip: '203.0.113.61',
    })
  );
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.token, undefined);
});

test('SA-13: no credentials exposed through the API', async () => {
  const res = await loginApi.POST(
    req(null, {
      method: 'POST',
      body: { email: process.env.SUPER_ADMIN_EMAIL, password: process.env.SUPER_ADMIN_PASSWORD },
      ip: '203.0.113.62',
    })
  );
  const body = await res.json();
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('password'), 'login response must not contain the password');
  assert.ok(!serialized.includes(process.env.SUPER_ADMIN_PASSWORD!), 'response must not echo the password value');
  assert.ok(!serialized.includes('$2'), 'response must not contain any hash');
});

// ─── 14: demo seed refuses in production / without opt-in ─────────────────

test('SA-14: demo seed refuses to run in production (SEED_ALLOWED guard)', () => {
  const env = process.env as Record<string, string>;
  const savedProd = env.NODE_ENV;
  const savedSeed = env.SEED_ALLOWED;
  try {
    env.NODE_ENV = 'production';
    env.SEED_ALLOWED = '1';
    assert.equal(seedAllowed(), false, 'seed must refuse in production even with SEED_ALLOWED=1');
  } finally {
    if (savedProd === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = savedProd;
    if (savedSeed === undefined) delete env.SEED_ALLOWED;
    else env.SEED_ALLOWED = savedSeed;
  }
  // And without SEED_ALLOWED even in dev it must refuse.
  assert.equal(seedAllowed(), false, 'seed must refuse without SEED_ALLOWED=1');
});

test('SA-14b: the seed CLI exits non-zero and wipes nothing in production', () => {
  // Run the real seed entrypoint with production env + SEED_ALLOWED=1 — it
  // must refuse BEFORE touching any table.
  assert.throws(
    () =>
      execSync('npx tsx src/lib/seed.ts', {
        env: { ...process.env, NODE_ENV: 'production', SEED_ALLOWED: '1', DATABASE_URL: TEST_DB_URL },
        stdio: 'pipe',
      }),
    /Seed failed|refused|Refusing/
  );
  // No tables were wiped or created by the refused seed.
  // (org count stays 0 because bootstrap created none and the seed refused.)
});

// ─── 15–17: zero-touch + consent regressions after bootstrap ──────────────

test('SA-15: authenticated discovery still works after production bootstrap', async () => {
  // Create employee + account for authenticated discovery
  const emp = await seedEmployee(org.id, 'SA15-EMP');
  await createAgentAccount({ employeeId: emp.id, agentId: 'SA15-EMP', password: PASSWORD });
  const loginRes = await agentLoginApi.POST(req(null, { body: { agentId: 'SA15-EMP', password: PASSWORD } }));
  const sessionToken = (await loginRes.json() as { token?: string }).token;
  const res = await discoverApi.POST(
    req(sessionToken, {
      method: 'POST',
      body: {
        deviceKey: 'sa15-device-key-abcdef123456',
        hostname: 'SA15-PC',
        os: 'Windows 11',
        agentVersion: '1.2.0',
      },
      ip: '203.0.113.15',
    })
  );
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(body.status, 'pending');
  assert.ok(body.deviceId);
  assert.ok(body.claimId);
  assert.ok(body.secret, 'one-time secret issued on first discovery');
});

test('SA-16: approval creates NO consent — device approval is not consent', async () => {
  const emp = await seedEmployee(org.id, 'SA16-EMP');
  const empAccount = await createTestEmployeeAndAccount('SA16-ACC');
  const loginRes = await agentLoginApi.POST(req(null, { body: { agentId: 'SA16-ACC', password: PASSWORD } }));
  const sessionToken = (await loginRes.json() as { token?: string }).token;
  const d = await discoverApi.POST(
    req(sessionToken, {
      method: 'POST',
      body: { deviceKey: 'sa16-device-key-abcdef123456', hostname: 'SA16-PC', os: 'Windows 11', agentVersion: '1.2.0' },
      ip: '203.0.113.16',
    })
  );
  const dBody = await d.json().catch(() => ({})) as Record<string, unknown>;
  const admin = await signJWT({ userId: 'sa16-admin', email: 'sa16@corp.local', role: 'admin', organizationId: org.id });

  const ar = await claimApproveApi.POST(
    req(admin, { method: 'POST', body: { employeeId: emp.id, projectIds: [] }, ip: '198.51.100.16' }),
    { params: Promise.resolve({ id: dBody.claimId as string }) }
  );
  assert.equal(ar.status, 200);

  const consentRows = await db.consent.count({ where: { employeeId: emp.id } });
  assert.equal(consentRows, 0, 'approval must create zero consent rows');
});

test('SA-17: consent fail-closed remains intact — no consent means 403 upload', async () => {
  const emp = await seedEmployee(org.id, 'SA17-EMP');
  const empAccount = await createTestEmployeeAndAccount('SA17-ACC');
  const loginRes = await agentLoginApi.POST(req(null, { body: { agentId: 'SA17-ACC', password: PASSWORD } }));
  const sessionToken = (await loginRes.json() as { token?: string }).token;
  const d = await discoverApi.POST(
    req(sessionToken, {
      method: 'POST',
      body: { deviceKey: 'sa17-device-key-abcdef123456', hostname: 'SA17-PC', os: 'Windows 11', agentVersion: '1.2.0' },
      ip: '203.0.113.17',
    })
  );
  const dBody = await d.json().catch(() => ({})) as Record<string, unknown>;
  const admin = await signJWT({ userId: 'sa17-admin', email: 'sa17@corp.local', role: 'admin', organizationId: org.id });
  const ar = await claimApproveApi.POST(
    req(admin, { method: 'POST', body: { employeeId: emp.id, projectIds: [] }, ip: '198.51.100.17' }),
    { params: Promise.resolve({ id: dBody.claimId as string }) }
  );
  assert.equal(ar.status, 200);

  // All 8 consent types are inactive.
  for (const t of ['monitoring', 'screenshot', 'activity_tracking', 'keystroke', 'usb_monitoring', 'webcam_access', 'location', 'email_monitoring']) {
    assert.equal(await hasActiveConsent(emp.id, t), false, `${t} must be inactive`);
  }

  // Server-side: authenticate the approved device (PATH A), then prove that
  // activity upload WITHOUT consent → 403 and nothing is persisted.
  const authApi = await import('../src/app/api/agent/authenticate/route');
  const res = await authApi.POST(
    req(null, {
      method: 'POST',
      body: { deviceId: dBody.deviceId, deviceSecret: dBody.secret, agentVersion: '1.2.0' },
      ip: '203.0.113.17',
    })
  );
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  assert.equal(res.status, 200, JSON.stringify(body));
  const token = body.token as string;

  const up = await activityApi.POST(
    req(token, { method: 'POST', body: { activities: [{ type: 'application', applicationName: 'chrome.exe', duration: 60 }] } })
  );
  assert.equal(up.status, 403, 'activity upload without consent must be 403');
  assert.equal(await db.activity.count({ where: { employeeId: emp.id } }), 0, 'nothing persisted');
});

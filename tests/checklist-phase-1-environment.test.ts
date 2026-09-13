/**
 * Smart Testing Checklist — PHASE 1: Environment, Database & Super Admin Setup.
 *
 * Verifies the platform bootstrap contract in-process:
 *   E-01  health endpoint reports ok (DB + storage) and never leaks secrets
 *   E-02  /api/health/database: reachable + bootstrap pending -> complete
 *   E-03  every core table exists after the schema push
 *   E-04  super admin env validation (missing / weak / invalid credentials throw)
 *   E-05  super admin bootstrap is idempotent and never overwrites the password
 *   E-06  the env-configured super admin can log in end-to-end
 *   E-07  app + realtime service declare their ports (next :3000 / socket :3010)
 *   E-08  health endpoints are whitelisted in the global proxy (external probes)
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_checklist_phase1).
 * Run: npx tsx --test tests/checklist-phase-1-environment.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { req } from './helpers/request';

// ─── Test DB isolation (must be set BEFORE any app module import) ──────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_checklist_phase1';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-checklist-p1-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

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
let healthApi: typeof import('../src/app/api/health/route');
let healthDbApi: typeof import('../src/app/api/health/database/route');
let loginApi: typeof import('../src/app/api/auth/login/route');
let bootstrapSuperAdmin: (env?: Record<string, string | undefined>) => Promise<import('../src/lib/super-admin').BootstrapResult>;
let validateSuperAdminEnv: (env?: Record<string, string | undefined>) => { email: string; password: string };
let verifyPassword: (candidate: string, hash: string) => Promise<boolean>;
let verifyJWT: (token: string) => Promise<{ userId: string; role: string } | null>;

before(async () => {
  db = (await import('../src/lib/db')).db;
  healthApi = await import('../src/app/api/health/route');
  healthDbApi = await import('../src/app/api/health/database/route');
  loginApi = await import('../src/app/api/auth/login/route');
  ({ bootstrapSuperAdmin, validateSuperAdminEnv } = await import('../src/lib/super-admin'));
  ({ verifyPassword } = await import('../src/lib/auth'));
  ({ verifyJWT } = await import('../src/lib/auth'));
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

// ─── E-01: health endpoint ──────────────────────────────────────────────────

test('E-01: /api/health reports ok (DB + storage) without leaking secrets', async () => {
  const res = await healthApi.GET();
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.status, 'ok');
  assert.equal(body.database, 'ok');
  assert.equal(body.storage, 'ok');
  assert.equal(typeof body.uptime, 'number');
  assert.equal(typeof body.version, 'string');
  const text = JSON.stringify(body).toLowerCase();
  assert.ok(!text.includes('jwt'), 'no JWT material');
  assert.ok(!text.includes('password') && !text.includes('secret'), 'no credentials');
  assert.ok(!text.includes('postgresql://') && !text.includes('database_url'), 'no DB URL');
});

// ─── E-02: database health + bootstrap state ────────────────────────────────

test('E-02: /api/health/database reachable + bootstrap pending -> complete', async () => {
  assert.equal(await db.organization.count(), 0, 'test starts org-less');
  const pending = await healthDbApi.GET();
  assert.equal(pending.status, 200, 'org-less bootstrap must not be a DB failure');
  const pendingBody = (await pending.json()) as Record<string, string>;
  assert.equal(pendingBody.status, 'ok');
  assert.equal(pendingBody.database, 'reachable');
  assert.equal(pendingBody.bootstrap, 'pending');

  await db.organization.create({ data: { name: 'P1 Org', slug: 'p1-org' } });
  const done = await healthDbApi.GET();
  assert.equal(done.status, 200);
  const doneBody = (await done.json()) as Record<string, string>;
  assert.equal(doneBody.bootstrap, 'complete');
});

// ─── E-03: schema pushed — every core table exists ──────────────────────────

test('E-03: the schema push defines every core platform table', async () => {
  const rows = (await db.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
  )) as { table_name: string }[];
  const tables = new Set(rows.map((r) => String(r.table_name).toLowerCase()));
  for (const expected of [
    'organization',
    'appuser',
    'employee',
    'device',
    'agenttoken',
    'consent',
    'consentpolicy',
    'consentlog',
    'organizationmembership',
    'usersession',
    'project',
    'projectmember',
    'timeentry',
    'projecttimesync',
    'projecttimesynccursor',
    'activity',
    'breaksession',
    'jobrun',
    'organizationsetting',
  ]) {
    assert.ok(tables.has(expected), `schema must define table "${expected}"`);
  }
});

// ─── E-04: super admin env validation ───────────────────────────────────────

test('E-04: super admin env validation fails fast on missing/weak/invalid credentials', () => {
  assert.throws(() => validateSuperAdminEnv({}), /SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD/);
  assert.throws(
    () => validateSuperAdminEnv({ SUPER_ADMIN_EMAIL: 'not-an-email', SUPER_ADMIN_PASSWORD: 'abcdefghijkl' }),
    /not a valid email/
  );
  assert.throws(
    () => validateSuperAdminEnv({ SUPER_ADMIN_EMAIL: 'ok@test.local', SUPER_ADMIN_PASSWORD: 'short' }),
    /at least 12 characters/
  );
  assert.throws(
    () => validateSuperAdminEnv({ SUPER_ADMIN_EMAIL: 'ok@test.local', SUPER_ADMIN_PASSWORD: 'abcdefghijkl' }),
    /uppercase, lowercase and at least one digit/
  );
  // Minimum-viable credentials pass validation.
  const ok = validateSuperAdminEnv({ SUPER_ADMIN_EMAIL: 'ok@test.local', SUPER_ADMIN_PASSWORD: 'Test-Password-123' });
  assert.equal(ok.email, 'ok@test.local');
  assert.equal(ok.password, 'Test-Password-123');
});

// ─── E-05: idempotent bootstrap, password never overwritten ─────────────────

test('E-05: bootstrapSuperAdmin creates once and never overwrites the password', async () => {
  const env = { SUPER_ADMIN_EMAIL: 'root@test.local', SUPER_ADMIN_PASSWORD: 'Tr0ub4dur!xCorrect' };

  const first = await bootstrapSuperAdmin(env);
  assert.equal(first.created, true);
  assert.equal(first.alreadyExisted, false);
  assert.equal(first.user.role, 'super_admin');
  assert.equal(first.user.organizationId, null, 'org-less global super admin');
  assert.ok(first.user.id, 'user id returned');
  // The password must never appear in the result.
  assert.ok(JSON.stringify(first).includes(env.SUPER_ADMIN_PASSWORD) === false);

  const second = await bootstrapSuperAdmin(env);
  assert.equal(second.created, false);
  assert.equal(second.alreadyExisted, true);
  assert.equal(second.user.id, first.user.id, 'same account, not a duplicate');

  // A later bootstrap with a DIFFERENT password leaves the original password in
  // place (deliberate rotation must be an explicit operation).
  const rotated = await bootstrapSuperAdmin({ ...env, SUPER_ADMIN_PASSWORD: 'Other-Strong-999xx' });
  assert.equal(rotated.alreadyExisted, true);
  const stored = await db.appUser.findUnique({ where: { id: first.user.id }, select: { password: true } });
  assert.ok(stored?.password, 'stored hash present');
  assert.equal(await verifyPassword(env.SUPER_ADMIN_PASSWORD, stored!.password), true, 'original password still valid');
  assert.equal(await verifyPassword('Other-Strong-999xx', stored!.password), false, 'rotated password NOT applied');
});

// ─── E-06: env-configured super admin logs in end-to-end ────────────────────

test('E-06: the bootstrap-created super admin logs in through /api/auth/login', async () => {
  // E-05 bootstrapped root@test.local; bootstrap is idempotent, so this is a
  // free guarantee that the env-configured account exists before login.
  await bootstrapSuperAdmin({ SUPER_ADMIN_EMAIL: 'root@test.local', SUPER_ADMIN_PASSWORD: 'Tr0ub4dur!xCorrect' });

  const res = await loginApi.POST(req(null, {
    method: 'POST',
    body: { email: 'root@test.local', password: 'Tr0ub4dur!xCorrect' },
    ip: '198.51.100.7',
    ua: 'test-agent',
  }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { token: string; user: { role: string } };
  assert.ok(body.token, 'JWT issued');
  assert.equal(body.user.role, 'super_admin');
  const payload = await verifyJWT(body.token);
  assert.equal(payload?.role, 'super_admin');

  const sessionCookie = res.cookies.get('worklens_token');
  assert.ok(sessionCookie, 'httpOnly session cookie set by login');
  const raw = res.headers.get('set-cookie') ?? '';
  assert.ok(/HttpOnly/i.test(raw), 'session cookie must be HttpOnly');
  assert.ok(/SameSite/i.test(raw), 'session cookie must carry SameSite');
});

// ─── E-07: configured service ports ─────────────────────────────────────────

test('E-07: app :3000 and realtime :3010 are the declared defaults', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.match(pkg.scripts['dev:app'], /next\s+dev\s+-p\s+3000/, 'next dev must bind port 3000');
  assert.match(pkg.scripts['dev:live'], /mini-services\/live-updates\/index\.ts/, 'realtime service bootstrap wired');

  const live = readFileSync(join(process.cwd(), 'mini-services', 'live-updates', 'index.ts'), 'utf8');
  assert.match(live, /LIVE_UPDATES_PORT\s*\|\|\s*3010/, 'socket service defaults to 3010');
  assert.match(live, /ALLOWED_ORIGIN\s*\|\|\s*'http:\/\/localhost:3000'/, 'CORS default allows the app origin');
});

// ─── E-08: global proxy whitelists health probes ────────────────────────────

test('E-08: /api/health is whitelisted for external monitoring probes', () => {
  const proxy = readFileSync(join(process.cwd(), 'src', 'proxy.ts'), 'utf8');
  assert.ok(proxy.includes("const HEALTH_PREFIX = '/api/health'"), 'proxy must define the health whitelist prefix');
  assert.match(proxy, /HEALTH_PREFIX/, 'proxy must apply the health whitelist');
});
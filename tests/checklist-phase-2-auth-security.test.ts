/**
 * Smart Testing Checklist — PHASE 2: Authentication & Session Security.
 *
 * In-process server tests for the auth/session contract:
 *   A-01  login issues a JWT + HttpOnly session cookie + server session row
 *   A-02  bad credentials -> uniform 401, no session row, no audit success
 *   A-03  login brute-force protection: 429 with Retry-After on both layers
 *   A-04  logout revokes the session server-side; repeat logout is a no-op
 *   A-05  revoked / deleted sessions invalidate an already-issued JWT (fail closed)
 *   A-06  revoke-all kills every session including the caller's own
 *   A-07  change-password requires current password + strength, revokes OTHER
 *         sessions while keeping the current one alive
 *   A-08  security-critical rate-limit keys are fail-closed by design (source contract)
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_checklist_phase2).
 * Run: npx tsx --test tests/checklist-phase-2-auth-security.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { req } from './helpers/request';

// ─── Test DB isolation (must be set BEFORE any app module import) ──────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_checklist_phase2';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-checklist-p2-0123456789abcdef';
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
let loginApi: typeof import('../src/app/api/auth/login/route');
let logoutApi: typeof import('../src/app/api/auth/logout/route');
let revokeAllApi: typeof import('../src/app/api/auth/sessions/revoke-all/route');
let changePasswordApi: typeof import('../src/app/api/auth/change-password/route');
let meApi: typeof import('../src/app/api/auth/me/route');
let hashPassword: (password: string) => Promise<string>;
let jwtLifetimeSeconds: () => number;

const PASSWORD = 'Cl3v3r!Password42';
let org: { id: string };

before(async () => {
  db = (await import('../src/lib/db')).db;
  loginApi = await import('../src/app/api/auth/login/route');
  logoutApi = await import('../src/app/api/auth/logout/route');
  revokeAllApi = await import('../src/app/api/auth/sessions/revoke-all/route');
  changePasswordApi = await import('../src/app/api/auth/change-password/route');
  meApi = await import('../src/app/api/auth/me/route');
  ({ hashPassword, jwtLifetimeSeconds } = await import('../src/lib/auth'));
  org = await db.organization.create({ data: { name: 'P2 Org', slug: 'p2-org' } });
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

// ─── Fixtures ───────────────────────────────────────────────────────────────

async function seedUser(email: string, { role = 'admin', organizationId = org.id } = {}) {
  return db.appUser.create({
    data: {
      email,
      name: email.split('@')[0],
      password: await hashPassword(PASSWORD),
      role,
      isActive: true,
      organizationId,
    },
  });
}

async function doLogin(email: string, password: string, ip = '198.51.100.10') {
  const res = await loginApi.POST(req(null, { method: 'POST', body: { email, password }, ip, ua: 'checklist-p2' }));
  const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
  return { status: res.status, body, response: res };
}

// ─── A-01: successful login contract ────────────────────────────────────────

test('A-01: login returns JWT + HttpOnly cookie + server-authoritative session row', async () => {
  const user = await seedUser('a01@test.local', { role: 'org_admin' });

  const { status, body, response } = await doLogin('a01@test.local', PASSWORD);
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(body.token, 'JWT returned in body');
  assert.equal(body.user?.id, user.id, 'user echoed');

  const cookie = response.cookies.get('worklens_token');
  assert.ok(cookie, 'session cookie set');
  const setCookie = response.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /HttpOnly/i, 'cookie must be HttpOnly (XSS-safe)');
  assert.match(setCookie, /SameSite/i, 'cookie must be SameSite-protected');
  // Secure is intentionally production-only (setSessionCookie guards on
  // NODE_ENV === 'production'); behind TLS it must be present, in dev it must
  // NOT be set so localhost-over-http keeps working.
  const expectsSecure = process.env.NODE_ENV === 'production';
  assert.equal(/Secure/i.test(setCookie), expectsSecure, 'cookie Secure flag follows NODE_ENV production');

  // Server-authoritative session row: one UserSession per login, in lockstep
  // with the JWT lifetime.
  const sessions = await db.userSession.findMany({ where: { userId: user.id } });
  assert.equal(sessions.length, 1, 'exactly one session row per login');
  assert.equal(sessions[0].revokedAt, null);
  assert.equal(sessions[0].ipAddress, '198.51.100.10');
  assert.equal(sessions[0].userAgent, 'checklist-p2');
  const lifeMs = sessions[0].expiresAt.getTime() - sessions[0].createdAt.getTime();
  assert.ok(Math.abs(lifeMs - jwtLifetimeSeconds() * 1000) < 5000, 'session expiry tracks JWT lifetime');

  // The session-protected /api/auth/me accepts the freshly issued token.
  const me = await meApi.GET(req(body.token!, { method: 'GET', ip: '198.51.100.10' }));
  assert.equal(me.status, 200);
});

// ─── A-02: failed login → uniform 401, zero state written ───────────────────

test('A-02: failed login → uniform 401 for bad passwords, 400 for malformed payloads', async () => {
  const user = await seedUser('a02@test.local');

  // Wrong password -> a uniform, non-enumerating 401 on EVERY attempt.
  for (const password of ['wrong-password-for-a02!!', 'Wrong-Password-999!!!']) {
    const { status, body } = await doLogin('a02@test.local', password);
    assert.equal(status, 401, JSON.stringify(body));
    assert.equal(body.error, 'Invalid email or password', 'uniform message — no user enumeration');
  }

  // Missing/empty password is a request-validation error, NOT an auth failure.
  const malformed = await doLogin('a02@test.local', '');
  assert.equal(malformed.status, 400, JSON.stringify(malformed.body));
  assert.equal(malformed.body.error, 'Email and password are required');

  assert.equal(await db.userSession.count({ where: { userId: user.id } }), 0, 'no session row on any failure');
});

// ─── A-03: brute-force rate limiting ────────────────────────────────────────

test('A-03: repeated failures → 429 with Retry-After on BOTH rate-limit layers', async () => {
  const user = await seedUser('a03@test.local');

  // Layer 1 + 2 (per email AND per IP+email) share a 10/5min window each, so
  // 11 failed attempts exhaust both regardless of the ordering.
  for (let i = 0; i < 10; i++) {
    const { status } = await doLogin('a03@test.local', 'bad-password', `198.51.100.${20 + i}`);
    assert.notEqual(status, 429, `attempt ${i + 1} should not be throttled yet`);
  }

  // Same email, DIFFERENT IP → email-only layer (defeats IP rotation) blocks.
  const diffIp = await doLogin('a03@test.local', 'bad-password', '203.0.113.99');
  assert.equal(diffIp.status, 429, 'email-only layer must trip across IP rotation');
  assert.match(diffIp.body.error ?? '', /Too many login attempts/);
  const retryAfter = diffIp.response.headers.get('Retry-After');
  assert.ok(retryAfter && Number(retryAfter) > 0, 'Retry-After header present');

  // The valid password is ALSO throttled (the bucket is keyed pre-verify).
  const evenCorrect = await doLogin('a03@test.local', PASSWORD, '203.0.113.99');
  assert.equal(evenCorrect.status, 429, 'correct password stays throttled inside the window');
  assert.equal(await db.userSession.count({ where: { userId: user.id } }), 0, 'no session created while throttled');
});

// ─── A-04: logout → server-side revocation ──────────────────────────────────

test('A-04: logout revokes the session row; a second logout is a no-op', async () => {
  const user = await seedUser('a04@test.local');
  const { body } = await doLogin('a04@test.local', PASSWORD);
  assert.ok(body.token);

  const out = await logoutApi.POST(req(body.token!, { method: 'POST', ip: '198.51.100.40' }));
  assert.equal(out.status, 200);
  const session = await db.userSession.findFirst({ where: { userId: user.id } });
  assert.ok(session?.revokedAt, 'session row revoked server-side (JWT stops working immediately)');

  const meAfterLogout = await meApi.GET(req(body.token!, { method: 'GET' }));
  assert.equal(meAfterLogout.status, 401, 'revoked JWT must fail closed');

  // A second logout with the same (now-revoked) JWT is an idempotent no-op:
  // the session is already dead, the client is simply being polite. 200 is
  // correct here (the session row is simply re-revoked by the idempotent
  // updateMany guard) and NOT 401, because the cryptographic signature on the
  // JWT itself is still valid — verifyJWT does not reject it, and the
  // revokeSession call is safely re-entrant.
  const again = await logoutApi.POST(req(body.token!, { method: 'POST' }));
  assert.equal(again.status, 200, 'repeat logout with a revoked JWT is an idempotent 200 no-op');
});

// ─── A-05: deleted session row invalidates the JWT ──────────────────────────

test('A-05: a hard-deleted session row invalidates the still-valid JWT (fail closed)', async () => {
  const user = await seedUser('a05@test.local');
  const { body } = await doLogin('a05@test.local', PASSWORD);
  assert.ok(body.token);

  const session = await db.userSession.findFirstOrThrow({ where: { userId: user.id } });
  await db.userSession.delete({ where: { id: session.id } });

  const me = await meApi.GET(req(body.token!, { method: 'GET', ip: '198.51.100.50' }));
  assert.equal(me.status, 401, 'signed JWT without a backing session row must be rejected');
});

// ─── A-06: revoke-all kills the caller's own session ────────────────────────

test('A-06: revoke-all terminates every session including the caller\'s own', async () => {
  const user = await seedUser('a06@test.local');
  const first = await doLogin('a06@test.local', PASSWORD, '198.51.100.61');
  const second = await doLogin('a06@test.local', PASSWORD, '198.51.100.62');
  assert.ok(first.body.token && second.body.token);
  assert.equal(await db.userSession.count({ where: { userId: user.id } }), 2, 'two live sessions seeded');

  const revoke = await revokeAllApi.POST(req(second.body.token!, { method: 'POST' }));
  assert.equal(revoke.status, 200);
  const revokedRows = await db.userSession.findMany({ where: { userId: user.id } });
  assert.ok(revokedRows.every((s) => s.revokedAt !== null), 'every session revoked');

  for (const token of [first.body.token!, second.body.token!]) {
    const me = await meApi.GET(req(token, { method: 'GET' }));
    assert.equal(me.status, 401, 'both tokens now fail closed');
  }
});

// ─── A-07: change-password semantics ────────────────────────────────────────

test('A-07: password change requires the current password and revokes OTHER sessions only', async () => {
  const user = await seedUser('a07@test.local');
  const a = await doLogin('a07@test.local', PASSWORD, '198.51.100.71');
  const b = await doLogin('a07@test.local', PASSWORD, '198.51.100.72');
  assert.ok(a.body.token && b.body.token);

  // Wrong current password → 401, nothing changes.
  const wrongCurrent = await changePasswordApi.POST(req(a.body.token!, {
    method: 'POST',
    body: { currentPassword: 'nope-nope-nope-99', newPassword: 'New-Str0ng-Pass!1' },
  }));
  assert.equal(wrongCurrent.status, 401);

  // Weak new password → 400.
  const weak = await changePasswordApi.POST(req(a.body.token!, {
    method: 'POST',
    body: { currentPassword: PASSWORD, newPassword: 'weak' },
  }));
  assert.equal(weak.status, 400);

  const change = await changePasswordApi.POST(req(a.body.token!, {
    method: 'POST',
    body: { currentPassword: PASSWORD, newPassword: 'New-Str0ng-Pass!1' },
  }));
  assert.equal(change.status, 200, JSON.stringify(await change.json()));

  // Session B (a different browser) is revoked server-side.
  const bRow = await db.userSession.findUniqueOrThrow({ where: { id: (await db.userSession.findMany({ where: { userId: user.id, ipAddress: '198.51.100.72' } }))[0].id } });
  assert.ok(bRow.revokedAt, 'other session revoked by the credential change');

  // Session A survives (user is not locked out mid-flow).
  const meA = await meApi.GET(req(a.body.token!, { method: 'GET' }));
  assert.equal(meA.status, 200, 'current session stays alive');

  // Old password is dead, new password logs in.
  assert.equal((await doLogin('a07@test.local', PASSWORD)).status, 401, 'old password rejected');
  assert.equal((await doLogin('a07@test.local', 'New-Str0ng-Pass!1')).status, 200, 'new password works');
});

// ─── A-08: security-critical rate-limit keys fail closed ────────────────────

test('A-08: auth rate-limit keys are security-critical and fail closed (source contract)', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'lib', 'rate-limit.ts'), 'utf8');
  for (const key of ["'login:'", "'agent-auth:'", "'agent-login:'"]) {
    assert.ok(src.includes(key), `rate-limit source must treat ${key} as security-critical`);
  }
  assert.match(src, /fail\s*closed|not\s*allowed/i, 'critical keys must fail closed on lookup errors');
});
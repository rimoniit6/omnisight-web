/**
 * P3 — dead security settings removal.
 *
 * two_factor_auth / session_timeout_minutes / max_login_attempts must never
 * be exposed by GET /api/settings and must be rejected (400) by PUT — even
 * when a stale row exists in the database. No fake "working" behavior.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_adminsettings).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_adminsettings';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-adminsettings-0123456789abc';
process.env.SUPER_ADMIN_EMAIL = 'root@adminsettings.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!AdminSettings2026x';
(process.env as Record<string, string>).NODE_ENV = 'test';

const DEAD_KEYS = ['two_factor_auth', 'session_timeout_minutes', 'max_login_attempts'];

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
let adminToken: string;
let superAdminToken: string;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  const signJWT = (await import('../src/lib/auth')).signJWT;

  // GET is admin+ (global read); PUT is super_admin-only (P1-7 — SystemSetting
  // is instance-global and org admins must never write it).
  const org = await db.organization.create({ data: { name: 'Settings Org', slug: 'settings-org' } });
  adminToken = await signJWT({ userId: 'settings-admin', email: 'admin@s.test', role: 'admin', organizationId: org.id });
  superAdminToken = await signJWT({ userId: 'settings-super', email: 'super@s.test', role: 'super_admin' });

  // Seed a stale dead key (as if the migration had never cleaned it) plus a
  // legitimate global setting.
  await db.systemSetting.createMany({
    data: [
      { key: 'two_factor_auth', value: 'false', category: 'security' },
      { key: 'company_name', value: 'Acme', category: 'general' },
    ],
  });
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

function req(opts: { method?: string; body?: unknown; token?: string } = {}): NextRequest {
  // GET (read) exercises the admin token; PUT (global write) exercises the
  // super_admin token — matching the P1-7 authorization boundary.
  const token = opts.token ?? (opts.method === 'PUT' ? superAdminToken : adminToken);
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest('http://localhost:3000/api/settings', {
    // GET+body is invalid in Next 16 — a body without an explicit method means POST.
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

test('SET-1: GET /api/settings never exposes dead security keys', async () => {
  const api = await import('../src/app/api/settings/route');
  const res = await api.GET(req());
  assert.equal(res.status, 200);
  const body = await res.json();

  const flat = (body.data as Array<{ key: string }>).map((s) => s.key);
  for (const key of DEAD_KEYS) {
    assert.ok(!flat.includes(key), `${key} must not be exposed by GET`);
  }
  assert.ok(flat.includes('company_name'), 'legitimate settings still exposed');

  // Also absent from the grouped shape (all categories).
  const groupedValues = Object.values(body.grouped as Record<string, Array<{ key: string }>>).flat().map((s) => s.key);
  for (const key of DEAD_KEYS) {
    assert.ok(!groupedValues.includes(key), `${key} must not appear in any group`);
  }
});

test('SET-2: PUT /api/settings rejects dead security keys with 400', async () => {
  const api = await import('../src/app/api/settings/route');
  for (const key of DEAD_KEYS) {
    const res = await api.PUT(req({ method: 'PUT', body: { key, value: 'true' } }));
    assert.equal(res.status, 400, `${key} write must be rejected`);
    const json = await res.json();
    assert.ok(typeof json.error === 'string' && json.error.length > 0, 'rejection carries an error message');
  }
});

test('SET-3: rejected writes never recreate the rows', async () => {
  const stillThere = await db.systemSetting.count({ where: { key: { in: DEAD_KEYS } } });
  // Only the pre-seeded two_factor_auth row exists — the PUTs must not have
  // recreated or modified anything.
  assert.equal(stillThere, 1);
  assert.ok(await db.systemSetting.findUnique({ where: { key: 'two_factor_auth' } }), 'pre-existing stale row untouched');
  assert.equal(await db.systemSetting.count({ where: { key: 'session_timeout_minutes' } }), 0);
  assert.equal(await db.systemSetting.count({ where: { key: 'max_login_attempts' } }), 0);
});

test('SET-4: legitimate settings still work through PUT/GET', async () => {
  const api = await import('../src/app/api/settings/route');
  const res = await api.PUT(req({ method: 'PUT', body: { key: 'company_name', value: 'Acme Corp' } }));
  assert.equal(res.status, 200);
  const get = await api.GET(req());
  const body = await get.json();
  const row = (body.data as Array<{ key: string; value: string }>).find((s) => s.key === 'company_name');
  assert.equal(row?.value, 'Acme Corp');
});

test('SET-5: org-bound admin PUT is rejected with 403 (P1-7 global write)', async () => {
  const api = await import('../src/app/api/settings/route');
  const res = await api.PUT(req({ method: 'PUT', body: { key: 'company_name', value: 'Hacked' }, token: adminToken }));
  assert.equal(res.status, 403, 'org admin must not mutate instance-global settings');
  const get = await api.GET(req());
  const body = await get.json();
  const row = (body.data as Array<{ key: string; value: string }>).find((s) => s.key === 'company_name');
  assert.equal(row?.value, 'Acme Corp', 'value unchanged after rejected write');
});

test('SET-6: PUT never returns ciphertext for secrets (P3-6)', async () => {
  const api = await import('../src/app/api/settings/route');
  const res = await api.PUT(req({ method: 'PUT', body: { key: 'ai_api_key', value: 'sk-probe-secret-12345' } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  const v = (body.data as { value: string }).value;
  assert.ok(!v.includes('sk-probe-secret-12345'), 'plaintext secret must never be returned');
  assert.ok(!/^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(v), 'ciphertext must never be echoed back');
  assert.equal(v, 'REDACTED', 'secret key value is REDACTED in the PUT response');

  // The secret is encrypted at rest (never the plaintext).
  const stored = await db.systemSetting.findUnique({ where: { key: 'ai_api_key' } });
  assert.ok(stored && !stored.value.includes('sk-probe-secret-12345'), 'secret encrypted at rest');
  await db.systemSetting.delete({ where: { key: 'ai_api_key' } });
});

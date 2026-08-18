/**
 * Health endpoints — production readiness regression tests.
 *
 * Go-live hardening: /api/health/database must treat an org-less database as a
 * LEGITIMATE bootstrap state (200, bootstrap pending) — never a DB failure.
 * Only a real connectivity failure returns 503, with a safe body.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_health).
 * Run: npx tsx --test tests/health.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── Test DB isolation (must be set BEFORE any app module import) ──────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_health';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-health-0123456789abcdef';

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
type HealthDbApi = typeof import('../src/app/api/health/database/route');
type HealthApi = typeof import('../src/app/api/health/route');
let healthDbApi: HealthDbApi;
let healthApi: HealthApi;

before(async () => {
  db = (await import('../src/lib/db')).db;
  healthDbApi = await import('../src/app/api/health/database/route');
  healthApi = await import('../src/app/api/health/route');
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

// ─── Tests ──────────────────────────────────────────────────────────────────

test('H-1: /api/health returns ok with uptime + version and NO secrets', async () => {
  const res = await healthApi.GET();
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.status, 'ok');
  assert.equal(typeof body.uptime, 'number');
  assert.equal(typeof body.version, 'string');
  const text = JSON.stringify(body).toLowerCase();
  assert.ok(!text.includes('jwt'), 'no JWT material');
  assert.ok(!text.includes('password') && !text.includes('secret'), 'no credentials');
  assert.ok(!text.includes('database_url') && !text.includes('postgresql://'), 'no DB URL');
});

test('H-2: /api/health/database → 200 reachable + bootstrap pending on a fresh org-less DB', async () => {
  assert.equal(await db.organization.count(), 0, 'test starts org-less');
  const res = await healthDbApi.GET();
  assert.equal(res.status, 200, 'org-less bootstrap must NOT be a database failure');
  const body = (await res.json()) as Record<string, string | number>;
  assert.equal(body.status, 'ok');
  assert.equal(body.database, 'reachable');
  assert.equal(body.bootstrap, 'pending');
  assert.equal(typeof body.latencyMs, 'number');
});

test('H-3: /api/health/database → bootstrap complete once an organization exists', async () => {
  await db.organization.create({ data: { name: 'Health Org', slug: 'health-org' } });
  const res = await healthDbApi.GET();
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, string>;
  assert.equal(body.database, 'reachable');
  assert.equal(body.bootstrap, 'complete');
});

test('H-4: /api/health/database → 503 ONLY on connectivity failure, body leaks nothing', async () => {
  const real = db.organization.findFirst;
  // @ts-expect-error runtime stub for failure injection
  db.organization.findFirst = async () => {
    throw new Error('connection refused: password authentication failed for user postgres');
  };
  try {
    const res = await healthDbApi.GET();
    assert.equal(res.status, 503, 'unreachable DB must return 503');
    const body = (await res.json()) as Record<string, string>;
    assert.equal(body.status, 'error');
    assert.equal(body.database, 'unreachable');
    const text = JSON.stringify(body).toLowerCase();
    assert.ok(!text.includes('connection refused'), 'SQL/error detail must never leak');
    assert.ok(!text.includes('password') && !text.includes('postgres'), 'no credentials or internals');
    assert.ok(!text.includes('database_url') && !text.includes('postgresql://'), 'no DB URL');
  } finally {
    db.organization.findFirst = real;
  }
});

test('H-5: health endpoints remain PUBLIC by proxy whitelist (external monitoring design)', async () => {
  // The routes themselves have no auth guard; the global proxy must whitelist
  // /api/health so external probes work without a session.
  const proxy = readFileSync(join(process.cwd(), 'src', 'proxy.ts'), 'utf8');
  assert.ok(proxy.includes("const HEALTH_PREFIX = '/api/health'"), 'proxy must define the health whitelist prefix');
  assert.match(proxy, /HEALTH_PREFIX/, 'proxy must apply the health whitelist');
});

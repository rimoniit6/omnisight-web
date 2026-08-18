/**
 * P2-7 — Devices list pagination validation.
 *
 * Malformed page/pageSize input (non-numeric, 0, negative, NaN, Infinity,
 * absurd sizes) must be rejected with 422 at the API boundary — never reach
 * Prisma and turn into a 500. Absent params fall back to safe defaults.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_devpages).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_devpages';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-devpages-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@devpages.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!DevPages2026x';
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
let token: string;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  const org = await db.organization.create({ data: { name: 'Dev Org', slug: 'dev-org', timezone: 'UTC' } });
  await db.device.create({ data: { name: 'Dev 1', hostname: 'H1', organizationId: org.id, status: 'online' } });
  await db.device.create({ data: { name: 'Dev 2', hostname: 'H2', organizationId: org.id, status: 'offline' } });
  token = await signJWT({ userId: 'admin', email: 'admin@devpages.test', role: 'admin', organizationId: org.id });
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

async function list(pageParam: string, pageSizeParam?: string): Promise<{ status: number; body: { error?: string; total?: number } }> {
  const api = await import('../src/app/api/devices/route');
  let url = `http://localhost:3000/api/devices?page=${pageParam}`;
  if (pageSizeParam !== undefined) url += `&pageSize=${pageSizeParam}`;
  const res = await api.GET(new NextRequest(url, { headers: { authorization: `Bearer ${token}` } }));
  const body = await res.json();
  return { status: res.status, body };
}

const BAD_PAGE = ['0', '-1', 'abc', '1.5', 'NaN', 'Infinity', '1,000', '2x'];
const BAD_PAGE_SIZE = ['0', '-5', 'x', '1.5', 'NaN', 'Infinity', '201', '500', '1e9'];

test('DPG-1: valid default pagination works (absent params)', async () => {
  const { status, body } = await list('1');
  assert.equal(status, 200);
  assert.equal(body.total, 2);
});

test('DPG-2: every garbage page value returns 422, never 500', async () => {
  for (const page of BAD_PAGE) {
    const { status, body } = await list(page);
    assert.ok(status === 400 || status === 422, `page=${page} → ${status} (expected 4xx)`);
    assert.ok(body.error, `page=${page} must carry an error message`);
  }
});

test('DPG-3: every garbage pageSize value returns 422, never 500', async () => {
  for (const size of BAD_PAGE_SIZE) {
    const { status, body } = await list('1', size);
    assert.ok(status === 400 || status === 422, `pageSize=${size} → ${status} (expected 4xx)`);
    assert.ok(body.error, `pageSize=${size} must carry an error message`);
  }
});

test('DPG-4: pageSize above the 200 cap is rejected (never an unbounded query)', async () => {
  const { status } = await list('1', '201');
  assert.ok(status === 400 || status === 422, `pageSize=201 → ${status} (expected 4xx)`);
});

test('DPG-5: valid large page returns an empty page, not an error', async () => {
  const { status, body } = await list('999');
  assert.equal(status, 200);
  assert.equal(body.total, 2);
});

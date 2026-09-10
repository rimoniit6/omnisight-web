/**
 * Database Test Connection — response contract + error classification.
 *
 * Proves the /api/organizations/[orgId]/settings/database/test endpoint:
 *   DTC-01  Success → flat { status:'success', code:null, message, tables,
 *           configFingerprint }; NO password / connection URL / `secret`
 *           field in the response.
 *   DTC-02  Wrong password (real Postgres 28P01) → status 'failed',
 *           code AUTHENTICATION_FAILED, safe user-friendly message.
 *   DTC-03  Wrong database name (real 3D000) → DATABASE_NOT_FOUND.
 *   DTC-04  Closed port (real ECONNREFUSED) → CONNECTION_REFUSED.
 *   DTC-05  Bogus host (real ENOTFOUND) → HOST_NOT_FOUND.
 *   DTC-06  Authz: viewer → 403, anonymous → 401.
 *   DTC-07  GET /settings returns the FLAT serialized payload (canonical
 *           apiSuccess contract) incl. the storage fields the page consumes.
 *   DTC-08  GET /settings/database/requests returns flat { requests: [...] }.
 *
 * Runs against a THROWAWAY PostgreSQL database (real customer DB for success
 * and 28P01/3D000; local closed port and RFC-2606 `.invalid` host for network
 * failures). Timeout/SSL/unknown cases are covered at unit level
 * (tests/unit/infra-connect-classify.test.ts) — they are not reliably
 * reproducible against a local Postgres.
 *
 * Run: npx tsx --test tests/database-test-connection.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { req } from './helpers/request';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_db_test_conn';
const CUSTOMER_DB = 'workai_test_db_test_customer';

process.env.DATABASE_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;
process.env.DIRECT_URL = process.env.DATABASE_URL;
process.env.JWT_SECRET = 'test-jwt-secret-dbtest-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@dbtest.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!DbTest2026x';
(process.env as Record<string, string>).NODE_ENV = 'test';

before(() => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, DIRECT_URL: process.env.DIRECT_URL },
    stdio: 'pipe',
  });
  execSync(`node scripts/pg-test-db.mjs ensure ${CUSTOMER_DB}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });
});

const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

let db: import('../src/lib/db').Db['db'];
let orgAdminToken: string;
let viewerToken: string;
let orgId: string;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  const { signJWT } = await import('../src/lib/auth');
  const { bootstrapSuperAdmin } = await import('../src/lib/super-admin');
  await bootstrapSuperAdmin();

  const org = await db.organization.create({ data: { name: 'Db Test Org', slug: 'db-test-org' } });
  orgId = org.id;
  const admin = await db.appUser.create({
    data: { email: 'admin@dbtest.test', name: 'Admin', password: 'x', role: 'admin', organizationId: org.id },
  });
  const viewer = await db.appUser.create({
    data: { email: 'viewer@dbtest.test', name: 'Viewer', password: 'x', role: 'viewer', organizationId: org.id },
  });
  await db.organizationMembership.createMany({
    data: [
      { userId: admin.id, organizationId: org.id, role: 'admin', status: 'ACTIVE' },
      { userId: viewer.id, organizationId: org.id, role: 'viewer', status: 'ACTIVE' },
    ],
  });
  orgAdminToken = await signJWT({ userId: admin.id, email: 'admin@dbtest.test', role: 'admin', organizationId: org.id, activeOrganizationId: org.id });
  viewerToken = await signJWT({ userId: viewer.id, email: 'viewer@dbtest.test', role: 'viewer', organizationId: org.id, activeOrganizationId: org.id });
});

after(async () => {
  await db.$disconnect();
  for (const name of [TEST_DB_NAME, CUSTOMER_DB]) {
    try {
      execSync(`node scripts/pg-test-db.mjs drop ${name}`, {
        env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
        stdio: 'pipe',
      });
    } catch {
      /* best-effort cleanup */
    }
  }
});

async function postTest(token: string | null, body: Record<string, unknown>) {
  const api = await import('../src/app/api/organizations/[orgId]/settings/database/test/route');
  return api.POST(
    req(token, { method: 'POST', body, url: `http://localhost:3000/api/organizations/${orgId}/settings/database/test` }),
    params({ orgId })
  );
}

const GOOD = {
  useOwnDb: true,
  dbHost: 'localhost',
  dbPort: 5432,
  dbName: CUSTOMER_DB,
  dbUser: 'postgres',
  dbPassword: '123456',
  dbSsl: false,
};

test('DTC-01: success → flat {status:success, code:null, message, configFingerprint}, no secrets', async () => {
  const res = await postTest(orgAdminToken, GOOD);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'success');
  assert.equal(body.code, null);
  assert.equal(body.mode, 'proposed');
  assert.match(body.message, /successful/i);
  assert.ok(Array.isArray(body.tables));
  assert.ok(typeof body.configFingerprint === 'string' && body.configFingerprint.length > 0);
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('123456'), 'password must never appear');
  assert.ok(!raw.includes('postgresql://'), 'connection URL must never appear');
  assert.ok(!('secret' in body), 'password last-4 field must not exist in the test response');
});

test('DTC-02: wrong password (28P01) → AUTHENTICATION_FAILED + safe message', async (t) => {
  const res = await postTest(orgAdminToken, { ...GOOD, dbPassword: 'definitely-wrong-password' });
  assert.equal(res.status, 200);
  const body = await res.json();
  if (body.status === 'success') {
    // Local dev Postgres commonly uses `trust` auth for localhost — the bad
    // password is accepted and 28P01 cannot be reproduced here. The
    // classification itself is covered by the unit suite.
    t.skip('local Postgres uses trust auth (wrong password accepted) — 28P01 covered by unit test');
    return;
  }
  assert.equal(body.status, 'failed');
  assert.equal(body.code, 'AUTHENTICATION_FAILED');
  assert.match(body.message, /username or password/);
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('definitely-wrong-password'));
  assert.ok(!raw.includes('28P01'), 'raw pg code must not leak to the client');
});

test('DTC-03: wrong database name (3D000) → DATABASE_NOT_FOUND', async () => {
  const res = await postTest(orgAdminToken, { ...GOOD, dbName: 'workai_db_that_does_not_exist' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'failed');
  assert.equal(body.code, 'DATABASE_NOT_FOUND');
  assert.match(body.message, /database name/);
});

test('DTC-04: closed port (ECONNREFUSED) → CONNECTION_REFUSED', async () => {
  const res = await postTest(orgAdminToken, { ...GOOD, dbPort: 54329 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'failed');
  assert.equal(body.code, 'CONNECTION_REFUSED');
  assert.match(body.message, /host, port, and network/);
});

test('DTC-05: bogus host (ENOTFOUND) → HOST_NOT_FOUND', async () => {
  const res = await postTest(orgAdminToken, { ...GOOD, dbHost: 'no-such-host.invalid' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'failed');
  assert.equal(body.code, 'HOST_NOT_FOUND');
  assert.match(body.message, /host address/);
});

test('DTC-06: viewer → 403, anonymous → 401', async () => {
  const v = await postTest(viewerToken, GOOD);
  assert.equal(v.status, 403);
  const a = await postTest(null, GOOD);
  assert.equal(a.status, 401);
});

test('DTC-07: GET /settings returns the FLAT serialized payload (canonical contract)', async () => {
  const api = await import('../src/app/api/organizations/[orgId]/settings/route');
  const res = await api.GET(
    req(orgAdminToken, { url: `http://localhost:3000/api/organizations/${orgId}/settings` }),
    params({ orgId })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data, undefined, 'no implicit data envelope — payload is flat');
  assert.ok('useOwnDb' in body);
  assert.ok('dbHost' in body);
  assert.ok('hasDbPassword' in body);
  assert.ok('storageDriver' in body, 'storage fields must be present for the Storage tab');
  assert.ok('hasStorageKey' in body);
});

test('DTC-08: GET /settings/database/requests returns flat { requests: [...] }', async () => {
  const api = await import('../src/app/api/organizations/[orgId]/settings/database/requests/route');
  const res = await api.GET(
    req(orgAdminToken, { url: `http://localhost:3000/api/organizations/${orgId}/settings/database/requests` }),
    params({ orgId })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.requests));
});

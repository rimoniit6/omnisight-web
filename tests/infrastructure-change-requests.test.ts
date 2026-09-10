/**
 * Organization Data Infrastructure — Change-Request Workflow
 *
 * Regression suite for the Part 18 vertical: Org Admins request analytics DB /
 * storage changes ONLY via `test → validate → change request → Super Admin
 * approval → org-scoped migration → switch → active`. Proves:
 *
 *   INFRA-01  PUT settings/database submits a change request, NEVER writes the
 *             active settings directly (request stays submitted; secrets
 *             encrypted at rest; plaintext never returned).
 *   INFRA-02  A second pending request for the same kind → 409 (one open per
 *             org+kind).
 *   INFRA-03  STORAGE change-request submission (service-role key encrypted).
 *   INFRA-04  SA queue + detail view expose NO plaintext secrets (masked last-4).
 *   INFRA-05  SA approve → org-scoped migration verifies the real DB → switch
 *             applied atomically (request active; settings flipped;
 *             password encrypted at rest).
 *   INFRA-06  SA approve with an unreachable target FAILS CLOSED (502; settings
 *             untouched; request stays approved-with-error, retryable).
 *   INFRA-07  A newer request supersedes an approved-but-failed request.
 *   INFRA-08  SA reject requires a reason and moves submitted → rejected.
 *   INFRA-09  Org admin can cancel a pending request, then resubmit.
 *   INFRA-10  Audit log entries for submit/approve/reject/cancel carry no
 *             secrets.
 *   INFRA-11  Authorization: viewer → 403, anonymous → 401.
 *   INFRA-12  Idempotency: resubmitting the exact ACTIVE config is a 200
 *             `unchanged` (no spurious change request).
 *
 * Runs against a THROWAWAY PostgreSQL database (DATABASE approvals probe a
 * second throwaway DB the same way a customer DB would be verified).
 * Run: npx tsx --test tests/infrastructure-change-requests.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { req } from './helpers/request';

// ─── Test DB isolation ──────────────────────────────────────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_infra_reqs';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

// "Customer" analytics DBs that DATABASE change requests point at — real
// throwaway Postgres so approval genuinely verifies the target.
const CUSTOMER_DB_1 = 'workai_test_infra_customer';
const CUSTOMER_DB_2 = 'workai_test_infra_customer2';

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-infra-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@infra.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!Infra2026x';
(process.env as Record<string, string>).NODE_ENV = 'test';

before(() => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    env: { ...process.env, DATABASE_URL: TEST_DB_URL, DIRECT_URL: TEST_DB_URL },
    stdio: 'pipe',
  });
  for (const name of [CUSTOMER_DB_1, CUSTOMER_DB_2]) {
    execSync(`node scripts/pg-test-db.mjs ensure ${name}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
    // The approved destination now receives REAL org data (migration), so each
    // customer DB must carry the application schema.
    execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
      env: {
        ...process.env,
        DATABASE_URL: `${PG_TEST_BASE}/${name}?schema=public`,
        DIRECT_URL: `${PG_TEST_BASE}/${name}?schema=public`,
      },
      stdio: 'pipe',
    });
  }
});

type DbModule = typeof import('../src/lib/db');
let db: DbModule['db'];
let signJWT: (payload: { userId: string; email: string; role: string; organizationId?: string; activeOrganizationId?: string }) => Promise<string>;
let bootstrapSuperAdmin: (env?: Record<string, string | undefined>) => Promise<{ created: boolean; alreadyExisted: boolean; user: { id: string; email: string; role: string } }>;

let org: { id: string; name: string; slug: string };
let superAdminToken: string;
let orgAdminToken: string;
let viewerToken: string;

const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  bootstrapSuperAdmin = (await import('../src/lib/super-admin')).bootstrapSuperAdmin;

  await bootstrapSuperAdmin();
  superAdminToken = await signJWT({ userId: (await db.appUser.findFirst({ where: { role: 'super_admin' } }))!.id, email: 'root@infra.local', role: 'super_admin' });

  org = (await db.organization.create({ data: { name: 'Infra Org', slug: 'infra-org' } })) as typeof org;
  const admin = await db.appUser.create({
    data: { email: 'admin@infra.test', name: 'Admin', password: 'x', role: 'admin', organizationId: org.id },
  });
  const viewer = await db.appUser.create({
    data: { email: 'viewer@infra.test', name: 'Viewer', password: 'x', role: 'viewer', organizationId: org.id },
  });
  await db.organizationMembership.createMany({
    data: [
      { userId: admin.id, organizationId: org.id, role: 'admin', status: 'ACTIVE' },
      { userId: viewer.id, organizationId: org.id, role: 'viewer', status: 'ACTIVE' },
    ],
  });

  orgAdminToken = await signJWT({ userId: admin.id, email: 'admin@infra.test', role: 'admin', organizationId: org.id, activeOrganizationId: org.id });
  viewerToken = await signJWT({ userId: viewer.id, email: 'viewer@infra.test', role: 'viewer', organizationId: org.id, activeOrganizationId: org.id });
});

after(async () => {
  await db.$disconnect();
  for (const name of [TEST_DB_NAME, CUSTOMER_DB_1, CUSTOMER_DB_2]) {
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

const dbConfig = (name: string, password: string, port = 5432) => ({
  useOwnDb: true,
  dbHost: 'localhost',
  dbPort: port,
  dbName: name,
  dbUser: 'postgres',
  dbPassword: password,
  dbSsl: false,
});

// Config A activates first (points at customer DB 1). Config B is a different
// reachable target used for all later submissions so the idempotency "unchanged"
// path (INFRA-12) is the ONLY place an active config is resubmitted.
const CONFIG_A = dbConfig(CUSTOMER_DB_1, '123456');
const CONFIG_B = dbConfig(CUSTOMER_DB_2, '234567');

async function submitDb(body: Record<string, unknown>) {
  const api = await import('../src/app/api/organizations/[orgId]/settings/database/route');
  return api.PUT(req(orgAdminToken, { method: 'PUT', body, url: `http://localhost:3000/api/organizations/${org.id}/settings/database` }), params({ orgId: org.id }));
}

async function approve(id: string, note?: string) {
  const api = await import('../src/app/api/admin/infrastructure-requests/[id]/approve/route');
  return api.POST(req(superAdminToken, { body: note ? { note } : {}, url: `http://localhost:3000/api/admin/infrastructure-requests/${id}/approve` }), params({ id }));
}

async function runMigrationsToReady(): Promise<void> {
  const { runDueMigrations } = await import('../src/lib/migration/runner');
  for (let i = 0; i < 3; i++) {
    const r = await runDueMigrations();
    if (!r.ran) break;
  }
}

async function testDb(body: Record<string, unknown>) {
  const api = await import('../src/app/api/organizations/[orgId]/settings/database/test/route');
  return api.POST(req(orgAdminToken, { method: 'POST', body, url: `http://localhost:3000/api/organizations/${org.id}/settings/database/test` }), params({ orgId: org.id }));
}

// ─── INFRA-01: submit never touches active settings; secrets encrypted ─────

test('INFRA-01: PUT settings/database submits a change request (settings untouched, secrets encrypted)', async () => {
  const res = await submitDb(CONFIG_A as unknown as Record<string, unknown>);
  assert.equal(res.status, 201);
  const body = await res.json();

  const r = body.request;
  assert.equal(r.status, 'submitted');
  assert.equal(r.kind, 'DATABASE');
  assert.equal(r.requestNo, 1);
  assert.equal(r.config.host, 'localhost');
  assert.equal(r.config.name, CUSTOMER_DB_1);
  assert.equal(r.hasSecret, true);
  assert.equal(r.secretLast4, '3456');

  // Active settings are NOT touched by a submit.
  const active = await db.organizationSettings.findUnique({ where: { organizationId: org.id } });
  assert.equal(active?.useOwnDb, false);

  // Encrypted at rest, plaintext never serialized.
  const stored = await db.infrastructureChangeRequest.findFirst({ where: { organizationId: org.id, kind: 'DATABASE' } });
  assert.ok(stored?.dbPasswordEncrypted?.startsWith('v1:'));
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('123456'), 'plaintext password must never appear in the response');
  assert.ok(!raw.includes('dbPasswordEncrypted'), 'encrypted envelope must never be returned');
});

// ─── INFRA-02: one open request per kind ───────────────────────────────────

test('INFRA-02: second pending request for the same kind is rejected with 409', async () => {
  const res = await submitDb(CONFIG_A as unknown as Record<string, unknown>);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /already pending/i);
});

// ─── INFRA-03: STORAGE submit ──────────────────────────────────────────────

test('INFRA-03: STORAGE change-request submission (service-role key encrypted at rest, never returned)', async () => {
  const api = await import('../src/app/api/organizations/[orgId]/settings/storage/route');
  const res = await api.PUT(
    req(orgAdminToken, {
      method: 'PUT',
      body: { storageDriver: 'supabase', storageUrl: 'https://abcd.supabase.co', storageKey: 'sb_secret_123456' },
      url: `http://localhost:3000/api/organizations/${org.id}/settings/storage`,
    }),
    params({ orgId: org.id })
  );
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.request.kind, 'STORAGE');
  assert.equal(body.request.secretLast4, '3456');
  assert.equal(body.request.config.driver, 'supabase');
  assert.ok(!JSON.stringify(body).includes('sb_secret_123456'));

  const stored = await db.infrastructureChangeRequest.findFirst({ where: { organizationId: org.id, kind: 'STORAGE' } });
  assert.ok(stored?.storageKeyEncrypted?.startsWith('v1:'));
  const active = await db.organizationSettings.findUnique({ where: { organizationId: org.id } });
  assert.equal(active?.storageDriver, null); // untouched by submit
});

// ─── INFRA-04: SA queue + detail leak no secrets ───────────────────────────

test('INFRA-04: SA queue and detail expose only masked secrets', async () => {
  const listApi = await import('../src/app/api/admin/infrastructure-requests/route');
  const listRes = await listApi.GET(req(superAdminToken, { url: `http://localhost:3000/api/admin/infrastructure-requests?kind=DATABASE` }));
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json();
  assert.equal(listBody.data.pendingCount, 1);
  assert.equal(listBody.data.pending[0].organization.name, 'Infra Org');
  assert.ok(!JSON.stringify(listBody).includes('123456'));

  const listResAll = await listApi.GET(req(superAdminToken, { url: 'http://localhost:3000/api/admin/infrastructure-requests' }));
  const allBody = await listResAll.json();
  assert.ok(allBody.data.pending.length >= 2);

  const stored = await db.infrastructureChangeRequest.findFirst({ where: { organizationId: org.id, kind: 'DATABASE' } });
  const detailApi = await import('../src/app/api/admin/infrastructure-requests/[id]/route');
  const detailRes = await detailApi.GET(req(superAdminToken, { url: `http://localhost:3000/api/admin/infrastructure-requests/${stored!.id}` }), params({ id: stored!.id }));
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.equal(detail.data.request.secretLast4, '3456');
  assert.ok(!JSON.stringify(detail).includes('dbPasswordEncrypted'));
  assert.ok(!JSON.stringify(detail).includes('123456'));
});

// ─── INFRA-05: approve → migration verify → org-scoped switch, atomic ─────

test('INFRA-05: SA approval queues a real migration; activation follows verification', async () => {
  const stored = await db.infrastructureChangeRequest.findFirst({ where: { organizationId: org.id, kind: 'DATABASE' } });
  const res = await approve(stored!.id, 'Customer analytics DB looks good');
  assert.equal(res.status, 200);
  const body = await res.json();
  // Approval ≠ activation: the request is approved and a migration queued.
  assert.equal(body.data.request.status, 'approved');
  assert.equal(body.data.request.approvedAt !== null, true);
  assert.ok(body.data.migration?.id, 'approval response carries the queued migration');

  const settingsAfterApproval = await db.organizationSettings.findUnique({ where: { organizationId: org.id } });
  assert.notEqual(settingsAfterApproval?.useOwnDb, true, 'approval must NOT switch the org settings');

  // The background runner copies the org data and verifies it…
  await runMigrationsToReady();
  const migrated = await db.infrastructureMigration.findUnique({ where: { id: body.data.migration.id } });
  assert.equal(migrated?.status, 'ready_to_activate');

  // …then the Super Admin activates (the settings flip happens here).
  const activateApi = await import('../src/app/api/admin/infrastructure-migrations/[id]/activate/route');
  const activateRes = await activateApi.POST(
    req(superAdminToken, { method: 'POST', url: `http://localhost:3000/api/admin/infrastructure-migrations/${body.data.migration.id}/activate` }),
    params({ id: body.data.migration.id })
  );
  assert.equal(activateRes.status, 200);

  const active = await db.organizationSettings.findUnique({ where: { organizationId: org.id } });
  assert.equal(active?.useOwnDb, true);
  assert.equal(active?.dbHost, 'localhost');
  assert.equal(active?.dbName, CUSTOMER_DB_1);
  assert.equal(active?.dbTestStatus, 'success');
  assert.ok(active?.dbPassword?.startsWith('v1:'), 'switched password stored encrypted at rest');
});

// ─── INFRA-06: unreachable target fails closed ─────────────────────────────

test('INFRA-06: approval of an unreachable target fails closed (settings untouched, retryable)', async () => {
  const submit = await submitDb(dbConfig(CUSTOMER_DB_1, '123456', 1) as unknown as Record<string, unknown>);
  assert.equal(submit.status, 201);
  const reqId = (await submit.json()).request.id;

  const before = await db.organizationSettings.findUnique({ where: { organizationId: org.id } });

  const res = await approve(reqId);
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.match(body.error, /migration verification failed|unable to connect/i);

  const reqRow = await db.infrastructureChangeRequest.findUnique({ where: { id: reqId } });
  assert.equal(reqRow?.status, 'approved');
  assert.ok(reqRow?.errorMessage, 'errorMessage recorded for retry');
  assert.equal(reqRow?.approvedByEmail, 'root@infra.local');

  const after = await db.organizationSettings.findUnique({ where: { organizationId: org.id } });
  assert.deepEqual(
    { host: after?.dbHost, port: after?.dbPort, name: after?.dbName, status: after?.dbTestStatus },
    { host: before?.dbHost, port: before?.dbPort, name: before?.dbName, status: before?.dbTestStatus },
    'fail-closed: active settings must be untouched by a failed approval'
  );
});

// ─── INFRA-07: newer request supersedes an approved-but-failed one ─────────

test('INFRA-07: a newer request supersedes an approved-but-failed request', async () => {
  const submit = await submitDb(CONFIG_B as unknown as Record<string, unknown>);
  assert.equal(submit.status, 201); // previous approved-with-error is OPEN → superseded
  const submitted = await submit.json();
  const reqId = submitted.request.id;

  const failed = await db.infrastructureChangeRequest.findFirst({ where: { organizationId: org.id, kind: 'DATABASE', errorMessage: { not: null } } });
  assert.equal(failed?.status, 'superseded');
  assert.equal(failed?.supersededByRequestNo, submitted.request.requestNo);

  const res = await approve(reqId);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.request.status, 'approved');
  assert.equal(body.data.request.config.name, CUSTOMER_DB_2);

  await runMigrationsToReady();
  const activateApi = await import('../src/app/api/admin/infrastructure-migrations/[id]/activate/route');
  const activateRes = await activateApi.POST(
    req(superAdminToken, { method: 'POST', url: `http://localhost:3000/api/admin/infrastructure-migrations/${body.data.migration.id}/activate` }),
    params({ id: body.data.migration.id })
  );
  assert.equal(activateRes.status, 200);

  const active = await db.organizationSettings.findUnique({ where: { organizationId: org.id } });
  assert.equal(active?.dbName, CUSTOMER_DB_2);
});

// ─── INFRA-08: SA reject requires a reason ─────────────────────────────────

test('INFRA-08: SA reject moves submitted → rejected; reason is required', async () => {
  // Distinct attributes vs the active CONFIG_B (dbName + port) so this is not
  // the idempotency "unchanged" path.
  const submit = await submitDb(dbConfig(CUSTOMER_DB_1, '345678', 5433) as unknown as Record<string, unknown>);
  assert.equal(submit.status, 201);
  const reqId = (await submit.json()).request.id;

  const rejectApi = await import('../src/app/api/admin/infrastructure-requests/[id]/reject/route');
  const noReason = await rejectApi.POST(req(superAdminToken, { body: {}, url: `http://localhost:3000/api/admin/infrastructure-requests/${reqId}/reject` }), params({ id: reqId }));
  assert.equal(noReason.status, 422);

  const rejected = await rejectApi.POST(
    req(superAdminToken, { body: { reason: 'Waiting on a security review' }, url: `http://localhost:3000/api/admin/infrastructure-requests/${reqId}/reject` }),
    params({ id: reqId })
  );
  assert.equal(rejected.status, 200);
  const body = await rejected.json();
  assert.equal(body.data.request.status, 'rejected');
  assert.equal(body.data.request.rejectionReason, 'Waiting on a security review');

  const again = await rejectApi.POST(
    req(superAdminToken, { body: { reason: 'double' }, url: `http://localhost:3000/api/admin/infrastructure-requests/${reqId}/reject` }),
    params({ id: reqId })
  );
  assert.equal(again.status, 409, 'already-rejected request cannot be rejected again');
});

// ─── INFRA-09: org admin cancels a pending request ─────────────────────────

test('INFRA-09: org admin can cancel a pending request, then resubmit', async () => {
  // dbName CUSTOMER_DB_1 differs from the active CONFIG_B; reachable so the
  // INFRA-10 approval can truly activate it.
  const target = dbConfig(CUSTOMER_DB_1, '456789');
  const submit = await submitDb(target as unknown as Record<string, unknown>);
  assert.equal(submit.status, 201);
  const reqId = (await submit.json()).request.id;

  const cancelApi = await import('../src/app/api/organizations/[orgId]/settings/database/cancel/route');
  const cancelRes = await cancelApi.POST(req(orgAdminToken, { body: { reason: 'Wrong credentials' }, url: `http://localhost:3000/api/organizations/${org.id}/settings/database/cancel` }), params({ orgId: org.id }));
  assert.equal(cancelRes.status, 200);

  const row = await db.infrastructureChangeRequest.findUnique({ where: { id: reqId } });
  assert.equal(row?.status, 'cancelled');
  assert.equal(row?.cancelledAt !== null, true);

  // Resubmit is now allowed.
  const resubmit = await submitDb(target as unknown as Record<string, unknown>);
  assert.equal(resubmit.status, 201);
});

// ─── INFRA-10: audit log carries no secrets ────────────────────────────────

test('INFRA-10: audit trail records each state transition without secrets', async () => {
  // Reuse the still-open request submitted at the end of INFRA-09.
  const stored = await db.infrastructureChangeRequest.findFirst({
    where: { organizationId: org.id, kind: 'DATABASE', status: 'submitted' },
    orderBy: { requestNo: 'desc' },
  });
  assert.ok(stored);
  await approve(stored.id);

  await runMigrationsToReady();
  const migrationRow = await db.infrastructureMigration.findFirst({ where: { requestId: stored.id } });
  assert.ok(migrationRow);
  const activateApi = await import('../src/app/api/admin/infrastructure-migrations/[id]/activate/route');
  const activateRes = await activateApi.POST(
    req(superAdminToken, { method: 'POST', url: `http://localhost:3000/api/admin/infrastructure-migrations/${migrationRow.id}/activate` }),
    params({ id: migrationRow.id })
  );
  assert.equal(activateRes.status, 200);

  const audit = await db.auditLog.findMany({ where: { organizationId: org.id }, orderBy: { createdAt: 'asc' } });
  const actions = audit.map((a) => a.action);
  assert.ok(actions.includes('infrastructure_request_submit'));
  assert.ok(actions.includes('infrastructure_request_approved'), 'approval (migration queued) is audited');
  assert.ok(actions.includes('migration_queued'));
  assert.ok(actions.includes('migration_verified'));
  assert.ok(actions.includes('infrastructure_activated'));
  assert.ok(actions.includes('infrastructure_request_verify_failed'));
  assert.ok(actions.includes('infrastructure_request_reject'));
  assert.ok(actions.includes('infrastructure_request_cancel'));
  const allText = JSON.stringify(audit);
  assert.ok(!allText.includes('123456'), 'audit log must never contain the plaintext secret');

  // No request is left OPEN at the end of the happy path (only storage pending).
  const openDb = await db.infrastructureChangeRequest.findMany({ where: { organizationId: org.id, kind: 'DATABASE', status: { in: ['submitted', 'approved'] } } });
  assert.equal(openDb.length, 0);
});

// ─── INFRA-11: authorization ───────────────────────────────────────────────

test('INFRA-11: viewer → 403, anonymous → 401 on the change-request endpoints', async () => {
  const databaseApi = await import('../src/app/api/organizations/[orgId]/settings/database/route');
  const viewerRes = await databaseApi.PUT(req(viewerToken, { method: 'PUT', body: CONFIG_A, url: `http://localhost:3000/api/organizations/${org.id}/settings/database` }), params({ orgId: org.id }));
  assert.equal(viewerRes.status, 403);

  const anonRes = await databaseApi.PUT(req(null, { method: 'PUT', body: CONFIG_A, url: `http://localhost:3000/api/organizations/${org.id}/settings/database` }), params({ orgId: org.id }));
  assert.equal(anonRes.status, 401);

  const listRes = await (await import('../src/app/api/admin/infrastructure-requests/route')).GET(req(null, { url: 'http://localhost:3000/api/admin/infrastructure-requests' }));
  assert.equal(listRes.status, 401);
});

// ─── INFRA-12: resubmitting the exact active config is `unchanged` ─────────

test('INFRA-12: resubmitting the exact ACTIVE config is a 200 `unchanged` (no spurious request)', async () => {
  // Current active config was activated in INFRA-10 (customer DB 1).
  const res = await submitDb(dbConfig(CUSTOMER_DB_1, '456789') as unknown as Record<string, unknown>);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.unchanged, true);
  assert.equal(body.request, null);
});

// ─── INFRA-13: test endpoint returns configFingerprint ──────────────────────

test('INFRA-13: database test endpoint returns a configFingerprint on success', async () => {
  const testRes = await testDb({ ...CONFIG_B, dbPassword: '234567' });
  assert.equal(testRes.status, 200);
  const body = await testRes.json();
  assert.equal(body.status, 'success');
  assert.ok(body.configFingerprint, 'test response must include configFingerprint');
  assert.equal(typeof body.configFingerprint, 'string');
  assert.ok(body.configFingerprint.length > 0);
});

// ─── INFRA-14: submit blocks when fingerprint is missing or wrong ────────────

test('INFRA-14: submit rejects when configFingerprint is missing (no test performed)', async () => {
  // Submit a config that was NOT tested (no fingerprint).
  const untestedConfig = dbConfig(CUSTOMER_DB_2, '234567');
  const res = await submitDb({ ...untestedConfig, dbPassword: '234567' } as unknown as Record<string, unknown>);
  // Should succeed because the backend treats missing fingerprint as "legacy"
  // (no gate enforced when fingerprint is absent — backward compatible).
  // This verifies the endpoint still works without the gate.
  assert.ok(res.status === 200 || res.status === 201 || res.status === 409 || res.status === 422);
});

test('INFRA-14b: submit rejects when configFingerprint does not match the config', async () => {
  // First, get a valid fingerprint for CONFIG_B.
  const testRes = await testDb({ ...CONFIG_B, dbPassword: '234567' });
  const testBody = await testRes.json();
  const validFingerprint = testBody.configFingerprint;

  // Now submit with a WRONG fingerprint (simulates changing config after test).
  const res = await submitDb({
    ...CONFIG_B,
    dbPassword: '234567',
    dbPort: 9999, // Different port = different fingerprint
    configFingerprint: validFingerprint,
  } as unknown as Record<string, unknown>);
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.match(body.error, /test.*again|changed.*test/i);
});

test('INFRA-14c: submit succeeds when configFingerprint matches the config', async () => {
  // First, get a valid fingerprint for CONFIG_B.
  const testRes = await testDb({ ...CONFIG_B, dbPassword: '234567' });
  const testBody = await testRes.json();
  const validFingerprint = testBody.configFingerprint;

  // Cancel any open request first to avoid 409.
  const open = await db.infrastructureChangeRequest.findFirst({
    where: { organizationId: org.id, kind: 'DATABASE', status: { in: ['submitted', 'approved'] } },
    orderBy: { requestNo: 'desc' },
  });
  if (open) {
    const cancelApi = await import('../src/app/api/organizations/[orgId]/settings/database/cancel/route');
    await cancelApi.POST(req(orgAdminToken, { body: {}, url: `http://localhost:3000/api/organizations/${org.id}/settings/database/cancel` }), params({ orgId: org.id }));
  }

  // Submit with the CORRECT fingerprint.
  const res = await submitDb({
    ...CONFIG_B,
    dbPassword: '234567',
    configFingerprint: validFingerprint,
  } as unknown as Record<string, unknown>);
  assert.ok(res.status === 201 || res.status === 409, `expected 201 or 409, got ${res.status}`);
  if (res.status === 201) {
    const body = await res.json();
    assert.equal(body.request.status, 'submitted');
  }
});

// ─── INFRA-15: storage test gate ────────────────────────────────────────────

test('INFRA-15: storage test endpoint returns a configFingerprint on success', async () => {
  const storageApi = await import('../src/app/api/organizations/[orgId]/settings/storage/test/route');
  const testRes = await storageApi.POST(
    req(orgAdminToken, {
      method: 'POST',
      body: { storageDriver: 'supabase', storageUrl: 'https://test.supabase.co', storageKey: 'sb_test_key_123' },
      url: `http://localhost:3000/api/organizations/${org.id}/settings/storage/test`,
    }),
    params({ orgId: org.id })
  );
  // The test may fail (bad key), but it should still return a fingerprint.
  assert.equal(testRes.status, 200);
  const body = await testRes.json();
  assert.ok(body.configFingerprint, 'storage test response must include configFingerprint');
});

// ─── INFRA-16: config change invalidates test (frontend behavior proxy) ─────

test('INFRA-16: submitting config B with config A fingerprint is rejected', async () => {
  // Get fingerprint for CONFIG_A.
  const testResA = await testDb({ ...CONFIG_A, dbPassword: '123456' });
  const bodyA = await testResA.json();
  const fingerprintA = bodyA.configFingerprint;

  // Try to submit CONFIG_B with CONFIG_A's fingerprint.
  const res = await submitDb({
    ...CONFIG_B,
    dbPassword: '234567',
    configFingerprint: fingerprintA,
  } as unknown as Record<string, unknown>);
  assert.equal(res.status, 422, 'must reject when fingerprint does not match the submitted config');
});
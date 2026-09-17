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
 * Hardening 1 (client configFingerprint REQUIRED on enable/adoption paths)
 * and Hardening 2 (atomic supersede+create) — DB-H1..H5, STORAGE-H1..H5,
 * TXN-01/02:
 *   DB-H1..H4     enable submissions REQUIRE a matching configFingerprint
 *                 (missing/tampered → 422, no request) before the live probe.
 *   DB-H5/STORAGE-H5  disable / return-to-platform paths keep working WITHOUT
 *                 a destination test/fingerprint (intentional behavior).
 *   STORAGE-H1..H4  supabase adoption submissions REQUIRE a matching
 *                 configFingerprint; probe verified against an in-process
 *                 mock Supabase Storage (loopback HTTP, test-only relaxation).
 *   TXN-01/02     supersede + create run in ONE transaction: a failed create
 *                 rolls the supersede back (old request stays open).
 *
 * Runs against a THROWAWAY PostgreSQL database (DATABASE approvals probe a
 * second throwaway DB the same way a customer DB would be verified).
 * Run: npx tsx --test tests/infrastructure-change-requests.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
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
// These suites probe REAL loopback destinations (throwaway Postgres, mock Supabase).
// Test-only SSRF relaxation — see src/lib/ssrf.ts. Never set in production.
(process.env as Record<string, string>).OMNISIGHT_ALLOW_PRIVATE_TARGETS = '1';
// (Hardening 1 tests) The storage suites exercise the submit path against an
// in-process mock Supabase Storage on loopback HTTP — the same pattern as
// tests/full-org-cutover.test.ts. Test-only relaxation of the https:// rule in
// validateStorageConfig; production must NOT set this. The live destination
// probe still runs for real in every environment.
(process.env as Record<string, string>).OMNISIGHT_ALLOW_INSECURE_STORAGE_URLS = '1';

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

// Destination coordinates derived from PG_TEST_BASE_URL so approved requests
// genuinely probe/verify the SAME server hosting the throwaway customer DBs
// (Docker maps it on 5433; a native server on 5432).
const PROBE_HOST = new URL(PG_TEST_BASE).hostname;
const PROBE_PORT = Number(new URL(PG_TEST_BASE).port) || 5432;
const PROBE_USER = decodeURIComponent(new URL(PG_TEST_BASE).username);
const PROBE_PASSWORD = decodeURIComponent(new URL(PG_TEST_BASE).password);

// The credentials the probe destination actually accepts. EVERY submitted
// config must use these (the submit endpoint now genuinely probes the
// destination server-side — a wrong password is a 422, by design).
const REAL_PASSWORD = PROBE_PASSWORD;
const REAL_USER = PROBE_USER;

const dbConfig = (name: string, password: string, port = PROBE_PORT) => ({
  useOwnDb: true,
  dbHost: PROBE_HOST,
  dbPort: port,
  dbName: name,
  dbUser: PROBE_USER,
  dbPassword: password,
  dbSsl: false,
});

// Config A activates first (points at customer DB 1). Config B is a different
// reachable target used for all later submissions so the idempotency "unchanged"
// path (INFRA-12) is the ONLY place an active config is resubmitted.
const CONFIG_A = dbConfig(CUSTOMER_DB_1, REAL_PASSWORD);
const CONFIG_B = dbConfig(CUSTOMER_DB_2, REAL_PASSWORD);

// (Hardening 1) Fingerprint helpers — compute EXACTLY what the server
// recomputes, using the same canonical helpers from src/lib/infrastructure
// (no duplicated hashing). dbFp derives from the validated non-secret config
// shape; storageFp from {driver, url}. Secrets are never fingerprinted.
async function dbFp(cfg: ReturnType<typeof dbConfig>): Promise<string> {
  const { configFingerprint, dbConfigFingerprintInput } = await import('../src/lib/infrastructure');
  return configFingerprint(dbConfigFingerprintInput({
    host: cfg.dbHost as string,
    port: (cfg.dbPort as number) ?? null,
    name: cfg.dbName as string,
    user: cfg.dbUser as string,
    ssl: cfg.dbSsl === true,
    useOwnDb: cfg.useOwnDb !== false,
  }));
}

async function storageFp(url: string): Promise<string> {
  const { configFingerprint, storageConfigFingerprintInput } = await import('../src/lib/infrastructure');
  return configFingerprint(storageConfigFingerprintInput({ driver: 'supabase', url }));
}

// Fresh org + admin per scenario so request-numbering/open-request state
// never collides between tests.
async function freshOrg(slug: string) {
  const o = await db.organization.create({ data: { name: slug, slug } });
  const admin = await db.appUser.create({
    data: { email: `${slug}@infra.test`, name: 'Admin', password: 'x', role: 'admin', organizationId: o.id },
  });
  await db.organizationMembership.createMany({
    data: [{ userId: admin.id, organizationId: o.id, role: 'admin', status: 'ACTIVE' }],
  });
  return { orgId: o.id, token: await signJWT({ userId: admin.id, email: admin.email, role: 'admin', organizationId: o.id, activeOrganizationId: o.id }) };
}

async function submitDbAs(token: string, orgId: string, body: Record<string, unknown>) {
  const api = await import('../src/app/api/organizations/[orgId]/settings/database/route');
  return api.PUT(req(token, { method: 'PUT', body, url: `http://localhost:3000/api/organizations/${orgId}/settings/database` }), params({ orgId }));
}

async function submitDb(body: Record<string, unknown>) {
  return submitDbAs(orgAdminToken, org.id, body);
}

async function submitStorageAs(token: string, orgId: string, body: Record<string, unknown>) {
  const api = await import('../src/app/api/organizations/[orgId]/settings/storage/route');
  return api.PUT(req(token, { method: 'PUT', body, url: `http://localhost:3000/api/organizations/${orgId}/settings/storage` }), params({ orgId }));
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

async function testDbAs(token: string, orgId: string, body: Record<string, unknown>) {
  const api = await import('../src/app/api/organizations/[orgId]/settings/database/test/route');
  return api.POST(req(token, { method: 'POST', body, url: `http://localhost:3000/api/organizations/${orgId}/settings/database/test` }), params({ orgId }));
}

async function testDb(body: Record<string, unknown>) {
  return testDbAs(orgAdminToken, org.id, body);
}

// ─── INFRA-01: submit never touches active settings; secrets encrypted ─────

test('INFRA-01: PUT settings/database submits a change request (settings untouched, secrets encrypted)', async () => {
  const res = await submitDb({ ...CONFIG_A, configFingerprint: await dbFp(CONFIG_A) } as unknown as Record<string, unknown>);
  assert.equal(res.status, 201);
  const body = await res.json();

  const r = body.request;
  assert.equal(r.status, 'submitted');
  assert.equal(r.kind, 'DATABASE');
  assert.equal(r.requestNo, 1);
  assert.equal(r.config.host, PROBE_HOST);
  assert.equal(r.config.name, CUSTOMER_DB_1);
  assert.equal(r.hasSecret, true);
  assert.equal(r.secretLast4, REAL_PASSWORD.slice(-4));

  // Active settings are NOT touched by a submit.
  const active = await db.organizationSettings.findUnique({ where: { organizationId: org.id } });
  assert.equal(active?.useOwnDb, false);

  // Encrypted at rest, plaintext never serialized.
  const stored = await db.infrastructureChangeRequest.findFirst({ where: { organizationId: org.id, kind: 'DATABASE' } });
  assert.ok(stored?.dbPasswordEncrypted?.startsWith('v1:'));
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('omnisight_password'), 'plaintext password must never appear in the response');
  assert.ok(!raw.includes('dbPasswordEncrypted'), 'encrypted envelope must never be returned');
});

// ─── INFRA-02: one open request per kind ───────────────────────────────────

test('INFRA-02: second pending request for the same kind is rejected with 409', async () => {
  const res = await submitDb({ ...CONFIG_A, configFingerprint: await dbFp(CONFIG_A) } as unknown as Record<string, unknown>);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /already pending/i);
});

// ─── INFRA-03: STORAGE submit ──────────────────────────────────────────────

test('INFRA-03: STORAGE change-request submission (service-role key encrypted at rest, never returned)', async () => {
  // (Phase 2) A submit now genuinely probes the destination server-side, so an
  // unreachable project URL is REJECTED 422 — the request never enters the SA
  // queue untested. (The full storage cutover lifecycle is covered in
  // tests/full-org-cutover.test.ts against an in-process mock Supabase.)
  const api = await import('../src/app/api/organizations/[orgId]/settings/storage/route');
  const res = await api.PUT(
    req(orgAdminToken, {
      method: 'PUT',
      body: { storageDriver: 'supabase', storageUrl: 'https://abcd.supabase.co', storageKey: 'sb_secret_123456', configFingerprint: await storageFp('https://abcd.supabase.co') },
      url: `http://localhost:3000/api/organizations/${org.id}/settings/storage`,
    }),
    params({ orgId: org.id })
  );
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.match(body.error, /connection test .* failed/i);
  assert.ok(!JSON.stringify(body).includes('sb_secret_123456'));

  // No request was created for the failed probe.
  const stored = await db.infrastructureChangeRequest.findFirst({ where: { organizationId: org.id, kind: 'STORAGE' } });
  assert.equal(stored, null);
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
  assert.ok(!JSON.stringify(listBody).includes('omnisight_password'));

  const listResAll = await listApi.GET(req(superAdminToken, { url: 'http://localhost:3000/api/admin/infrastructure-requests' }));
  const allBody = await listResAll.json();
  // (Phase 2) Only the DATABASE request is open now — the STORAGE submit is
  // rejected 422 before creating a request (destination unreachable).
  assert.ok(allBody.data.pending.length >= 1);

  const stored = await db.infrastructureChangeRequest.findFirst({ where: { organizationId: org.id, kind: 'DATABASE' } });
  const detailApi = await import('../src/app/api/admin/infrastructure-requests/[id]/route');
  const detailRes = await detailApi.GET(req(superAdminToken, { url: `http://localhost:3000/api/admin/infrastructure-requests/${stored!.id}` }), params({ id: stored!.id }));
  assert.equal(detailRes.status, 200);
  const detail = await detailRes.json();
  assert.equal(detail.data.request.secretLast4, REAL_PASSWORD.slice(-4));
  assert.ok(!JSON.stringify(detail).includes('dbPasswordEncrypted'));
  assert.ok(!JSON.stringify(detail).includes('omnisight_password'));
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
  assert.equal(active?.dbHost, PROBE_HOST);
  assert.equal(active?.dbName, CUSTOMER_DB_1);
  assert.equal(active?.dbTestStatus, 'success');
  assert.ok(active?.dbPassword?.startsWith('v1:'), 'switched password stored encrypted at rest');
});

// ─── INFRA-06: unreachable target fails closed ─────────────────────────────

test('INFRA-06: an unreachable target fails closed at SUBMIT (settings untouched, nothing queued)', async () => {
  // (Phase 2) The submit endpoint probes the destination server-side BEFORE
  // creating the request, so an unreachable target is rejected 422 and never
  // reaches the SA queue — a stricter fail-closed than the old approve-time
  // 502. Settings remain untouched either way.
  const unreachableConfig = dbConfig(CUSTOMER_DB_1, REAL_PASSWORD, 1);
  const submit = await submitDb({ ...unreachableConfig, configFingerprint: await dbFp(unreachableConfig) } as unknown as Record<string, unknown>);
  assert.equal(submit.status, 422);
  const body = await submit.json();
  assert.match(body.error, /connection test .* failed/i);

  const before = await db.organizationSettings.findUnique({ where: { organizationId: org.id } });

  const after = await db.organizationSettings.findUnique({ where: { organizationId: org.id } });
  assert.deepEqual(
    { host: after?.dbHost, port: after?.dbPort, name: after?.dbName, status: after?.dbTestStatus },
    { host: before?.dbHost, port: before?.dbPort, name: before?.dbName, status: before?.dbTestStatus },
    'fail-closed: active settings must be untouched by a failed submission'
  );
});

// ─── INFRA-07: newer request supersedes an approved-but-failed one ─────────

test('INFRA-07: a newer request supersedes an earlier open request', async () => {
  const submit = await submitDb({ ...CONFIG_B, configFingerprint: await dbFp(CONFIG_B) } as unknown as Record<string, unknown>);
  assert.equal(submit.status, 201); // any earlier OPEN request is superseded
  const submitted = await submit.json();
  const reqId = submitted.request.id;

  // After supersede, no OTHER open request of this kind remains (INFRA-05's
  // flow already activated request #1, so superseding applied to any leftover
  // open state; the invariant is that the newest submission is the only
  // actionable one).
  const earlierOpen = await db.infrastructureChangeRequest.findFirst({
    where: { organizationId: org.id, kind: 'DATABASE', status: { in: ['draft', 'submitted', 'approved'] }, id: { not: reqId } },
  });
  assert.equal(earlierOpen, null, 'no other open request remains after supersede');

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
  // the idempotency "unchanged" path. Port PROBE_PORT + 1 is a closed port on
  // the test host, but the SUBMIT-time probe runs against the REAL destination
  // (which accepts those credentials only on PROBE_PORT) — so submit via the
  // idempotent-safe config and instead rely on dbName CUSTOMER_DB_1 being
  // different from the active CUSTOMER_DB_2.
  const rejectTarget = dbConfig(CUSTOMER_DB_1, REAL_PASSWORD);
  const submit = await submitDb({ ...rejectTarget, configFingerprint: await dbFp(rejectTarget) } as unknown as Record<string, unknown>);
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
  const target = dbConfig(CUSTOMER_DB_1, REAL_PASSWORD);
  const submit = await submitDb({ ...target, configFingerprint: await dbFp(target) } as unknown as Record<string, unknown>);
  assert.equal(submit.status, 201);
  const reqId = (await submit.json()).request.id;

  const cancelApi = await import('../src/app/api/organizations/[orgId]/settings/database/cancel/route');
  const cancelRes = await cancelApi.POST(req(orgAdminToken, { body: { reason: 'Wrong credentials' }, url: `http://localhost:3000/api/organizations/${org.id}/settings/database/cancel` }), params({ orgId: org.id }));
  assert.equal(cancelRes.status, 200);

  const row = await db.infrastructureChangeRequest.findUnique({ where: { id: reqId } });
  assert.equal(row?.status, 'cancelled');
  assert.equal(row?.cancelledAt !== null, true);

  // Resubmit is now allowed.
  const resubmit = await submitDb({ ...target, configFingerprint: await dbFp(target) } as unknown as Record<string, unknown>);
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
  // (Phase 2) 'infrastructure_request_verify_failed' no longer occurs in this
  // suite: submit-time probing rejects unreachable destinations before any
  // approval, so there is no approve-time verification failure to audit here.
  assert.ok(actions.includes('infrastructure_request_reject'));
  assert.ok(actions.includes('infrastructure_request_cancel'));
  const allText = JSON.stringify(audit);
  assert.ok(!allText.includes('omnisight_password'), 'audit log must never contain the plaintext secret');

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
  const res = await submitDb(dbConfig(CUSTOMER_DB_1, REAL_PASSWORD) as unknown as Record<string, unknown>);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.unchanged, true);
  assert.equal(body.request, null);
});

// ─── INFRA-13: test endpoint returns configFingerprint ──────────────────────

test('INFRA-13: database test endpoint returns a configFingerprint on success', async () => {
  const testRes = await testDb({ ...CONFIG_B, dbPassword: REAL_PASSWORD });
  assert.equal(testRes.status, 200);
  const body = await testRes.json();
  assert.equal(body.status, 'success');
  assert.ok(body.configFingerprint, 'test response must include configFingerprint');
  assert.equal(typeof body.configFingerprint, 'string');
  assert.ok(body.configFingerprint.length > 0);
});

// ─── INFRA-14: submit blocks when fingerprint is missing or wrong ────────────

test('INFRA-14: submit rejects when configFingerprint is missing (no test performed)', async () => {
  // (Hardening 1) Submit a config that was NOT tested (no fingerprint) for an
  // org that has NO pending test evidence. The enable path REQUIRES a
  // fingerprint — deterministic 422, and no request may be created for an
  // untested configuration.
  //
  // NB: the RC-1 fix legitimately binds a fresh server-side PENDING test when
  // the client cannot supply the fingerprint (Test → reload → Submit — see
  // TE-02), so this scenario needs its OWN fresh org. Previously it reused the
  // shared org whose CONFIG_B had just been tested by INFRA-13.
  const { orgId, token } = await freshOrg('infra-14-no-fp');
  const beforeCount = await db.infrastructureChangeRequest.count({ where: { organizationId: orgId, kind: 'DATABASE' } });
  const untestedConfig = dbConfig(CUSTOMER_DB_2, REAL_PASSWORD);
  const res = await submitDbAs(token, orgId, { ...untestedConfig, dbPassword: REAL_PASSWORD } as unknown as Record<string, unknown>);
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.match(body.error, /test the destination database connection first/i);
  const afterCount = await db.infrastructureChangeRequest.count({ where: { organizationId: orgId, kind: 'DATABASE' } });
  assert.equal(afterCount, beforeCount, 'no request may be created without a configFingerprint');
});

test('INFRA-14b: submit rejects when configFingerprint does not match the config', async () => {
  // First, get a valid fingerprint for CONFIG_B.
  const testRes = await testDb({ ...CONFIG_B, dbPassword: REAL_PASSWORD });
  const testBody = await testRes.json();
  const validFingerprint = testBody.configFingerprint;

  // Now submit with a WRONG fingerprint (simulates changing config after test).
  const res = await submitDb({
    ...CONFIG_B,
    dbPassword: REAL_PASSWORD,
    dbPort: 9999, // Different port = different fingerprint
    configFingerprint: validFingerprint,
  } as unknown as Record<string, unknown>);
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.match(body.error, /test.*again|changed.*test/i);
});

test('INFRA-14c: submit succeeds when configFingerprint matches the config', async () => {
  // First, get a valid fingerprint for CONFIG_B.
  const testRes = await testDb({ ...CONFIG_B, dbPassword: REAL_PASSWORD });
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
    dbPassword: REAL_PASSWORD,
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
    dbPassword: REAL_PASSWORD,
    configFingerprint: fingerprintA,
  } as unknown as Record<string, unknown>);
  assert.equal(res.status, 422, 'must reject when fingerprint does not match the submitted config');
});

// ═══════════════════════════════════════════════════════════════════════════
// Hardening 1 — client configFingerprint REQUIRED at submission (enable path)
// ═══════════════════════════════════════════════════════════════════════════

test('DB-H1: enable submission WITHOUT configFingerprint is rejected 422, no request created', async () => {
  const { orgId, token } = await freshOrg('infra-h1-no-fp');
  const cfg = dbConfig(CUSTOMER_DB_2, REAL_PASSWORD);
  const res = await submitDbAs(token, orgId, cfg as unknown as Record<string, unknown>);
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.match(body.error, /test the destination database connection first/i);
  const stored = await db.infrastructureChangeRequest.findFirst({ where: { organizationId: orgId, kind: 'DATABASE' } });
  assert.equal(stored, null, 'request must NOT be created');
});

test('DB-H2: enable submission with a TAMPERED fingerprint is rejected 422, no request created', async () => {
  const { orgId, token } = await freshOrg('infra-h2-tampered-fp');
  const cfg = dbConfig(CUSTOMER_DB_2, REAL_PASSWORD);
  const res = await submitDbAs(token, orgId, { ...cfg, configFingerprint: 'deadbeefdeadbeef' } as unknown as Record<string, unknown>);
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.match(body.error, /changed since the last connection test|test the connection again/i);
  const stored = await db.infrastructureChangeRequest.findFirst({ where: { organizationId: orgId, kind: 'DATABASE' } });
  assert.equal(stored, null, 'request must NOT be created');
});

test('DB-H3: correct fingerprint + live DB probe succeeds → request created', async () => {
  const { orgId, token } = await freshOrg('infra-h3-valid');
  const cfg = dbConfig(CUSTOMER_DB_2, REAL_PASSWORD);
  const res = await submitDbAs(token, orgId, { ...cfg, configFingerprint: await dbFp(cfg) } as unknown as Record<string, unknown>);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.request.status, 'submitted');
  assert.equal(body.request.config.name, CUSTOMER_DB_2);
  assert.equal(body.request.lastTestStatus, 'success', 'request is born with fresh probe evidence');
  // The stored fingerprint is the server-recomputed one (matches the client's).
  const storedRow = await db.infrastructureChangeRequest.findUnique({ where: { id: body.request.id } });
  assert.equal(storedRow?.lastTestConfigFingerprint, await dbFp(cfg));
});

test('DB-H4: correct fingerprint + live DB probe FAILS → 422, no request created', async () => {
  const { orgId, token } = await freshOrg('infra-h4-probe-fail');
  const cfg = dbConfig(CUSTOMER_DB_1, REAL_PASSWORD, 1); // port 1: unreachable
  const res = await submitDbAs(token, orgId, { ...cfg, configFingerprint: await dbFp(cfg) } as unknown as Record<string, unknown>);
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.match(body.error, /connection test .* failed/i);
  const stored = await db.infrastructureChangeRequest.findFirst({ where: { organizationId: orgId, kind: 'DATABASE' } });
  assert.equal(stored, null, 'request must NOT be created for a failing destination');
});

test('DB-H5: DISABLE request needs no destination test/fingerprint (existing behavior preserved)', async () => {
  const { orgId, token } = await freshOrg('infra-h5-disable');
  const res = await submitDbAs(token, orgId, { useOwnDb: false, dbHost: '', dbName: '', dbUser: '' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.request.kind, 'DATABASE');
  assert.equal(body.request.status, 'submitted');
  assert.equal(body.request.config.useOwnDb, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// RC-1 — Test Connection BEFORE submit: org-scoped PENDING evidence binding
// ═══════════════════════════════════════════════════════════════════════════
// The transfer gate needs fingerprint-bound, fresh evidence on the REQUEST. A
// test that runs BEFORE the request exists used to be discarded (no open
// request → nothing persisted), leaving the request untested and blocked from
// migration. These prove the pre-submit test is persisted org-scoped and bound
// to the request it authorizes — without ever trusting the client, and without
// bypassing the live submit-time probe or the migration gate.

test('TE-01: a successful pre-submit Test persists org-scoped pending evidence (no request created)', async () => {
  const { orgId, token } = await freshOrg('infra-te1-pending');
  const cfg = dbConfig(CUSTOMER_DB_2, REAL_PASSWORD);
  const res = await testDbAs(token, orgId, { ...cfg, dbPassword: REAL_PASSWORD });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'success');

  const pending = await db.infrastructurePendingTest.findUnique({
    where: { organizationId_kind: { organizationId: orgId, kind: 'DATABASE' } },
  });
  assert.ok(pending, 'pending evidence must be recorded even with no open request');
  assert.equal(pending?.lastTestStatus, 'success');
  assert.equal(pending?.lastTestConfigFingerprint, await dbFp(cfg));
  assert.ok(pending?.lastTestedAt, 'pending evidence carries the test timestamp');
  assert.equal(
    await db.infrastructureChangeRequest.count({ where: { organizationId: orgId, kind: 'DATABASE' } }),
    0,
    'a Test never creates a change request'
  );
});

test('TE-02: submit WITHOUT the client fingerprint binds the fresh matching pending test', async () => {
  const { orgId, token } = await freshOrg('infra-te2-bind');
  const cfg = dbConfig(CUSTOMER_DB_2, REAL_PASSWORD);
  const testRes = await testDbAs(token, orgId, { ...cfg, dbPassword: REAL_PASSWORD });
  assert.equal(testRes.status, 200);
  const tested = await testRes.json();

  const pending = await db.infrastructurePendingTest.findUnique({
    where: { organizationId_kind: { organizationId: orgId, kind: 'DATABASE' } },
  });
  assert.ok(pending?.lastTestedAt);

  // Submit the SAME config with NO configFingerprint — the classic
  // Test → (page reload) → Submit sequence.
  const res = await submitDbAs(token, orgId, { ...cfg, dbPassword: REAL_PASSWORD } as unknown as Record<string, unknown>);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.request.lastTestStatus, 'success', 'request is born with the bound successful evidence');

  const stored = await db.infrastructureChangeRequest.findUnique({ where: { id: body.request.id } });
  assert.equal(stored?.lastTestStatus, 'success');
  assert.equal(stored?.lastTestConfigFingerprint, tested.configFingerprint);
  assert.equal(stored?.lastTestConfigFingerprint, await dbFp(cfg));
  assert.equal(
    new Date(stored!.lastTestedAt!).getTime(),
    new Date(pending!.lastTestedAt!).getTime(),
    'the bound evidence keeps the timestamp of the test that was actually run'
  );
  // Submit never activates; the active settings stay untouched.
  const settings = await db.organizationSettings.findUnique({ where: { organizationId: orgId } });
  assert.notEqual(settings?.useOwnDb, true, 'submit must not switch the active infrastructure');
});

test('TE-03: a changed config (no matching pending test) is rejected 422', async () => {
  const { orgId, token } = await freshOrg('infra-te3-changed');
  const tested = dbConfig(CUSTOMER_DB_2, REAL_PASSWORD);
  await testDbAs(token, orgId, { ...tested, dbPassword: REAL_PASSWORD });

  // Submit a DIFFERENT destination (customer DB 1) without a fingerprint.
  const other = dbConfig(CUSTOMER_DB_1, REAL_PASSWORD);
  const res = await submitDbAs(token, orgId, { ...other, dbPassword: REAL_PASSWORD });
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /test the destination database connection first/i);
  assert.equal(await db.infrastructureChangeRequest.count({ where: { organizationId: orgId, kind: 'DATABASE' } }), 0);
});

test('TE-04: stale pending evidence (older than the freshness window) is not bindable', async () => {
  const { orgId, token } = await freshOrg('infra-te4-stale');
  const cfg = dbConfig(CUSTOMER_DB_2, REAL_PASSWORD);
  await testDbAs(token, orgId, { ...cfg, dbPassword: REAL_PASSWORD });
  await db.infrastructurePendingTest.update({
    where: { organizationId_kind: { organizationId: orgId, kind: 'DATABASE' } },
    data: { lastTestedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
  });
  const res = await submitDbAs(token, orgId, { ...cfg, dbPassword: REAL_PASSWORD });
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /test the destination database connection first/i);
});

test('TE-05: a FAILED test never becomes bindable evidence', async () => {
  const { orgId, token } = await freshOrg('infra-te5-failed');
  const cfg = dbConfig(CUSTOMER_DB_2, REAL_PASSWORD);
  // Reachable host, wrong password → the probe fails but the fingerprint is
  // still computed for the exact config the admin entered.
  const testRes = await testDbAs(token, orgId, { ...cfg, dbPassword: 'definitely-wrong-password' });
  assert.equal(testRes.status, 200);
  assert.equal((await testRes.json()).status, 'failed');
  const pending = await db.infrastructurePendingTest.findUnique({
    where: { organizationId_kind: { organizationId: orgId, kind: 'DATABASE' } },
  });
  assert.equal(pending?.lastTestStatus, 'failed');

  // The correct config, submitted without a fingerprint, must NOT be authorized.
  const res = await submitDbAs(token, orgId, { ...cfg, dbPassword: REAL_PASSWORD });
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /test the destination database connection first/i);
});

test('TE-06: pending evidence is ORG-SCOPED — another org posting the same config is rejected', async () => {
  const a = await freshOrg('infra-te6-org-a');
  const b = await freshOrg('infra-te6-org-b');
  const cfg = dbConfig(CUSTOMER_DB_2, REAL_PASSWORD);
  await testDbAs(a.token, a.orgId, { ...cfg, dbPassword: REAL_PASSWORD });
  const res = await submitDbAs(b.token, b.orgId, { ...cfg, dbPassword: REAL_PASSWORD });
  assert.equal(res.status, 422, "org B must not bind org A's pending test");
  assert.match((await res.json()).error, /test the destination database connection first/i);
});

test('TE-07: an explicit mismatching client fingerprint is never overridden by pending evidence', async () => {
  const { orgId, token } = await freshOrg('infra-te7-mismatch');
  const tested = dbConfig(CUSTOMER_DB_2, REAL_PASSWORD);
  await testDbAs(token, orgId, { ...tested, dbPassword: REAL_PASSWORD }); // pending for CONFIG_B
  const other = dbConfig(CUSTOMER_DB_1, REAL_PASSWORD);
  const res = await submitDbAs(token, orgId, {
    ...other,
    dbPassword: REAL_PASSWORD,
    configFingerprint: await dbFp(tested),
  });
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /changed since the last connection test|test the connection again/i);
});

// ═══════════════════════════════════════════════════════════════════════════
// Hardening 1 — Storage adoption submissions (mock Supabase on loopback)
// ═══════════════════════════════════════════════════════════════════════════

/** In-process mock Supabase Storage: bucket list + scratch write/verify/delete. */
async function startMockSupabase(mode: 'ok' | 'auth403'): Promise<{ url: string; close: () => Promise<void> }> {
  let lastScratch = '';
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost');
    if (mode === 'auth403') {
      res.statusCode = 403;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ statusCode: '403', error: 'Unauthorized', message: 'Invalid Compact JWS', code: 'AccessDenied' }));
      return;
    }
    if (u.pathname === '/storage/v1/bucket' && req.method === 'GET') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([{ id: 'screenshots' }, { id: 'avatars' }]));
      return;
    }
    if (u.pathname.startsWith('/storage/v1/object/screenshots/')) {
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c as Buffer));
        req.on('end', () => {
          lastScratch = Buffer.concat(chunks).toString('utf8');
          res.statusCode = 200;
          res.end('{}');
        });
        return;
      }
      if (req.method === 'GET') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/plain;charset=utf-8');
        res.end(lastScratch);
        return;
      }
      res.statusCode = 200;
      res.end('{}');
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test('STORAGE-H1: storage adoption WITHOUT configFingerprint is rejected 422, no request created', async () => {
  const { orgId, token } = await freshOrg('infra-sh1-no-fp');
  const res = await submitStorageAs(token, orgId, { storageDriver: 'supabase', storageUrl: 'https://sh1.supabase.co', storageKey: 'sb_secret_h1key' });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.match(body.error, /test the destination storage connection first/i);
  const stored = await db.infrastructureChangeRequest.findFirst({ where: { organizationId: orgId, kind: 'STORAGE' } });
  assert.equal(stored, null, 'request must NOT be created');
});

test('STORAGE-H2: storage adoption with a TAMPERED fingerprint is rejected 422, no request created', async () => {
  const { orgId, token } = await freshOrg('infra-sh2-tampered-fp');
  const res = await submitStorageAs(token, orgId, { storageDriver: 'supabase', storageUrl: 'https://sh2.supabase.co', storageKey: 'sb_secret_h2key', configFingerprint: 'deadbeefdeadbeef' });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.match(body.error, /changed since the last connection test|test the connection again/i);
  const stored = await db.infrastructureChangeRequest.findFirst({ where: { organizationId: orgId, kind: 'STORAGE' } });
  assert.equal(stored, null, 'request must NOT be created');
});

test('STORAGE-H3: correct fingerprint + scratch probe succeeds → request created', async () => {
  const mock = await startMockSupabase('ok');
  try {
    const { orgId, token } = await freshOrg('infra-sh3-valid');
    const res = await submitStorageAs(token, orgId, { storageDriver: 'supabase', storageUrl: mock.url, storageKey: 'sb_secret_h3key', configFingerprint: await storageFp(mock.url) });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.request.status, 'submitted');
    assert.equal(body.request.config.driver, 'supabase');
    assert.equal(body.request.lastTestStatus, 'success');
    // The secret key must never appear anywhere in the response.
    assert.ok(!JSON.stringify(body).includes('sb_secret_h3key'));
  } finally {
    await mock.close();
  }
});

test('STORAGE-H4: correct fingerprint + storage probe FAILS → 422, no request created', async () => {
  const mock = await startMockSupabase('auth403');
  try {
    const { orgId, token } = await freshOrg('infra-sh4-probe-fail');
    const res = await submitStorageAs(token, orgId, { storageDriver: 'supabase', storageUrl: mock.url, storageKey: 'sb_secret_h4key', configFingerprint: await storageFp(mock.url) });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.match(body.error, /connection test .* failed/i);
    // The raw auth-failure shape must not leak into the API response.
    assert.ok(!JSON.stringify(body).includes('sb_secret_h4key'));
    const stored = await db.infrastructureChangeRequest.findFirst({ where: { organizationId: orgId, kind: 'STORAGE' } });
    assert.equal(stored, null, 'request must NOT be created for a failing destination');
  } finally {
    await mock.close();
  }
});

test('STORAGE-H5: return-to-LOCAL request needs no destination test/fingerprint (existing behavior preserved)', async () => {
  const { orgId, token } = await freshOrg('infra-sh5-local');
  const res = await submitStorageAs(token, orgId, { storageDriver: 'local' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.request.kind, 'STORAGE');
  assert.equal(body.request.status, 'submitted');
  assert.equal(body.request.config.driver, 'local');
});

// ═══════════════════════════════════════════════════════════════════════════
// Hardening 2 — atomic supersede + create inside submitChangeRequest
// ═══════════════════════════════════════════════════════════════════════════

test('TXN-01: failed request creation ROLLS BACK the supersede (old request stays open)', async () => {
  const { orgId } = await freshOrg('infra-txn-rollback');
  const { submitChangeRequest } = await import('../src/lib/infrastructure');
  const dbModule = await import('../src/lib/db');

  // First submission succeeds → open request #1.
  const first = await submitChangeRequest({
    organizationId: orgId,
    kind: 'DATABASE',
    actor: { id: 'txn-actor', email: 'txn@infra.test' },
    configJson: JSON.stringify({ useOwnDb: true, host: 'h1', port: 5432, name: 'n1', user: 'u1', ssl: false }),
  });
  assert.equal(first.superseded, 0);
  assert.equal(first.request.requestNo, 1);

  // Second submission: force the CREATE inside the transaction to throw AFTER
  // the supersede has run, by wrapping db.$transaction so the tx client's
  // infrastructureChangeRequest.create always rejects.
  const realDb = dbModule.db as unknown as { $transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> };
  const originalTransaction = realDb.$transaction.bind(realDb);
  const boom = new Error('simulated create failure');
  (realDb as unknown as Record<string, unknown>).$transaction = async (fn: (tx: unknown) => Promise<unknown>) =>
    originalTransaction(async (prismaTx) => {
      const tx = prismaTx as { infrastructureChangeRequest: Record<string, unknown> };
      const failingTx = new Proxy(tx, {
        get(target, prop) {
          if (prop !== 'infrastructureChangeRequest') {
            const v = Reflect.get(target, prop);
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
          }
          const delegate = target.infrastructureChangeRequest;
          return new Proxy(delegate, {
            get(t2, p2) {
              if (p2 === 'create') return async () => { throw boom; };
              const v2 = Reflect.get(t2, p2);
              return typeof v2 === 'function' ? (v2 as (...a: unknown[]) => unknown).bind(t2) : v2;
            },
          });
        },
      });
      return fn(failingTx);
    });

  try {
    await assert.rejects(
      submitChangeRequest({
        organizationId: orgId,
        kind: 'DATABASE',
        actor: { id: 'txn-actor', email: 'txn@infra.test' },
        configJson: JSON.stringify({ useOwnDb: true, host: 'h2', port: 5432, name: 'n2', user: 'u2', ssl: false }),
      }),
      (err: Error) => err.message === 'simulated create failure',
      'submitChangeRequest must propagate the create failure',
    );
  } finally {
    (realDb as unknown as Record<string, unknown>).$transaction = originalTransaction;
  }

  // ROLLBACK PROVEN: the old request is still open (not superseded) and no
  // orphan/new request exists.
  const oldRow = await db.infrastructureChangeRequest.findUnique({ where: { id: first.request.id } });
  assert.equal(oldRow?.status, 'submitted', 'old request must NOT be left superseded');
  assert.equal(oldRow?.supersededByRequestNo, null);
  assert.equal(oldRow?.supersededAt, null);
  const total = await db.infrastructureChangeRequest.count({ where: { organizationId: orgId, kind: 'DATABASE' } });
  assert.equal(total, 1, 'no new request row may survive a rolled-back transaction');
});

test('TXN-02: successful replacement supersedes the old request and creates the new one', async () => {
  const { orgId } = await freshOrg('infra-txn-success');
  const { submitChangeRequest } = await import('../src/lib/infrastructure');

  const first = await submitChangeRequest({
    organizationId: orgId,
    kind: 'DATABASE',
    actor: { id: 'txn-actor', email: 'txn@infra.test' },
    configJson: JSON.stringify({ useOwnDb: true, host: 'h1', port: 5432, name: 'n1', user: 'u1', ssl: false }),
  });
  const second = await submitChangeRequest({
    organizationId: orgId,
    kind: 'DATABASE',
    actor: { id: 'txn-actor', email: 'txn@infra.test' },
    configJson: JSON.stringify({ useOwnDb: true, host: 'h2', port: 5432, name: 'n2', user: 'u2', ssl: false }),
  });

  assert.equal(second.superseded, 1);
  assert.equal(second.request.requestNo, 2);

  const oldRow = await db.infrastructureChangeRequest.findUnique({ where: { id: first.request.id } });
  assert.equal(oldRow?.status, 'superseded');
  assert.equal(oldRow?.supersededByRequestNo, 2);
  assert.ok(oldRow?.supersededAt);

  const newRow = await db.infrastructureChangeRequest.findUnique({ where: { id: second.request.id } });
  assert.equal(newRow?.status, 'submitted');
});
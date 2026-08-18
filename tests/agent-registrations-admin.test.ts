/**
 * Admin-side legacy agent registration endpoints (list / approve / reject).
 *
 * Regression contract (Agent Approvals hardening):
 *   - Approve/reject are rate-limited per IP — the same class of admin write
 *     as the zero-touch claim approve/reject (new agentRegistrationWrite key).
 *   - Approve enforces ONE ACTIVE DEVICE PER EMPLOYEE via the SHARED rule from
 *     src/lib/agent/activation.ts (DEVICE_ELIGIBLE_STATUSES +
 *     ActiveDeviceConflictError): a conflict returns 409 ACTIVE_DEVICE_EXISTS
 *     with ZERO mutation — registration stays pending, no device is created,
 *     no notification is written, the employee row is untouched.
 *   - The approval notification carries entityType/entityId linking the
 *     created device (parity with the zero-touch claims approve notification).
 *   - The list endpoint clamps pageSize (1..100), supports org-scoped
 *     server-side search (?q=), complete server-side summary counts
 *     (?summary=true), and returns an EMPTY page for org-less super-admins
 *     (never business data).
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_regs_admin).
 * Run: npx tsx --test tests/agent-registrations-admin.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation (must be set BEFORE any app module import) ──────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_regs_admin';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-regsadmin-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

before(() => {
  if (process.env.REGS_ADMIN_TEST_MIGRATED_DB !== '1') {
    execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
    execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
      env: { ...process.env, DATABASE_URL: TEST_DB_URL },
      stdio: 'pipe',
    });
  }
});

type DbModule = typeof import('../src/lib/db');
let db: DbModule['db'];
let signJWT: (payload: { userId: string; email: string; role: string; organizationId?: string }) => Promise<string>;

type ListApi = typeof import('../src/app/api/agent-registrations/route');
type ApproveApi = typeof import('../src/app/api/agent-registrations/[id]/approve/route');
type RejectApi = typeof import('../src/app/api/agent-registrations/[id]/reject/route');

let listApi: ListApi;
let approveApi: ApproveApi;
let rejectApi: RejectApi;

let org: { id: string };
let org2: { id: string };

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  const [lApi, aApi, rApi] = await Promise.all([
    import('../src/app/api/agent-registrations/route'),
    import('../src/app/api/agent-registrations/[id]/approve/route'),
    import('../src/app/api/agent-registrations/[id]/reject/route'),
  ]);
  listApi = lApi;
  approveApi = aApi;
  rejectApi = rApi;

  org = await db.organization.create({ data: { name: 'Legacy Reg Org', slug: 'regs-admin-org' } });
  org2 = await db.organization.create({ data: { name: 'Other Org', slug: 'regs-admin-other' } });
});

after(async () => {
  await db.$disconnect();
  if (process.env.REGS_ADMIN_TEST_MIGRATED_DB !== '1') {
    try {
      execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
        env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
        stdio: 'pipe',
      });
    } catch {
      /* best-effort cleanup */
    }
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function req(token: string | null, opts: { method?: string; body?: unknown; url?: string; ip?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (opts.ip) headers['x-forwarded-for'] = opts.ip;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(opts.url || 'http://localhost:3000/api/test', {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

function tokenFor(role: string, userId: string, organizationId: string = org.id) {
  return signJWT({ userId, email: `${userId}@${organizationId.slice(-6)}.local`, role, organizationId });
}

async function seedEmployee(code: string, organizationId: string = org.id) {
  return db.employee.create({
    data: {
      employeeId: code,
      firstName: code.split('-')[0],
      lastName: 'Test',
      email: `${code.toLowerCase()}@test.local`,
      organizationId,
      status: 'active',
      agentApproved: false,
    },
  });
}

async function seedRegistration(employeeId: string, organizationId: string = org.id, status = 'pending') {
  return db.agentRegistration.create({
    data: {
      employeeId,
      organizationId,
      status,
      hostname: 'PC-LEGACY',
      deviceName: 'Legacy PC',
      operatingSystem: 'Windows 11',
      osVersion: '24H2',
      processor: 'x64',
      memory: '16GB',
      agentVersion: '1.2.0',
    },
  });
}

// ─── LRA-1: approve (success path + notification metadata) ──────────────────

test('LRA-1: legacy approve creates the device and links the notification (entityType/entityId)', async () => {
  const emp = await seedEmployee('LRA1-EMP');
  const reg = await seedRegistration(emp.id);
  const admin = await tokenFor('admin', 'u-lra1-admin');

  const res = await approveApi.POST(
    req(admin, { method: 'POST', ip: '198.51.100.71' }),
    { params: Promise.resolve({ id: reg.id }) }
  );
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  assert.equal(res.status, 200, JSON.stringify(body));

  const stored = await db.agentRegistration.findUnique({ where: { id: reg.id } });
  assert.equal(stored!.status, 'approved');

  const device = await db.device.findFirst({ where: { employeeId: emp.id, hostname: 'PC-LEGACY' } });
  assert.ok(device, 'a Device row must be created from the registration system info');
  assert.equal(device!.name, 'Legacy PC', 'the proposed deviceName wins over the fallback');

  const employee = await db.employee.findUnique({ where: { id: emp.id } });
  assert.equal(employee!.agentApproved, true, 'the employee becomes agent-approved');

  const notification = await db.notification.findFirst({
    where: { organizationId: org.id, title: 'Agent Registration Approved' },
  });
  assert.ok(notification, 'an approval notification must be created');
  assert.equal(notification!.entityType, 'device', 'notification must link the created device');
  assert.equal(notification!.entityId, device!.id, 'notification entityId must be the created device id');
});

// ─── LRA-2: one-active-device conflict (409 + zero mutation) ────────────────

test('LRA-2: legacy approve with an existing active device → 409 ACTIVE_DEVICE_EXISTS with ZERO mutation', async () => {
  const emp = await seedEmployee('LRA2-EMP');
  const reg = await seedRegistration(emp.id);
  // The employee already holds the single active-device slot.
  await db.device.create({
    data: {
      name: 'Existing PC',
      hostname: 'PC-EXISTING',
      operatingSystem: 'Windows 11',
      status: 'online',
      organizationId: org.id,
      employeeId: emp.id,
    },
  });
  const notificationsBefore = await db.notification.count({ where: { organizationId: org.id } });
  const admin = await tokenFor('admin', 'u-lra2-admin');

  const res = await approveApi.POST(
    req(admin, { method: 'POST', ip: '198.51.100.72' }),
    { params: Promise.resolve({ id: reg.id }) }
  );
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  assert.equal(res.status, 409, JSON.stringify(body));
  assert.equal(body.error, 'ACTIVE_DEVICE_EXISTS');

  // Zero mutation: registration untouched, no device, no notification,
  // employee not agent-approved.
  const stored = await db.agentRegistration.findUnique({ where: { id: reg.id } });
  assert.equal(stored!.status, 'pending', 'the registration must stay pending');
  assert.equal(
    await db.device.count({ where: { employeeId: emp.id } }),
    1,
    'no second device may be created'
  );
  assert.equal(
    await db.notification.count({ where: { organizationId: org.id } }),
    notificationsBefore,
    'no notification may be written'
  );
  const employee = await db.employee.findUnique({ where: { id: emp.id } });
  assert.equal(employee!.agentApproved, false, 'the employee row must be untouched');
});

// ─── LRA-3: rate limiting (approve + reject share the write bucket) ─────────

test('LRA-3: legacy approve/reject are rate-limited per IP (31st write in the window → 429)', async () => {
  const emp = await seedEmployee('LRA3-EMP');
  const reg = await seedRegistration(emp.id);
  const admin = await tokenFor('admin', 'u-lra3-admin');
  const ip = '203.0.113.99';

  const results: number[] = [];
  for (let i = 0; i < 31; i++) {
    const res = await approveApi.POST(
      req(admin, { method: 'POST', ip }),
      { params: Promise.resolve({ id: reg.id }) }
    );
    results.push(res.status);
  }
  assert.equal(results[0], 200, 'the first approve must succeed');
  assert.equal(results[30], 429, 'the 31st admin write in the window must be rate-limited');
  assert.ok(
    results.slice(1, 30).every((s) => s === 400),
    'already-approved attempts keep their existing 400 semantics (the limiter only adds 429 at the cap)'
  );
});

// ─── LRA-4: reject (success path) ───────────────────────────────────────────

test('LRA-4: legacy reject persists the reason and notifies', async () => {
  const emp = await seedEmployee('LRA4-EMP');
  const reg = await seedRegistration(emp.id);
  const admin = await tokenFor('admin', 'u-lra4-admin');

  const res = await rejectApi.POST(
    req(admin, { method: 'POST', body: { reason: 'Unrecognized device' }, ip: '198.51.100.74' }),
    { params: Promise.resolve({ id: reg.id }) }
  );
  assert.equal(res.status, 200);

  const stored = await db.agentRegistration.findUnique({ where: { id: reg.id } });
  assert.equal(stored!.status, 'rejected');
  assert.equal(stored!.rejectionReason, 'Unrecognized device');
  const notification = await db.notification.findFirst({
    where: { organizationId: org.id, title: 'Agent Registration Rejected' },
  });
  assert.ok(notification, 'a rejection notification must be created');
});

// ─── LRA-5: list — pageSize clamp, search, summary ──────────────────────────

test('LRA-5: registrations list clamps pageSize, searches server-side and reports complete summary counts', async () => {
  const admin = await tokenFor('admin', 'u-lra5-admin');

  // pageSize / page clamps (malformed input cannot force an unbounded query).
  const big = await listApi.GET(req(admin, { url: 'http://localhost:3000/api/agent-registrations?pageSize=999' }));
  assert.equal((await big.json()).pageSize, 100);
  const tiny = await listApi.GET(req(admin, { url: 'http://localhost:3000/api/agent-registrations?pageSize=0' }));
  assert.equal((await tiny.json()).pageSize, 1);
  const bad = await listApi.GET(req(admin, { url: 'http://localhost:3000/api/agent-registrations?page=abc&pageSize=banana' }));
  const badBody = await bad.json() as { page: number; pageSize: number };
  assert.equal(badBody.page, 1);
  assert.equal(badBody.pageSize, 10);

  // Seed a deterministic spread of statuses.
  const e1 = await seedEmployee('LRA5A-EMP');
  const e2 = await seedEmployee('LRA5B-EMP');
  const e3 = await seedEmployee('LRA5C-EMP');
  const e4 = await seedEmployee('LRA5D-EMP');
  await seedRegistration(e1.id);
  await seedRegistration(e2.id);
  await seedRegistration(e3.id, org.id, 'approved');
  await seedRegistration(e4.id, org.id, 'rejected');

  // Summary must equal the DB ground truth per status.
  const res = await listApi.GET(req(admin, { url: 'http://localhost:3000/api/agent-registrations?summary=true' }));
  const body = await res.json() as { summary: Record<string, number> };
  const ground = await db.agentRegistration.groupBy({
    by: ['status'],
    where: { organizationId: org.id },
    _count: { _all: true },
  });
  for (const row of ground) {
    assert.equal(body.summary[row.status], row._count._all, `summary.${row.status} must match the real queue`);
  }
  assert.equal(
    body.summary.total,
    body.summary.pending + body.summary.approved + body.summary.rejected + body.summary.expired,
    'summary.total must be the sum of the four registration statuses'
  );

  // Server-side search: hostname and employee id.
  const byHost = await listApi.GET(req(admin, { url: `http://localhost:3000/api/agent-registrations?q=${encodeURIComponent('PC-LEGACY')}` }));
  const hb = await byHost.json() as { data: Array<{ id: string }> };
  assert.ok(hb.data.length >= 4, 'hostname search must match the seeded rows');
  const byEmp = await listApi.GET(req(admin, { url: `http://localhost:3000/api/agent-registrations?q=${encodeURIComponent('LRA5A-EMP')}` }));
  const eb = await byEmp.json() as { data: Array<{ id: string; employee: { employeeId: string } }> };
  assert.equal(eb.data.length, 1, 'employee-id search must narrow to the exact row');
  assert.equal(eb.data[0].employee.employeeId, 'LRA5A-EMP');
  const none = await listApi.GET(req(admin, { url: 'http://localhost:3000/api/agent-registrations?q=zzz-nothing-matches' }));
  assert.equal((await none.json()).data.length, 0);
});

// ─── LRA-6: org-less super-admin (empty page) ───────────────────────────────

test('LRA-6: org-less super-admin receives an empty registrations page — never business data', async () => {
  const saToken = await signJWT({ userId: 'u-sa-global', email: 'sa@global.local', role: 'super_admin' });
  const res = await listApi.GET(req(saToken, { url: 'http://localhost:3000/api/agent-registrations?summary=true' }));
  const body = await res.json() as { data: unknown[]; total: number; summary: Record<string, number> };
  assert.equal(body.data.length, 0);
  assert.equal(body.total, 0);
  assert.equal(body.summary.pending, 0);
  assert.equal(body.summary.total, 0);
});

// ─── LRA-7: cross-org isolation (approve never action a foreign registration) ─

test('LRA-7: approving a registration from ANOTHER organization is indistinguishable from missing (404)', async () => {
  const emp2 = await seedEmployee('LRA7-EMP', org2.id);
  const reg2 = await seedRegistration(emp2.id, org2.id);
  const admin = await tokenFor('admin', 'u-lra7-admin', org.id);

  const res = await approveApi.POST(
    req(admin, { method: 'POST', ip: '198.51.100.77' }),
    { params: Promise.resolve({ id: reg2.id }) }
  );
  assert.equal(res.status, 404, 'a foreign registration id must 404, never leak existence');
  const stored = await db.agentRegistration.findUnique({ where: { id: reg2.id } });
  assert.equal(stored!.status, 'pending', 'the foreign registration must be untouched');
});
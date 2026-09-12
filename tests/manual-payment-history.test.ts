/**
 * Manual Payment History — Regression Tests
 *
 * Proves the append-only manual payment contract:
 *   - SA records a payment → NEW Invoice row (existing records untouched)
 *   - multiple payments remain independently accessible
 *   - non-SA / unauthenticated denied
 *   - cross-org payment cannot be read/edited via another org's request
 *   - validation: zero/negative/NaN amount, bad date, bad status/method
 *   - edit modifies only the targeted record (audit verified)
 *
 * Run: npx tsx --test tests/manual-payment-history.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation ──────────────────────────────────────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_pay_history';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-pay-history-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@pay-history.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!PayHistory2026x';
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
let signJWT: (payload: { userId: string; email: string; role: string; organizationId?: string; activeOrganizationId?: string }) => Promise<string>;
let bootstrapSuperAdmin: (env?: Record<string, string | undefined>) => Promise<{
  created: boolean;
  alreadyExisted: boolean;
  user: { id: string; email: string; role: string; organizationId: string | null };
}>;

type InvoicesApi = typeof import('../src/app/api/admin/invoices/route');
type InvoiceApi = typeof import('../src/app/api/admin/invoices/[invoiceId]/route');
let invoicesApi: InvoicesApi;
let invoiceApi: InvoiceApi;

let saUserId: string;
let saToken: string;
let org: { id: string; name: string };
let planId: string;
let subscriptionId: string;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  const sa = await import('../src/lib/super-admin');
  bootstrapSuperAdmin = sa.bootstrapSuperAdmin;
  invoicesApi = await import('../src/app/api/admin/invoices/route');
  invoiceApi = await import('../src/app/api/admin/invoices/[invoiceId]/route');

  const result = await bootstrapSuperAdmin();
  saUserId = result.user.id;
  saToken = await signJWT({ userId: saUserId, email: process.env.SUPER_ADMIN_EMAIL!, role: 'super_admin' });

  org = await db.organization.create({
    data: { name: 'Payment History Org', slug: 'pay-history' },
  });
  const plan = await db.plan.create({
    data: { name: 'Enterprise', priceMonthly: 50000, currency: 'BDT', maxDevices: 100, retentionDays: 90, features: [] },
  });
  planId = plan.id;
  const sub = await db.subscription.create({
    data: { organizationId: org.id, planId, status: 'PENDING', startDate: new Date() },
  });
  subscriptionId = sub.id;
  await db.organization.update({ where: { id: org.id }, data: { subscriptionId } });
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
  } catch { /* best-effort cleanup */ }
});

function req(url: string, token?: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const CREATE = 'http://localhost:3000/api/admin/invoices';

// ─── PAY-01: SA records a payment → NEW record ──────────────────────────

test('PAY-01: SA records a manual payment (new Invoice row, audited)', async () => {
  const res = await invoicesApi.POST(
    req(CREATE, saToken, 'POST', {
      organizationId: org.id, amount: 50000, currency: 'BDT',
      paymentMethod: 'Bank_Transfer', transactionId: 'INV-2026-001',
      status: 'PAID', notes: 'Initial payment',
    })
  );
  const body = await res.json();
  assert.equal(res.status, 201, `create failed: ${JSON.stringify(body)}`);
  assert.match(body.invoice.invoiceNumber, /^INV-\d{4}-\d{4}$/);
  assert.equal(body.invoice.status, 'PAID');
  assert.ok(body.invoice.paidAt, 'PAID record has a payment date');

  const audits = await db.auditLog.findMany({ where: { resource: 'invoice', resourceId: body.invoice.id } });
  assert.ok(audits.length >= 1, 'audit recorded');
});

// ─── PAY-02: three payments → three independent records ─────────────────

test('PAY-02: three payments create three independent history records', async () => {
  for (const ref of ['INV-2027-002', 'INV-2028-003']) {
    const res = await invoicesApi.POST(
      req(CREATE, saToken, 'POST', {
        organizationId: org.id, amount: 50000, currency: 'BDT',
        paymentMethod: 'Bank_Transfer', transactionId: ref, status: 'PAID',
      })
    );
    assert.equal(res.status, 201);
  }

  const rows = await db.invoice.findMany({ where: { organizationId: org.id }, orderBy: { createdAt: 'asc' } });
  assert.equal(rows.length, 3, 'all three payments exist');
  assert.ok(new Set(rows.map((r) => r.transactionId)).size === 3, 'each record has its own reference');
  assert.ok(new Set(rows.map((r) => r.id)).size === 3, 'distinct rows — nothing overwritten');
});

// ─── PAY-03: existing payments unchanged after new additions ────────────

test('PAY-03: adding a payment never modifies previous records', async () => {
  const before = await db.invoice.findMany({ where: { organizationId: org.id }, orderBy: { createdAt: 'asc' } });
  const snapshot = before.map((r) => ({ id: r.id, amount: r.amount, paidAt: r.paidAt, transactionId: r.transactionId }));

  await invoicesApi.POST(
    req(CREATE, saToken, 'POST', { organizationId: org.id, amount: 25000, status: 'PENDING' })
  );

  const after = await db.invoice.findMany({ where: { organizationId: org.id }, orderBy: { createdAt: 'asc' } });
  assert.equal(after.length, snapshot.length + 1, 'one new record appended');
  for (const snap of snapshot) {
    const now = after.find((r) => r.id === snap.id);
    assert.ok(now, 'record still present');
    assert.equal(now!.amount, snap.amount, 'amount unchanged');
    assert.equal(now!.transactionId, snap.transactionId, 'reference unchanged');
    assert.equal(now!.paidAt?.getTime(), snap.paidAt?.getTime(), 'date unchanged');
  }
});

// ─── PAY-04: scoped listing ─────────────────────────────────────────────

test('PAY-04: ?organizationId returns only that organization\u2019s payments', async () => {
  const res = await invoicesApi.GET(req(`${CREATE}?organizationId=${org.id}`, saToken));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.invoices.length, 4);
  assert.ok(body.invoices.every((i: { organization: { id: string } }) => i.organization.id === org.id));
});

// ─── PAY-05: validation ─────────────────────────────────────────────────

test('PAY-05: zero, negative and non-numeric amounts rejected', async () => {
  for (const amount of [0, -100, 'abc', '']) {
    const res = await invoicesApi.POST(
      req(CREATE, saToken, 'POST', { organizationId: org.id, amount })
    );
    assert.equal(res.status, 422, `amount ${JSON.stringify(amount)} must be rejected`);
  }
});

test('PAY-06: invalid date, status and method rejected', async () => {
  const badDate = await invoicesApi.POST(
    req(CREATE, saToken, 'POST', { organizationId: org.id, amount: 100, paidAt: 'not-a-date' })
  );
  assert.equal(badDate.status, 422);

  const badStatus = await invoicesApi.POST(
    req(CREATE, saToken, 'POST', { organizationId: org.id, amount: 100, status: 'REFUNDED' })
  );
  assert.equal(badStatus.status, 422, 'non-enum status rejected');

  const badMethod = await invoicesApi.POST(
    req(CREATE, saToken, 'POST', { organizationId: org.id, amount: 100, paymentMethod: 'Stripe' })
  );
  assert.equal(badMethod.status, 422, 'non-enum method rejected');
});

test('PAY-07: invalid organization rejected', async () => {
  const res = await invoicesApi.POST(
    req(CREATE, saToken, 'POST', { organizationId: 'does-not-exist', amount: 100 })
  );
  assert.equal(res.status, 404);
});

// ─── PAY-08: RBAC ───────────────────────────────────────────────────────

test('PAY-08: org_admin cannot create payments', async () => {
  const { hashPassword } = await import('../src/lib/auth');
  const orgAdmin = await db.appUser.create({
    data: { email: 'admin@pay-history.local', name: 'Org Admin', password: await hashPassword('x'), role: 'user' },
  });
  await db.organizationMembership.create({
    data: { userId: orgAdmin.id, organizationId: org.id, role: 'org_admin', status: 'ACTIVE' },
  });
  const orgToken = await signJWT({
    userId: orgAdmin.id, email: orgAdmin.email, role: 'org_admin',
    organizationId: org.id, activeOrganizationId: org.id,
  });
  const res = await invoicesApi.POST(
    req(CREATE, orgToken, 'POST', { organizationId: org.id, amount: 100 })
  );
  assert.ok(res.status === 401 || res.status === 403, `org_admin create denied, got ${res.status}`);
});

test('PAY-09: unauthenticated create denied', async () => {
  const res = await invoicesApi.POST(req(CREATE, undefined, 'POST', { organizationId: org.id, amount: 100 }));
  assert.equal(res.status, 401);
});

// ─── PAY-10: cross-org protection ───────────────────────────────────────

test('PAY-10: cross-org payment read/edit denied and ownership resolved server-side', async () => {
  // Payment belongs to org A; attacker targets it with an org-B-scoped request
  const rows = await db.invoice.findMany({ where: { organizationId: org.id }, take: 1 });
  const target = rows[0];

  const orgB = await db.organization.create({ data: { name: 'Other Org', slug: 'other-org' } });
  const { hashPassword } = await import('../src/lib/auth');
  const attacker = await db.appUser.create({
    data: { email: 'attacker@pay-history.local', name: 'Attacker', password: await hashPassword('x'), role: 'user' },
  });
  await db.organizationMembership.create({
    data: { userId: attacker.id, organizationId: orgB.id, role: 'org_admin', status: 'ACTIVE' },
  });
  const atkToken = await signJWT({
    userId: attacker.id, email: attacker.email, role: 'org_admin',
    organizationId: orgB.id, activeOrganizationId: orgB.id,
  });

  // GET: non-SA cannot read the payment
  const getRes = await invoiceApi.GET(
    req(`http://localhost:3000/api/admin/invoices/${target.id}`, atkToken),
    { params: Promise.resolve({ invoiceId: target.id }) }
  );
  assert.ok(getRes.status === 401 || getRes.status === 403, `cross-org read denied, got ${getRes.status}`);

  // PATCH: non-SA cannot modify it
  const patchRes = await invoiceApi.PATCH(
    req(`http://localhost:3000/api/admin/invoices/${target.id}`, atkToken, 'PATCH', { status: 'CANCELLED' }),
    { params: Promise.resolve({ invoiceId: target.id }) }
  );
  assert.ok(patchRes.status === 401 || patchRes.status === 403, `cross-org edit denied, got ${patchRes.status}`);

  // Record unchanged
  const row = await db.invoice.findUnique({ where: { id: target.id } });
  assert.equal(row?.status, target.status, 'payment record untouched');
});

// ─── PAY-11: edit modifies only the targeted record ─────────────────────

test('PAY-11: editing a payment changes only that record (audit verified)', async () => {
  const rows = await db.invoice.findMany({ where: { organizationId: org.id }, orderBy: { createdAt: 'asc' } });
  const target = rows[0];
  const others = rows.slice(1).map((r) => ({ id: r.id, notes: r.notes, status: r.status }));

  const res = await invoiceApi.PATCH(
    req(`http://localhost:3000/api/admin/invoices/${target.id}`, saToken, 'PATCH', {
      notes: 'corrected reference', status: 'PAID',
    }),
    { params: Promise.resolve({ invoiceId: target.id }) }
  );
  assert.equal(res.status, 200);

  const updated = await db.invoice.findUnique({ where: { id: target.id } });
  assert.equal(updated?.notes, 'corrected reference');

  for (const o of others) {
    const row = await db.invoice.findUnique({ where: { id: o.id } });
    assert.equal(row?.notes, o.notes, 'other payment records untouched');
    assert.equal(row?.status, o.status, 'other payment statuses untouched');
  }

  const audits = await db.auditLog.findMany({ where: { resource: 'invoice', resourceId: target.id } });
  assert.ok(audits.some((a) => a.action === 'update'), 'update audit recorded');
});

// ─── PAY-12: no destructive delete endpoint exists ──────────────────────

test('PAY-12: no DELETE handler on the admin invoice API (history preserved)', async () => {
  const mod = await import('../src/app/api/admin/invoices/[invoiceId]/route');
  assert.equal(typeof (mod as Record<string, unknown>).DELETE, 'undefined', 'no DELETE handler');
  const listMod = await import('../src/app/api/admin/invoices/route');
  assert.equal(typeof (listMod as Record<string, unknown>).DELETE, 'undefined', 'no DELETE handler on collection');
});

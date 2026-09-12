/**
 * Phase 2 §36: control-plane lifecycle tests (throwaway DB).
 *
 * Proves:
 *  LC-01  Package create → 201 + audited
 *  LC-02  Package update + deactivate → 200
 *  LC-03  Package delete while referenced → 409 (archival, not destruction)
 *  LC-04  Manual sales: create org (PRIVATE+pending) → subscription → invoice
 *          → Super Admin activates the PENDING subscription → ACTIVE/active +
 *          audited (invoice stays PENDING — manual ledger, no verify action)
 *  LC-05  Subscription cancel → CANCELLED + pointer cleared + audited
 *  LC-06  License issue → revoke lifecycle + audited, key never in audit
 *  LC-07  Invalid subscription transitions are guarded (no verify/reject
 *          workflow): CANCELLED → ACTIVE rejected, double-activate rejected
 *  LC-08  Pending org locked out of tenant APIs; activation restores access
 *  LC-09  SA metrics endpoint returns control-plane aggregates only
 *  LC-10  Service Type at creation: MANAGED / CUSTOMER_DB / PRIVATE each
 *          persist verbatim to Organization.deploymentMode (no silent fallback)
 *  LC-11  Invalid deploymentMode is rejected; omitted uses the MANAGED default
 *
 * Run: npx tsx --test tests/control-plane-lifecycle.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_cp_lifecycle';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-cp-lifecycle-0123456789abcdef';
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
let signJWT: (payload: {
  userId: string;
  email: string;
  role: string;
  organizationId?: string;
  activeOrganizationId?: string;
  sessionId?: string;
}) => Promise<string>;

let saId: string;
let packageId: string;
let orgId: string;
let subId: string;
let invoiceId: string;

function req(url: string, token: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  const sa = await db.appUser.create({
    data: { email: 'sa@lifecycle.local', name: 'SA', role: 'super_admin', isActive: true },
  });
  saId = sa.id;
  // NOTE: no self-hosted plan is created — the LicenseKey / self-hosted
  // architecture was removed (Self-Hosted / PRIVATE is not a V1 service model).
  // A normal V1 plan is created for the subscription life-cycle tests below.
  await db.plan.create({
    data: { name: 'Lifecycle', priceMonthly: 5000, maxDevices: 50, retentionDays: 365, features: [] },
  });
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
  } catch { /* best-effort */ }
});

async function saToken(): Promise<string> {
  return signJWT({ userId: saId, email: 'sa@lifecycle.local', role: 'super_admin' });
}

// LC-01
test('LC-01: package create is audited', async () => {
  const { POST } = await import('../src/app/api/super-admin/packages/route');
  const res = await POST(
    req('http://localhost:3000/api/super-admin/packages', await saToken(), 'POST', {
      name: 'LC-Pro', description: 'test', priceMonthly: 100, currency: 'BDT', maxDevices: 10, retentionDays: 90, features: ['screenshots'],
    }),
  );
  assert.equal(res.status, 201);
  const body = await res.json();
  packageId = body.id ?? body.data?.id;
  assert.ok(packageId, 'package id returned');
  const audit = await db.auditLog.findFirst({ where: { resource: 'package', resourceId: packageId } });
  assert.ok(audit, 'package creation audited');
});

// LC-02
test('LC-02: package update and deactivate', async () => {
  const mod = await import('../src/app/api/super-admin/packages/[id]/route');
  const res = await mod.PATCH(
    req(`http://localhost:3000/api/super-admin/packages/${packageId}`, await saToken(), 'PATCH', { priceMonthly: 150, isActive: false }),
    { params: Promise.resolve({ id: packageId }) },
  );
  assert.equal(res.status, 200);
  const row = await db.plan.findUnique({ where: { id: packageId }, select: { priceMonthly: true, isActive: true } });
  assert.equal(row?.priceMonthly, 150);
  assert.equal(row?.isActive, false);
  await db.plan.update({ where: { id: packageId }, data: { isActive: true } });
});

// LC-03
test('LC-03: referenced package cannot be deleted', async () => {
  // Reference it via an org + subscription first (LC-04 creates these; create minimal refs here).
  const org = await db.organization.create({ data: { name: 'LC Ref', slug: 'lc-ref' } });
  const sub = await db.subscription.create({ data: { organizationId: org.id, planId: packageId, status: 'PENDING' } });
  const mod = await import('../src/app/api/super-admin/packages/[id]/route');
  const res = await mod.DELETE(
    req(`http://localhost:3000/api/super-admin/packages/${packageId}`, await saToken(), 'DELETE'),
    { params: Promise.resolve({ id: packageId }) },
  );
  assert.equal(res.status, 409);
  await db.subscription.delete({ where: { id: sub.id } });
  await db.organization.delete({ where: { id: org.id } });
});

// LC-04: full manual sales flow
test('LC-04: manual sales end-to-end (org → sub → invoice → SA activates)', async () => {
  const token = await saToken();
  const create = await import('../src/app/api/admin/organizations/create/route');
  const cRes = await create.POST(
    req('http://localhost:3000/api/admin/organizations/create', token, 'POST', {
      name: 'LC Customer',
      slug: 'lc-customer',
      adminEmail: 'admin@lc-customer.local',
      planName: 'LC-Pro',
      deploymentMode: 'PRIVATE',
      status: 'pending',
    }),
  );
  assert.equal(cRes.status, 201);
  const created = await cRes.json();
  // apiSuccess returns the raw body (no envelope).
  orgId = created.organization.id;
  assert.equal(created.organization.deploymentMode, 'PRIVATE');
  assert.equal(created.organization.status, 'pending');
  assert.ok(created.tempPassword, 'temp password returned once');

  const orgRow = await db.organization.findUnique({ where: { id: orgId }, select: { subscriptionId: true } });
  assert.ok(orgRow?.subscriptionId, 'pending subscription created');
  subId = orgRow.subscriptionId!;
  const inv = await db.invoice.findFirst({ where: { subscriptionId: subId }, select: { id: true } });
  assert.ok(inv, 'pending invoice created');
  invoiceId = inv!.id;

  // Manual-sales activation: the single Super Admin confirms payment and
  // activates the PENDING subscription directly (no separate payment-
  // verification workflow, no invoice verify/reject action).
  const activate = await import('../src/app/api/super-admin/subscriptions/[id]/route');
  const aRes = await activate.PATCH(
    req(`http://localhost:3000/api/super-admin/subscriptions/${subId}`, token, 'PATCH', { action: 'activate' }),
    { params: Promise.resolve({ id: subId }) },
  );
  assert.equal(aRes.status, 200);

  const after = await db.organization.findUnique({
    where: { id: orgId },
    select: { status: true, subscriptionId: true, subscription: { select: { status: true } } },
  });
  assert.equal(after?.status, 'active', 'activation makes the org active');
  assert.equal(after?.subscription?.status, 'ACTIVE');

  // The manual-payment invoice stays PENDING — it is a ledger record, not a
  // verification gate. No payment method/reference fields are set by the SA.
  const invRow = await db.invoice.findUnique({ where: { id: invoiceId }, select: { status: true, paymentMethod: true } });
  assert.equal(invRow?.status, 'PENDING', 'invoice ledger record stays PENDING');
  assert.equal(invRow?.paymentMethod, null, 'no payment fields written by activation');

  const audits = await db.auditLog.findMany({
    where: { resource: 'subscription', resourceId: subId, description: { contains: 'activated' } },
  });
  assert.ok(audits.length >= 1, 'subscription activation audited');
});

// LC-05
test('LC-05: subscription cancel clears pointer and is audited', async () => {
  const mod = await import('../src/app/api/super-admin/subscriptions/[id]/route');
  const res = await mod.PATCH(
    req(`http://localhost:3000/api/super-admin/subscriptions/${subId}`, await saToken(), 'PATCH', { action: 'cancel', notes: 'customer request' }),
    { params: Promise.resolve({ id: subId }) },
  );
  assert.equal(res.status, 200);
  const sub = await db.subscription.findUnique({ where: { id: subId }, select: { status: true } });
  assert.equal(sub?.status, 'CANCELLED');
  const org = await db.organization.findUnique({ where: { id: orgId }, select: { subscriptionId: true } });
  assert.equal(org?.subscriptionId, null, 'org pointer cleared');
  const audit = await db.auditLog.findFirst({ where: { resource: 'subscription', resourceId: subId, description: { contains: 'cancelled' } } });
  assert.ok(audit, 'cancellation audited');
});

// LC-06
// The LicenseKey / self-hosted license architecture was REMOVED (Self-Hosted /
// PRIVATE is not a V1 service model; activation is subscription-based). This
// test is the regression guard that no active license API came back.
test('LC-06: obsolete LicenseKey / self-hosted license API is gone', async () => {
  const missing = /Cannot find module|ERR_MODULE_NOT_FOUND|Failed to resolve/i;
  await assert.rejects(() => import('../src/app/api/admin/licenses/route'), missing, 'license issuance API must not exist');
  await assert.rejects(
    () => import('../src/app/api/admin/licenses/[licenseId]/revoke/route'),
    missing,
    'license revoke API must not exist',
  );
  await assert.rejects(
    () => import('../src/app/api/license/validate/route'),
    missing,
    'public license validation endpoint must not exist',
  );
});

// LC-07
test('LC-07: invalid subscription transitions are guarded (no verify/reject workflow)', async () => {
  const token = await saToken();
  const mod = await import('../src/app/api/super-admin/subscriptions/[id]/route');

  // (a) A CANCELLED subscription (LC-05) can never jump to ACTIVE.
  const cancelledRes = await mod.PATCH(
    req(`http://localhost:3000/api/super-admin/subscriptions/${subId}`, token, 'PATCH', { action: 'activate' }),
    { params: Promise.resolve({ id: subId }) },
  );
  assert.equal(cancelledRes.status, 422, 'CANCELLED → ACTIVE must be rejected');
  const stillCancelled = await db.subscription.findUnique({ where: { id: subId }, select: { status: true } });
  assert.equal(stillCancelled?.status, 'CANCELLED');

  // (b) Double activation of an ACTIVE subscription is rejected (409).
  const sub = await db.subscription.create({ data: { organizationId: orgId, planId: packageId, status: 'PENDING' } });
  const first = await mod.PATCH(
    req(`http://localhost:3000/api/super-admin/subscriptions/${sub.id}`, token, 'PATCH', { action: 'activate' }),
    { params: Promise.resolve({ id: sub.id }) },
  );
  assert.equal(first.status, 200);
  const second = await mod.PATCH(
    req(`http://localhost:3000/api/super-admin/subscriptions/${sub.id}`, token, 'PATCH', { action: 'activate' }),
    { params: Promise.resolve({ id: sub.id }) },
  );
  assert.equal(second.status, 409, 'ACTIVE → ACTIVE must be rejected');
  const audit = await db.auditLog.findFirst({
    where: { resource: 'subscription', resourceId: sub.id, description: { contains: 'activated' } },
  });
  assert.ok(audit, 'activation audited');

  // Clean up the throwaway subscription.
  await db.organization.update({ where: { id: orgId }, data: { subscriptionId: null } });
  await db.subscription.delete({ where: { id: sub.id } });
});

// LC-08
test('LC-08: pending org is locked out; activation restores access', async () => {
  const pOrg = await db.organization.create({ data: { name: 'LC Pending', slug: 'lc-pending', status: 'pending' } });
  const u = await db.appUser.create({ data: { email: 'u@lc-pending.local', name: 'U', role: 'user', isActive: true } });
  await db.organizationMembership.create({ data: { userId: u.id, organizationId: pOrg.id, role: 'org_admin', status: 'ACTIVE' } });
  const token = await signJWT({ userId: u.id, email: 'u@lc-pending.local', role: 'org_admin', organizationId: pOrg.id, activeOrganizationId: pOrg.id });

  const members = await import('../src/app/api/organizations/[orgId]/members/route');
  const blocked = await members.GET(
    req(`http://localhost:3000/api/organizations/${pOrg.id}/members`, token),
    { params: Promise.resolve({ orgId: pOrg.id }) },
  );
  assert.equal(blocked.status, 403, 'pending org locked out');

  const patch = await import('../src/app/api/super-admin/organizations/[orgId]/route');
  const aRes = await patch.PATCH(
    req(`http://localhost:3000/api/super-admin/organizations/${pOrg.id}`, await saToken(), 'PATCH', { status: 'active' }),
    { params: Promise.resolve({ orgId: pOrg.id }) },
  );
  assert.equal(aRes.status, 200);

  const allowed = await members.GET(
    req(`http://localhost:3000/api/organizations/${pOrg.id}/members`, token),
    { params: Promise.resolve({ orgId: pOrg.id }) },
  );
  assert.equal(allowed.status, 200, 'activation restores access');
});

// LC-09
test('LC-09: SA metrics are control-plane aggregates only', async () => {
  const { GET } = await import('../src/app/api/super-admin/metrics/route');
  const res = await GET(req('http://localhost:3000/api/super-admin/metrics', await saToken()));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(typeof body.organizations.total === 'number');
  assert.ok(typeof body.organizations.managed === 'number');
  assert.ok(typeof body.subscriptions.active === 'number');
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('secret-app'), 'no operational content in metrics');
});

// LC-10: Service Type selection at creation — all three modes persist verbatim.
test('LC-10: service type persists verbatim (MANAGED / CUSTOMER_DB / PRIVATE, no silent fallback)', async () => {
  const create = await import('../src/app/api/admin/organizations/create/route');
  const token = await saToken();

  const cases = [
    { slug: 'lc-st-managed', mode: 'MANAGED' },
    { slug: 'lc-st-customer', mode: 'CUSTOMER_DB' },
    { slug: 'lc-st-private', mode: 'PRIVATE' },
  ] as const;

  for (const c of cases) {
    const res = await create.POST(
      req('http://localhost:3000/api/admin/organizations/create', token, 'POST', {
        name: `ST ${c.mode}`,
        slug: c.slug,
        adminEmail: `admin@${c.slug}.local`,
        deploymentMode: c.mode,
      }),
    );
    assert.equal(res.status, 201, `${c.mode} creation must succeed`);
    const body = await res.json();
    assert.equal(body.organization.deploymentMode, c.mode, `${c.mode} must persist verbatim (no silent fallback to MANAGED)`);
    const row = await db.organization.findUnique({
      where: { id: body.organization.id },
      select: { deploymentMode: true },
    });
    assert.equal(row?.deploymentMode, c.mode, `DB row for ${c.mode} must match`);
  }
});

// LC-11: invalid deploymentMode rejected; omitted value uses the MANAGED default.
test('LC-11: invalid deploymentMode is rejected; omitted defaults to MANAGED', async () => {
  const create = await import('../src/app/api/admin/organizations/create/route');
  const token = await saToken();

  for (const bad of ['INVALID', 'SUPER_ADMIN', 'CUSTOM_DB', '', 1234, null]) {
    const res = await create.POST(
      req('http://localhost:3000/api/admin/organizations/create', token, 'POST', {
        name: `ST Bad ${String(bad)}`,
        slug: `lc-st-bad-${String(bad).toLowerCase().replace(/[^a-z0-9]/g, '') || 'empty'}`,
        adminEmail: `bad-${Date.now()}-${String(bad).length}@lc.local`,
        deploymentMode: bad,
      }),
    );
    assert.equal(res.status, 422, `deploymentMode ${JSON.stringify(bad)} must be rejected`);
  }

  // Omitted field → the explicitly defined legacy default MANAGED.
  const res = await create.POST(
    req('http://localhost:3000/api/admin/organizations/create', token, 'POST', {
      name: 'ST Default',
      slug: 'lc-st-default',
      adminEmail: 'admin@lc-st-default.local',
    }),
  );
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.organization.deploymentMode, 'MANAGED', 'omitted deploymentMode uses the MANAGED default');
});

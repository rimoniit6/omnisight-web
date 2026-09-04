/**
 * Phase 2 §36: control-plane lifecycle tests (throwaway DB).
 *
 * Proves:
 *  LC-01  Package create → 201 + audited
 *  LC-02  Package update + deactivate → 200
 *  LC-03  Package delete while referenced → 409 (archival, not destruction)
 *  LC-04  Manual sales: create org (PRIVATE+pending) → subscription → invoice
 *          verify with payment details → PAID/ACTIVE/active + audits
 *  LC-05  Subscription cancel → CANCELLED + pointer cleared + audited
 *  LC-06  License issue → revoke lifecycle + audited, key never in audit
 *  LC-07  Invoice verify/reject produce audit events
 *  LC-08  Pending org locked out of tenant APIs; activation restores access
 *  LC-09  SA metrics endpoint returns control-plane aggregates only
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
  // Seed a self-hosted plan for license tests.
  await db.plan.create({
    data: { name: 'Enterprise_SelfHosted', priceMonthly: 0, isSelfHosted: true, maxDevices: -1, retentionDays: 0, features: [] },
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
test('LC-04: manual sales end-to-end (org → sub → verify → active)', async () => {
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

  const verify = await import('../src/app/api/admin/invoices/[invoiceId]/[action]/route');
  const vRes = await verify.PUT(
    req(`http://localhost:3000/api/admin/invoices/${invoiceId}/verify`, token, 'PUT', {
      paymentMethod: 'Bank_Transfer',
      transactionId: 'TXN-LC-001',
    }),
    { params: Promise.resolve({ invoiceId, action: 'verify' }) },
  );
  assert.equal(vRes.status, 200);

  const after = await db.organization.findUnique({
    where: { id: orgId },
    select: { status: true, subscriptionId: true, subscription: { select: { status: true } } },
  });
  assert.equal(after?.status, 'active', 'verify activates the org');
  assert.equal(after?.subscription?.status, 'ACTIVE');
  const paidInv = await db.invoice.findUnique({ where: { id: invoiceId }, select: { status: true, paymentMethod: true, transactionId: true } });
  assert.equal(paidInv?.status, 'PAID');
  assert.equal(paidInv?.paymentMethod, 'Bank_Transfer');
  assert.equal(paidInv?.transactionId, 'TXN-LC-001');

  const audits = await db.auditLog.findMany({ where: { resource: 'invoice', resourceId: invoiceId } });
  assert.ok(audits.length >= 1, 'payment verification audited');
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
test('LC-06: license issue and revoke without leaking the key into audit', async () => {
  const token = await saToken();
  const lic = await import('../src/app/api/admin/licenses/route');
  const plan = await db.plan.findFirst({ where: { name: 'Enterprise_SelfHosted' }, select: { id: true } });
  const gRes = await lic.POST(
    req('http://localhost:3000/api/admin/licenses', token, 'POST', { organizationId: orgId, planId: plan!.id }),
  );
  assert.equal(gRes.status, 201);
  const gBody = await gRes.json();
  const licenseId = gBody.license?.id ?? gBody.data?.id ?? gBody.id;
  assert.ok(licenseId, 'license id returned');

  const revoke = await import('../src/app/api/admin/licenses/[licenseId]/revoke/route');
  const rRes = await revoke.PUT(
    req(`http://localhost:3000/api/admin/licenses/${licenseId}/revoke`, token, 'PUT', { reason: 'test rotation' }),
    { params: Promise.resolve({ licenseId }) },
  );
  assert.equal(rRes.status, 200);
  const row = await db.licenseKey.findUnique({ where: { id: licenseId }, select: { isRevoked: true, key: true } });
  assert.equal(row?.isRevoked, true);
  const audits = await db.auditLog.findMany({ where: { resource: 'license_key', resourceId: licenseId } });
  assert.ok(audits.length >= 2, 'issue + revoke audited');
  for (const a of audits) {
    assert.ok(!a.description.includes(row!.key), 'license key must never appear in audit text');
  }
});

// LC-07
test('LC-07: invoice reject is audited and keeps subscription pending', async () => {
  const token = await saToken();
  const sub = await db.subscription.create({ data: { organizationId: orgId, planId: packageId, status: 'PENDING' } });
  const inv = await db.invoice.create({
    data: { subscriptionId: sub.id, organizationId: orgId, invoiceNumber: `INV-2099-${Date.now()}`, amount: 100, currency: 'BDT', status: 'PENDING', dueDate: new Date() },
  });
  const act = await import('../src/app/api/admin/invoices/[invoiceId]/[action]/route');
  const res = await act.PUT(
    req(`http://localhost:3000/api/admin/invoices/${inv.id}/reject`, token, 'PUT', { reason: 'unverifiable reference' }),
    { params: Promise.resolve({ invoiceId: inv.id, action: 'reject' }) },
  );
  assert.equal(res.status, 200);
  const audit = await db.auditLog.findFirst({ where: { resource: 'invoice', resourceId: inv.id, description: { contains: 'rejected' } } });
  assert.ok(audit, 'rejection audited');
  const kept = await db.subscription.findUnique({ where: { id: sub.id }, select: { status: true } });
  assert.equal(kept?.status, 'PENDING');
  await db.invoice.delete({ where: { id: inv.id } });
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

  const patch = await import('../src/app/api/super-admin/organizations/[id]/route');
  const aRes = await patch.PATCH(
    req(`http://localhost:3000/api/super-admin/organizations/${pOrg.id}`, await saToken(), 'PATCH', { status: 'active' }),
    { params: Promise.resolve({ id: pOrg.id }) },
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

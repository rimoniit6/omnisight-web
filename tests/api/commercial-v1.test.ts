/**
 * V1 Device Entitlement + Purchase Request — integration tests.
 *
 * Entitlement (§9 of the V1 commercial spec):
 *   E-1  Managed below limit → allowed
 *   E-2  Managed at limit → rejected
 *   E-3  Managed above limit → rejected
 *   E-4  Customer Database with any device count → allowed (never capped)
 *   E-5  No subscription → legacy plan fallback still enforced for MANAGED
 *   E-6  Legacy PRIVATE mode is never capped
 *
 * Purchase Request public flow (§6):
 *   R-1  Public submit (no auth) → 201 with server-calculated price snapshot
 *   R-2  Client-submitted price is IGNORED (recalculated server-side)
 *   R-3  Managed requires deviceQuantity ≥ 1 → 422 otherwise
 *   R-4  PRIVATE deployment mode is rejected → 422
 *   R-5  Inactive plan → 422
 *   R-6  Super Admin queue lifecycle: review → verify_payment → activate
 *        creates org + subscription carrying the snapshot terms (billing
 *        period, device quantity, price snapshot) through the EXISTING
 *        activation lifecycle.
 *   R-7  Invalid transitions rejected (409)
 *
 * Run: npx tsx --test tests/api/commercial-v1.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import type { PrismaClient } from '@prisma/client';
import { req } from '../helpers/request';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_commercial';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-commercial-01234';

let db: PrismaClient;
let signJWT: (payload: { userId: string; email: string; role: string; organizationId?: string }) => Promise<string>;
let purchaseApi: typeof import('../../src/app/api/purchase-requests/route');
let queueApi: typeof import('../../src/app/api/super-admin/purchase-requests/[id]/route');
let checkDeviceEntitlement: typeof import('../../src/lib/device-entitlement').checkDeviceEntitlement;

let managedPlanId: string;
let orgManaged: string;
let orgCustomerDb: string;
let orgPrivate: string;
let saToken: string;

before(async () => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', { env: { ...process.env, DATABASE_URL: TEST_DB_URL }, stdio: 'pipe' });

  db = (await import('../../src/lib/db')).db;
  signJWT = (await import('../../src/lib/auth')).signJWT;
  purchaseApi = await import('../../src/app/api/purchase-requests/route');
  queueApi = (await import('../../src/app/api/super-admin/purchase-requests/[id]/route'));
  ({ checkDeviceEntitlement } = await import('../../src/lib/device-entitlement'));

  // Super Admin (org-less, platform role).
  const sa = await db.appUser.create({
    data: { email: 'sa@commercial.test', name: 'SA', role: 'super_admin', isActive: true },
  });
  saToken = await signJWT({ userId: sa.id, email: sa.email, role: 'super_admin' });

  const plan = await db.plan.create({
    data: { name: 'Commercial', priceMonthly: 5000, maxDevices: 10, retentionDays: 90, isActive: true, features: [] },
  });
  managedPlanId = plan.id;
  await db.planPricing.create({
    data: { planId: plan.id, deploymentMode: 'MANAGED', billingPeriod: 'MONTHLY', basePrice: 5000, includedDevices: 5, additionalDevicePrice: 200 },
  });
  await db.planPricing.create({
    data: { planId: plan.id, deploymentMode: 'CUSTOMER_DB', billingPeriod: 'MONTHLY', basePrice: 8000 },
  });

  const managed = await db.organization.create({ data: { name: 'Managed Co', slug: 'managed-co', status: 'active', deploymentMode: 'MANAGED' } });
  orgManaged = managed.id;
  const customerDb = await db.organization.create({ data: { name: 'DB Co', slug: 'db-co', status: 'active', deploymentMode: 'CUSTOMER_DB' } });
  orgCustomerDb = customerDb.id;
  const priv = await db.organization.create({ data: { name: 'Legacy Private', slug: 'legacy-private', status: 'active', deploymentMode: 'PRIVATE' } });
  orgPrivate = priv.id;
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  } catch {
    /* best effort */
  }
});

async function setActiveDevices(orgId: string, count: number) {
  // The authoritative count source is Organization.activeDeviceCount (kept in
  // sync by the existing lease-guarded job — mirrored here directly).
  await db.organization.update({ where: { id: orgId }, data: { activeDeviceCount: count } });
}

test('E-1: Managed below limit → allowed', async () => {
  await setActiveDevices(orgManaged, 4);
  const e = await checkDeviceEntitlement(orgManaged);
  assert.equal(e.mode, 'MANAGED');
  assert.equal(e.allowed, true);
  assert.equal(e.limit, 5);
});

test('E-2: Managed at limit → rejected', async () => {
  await setActiveDevices(orgManaged, 5);
  const e = await checkDeviceEntitlement(orgManaged);
  assert.equal(e.allowed, false);
  assert.equal(e.currentCount, 5);
  assert.equal(e.limit, 5);
  assert.match(e.reason ?? '', /limit|entitlement/i);
});

test('E-3: Managed above limit → rejected', async () => {
  await setActiveDevices(orgManaged, 9);
  const e = await checkDeviceEntitlement(orgManaged);
  assert.equal(e.allowed, false);
});

test('E-4: Customer Database with any device count → allowed (never capped)', async () => {
  await setActiveDevices(orgCustomerDb, 500);
  const e = await checkDeviceEntitlement(orgCustomerDb);
  assert.equal(e.mode, 'CUSTOMER_DB');
  assert.equal(e.allowed, true, 'CUSTOMER_DB must NEVER be capped');
  assert.equal(e.limit, null);
  assert.equal(e.currentCount, 500);
});

test('E-5: MANAGED without subscription falls back to Free-tier defaults (fail closed)', async () => {
  // Existing contract: getPlanLimits() with NO subscription returns the Free
  // defaults (maxDevices 5) — never unlimited. Enforcement must keep that.
  const org2 = await db.organization.create({ data: { name: 'NoSub Co', slug: 'nosub-co', status: 'active', deploymentMode: 'MANAGED' } });
  await db.organization.update({ where: { id: org2.id }, data: { activeDeviceCount: 5 } });
  const e = await checkDeviceEntitlement(org2.id);
  assert.equal(e.allowed, false, 'legacy Free-tier cap must still apply for MANAGED with no subscription');
  assert.equal(e.limit, 5);
});

test('E-7: MANAGED with ACTIVE subscription (no snapshot) falls back to plan.maxDevices', async () => {
  const org3 = await db.organization.create({ data: { name: 'PlanCap Co', slug: 'plancap-co', status: 'active', deploymentMode: 'MANAGED' } });
  await db.subscription.create({
    data: { organizationId: org3.id, planId: managedPlanId, status: 'ACTIVE', endDate: new Date(Date.now() + 30 * 86_400_000) },
  });
  await db.organization.update({ where: { id: org3.id }, data: { activeDeviceCount: 10 } });
  const e = await checkDeviceEntitlement(org3.id);
  assert.equal(e.allowed, false, 'plan.maxDevices cap must apply when no snapshot exists');
  assert.equal(e.limit, 10);
});

test('E-8: MANAGED with subscription snapshot uses the purchased deviceQuantity', async () => {
  // Snapshot (8) overrides plan.maxDevices (10) — purchased terms win.
  const org4 = await db.organization.create({ data: { name: 'Snap Co', slug: 'snap-co', status: 'active', deploymentMode: 'MANAGED' } });
  await db.subscription.create({
    data: {
      organizationId: org4.id, planId: managedPlanId, status: 'ACTIVE',
      endDate: new Date(Date.now() + 30 * 86_400_000),
      billingPeriod: 'MONTHLY', deviceQuantity: 8, deploymentModeSnapshot: 'MANAGED',
    },
  });
  await db.organization.update({ where: { id: org4.id }, data: { activeDeviceCount: 8 } });
  const e = await checkDeviceEntitlement(org4.id);
  assert.equal(e.allowed, false, 'snapshot quantity (8) is the entitlement, not plan.maxDevices (10)');
  assert.equal(e.limit, 8);
});

test('E-6: Legacy PRIVATE mode is never capped', async () => {
  await setActiveDevices(orgPrivate, 9999);
  const e = await checkDeviceEntitlement(orgPrivate);
  assert.equal(e.mode, 'PRIVATE');
  assert.equal(e.allowed, true);
  assert.equal(e.limit, null);
});

test('R-1: public purchase request submit → 201 with server-calculated price', async () => {
  const res = await purchaseApi.POST(
    req(null, {
      method: 'POST',
      body: {
        companyName: 'Acme', contactName: 'Jane', contactEmail: 'jane@acme.test',
        planId: managedPlanId, deploymentMode: 'MANAGED', billingPeriod: 'MONTHLY', deviceQuantity: 8,
      },
    })
  );
  assert.equal(res.status, 201);
  const body = await res.json() as { requestNumber: string; price: { final: number } };
  assert.match(body.requestNumber, /^PR-\d{4}-\d{4}$/);
  // 5000 base + (8-5 extra × 200) = 5600
  assert.equal(body.price.final, 5600);
});

test('R-2: client-submitted price/offer fields are ignored (server recalculates)', async () => {
  const res = await purchaseApi.POST(
    req(null, {
      method: 'POST',
      body: {
        companyName: 'Evil Co', contactName: 'E', contactEmail: 'evil@acme.test',
        planId: managedPlanId, deploymentMode: 'MANAGED', billingPeriod: 'MONTHLY', deviceQuantity: 5,
        finalPrice: 0, discountAmount: 999999, basePrice: 1,
      },
    })
  );
  assert.equal(res.status, 201);
  const body = await res.json() as { price: { final: number } };
  assert.equal(body.price.final, 5000, 'authoritative price must come from the server resolver');
  const row = await db.purchaseRequest.findFirst({ where: { contactEmail: 'evil@acme.test' } });
  assert.equal(row?.basePrice, 5000);
  assert.equal(row?.finalPrice, 5000);
});

test('R-3: Managed without deviceQuantity → 422', async () => {
  const res = await purchaseApi.POST(
    req(null, {
      method: 'POST',
      body: {
        companyName: 'NoQty', contactName: 'N', contactEmail: 'noqty@acme.test',
        planId: managedPlanId, deploymentMode: 'MANAGED', billingPeriod: 'MONTHLY',
      },
    })
  );
  assert.equal(res.status, 422);
});

test('R-4: PRIVATE deployment mode → 422 (never a V1 commercial mode)', async () => {
  const res = await purchaseApi.POST(
    req(null, {
      method: 'POST',
      body: {
        companyName: 'Private Co', contactName: 'P', contactEmail: 'priv@acme.test',
        planId: managedPlanId, deploymentMode: 'PRIVATE', billingPeriod: 'MONTHLY',
      },
    })
  );
  assert.equal(res.status, 422);
});

test('R-5: inactive plan → 422', async () => {
  const dead = await db.plan.create({ data: { name: 'DeadPlan', priceMonthly: 1, maxDevices: 1, isActive: false, features: [] } });
  const res = await purchaseApi.POST(
    req(null, {
      method: 'POST',
      body: {
        companyName: 'Dead Co', contactName: 'D', contactEmail: 'dead@acme.test',
        planId: dead.id, deploymentMode: 'CUSTOMER_DB', billingPeriod: 'MONTHLY',
      },
    })
  );
  assert.equal(res.status, 422);
});

test('R-6: SA queue lifecycle review → verify_payment → activate (existing lifecycle)', async () => {
  // Submit a CUSTOMER_DB request (unlimited — deviceQuantity stays null).
  const created = await purchaseApi.POST(
    req(null, {
      method: 'POST',
      body: {
        companyName: 'Flow Co', contactName: 'Fiona', contactEmail: 'fiona@flow.test',
        planId: managedPlanId, deploymentMode: 'CUSTOMER_DB', billingPeriod: 'MONTHLY',
      },
    })
  );
  const { id } = await created.json() as { id: string };

  // review
  const r1 = await queueApi.PATCH(req(saToken, { method: 'PATCH', body: { action: 'review' } }), { params: Promise.resolve({ id }) });
  assert.equal(r1.status, 200, `review failed: ${await r1.text()}`);
  assert.equal((await db.purchaseRequest.findUnique({ where: { id } }))?.status, 'REVIEWED');

  // verify_payment — full manual payment record (method/amount/ref/date/note)
  const r2 = await queueApi.PATCH(req(saToken, {
    method: 'PATCH',
    body: {
      action: 'verify_payment',
      paymentMethod: 'bKash',
      paymentAmount: 8000,
      paymentReference: 'BKASH-123',
      paymentDate: '2026-09-10',
      paymentNote: 'Full payment received via bKash',
    },
  }), { params: Promise.resolve({ id }) });
  assert.equal(r2.status, 200, `verify_payment failed: ${await r2.text()}`);
  const verified = await db.purchaseRequest.findUnique({ where: { id } });
  assert.equal(verified?.status, 'PAYMENT_VERIFIED');
  assert.equal(verified?.paymentReference, 'BKASH-123');
  // Payment record persists on the request permanently (Scenario B).
  assert.equal(verified?.paymentMethod, 'bKash');
  assert.equal(verified?.paymentAmount, 8000);
  assert.ok(verified?.paymentDate);
  assert.equal(verified?.paymentNote, 'Full payment received via bKash');
  // The requested price snapshot is NOT modified by payment verification.
  assert.equal(verified?.finalPrice, 8000);

  // activate — creates org + PENDING subscription with snapshot, then activates
  const r3 = await queueApi.PATCH(req(saToken, { method: 'PATCH', body: { action: 'activate' } }), { params: Promise.resolve({ id }) });
  assert.equal(r3.status, 200, `activate failed: ${await r3.text()}`);
  const activated = await db.purchaseRequest.findUnique({ where: { id } });
  assert.equal(activated?.status, 'ACTIVATED');
  assert.ok(activated?.activatedSubscriptionId);

  // Subscription carries the snapshot terms and is ACTIVE.
  const sub = await db.subscription.findUnique({ where: { id: activated!.activatedSubscriptionId! } });
  assert.equal(sub?.status, 'ACTIVE');
  assert.equal(sub?.billingPeriod, 'MONTHLY');
  assert.equal(sub?.deploymentModeSnapshot, 'CUSTOMER_DB');
  assert.equal(sub?.deviceQuantity, null, 'CUSTOMER_DB must store null quantity (unlimited)');
  assert.ok(sub?.priceSnapshot);

  // Invoice recorded the manual payment (existing invoice system) — the
  // verified method/amount/date carry through to the invoice.
  const invoice = await db.invoice.findFirst({ where: { subscriptionId: sub!.id } });
  assert.equal(invoice?.status, 'PAID');
  assert.equal(invoice?.transactionId, 'BKASH-123');
  assert.equal(invoice?.amount, 8000);
  assert.equal(invoice?.paymentMethod, 'bKash');
  assert.ok(invoice?.paidAt);

  // Organization provisioned with the requested mode.
  const org = await db.organization.findFirst({ where: { email: 'fiona@flow.test' } });
  assert.ok(org);
  assert.equal(org?.deploymentMode, 'CUSTOMER_DB');

  // Second activation attempt must fail (terminal state).
  const r4 = await queueApi.PATCH(req(saToken, { method: 'PATCH', body: { action: 'activate' } }), { params: Promise.resolve({ id }) });
  assert.equal(r4.status, 409);
});

test('R-7: invalid lifecycle transition → 409', async () => {
  const created = await purchaseApi.POST(
    req(null, {
      method: 'POST',
      body: {
        companyName: 'Skip Co', contactName: 'S', contactEmail: 'skip@flow.test',
        planId: managedPlanId, deploymentMode: 'MANAGED', billingPeriod: 'MONTHLY', deviceQuantity: 6,
      },
    })
  );
  const { id } = await created.json() as { id: string };
  // verify_payment before review → 409
  const res = await queueApi.PATCH(req(saToken, { method: 'PATCH', body: { action: 'verify_payment' } }), { params: Promise.resolve({ id }) });
  assert.equal(res.status, 409);
});

test('R-8: payment record persists permanently; partial payment never mutates the price snapshot (Scenario B/E)', async () => {
  // Managed request — 5000 base + 1 extra device (200) = 5200 requested.
  const created = await purchaseApi.POST(
    req(null, {
      method: 'POST',
      body: {
        companyName: 'Ledger Co', contactName: 'Lena', contactEmail: 'lena@ledger.test',
        planId: managedPlanId, deploymentMode: 'MANAGED', billingPeriod: 'MONTHLY', deviceQuantity: 6,
      },
    })
  );
  const { id } = await created.json() as { id: string };
  const createdRow = await db.purchaseRequest.findUnique({ where: { id } });
  assert.equal(createdRow?.finalPrice, 5200, 'requested snapshot: 5000 base + 1 × 200 extra device');

  await queueApi.PATCH(req(saToken, { method: 'PATCH', body: { action: 'review' } }), { params: Promise.resolve({ id }) });
  // Partial payment — the customer underpaid; the verified amount is what
  // was actually received, the requested snapshot stays 5200.
  const r2 = await queueApi.PATCH(req(saToken, {
    method: 'PATCH',
    body: { action: 'verify_payment', paymentMethod: 'Nagad', paymentAmount: 4000, paymentReference: 'NGD-9', paymentNote: 'partial' },
  }), { params: Promise.resolve({ id }) });
  assert.equal(r2.status, 200, `verify_payment failed: ${await r2.text()}`);

  // Activation uses the verified amount on the invoice.
  const r3 = await queueApi.PATCH(req(saToken, { method: 'PATCH', body: { action: 'activate' } }), { params: Promise.resolve({ id }) });
  assert.equal(r3.status, 200, `activate failed: ${await r3.text()}`);

  const activated = await db.purchaseRequest.findUnique({ where: { id } });
  // Historical price snapshot remains immutable after activation.
  assert.equal(activated?.finalPrice, 5200);
  // Payment history is permanent: method/amount/reference/note survive activation.
  assert.equal(activated?.paymentMethod, 'Nagad');
  assert.equal(activated?.paymentAmount, 4000);
  assert.equal(activated?.paymentReference, 'NGD-9');
  assert.equal(activated?.paymentNote, 'partial');

  const invoice = await db.invoice.findFirst({ where: { subscriptionId: activated!.activatedSubscriptionId! } });
  assert.equal(invoice?.amount, 4000, 'invoice records the amount actually received');
  assert.equal(invoice?.paymentMethod, 'Nagad');
});

/**
 * Subscription lifecycle — API integration.
 *
 * Exercises the manual-subscribe flow against a throwaway DB:
 *   S-1  GET a fresh org -> no subscription, not on trial
 *   S-2  POST subscribe (org admin) -> 201, PENDING sub + invoice created
 *   S-3  GET now returns the pending subscription with its plan
 *   S-4  POST again -> 409 ALREADY_ACTIVE (no double subscription)
 *   S-5  A non-admin member is forbidden from subscribing
 *
 * Tokens are stateless JWTs (signJWT); membership rows provide the DB-backed
 * role for resolveActorDbRole + requireActiveSessionOrg.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_subscription).
 * Run: npx tsx --test tests/api/subscription.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import type { PrismaClient } from '@prisma/client';
import { req } from '../helpers/request';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_subscription';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-subscription-0123456';

let db: PrismaClient;
let signJWT: (payload: { userId: string; email: string; role: string; organizationId?: string }) => Promise<string>;
let subApi: typeof import('../../src/app/api/organizations/[orgId]/subscription/route');

let orgId: string;
let planId: string;
let adminToken: string;
let viewerAdminToken: string;

before(async () => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', { env: { ...process.env, DATABASE_URL: TEST_DB_URL }, stdio: 'pipe' });

  db = (await import('../../src/lib/db')).db;
  signJWT = (await import('../../src/lib/auth')).signJWT;
  subApi = await import('../../src/app/api/organizations/[orgId]/subscription/route');

  const org = await db.organization.create({ data: { name: 'Sub Corp', slug: 'sub-corp', status: 'active' } });
  orgId = org.id;

  const plan = await db.plan.create({
    data: { name: 'Pro', priceMonthly: 499, maxDevices: 50, retentionDays: 365, isActive: true, features: [] },
  });
  planId = plan.id;

  // Org admin with an ACTIVE membership (supplies the DB role for the POST).
  const adminUser = await db.appUser.create({
    data: { email: 'org-admin@corp.local', name: 'Org Admin', role: 'admin' },
  });
  await db.organizationMembership.create({
    data: { userId: adminUser.id, organizationId: orgId, role: 'org_admin', status: 'ACTIVE' },
  });
  adminToken = await signJWT({ userId: adminUser.id, email: adminUser.email, role: 'admin', organizationId: orgId });

  // A viewer member (no org_admin role) for the forbidden test.
  const viewer = await db.appUser.create({
    data: { email: 'viewer@corp.local', name: 'Viewer', role: 'viewer' },
  });
  await db.organizationMembership.create({
    data: { userId: viewer.id, organizationId: orgId, role: 'viewer', status: 'ACTIVE' },
  });
  viewerAdminToken = await signJWT({ userId: viewer.id, email: viewer.email, role: 'viewer', organizationId: orgId });
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  } catch {
    /* best effort */
  }
});

function getReq(token: string) {
  return subApi.GET(req(token, { method: 'GET' }), { params: Promise.resolve({ orgId }) });
}

test('S-1: a fresh org has no subscription and is not on trial', async () => {
  const res = await getReq(adminToken);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { subscription: unknown; isOnTrial: boolean };
  assert.equal(body.subscription, null);
  assert.equal(body.isOnTrial, false);
});

test('S-2: org admin subscribes -> 201 with PENDING sub + invoice', async () => {
  const res = await subApi.POST(
    req(adminToken, { method: 'POST', body: { planId, billingPeriod: 'MONTHLY' } }),
    { params: Promise.resolve({ orgId }) }
  );
  assert.equal(res.status, 201, `expected 201, got ${res.status}`);
  const body = (await res.json()) as { success: boolean; subscriptionId: string; invoiceId: string; status: string };
  assert.equal(body.success, true);
  assert.equal(body.status, 'PENDING');
  assert.ok(body.subscriptionId);
  assert.ok(body.invoiceId);

  const invoice = await db.invoice.findUnique({ where: { id: body.invoiceId } });
  assert.ok(invoice, 'a PENDING invoice is created');
  assert.match(invoice.invoiceNumber, /^INV-\d{4}-\d{4}$/, 'sequential invoice number format');
});

test('S-3: GET now returns the pending subscription with its plan', async () => {
  const res = await getReq(adminToken);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { subscription: { status: string; plan: { name: string } } };
  assert.equal(body.subscription.status, 'PENDING');
  assert.equal(body.subscription.plan.name, 'Pro');
});

test('S-4: subscribing again -> 409 already active', async () => {
  const res = await subApi.POST(
    req(adminToken, { method: 'POST', body: { planId, billingPeriod: 'MONTHLY' } }),
    { params: Promise.resolve({ orgId }) }
  );
  assert.equal(res.status, 409);
});

test('S-5: a viewer (non-admin) is forbidden from subscribing', async () => {
  const res = await subApi.POST(
    req(viewerAdminToken, { method: 'POST', body: { planId, billingPeriod: 'MONTHLY' } }),
    { params: Promise.resolve({ orgId }) }
  );
  assert.equal(res.status, 403);
});

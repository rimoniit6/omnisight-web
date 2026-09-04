/**
 * Invoice retrieval — API integration + tenant isolation.
 *
 *   I-1  GET a single invoice returns its details (subscription, plan, org)
 *   I-2  A member of a DIFFERENT org is forbidden from reading it (403)
 *   I-3  Unknown invoice ids -> 404
 *
 * Invoices are created directly as fixtures (they require a Subscription, so a
 * subscription is created first). Tokens are stateless JWTs.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_invoices).
 * Run: npx tsx --test tests/api/invoices.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import type { PrismaClient } from '@prisma/client';
import { req } from '../helpers/request';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_invoices';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-invoices-0123456789abcd';

let db: PrismaClient;
let signJWT: (payload: { userId: string; email: string; role: string; organizationId?: string }) => Promise<string>;
let invoiceApi: typeof import('../../src/app/api/invoices/[invoiceId]/route');

let ownerOrgId: string;
let ownerMemberToken: string;
let otherOrgMemberToken: string;
let invoiceId: string;

before(async () => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', { env: { ...process.env, DATABASE_URL: TEST_DB_URL }, stdio: 'pipe' });

  db = (await import('../../src/lib/db')).db;
  signJWT = (await import('../../src/lib/auth')).signJWT;
  invoiceApi = await import('../../src/app/api/invoices/[invoiceId]/route');

  const plan = await db.plan.create({
    data: { name: 'Pro', priceMonthly: 499, maxDevices: 50, retentionDays: 365, isActive: true, features: [] },
  });

  const ownerOrg = await db.organization.create({ data: { name: 'Owner Org', slug: 'owner-org', status: 'active' } });
  ownerOrgId = ownerOrg.id;
  const sub = await db.subscription.create({
    data: { organizationId: ownerOrg.id, planId: plan.id, status: 'ACTIVE', startDate: new Date() },
  });
  const invoice = await db.invoice.create({
    data: {
      subscriptionId: sub.id,
      organizationId: ownerOrg.id,
      invoiceNumber: 'INV-2026-0001',
      amount: 499,
      currency: 'USD',
      status: 'PENDING',
      dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  invoiceId = invoice.id;

  // Owner org member.
  const ownerUser = await db.appUser.create({ data: { email: 'owner@corp.local', name: 'Owner', role: 'admin' } });
  await db.organizationMembership.create({
    data: { userId: ownerUser.id, organizationId: ownerOrg.id, role: 'admin', status: 'ACTIVE' },
  });
  ownerMemberToken = await signJWT({ userId: ownerUser.id, email: ownerUser.email, role: 'admin', organizationId: ownerOrg.id });

  // Another org's member (must NOT see the owner invoice).
  const otherOrg = await db.organization.create({ data: { name: 'Other Org', slug: 'other-org', status: 'active' } });
  const otherUser = await db.appUser.create({ data: { email: 'other@corp.local', name: 'Other', role: 'admin' } });
  await db.organizationMembership.create({
    data: { userId: otherUser.id, organizationId: otherOrg.id, role: 'admin', status: 'ACTIVE' },
  });
  otherOrgMemberToken = await signJWT({ userId: otherUser.id, email: otherUser.email, role: 'admin', organizationId: otherOrg.id });
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  } catch {
    /* best effort */
  }
});

test('I-1: GET returns the invoice with subscription + plan + org', async () => {
  const res = await invoiceApi.GET(req(ownerMemberToken, { method: 'GET' }), { params: Promise.resolve({ invoiceId }) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    invoice: { invoiceNumber: string; status: string; amount: number; organization: { name: string }; subscription: { status: string }; plan: { name: string } };
  };
  assert.equal(body.invoice.invoiceNumber, 'INV-2026-0001');
  assert.equal(body.invoice.status, 'PENDING');
  assert.equal(body.invoice.amount, 499);
  assert.equal(body.invoice.organization.name, 'Owner Org');
  assert.equal(body.invoice.subscription.status, 'ACTIVE');
  assert.equal(body.invoice.plan.name, 'Pro');
});

test('I-2: a member of another org is forbidden (tenant isolation)', async () => {
  const res = await invoiceApi.GET(req(otherOrgMemberToken, { method: 'GET' }), { params: Promise.resolve({ invoiceId }) });
  assert.equal(res.status, 403);
});

test('I-3: unknown invoice id -> 404', async () => {
  const res = await invoiceApi.GET(req(ownerMemberToken, { method: 'GET' }), {
    params: Promise.resolve({ invoiceId: 'cuidmademup0000000000' }),
  });
  assert.equal(res.status, 404);
});

/**
 * V1 Pricing Resolver — unit tests against a throwaway DB.
 *
 * Coverage:
 *   P-1  Managed monthly price from PlanPricing config
 *   P-2  Managed yearly price from PlanPricing config
 *   P-3  Managed price scales with device quantity (included + additional)
 *   P-4  Customer Database price ignores device quantity (unlimited)
 *   P-5  Percentage offer discount, clamped at zero (never negative)
 *   P-6  Fixed offer discount
 *   P-7  Free offer → price 0
 *   P-8  Deterministic single-offer precedence (largest discount wins)
 *   P-9  Expired offer is ignored
 *   P-10 Legacy plan fallback when no PlanPricing row exists
 *   P-11 CUSTOMER_DB never carries device terms even if row had them
 *
 * Run: npx tsx --test tests/unit/pricing-resolver.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import type { PrismaClient } from '@prisma/client';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_pricing';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-pricing-0123456789';

let db: PrismaClient;
let resolvePrice: typeof import('../../src/lib/pricing').resolvePrice;

let planId: string;

before(async () => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', { env: { ...process.env, DATABASE_URL: TEST_DB_URL }, stdio: 'pipe' });

  db = (await import('../../src/lib/db')).db;
  ({ resolvePrice } = await import('../../src/lib/pricing'));

  const plan = await db.plan.create({
    data: { name: 'Business', priceMonthly: 9900, priceYearly: 99000, maxDevices: 500, retentionDays: 365, isActive: true, features: [] },
  });
  planId = plan.id;
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  } catch {
    /* best effort */
  }
});

async function seedPricing(mode: 'MANAGED' | 'CUSTOMER_DB', period: 'MONTHLY' | 'YEARLY', base: number, included = 10, extra = 500) {
  await db.planPricing.upsert({
    where: { planId_deploymentMode_billingPeriod: { planId, deploymentMode: mode, billingPeriod: period } },
    update: { basePrice: base, includedDevices: included, additionalDevicePrice: extra, isActive: true },
    create: { planId, deploymentMode: mode, billingPeriod: period, basePrice: base, includedDevices: included, additionalDevicePrice: extra, isActive: true },
  });
}

test('P-1: Managed monthly price comes from PlanPricing config', async () => {
  await seedPricing('MANAGED', 'MONTHLY', 5000, 10, 500);
  const b = await resolvePrice({ planId, deploymentMode: 'MANAGED', billingPeriod: 'MONTHLY', deviceQuantity: 10 });
  assert.equal(b.basePrice, 5000);
  assert.equal(b.deviceCharge, 0);
  assert.equal(b.finalPrice, 5000);
  assert.equal(b.pricingSource, 'PRICING_CONFIG');
  assert.equal(b.unlimitedDevices, false);
});

test('P-2: Managed yearly price comes from PlanPricing config', async () => {
  await seedPricing('MANAGED', 'YEARLY', 50000, 10, 5000);
  const b = await resolvePrice({ planId, deploymentMode: 'MANAGED', billingPeriod: 'YEARLY', deviceQuantity: 10 });
  assert.equal(b.basePrice, 50000);
  assert.equal(b.finalPrice, 50000);
  assert.equal(b.billingPeriod, 'YEARLY');
});

test('P-3: Managed price scales with device quantity beyond included count', async () => {
  await seedPricing('MANAGED', 'MONTHLY', 5000, 10, 500);
  // 15 devices = 5 extra × 500 = 2500
  const b15 = await resolvePrice({ planId, deploymentMode: 'MANAGED', billingPeriod: 'MONTHLY', deviceQuantity: 15 });
  assert.equal(b15.extraDevices, 5);
  assert.equal(b15.deviceCharge, 2500);
  assert.equal(b15.finalPrice, 7500);
  // 25 devices = 15 extra × 500 = 7500
  const b25 = await resolvePrice({ planId, deploymentMode: 'MANAGED', billingPeriod: 'MONTHLY', deviceQuantity: 25 });
  assert.equal(b25.finalPrice, 12500);
  // At/below included: no device charge
  const b10 = await resolvePrice({ planId, deploymentMode: 'MANAGED', billingPeriod: 'MONTHLY', deviceQuantity: 10 });
  assert.equal(b10.deviceCharge, 0);
});

test('P-4: Customer Database price ignores device quantity and is unlimited', async () => {
  await seedPricing('CUSTOMER_DB', 'MONTHLY', 8000);
  const b5 = await resolvePrice({ planId, deploymentMode: 'CUSTOMER_DB', billingPeriod: 'MONTHLY', deviceQuantity: 5 });
  const b500 = await resolvePrice({ planId, deploymentMode: 'CUSTOMER_DB', billingPeriod: 'MONTHLY', deviceQuantity: 500 });
  assert.equal(b5.finalPrice, 8000);
  assert.equal(b500.finalPrice, 8000, 'device quantity must NOT affect Customer DB price');
  assert.equal(b500.unlimitedDevices, true);
  assert.equal(b500.deviceQuantity, null);
  assert.equal(b500.includedDevices, null);
  assert.equal(b500.additionalDevicePrice, null);
});

test('P-5: Percentage offer discounts and never goes negative', async () => {
  await seedPricing('MANAGED', 'MONTHLY', 5000, 10, 500);
  await db.offer.create({
    data: { name: 'Launch 20%', discountType: 'PERCENTAGE', discountValue: 20, isActive: true },
  });
  const b = await resolvePrice({ planId, deploymentMode: 'MANAGED', billingPeriod: 'MONTHLY', deviceQuantity: 10 });
  assert.equal(b.offerName, 'Launch 20%');
  assert.equal(b.discountAmount, 1000);
  assert.equal(b.finalPrice, 4000);

  // 150% percentage is clamped to 100% → price 0, never negative.
  await db.offer.create({
    data: { name: 'Overclamped', discountType: 'PERCENTAGE', discountValue: 150, isActive: true, planId },
  });
  const b2 = await resolvePrice({ planId, deploymentMode: 'MANAGED', billingPeriod: 'MONTHLY', deviceQuantity: 10 });
  assert.equal(b2.finalPrice, 0);
  await db.offer.deleteMany({ where: { name: 'Overclamped' } });
});

test('P-6: Fixed offer discount applies against the base amount', async () => {
  await db.offer.create({
    data: { name: 'Flat 1500', discountType: 'FIXED', discountValue: 1500, isActive: true },
  });
  const b = await resolvePrice({ planId, deploymentMode: 'MANAGED', billingPeriod: 'MONTHLY', deviceQuantity: 10 });
  assert.equal(b.discountAmount, 1500);
  assert.equal(b.finalPrice, 3500);
  await db.offer.deleteMany({ where: { name: 'Flat 1500' } });
});

test('P-7: Free offer resolves to price 0', async () => {
  await db.offer.create({
    data: { name: 'Free month', discountType: 'PERCENTAGE', discountValue: 100, isFree: true, isActive: true },
  });
  const b = await resolvePrice({ planId, deploymentMode: 'MANAGED', billingPeriod: 'MONTHLY', deviceQuantity: 10 });
  assert.equal(b.finalPrice, 0);
  assert.equal(b.discountAmount, 5000);
  await db.offer.deleteMany({ where: { name: 'Free month' } });
});

test('P-8: Multiple offers → deterministic single winner (largest discount)', async () => {
  await db.offer.create({ data: { name: 'Ten pct', discountType: 'PERCENTAGE', discountValue: 10, isActive: true } }); // 500
  await db.offer.create({ data: { name: 'Big fixed', discountType: 'FIXED', discountValue: 2000, isActive: true } }); // 2000
  const b = await resolvePrice({ planId, deploymentMode: 'MANAGED', billingPeriod: 'MONTHLY', deviceQuantity: 10 });
  assert.equal(b.offerName, 'Big fixed');
  assert.equal(b.finalPrice, 3000);
  await db.offer.deleteMany({});
});

test('P-9: Expired offer is ignored', async () => {
  await db.offer.create({
    data: { name: 'Stale', discountType: 'PERCENTAGE', discountValue: 50, isActive: true, endsAt: new Date(Date.now() - 86_400_000) },
  });
  const b = await resolvePrice({ planId, deploymentMode: 'MANAGED', billingPeriod: 'MONTHLY', deviceQuantity: 10 });
  assert.equal(b.offerId, null);
  assert.equal(b.finalPrice, 5000);
  await db.offer.deleteMany({ where: { name: 'Stale' } });
});

test('P-10: Legacy plan fallback when no PlanPricing row exists', async () => {
  await db.planPricing.deleteMany({ where: { planId } });
  const b = await resolvePrice({ planId, deploymentMode: 'MANAGED', billingPeriod: 'MONTHLY', deviceQuantity: 5 });
  assert.equal(b.pricingSource, 'LEGACY_PLAN');
  assert.equal(b.basePrice, 9900);
  assert.equal(b.includedDevices, 500); // falls back to plan.maxDevices

  const by = await resolvePrice({ planId, deploymentMode: 'MANAGED', billingPeriod: 'YEARLY' });
  assert.equal(by.basePrice, 99000);
  // Restore config for other tests' teardown symmetry
  await seedPricing('MANAGED', 'MONTHLY', 5000, 10, 500);
});

test('P-11: Managed scope offers do not leak into Customer Database pricing', async () => {
  await db.offer.create({
    data: { name: 'Managed only', discountType: 'PERCENTAGE', discountValue: 50, isActive: true, deploymentMode: 'MANAGED' },
  });
  const bm = await resolvePrice({ planId, deploymentMode: 'MANAGED', billingPeriod: 'MONTHLY', deviceQuantity: 10 });
  assert.equal(bm.offerName, 'Managed only');
  const bc = await resolvePrice({ planId, deploymentMode: 'CUSTOMER_DB', billingPeriod: 'MONTHLY' });
  assert.equal(bc.offerId, null, 'MANAGED-scoped offer must not apply to CUSTOMER_DB');
  await db.offer.deleteMany({});
});

/**
 * Seed PlanPricing rows for the V1 landing page catalog.
 *
 * Run: npx tsx scripts/seed-pricing.ts
 *
 * Creates pricing rows for Pro + Business × MANAGED/CUSTOMER_DB × MONTHLY/YEARLY.
 * Only Pro MANAGED MONTHLY has an approved price (from Super Admin config).
 * All other rows are created with basePrice=0 to represent "unconfigured" —
 * the landing page will show "Contact us for pricing" for these.
 *
 * The Super Admin can later configure any row via Pricing & Offers.
 */

import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

const PRO_ID = 'cmtwl16z50001fij876jly5wf';
const BUSINESS_ID = 'cmtwl16z80002fij8h6oydro5';

type DeploymentMode = 'MANAGED' | 'CUSTOMER_DB';
type BillingPeriod = 'MONTHLY' | 'YEARLY';

interface PricingSeed {
  planId: string;
  deploymentMode: DeploymentMode;
  billingPeriod: BillingPeriod;
  basePrice: number;
  currency: string;
  includedDevices: number;
  additionalDevicePrice: number;
}

const ROWS: PricingSeed[] = [
  // ── Pro ──────────────────────────────────────────────────────────────────
  // MANAGED MONTHLY — approved price from Super Admin
  {
    planId: PRO_ID,
    deploymentMode: 'MANAGED',
    billingPeriod: 'MONTHLY',
    basePrice: 1000,
    currency: 'BDT',
    includedDevices: 10,
    additionalDevicePrice: 100,
  },
  // MANAGED YEARLY — approved device limits, price to be configured by SA
  {
    planId: PRO_ID,
    deploymentMode: 'MANAGED',
    billingPeriod: 'YEARLY',
    basePrice: 0,
    currency: 'BDT',
    includedDevices: 10,
    additionalDevicePrice: 100,
  },
  // CUSTOMER_DB — unconfigured (SA sets price later)
  {
    planId: PRO_ID,
    deploymentMode: 'CUSTOMER_DB',
    billingPeriod: 'MONTHLY',
    basePrice: 0,
    currency: 'BDT',
    includedDevices: 0,
    additionalDevicePrice: 0,
  },
  {
    planId: PRO_ID,
    deploymentMode: 'CUSTOMER_DB',
    billingPeriod: 'YEARLY',
    basePrice: 0,
    currency: 'BDT',
    includedDevices: 0,
    additionalDevicePrice: 0,
  },

  // ── Business ─────────────────────────────────────────────────────────────
  // All Business rows are unconfigured — SA sets prices via Pricing & Offers
  {
    planId: BUSINESS_ID,
    deploymentMode: 'MANAGED',
    billingPeriod: 'MONTHLY',
    basePrice: 0,
    currency: 'BDT',
    includedDevices: 50,
    additionalDevicePrice: 0,
  },
  {
    planId: BUSINESS_ID,
    deploymentMode: 'MANAGED',
    billingPeriod: 'YEARLY',
    basePrice: 0,
    currency: 'BDT',
    includedDevices: 50,
    additionalDevicePrice: 0,
  },
  {
    planId: BUSINESS_ID,
    deploymentMode: 'CUSTOMER_DB',
    billingPeriod: 'MONTHLY',
    basePrice: 0,
    currency: 'BDT',
    includedDevices: 0,
    additionalDevicePrice: 0,
  },
  {
    planId: BUSINESS_ID,
    deploymentMode: 'CUSTOMER_DB',
    billingPeriod: 'YEARLY',
    basePrice: 0,
    currency: 'BDT',
    includedDevices: 0,
    additionalDevicePrice: 0,
  },
];

async function main() {
  console.log('Seeding PlanPricing rows...\n');

  for (const row of ROWS) {
    const existing = await db.planPricing.findUnique({
      where: {
        planId_deploymentMode_billingPeriod: {
          planId: row.planId,
          deploymentMode: row.deploymentMode,
          billingPeriod: row.billingPeriod,
        },
      },
    });

    if (existing) {
      // Update Pro MANAGED MONTHLY: fix includedDevices from 5 → 10
      if (row.basePrice > 0 || row.includedDevices > 0) {
        await db.planPricing.update({
          where: { id: existing.id },
          data: {
            includedDevices: row.includedDevices,
            additionalDevicePrice: row.additionalDevicePrice,
            ...(row.basePrice > 0 ? { basePrice: row.basePrice } : {}),
          },
        });
        console.log(`  ↻ Updated: ${row.planId.slice(0, 8)}… ${row.deploymentMode} ${row.billingPeriod} → devices=${row.includedDevices}, price=${row.basePrice}`);
      } else {
        console.log(`  – Exists:  ${row.planId.slice(0, 8)}… ${row.deploymentMode} ${row.billingPeriod} (no change)`);
      }
    } else {
      await db.planPricing.create({ data: row });
      console.log(`  + Created: ${row.planId.slice(0, 8)}… ${row.deploymentMode} ${row.billingPeriod} → devices=${row.includedDevices}, price=${row.basePrice}`);
    }
  }

  console.log('\nDone. Verifying...');

  const all = await db.planPricing.findMany({
    include: { plan: { select: { name: true } } },
    orderBy: [{ plan: { name: 'asc' } }, { deploymentMode: 'asc' }, { billingPeriod: 'asc' }],
  });

  console.log(`\nTotal PlanPricing rows: ${all.length}`);
  for (const r of all) {
    const configured = r.basePrice > 0 ? `৳${r.basePrice}` : 'unconfigured';
    const devices = r.deploymentMode === 'CUSTOMER_DB' ? 'unlimited' : `${r.includedDevices} devices`;
    console.log(`  ${r.plan.name} | ${r.deploymentMode} | ${r.billingPeriod} | ${configured} | ${devices} | +৳${r.additionalDevicePrice}/device`);
  }

  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  db.$disconnect();
  process.exit(1);
});

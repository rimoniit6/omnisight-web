const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();

const [action, ...args] = process.argv.slice(2);

async function main() {
  if (action === 'update-cdb') {
    // Update Customer DB pricing: node scripts/update-pricing.js update-cdb basePrice 800
    const [field, value, planName, mode, period] = args;
    const planId = planName === 'Business' ? 'cmtwl16z80002fij8h6oydro5' : 'cmtwl16z50001fij876jly5wf';
    const r = await db.planPricing.updateMany({
      where: { planId, deploymentMode: mode || 'CUSTOMER_DB', billingPeriod: period || 'MONTHLY' },
      data: { [field]: Number(value) },
    });
    console.log(`Updated ${r.count} row(s): ${field}=${value}`);
  } else if (action === 'update') {
    const [field, value, planName, mode, period] = args;
    const planId = planName === 'Business' ? 'cmtwl16z80002fij8h6oydro5' : 'cmtwl16z50001fij876jly5wf';
    const r = await db.planPricing.updateMany({
      where: { planId, deploymentMode: mode || 'MANAGED', billingPeriod: period || 'MONTHLY' },
      data: { [field]: Number(value) },
    });
    console.log(`Updated ${r.count} row(s): ${field}=${value}`);
  } else if (action === 'verify') {
    const rows = await db.planPricing.findMany({
      include: { plan: { select: { name: true } } },
      orderBy: [{ plan: { name: 'asc' } }, { deploymentMode: 'asc' }, { billingPeriod: 'asc' }],
    });
    console.log('\n=== Current PlanPricing State ===');
    for (const r of rows) {
      const price = r.basePrice > 0 ? `${r.currency} ${r.basePrice}` : 'unconfigured';
      const devices = r.deploymentMode === 'CUSTOMER_DB' ? 'unlimited' : `${r.includedDevices} devices`;
      console.log(`  ${r.plan.name} | ${r.deploymentMode} | ${r.billingPeriod} | ${price} | ${devices} | +${r.currency} ${r.additionalDevicePrice}/device`);
    }
  }
  await db.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });

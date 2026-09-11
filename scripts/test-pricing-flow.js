const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();

async function main() {
  const action = process.argv[2]; // 'update', 'verify', or 'reset'
  const field = process.argv[3];  // e.g. 'basePrice', 'includedDevices'
  const value = process.argv[4];  // new value

  if (action === 'update') {
    // Update Pro MANAGED MONTHLY pricing
    const r = await db.planPricing.updateMany({
      where: { planId: 'cmtwl16z50001fij876jly5wf', deploymentMode: 'MANAGED', billingPeriod: 'MONTHLY' },
      data: { [field]: Number(value) },
    });
    console.log(`Updated ${r.count} row(s): Pro MANAGED MONTHLY ${field}=${value}`);
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
  } else if (action === 'reset') {
    // Reset Pro MANAGED MONTHLY back to 1000
    await db.planPricing.updateMany({
      where: { planId: 'cmtwl16z50001fij876jly5wf', deploymentMode: 'MANAGED', billingPeriod: 'MONTHLY' },
      data: { basePrice: 1000 },
    });
    console.log('Reset Pro MANAGED MONTHLY basePrice=1000');
  }

  await db.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });

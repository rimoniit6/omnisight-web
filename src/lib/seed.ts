import { db } from '@/lib/db';
import { bootstrapSuperAdmin } from '@/lib/super-admin';

// ─── Production guard ─────────────────────────────────────────────────────────
// This seed bootstraps ONLY the Super Admin account (from environment
// variables) plus the required Plan reference catalog. It creates:
//   - zero demo organizations, zero demo users, zero demo credentials
//   - zero destructive deletes (no wipe, no deleteMany)
// It must NEVER run in production and must NEVER run implicitly.
// It only runs when BOTH hold:
//   - NODE_ENV !== 'production'
//   - SEED_ALLOWED=1  (explicit opt-in)
// Production bootstrap is performed by `scripts/bootstrap-super-admin.ts`.
export function seedAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.SEED_ALLOWED === '1';
}

// ─── Required reference catalog ───────────────────────────────────────────────
// The Plan catalog is CONSTANT system configuration (no credentials, no org
// data). Without it the Super Admin cannot create subscriptions or
// invoices, so it is bootstrapped idempotently. It is deliberately NOT
// experimental/demo data and carries no secrets. Field names must match
// prisma/schema.prisma (Plan model).
//
// V1 service models are MANAGED and CUSTOMER_DB. Self-Hosted / PRIVATE is NOT
// a V1 service model, so there is NO `Enterprise_SelfHosted` plan here (it was
// removed with the LicenseKey architecture) and the Plan model no longer has
// an `isSelfHosted` field. Do NOT reintroduce a self-hosted plan.
const PLAN_DEFINITIONS = [
  {
    name: 'Free',
    description: 'Get started with basic workforce tracking',
    priceMonthly: 0,
    priceYearly: 0,
    currency: 'BDT',
    maxDevices: 5,
    retentionDays: 90,
    features: ['basic_tracking', 'reports'],
  },
  {
    name: 'Pro',
    description: 'Full-featured monitoring with screenshots and reporting',
    priceMonthly: 3400,
    priceYearly: 34000,
    currency: 'BDT',
    maxDevices: 50,
    retentionDays: 365,
    features: ['basic_tracking', 'screenshots', 'reports', 'export', 'break_detection'],
  },
  {
    name: 'Business',
    description: 'Advanced monitoring with app blocking and location',
    priceMonthly: 9900,
    priceYearly: 99000,
    currency: 'BDT',
    maxDevices: 500,
    retentionDays: 365,
    features: ['basic_tracking', 'screenshots', 'reports', 'export', 'break_detection', 'app_blocking', 'location_tracking'],
  },
] as const;

async function seed() {
  console.log('🌱 Seeding database...');
  console.log('   Mode: Super Admin only (no demo users, no destructive wipe)');

  // Plans — idempotent upsert of the required reference catalog.
  for (const p of PLAN_DEFINITIONS) {
    await db.plan.upsert({
      where: { name: p.name },
      update: {
        description: p.description,
        priceMonthly: p.priceMonthly,
        priceYearly: p.priceYearly,
        currency: p.currency,
        maxDevices: p.maxDevices,
        retentionDays: p.retentionDays,
        features: p.features,
        isActive: true,
      },
      create: {
        name: p.name,
        description: p.description,
        priceMonthly: p.priceMonthly,
        priceYearly: p.priceYearly,
        currency: p.currency,
        maxDevices: p.maxDevices,
        retentionDays: p.retentionDays,
        features: p.features,
        isActive: true,
      },
    });
  }
  console.log(`  📦 Plans: ${PLAN_DEFINITIONS.length} required catalog entries ensured`);

  // Super Admin — the ONLY user this seed ever creates. Credentials come from
  // environment variables (SUPER_ADMIN_EMAIL/PASSWORD/NAME); never hardcoded,
  // never printed, never overwritten once created.
  const adminResult = await bootstrapSuperAdmin();
  if (adminResult.created) {
    console.log(`✅ Super Admin created: ${adminResult.email}`);
  } else {
    console.log(`ℹ️  Super Admin already exists — left unchanged: ${adminResult.email} (role=${adminResult.user.role})`);
  }

  console.log('✅ Seed complete: Super Admin only. No demo data created.');
}

export { seed };

// Only run seed when executed directly (not imported)
// Works with tsx, node --loader ts-node/esm, etc.
const isMainModule = process.argv[1]?.endsWith('seed.ts') || import.meta.url === `file://${process.argv[1]}` || import.meta.main;

if (isMainModule) {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ Seed refused: cannot run in production (NODE_ENV=production)');
    console.error('   Use `scripts/bootstrap-super-admin.ts` for production bootstrap.');
    process.exit(1);
  }
  if (process.env.SEED_ALLOWED !== '1') {
    console.error('❌ Seed refused: SEED_ALLOWED=1 not set (explicit opt-in required)');
    process.exit(1);
  }
  seed()
    .catch((e) => {
      console.error('❌ Seed failed:', e);
      process.exit(1);
    })
    .finally(async () => {
      await db.$disconnect();
    });
}
import { db } from '@/lib/db';
import { hashPasswordSync } from '@/lib/auth';
import { normalizeEmail } from '@/lib/email';
import { bootstrapSuperAdmin } from '@/lib/super-admin';

// ─── Production guard ─────────────────────────────────────────────────────────
// This seed creates the Super Admin account from environment variables and,
// when DEMO_SEED=1, also creates demo organizations and users.
// It must NEVER run in production and must NEVER run implicitly.
// It only runs when BOTH hold:
//   - NODE_ENV !== 'production'
//   - SEED_ALLOWED=1  (explicit opt-in)
// Production bootstrap is performed by `scripts/bootstrap-super-admin.ts`.
export function seedAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.SEED_ALLOWED === '1';
}

// ─── Demo data constants ──────────────────────────────────────────────────────
const DEMO_PASSWORD = 'Demo@2026Pass'; // Development-only password

interface DemoOrg {
  name: string;
  slug: string;
  users: { name: string; email: string; orgRole: string }[];
}

const DEMO_ORGS: DemoOrg[] = [
  {
    name: 'Acme Corporation',
    slug: 'acme-corporation',
    users: [
      { name: 'Rahim Ahmed', email: 'rahim@acme.local', orgRole: 'org_admin' },
      { name: 'Karim Hasan', email: 'karim@acme.local', orgRole: 'manager' },
      { name: 'Salma Akter', email: 'salma@acme.local', orgRole: 'viewer' },
    ],
  },
  {
    name: 'TechVision Ltd',
    slug: 'techvision-ltd',
    users: [
      { name: 'Nadia Islam', email: 'nadia@techvision.local', orgRole: 'org_admin' },
      { name: 'Hasan Mahmud', email: 'hasan@techvision.local', orgRole: 'manager' },
      { name: 'Mitu Rahman', email: 'mitu@techvision.local', orgRole: 'viewer' },
    ],
  },
  {
    name: 'Demo Manufacturing',
    slug: 'demo-manufacturing',
    users: [
      { name: 'Tanvir Ahmed', email: 'tanvir@manufacturing.local', orgRole: 'org_admin' },
      { name: 'Jahid Khan', email: 'jahid@manufacturing.local', orgRole: 'manager' },
      { name: 'Rima Sultana', email: 'rima@manufacturing.local', orgRole: 'viewer' },
    ],
  },
];

async function seed() {
  console.log('🌱 Seeding database...');

  const includeDemo = process.env.DEMO_SEED === '1';
  console.log(`   Mode: Super Admin${includeDemo ? ' + Demo Data' : ' only'}`);

  // Clear existing data (reverse dependency order)
  await db.invoice.deleteMany();
  await db.sentimentRecord.deleteMany();
  await db.timeEntry.deleteMany();
  await db.projectMember.deleteMany();
  await db.project.deleteMany();
  await db.consentLog.deleteMany();
  await db.consent.deleteMany();
  await db.consentPolicy.deleteMany();
  await db.organizationSetting.deleteMany();
  await db.jobRun.deleteMany();
  await db.agentToken.deleteMany();
  await db.usbEvent.deleteMany();
  await db.appListEntry.deleteMany();
  await db.screenshot.deleteMany();
  await db.anomaly.deleteMany();
  await db.activity.deleteMany();
  await db.auditLog.deleteMany();
  await db.aiInsight.deleteMany();
  await db.alert.deleteMany();
  await db.notification.deleteMany();
  await db.report.deleteMany();
  await db.systemSetting.deleteMany();
  await db.device.deleteMany();
  await db.employee.deleteMany();
  await db.department.deleteMany();
  await db.organizationMembership.deleteMany();
  await db.userSession.deleteMany();
  await db.appUser.deleteMany();
  await db.organization.deleteMany();

  // ==================== Default Plans ====================
  // Field names must match prisma/schema.prisma (Plan model): name @unique,
  // priceMonthly/priceYearly, currency, maxDevices (0 = unlimited),
  // retentionDays (0 = unlimited), isSelfHosted, features (Json array).
  const planDefinitions = [
    {
      name: 'Free',
      description: 'Get started with basic workforce tracking',
      priceMonthly: 0,
      priceYearly: 0,
      currency: 'BDT',
      maxDevices: 5,
      retentionDays: 90,
      isSelfHosted: false,
      features: ['basic_tracking', 'reports'],
    },
    {
      name: 'Pro',
      description: 'Full-featured monitoring with screenshots and reporting',
      priceMonthly: 3400, // BDT
      priceYearly: 34000, // BDT
      currency: 'BDT',
      maxDevices: 50,
      retentionDays: 365,
      isSelfHosted: false,
      features: ['basic_tracking', 'screenshots', 'reports', 'export', 'break_detection'],
    },
    {
      name: 'Business',
      description: 'Advanced monitoring with app blocking and location',
      priceMonthly: 9900, // BDT
      priceYearly: 99000, // BDT
      currency: 'BDT',
      maxDevices: 500,
      retentionDays: 365,
      isSelfHosted: false,
      features: ['basic_tracking', 'screenshots', 'reports', 'export', 'break_detection', 'app_blocking', 'location_tracking'],
    },
    {
      name: 'Enterprise_SelfHosted',
      description: 'Unlimited self-hosted deployment',
      priceMonthly: 0,
      priceYearly: 0,
      currency: 'BDT',
      maxDevices: -1, // unlimited
      retentionDays: 0, // unlimited
      isSelfHosted: true,
      features: ['basic_tracking', 'screenshots', 'reports', 'export', 'break_detection', 'app_blocking', 'location_tracking', 'audit_logs', 'custom_retention'],
    },
  ];

  for (const p of planDefinitions) {
    await db.plan.upsert({
      where: { name: p.name },
      update: {
        description: p.description,
        priceMonthly: p.priceMonthly,
        priceYearly: p.priceYearly,
        currency: p.currency,
        maxDevices: p.maxDevices,
        retentionDays: p.retentionDays,
        isSelfHosted: p.isSelfHosted,
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
        isSelfHosted: p.isSelfHosted,
        features: p.features,
        isActive: true,
      },
    });
  }
  console.log(`  📦 Plans: ${planDefinitions.length} seeded (Free, Pro, Business, Enterprise_SelfHosted)`);

  // ==================== Super Admin ====================
  // Use the existing bootstrap mechanism — never create a duplicate.
  const adminResult = await bootstrapSuperAdmin();
  if (adminResult.created) {
    console.log(`✅ Super Admin created: ${adminResult.email}`);
  } else {
    console.log(`ℹ️  Super Admin already exists — left unchanged: ${adminResult.email} (role=${adminResult.user.role})`);
  }

  // ==================== Demo Data ====================
  if (!includeDemo) {
    console.log('✅ Seed complete: Super Admin only. No demo data created.');
    return;
  }

  const demoHashedPassword = hashPasswordSync(DEMO_PASSWORD);
  const createdUsers: { id: string; email: string; name: string }[] = [];

  // Create organizations
  for (const orgDef of DEMO_ORGS) {
    const org = await db.organization.create({
      data: { name: orgDef.name, slug: orgDef.slug },
    });
    console.log(`  📁 Organization: ${orgDef.name}`);

    // Create users for this organization
    for (const userDef of orgDef.users) {
      const normalizedEmail = normalizeEmail(userDef.email) || userDef.email;
      const user = await db.appUser.create({
        data: {
          email: normalizedEmail,
          name: userDef.name,
          password: demoHashedPassword,
          role: 'user',
          avatar: null,
          organizationId: null, // canonical model: membership is separate
          isActive: true,
        },
      });

      await db.organizationMembership.create({
        data: {
          userId: user.id,
          organizationId: org.id,
          role: userDef.orgRole,
          status: 'ACTIVE',
        },
      });

      createdUsers.push({ id: user.id, email: normalizedEmail, name: userDef.name });
      console.log(`    👤 ${userDef.name} (${normalizedEmail}) — ${userDef.orgRole}`);
    }
  }

  // ==================== Multi-Organization User ====================
  // Proves ONE AppUser can belong to MULTIPLE organizations
  const sharedEmail = normalizeEmail('shared@omnisight.local') || 'shared@omnisight.local';
  const sharedUser = await db.appUser.create({
    data: {
      email: sharedEmail,
      name: 'Shared Demo User',
      password: demoHashedPassword,
      role: 'user',
      avatar: null,
      organizationId: null,
      isActive: true,
    },
  });

  // Find Acme and TechVision orgs
  const acmeOrg = await db.organization.findUnique({ where: { slug: 'acme-corporation' } });
  const techvisionOrg = await db.organization.findUnique({ where: { slug: 'techvision-ltd' } });

  if (acmeOrg && techvisionOrg) {
    await db.organizationMembership.createMany({
      data: [
        { userId: sharedUser.id, organizationId: acmeOrg.id, role: 'manager', status: 'ACTIVE' },
        { userId: sharedUser.id, organizationId: techvisionOrg.id, role: 'viewer', status: 'ACTIVE' },
      ],
    });
    console.log(`\n  🔄 Shared Demo User (${sharedEmail})`);
    console.log(`    → Acme Corporation: Manager`);
    console.log(`    → TechVision Ltd: Viewer`);
  }

  console.log(`\n✅ Demo seed complete!`);
  console.log(`   Organizations: ${DEMO_ORGS.length}`);
  console.log(`   Users: ${createdUsers.length + 1} (including Shared Demo User)`);
  console.log(`   Demo password: ${DEMO_PASSWORD}`);
  console.log(`   ⚠️  Demo credentials are for development only!`);
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
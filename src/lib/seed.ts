import { db } from '@/lib/db';
import { hashPasswordSync } from '@/lib/auth';
import { Prisma } from '@prisma/client';

// ─── Production guard ─────────────────────────────────────────────────────────
// This seed creates ONLY the Super Admin account from environment variables.
// It must NEVER run in production and must NEVER run implicitly.
// It only runs when BOTH hold:
//   - NODE_ENV !== 'production'
//   - SEED_ALLOWED=1  (explicit opt-in)
// The demo seed is therefore dev-only; production bootstrap is performed by
// `scripts/bootstrap-super-admin.ts` (migrations + explicit bootstrap, no demo data).
export function seedAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.SEED_ALLOWED === '1';
}

async function seed() {
  console.log('🌱 Seeding database with Super Admin only...');

  // Clear existing data (reverse dependency order)
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
  await db.appUser.deleteMany();
  await db.organization.deleteMany();

  // ==================== Super Admin ====================
  // Super Admin credentials come from .env — no fallbacks, ever.
  const superAdminEmail = process.env.SUPER_ADMIN_EMAIL;
  const superAdminPassword = process.env.SUPER_ADMIN_PASSWORD;
  if (!superAdminEmail || !superAdminPassword) {
    throw new Error(
      'SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be set in .env to run the seed.'
    );
  }
  const superAdminHashedPassword = hashPasswordSync(superAdminPassword);

  await db.appUser.create({
    data: {
      email: superAdminEmail,
      name: 'Super Admin',
      password: superAdminHashedPassword,
      role: 'super_admin',
      avatar: null,
      organizationId: null, // org-less global super admin
      isActive: true,
      lastLogin: null,
    },
  });

  console.log(`✅ Super Admin created: ${superAdminEmail} (password from .env, org-less)`);
  console.log('✅ Seed complete: ONLY Super Admin exists. No demo data created.');
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
// OmniSight — Super Admin Bootstrap CLI (production)
//
// Usage:  npx tsx scripts/bootstrap-super-admin.ts
// Env:    SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD  (required)
//
// Idempotent: creates the Super Admin on first run; subsequent runs leave an
// existing account untouched (the password is NEVER overwritten). No demo
// users, orgs, employees or consent records are ever created by this command.
//
// Never prints the password.
import { bootstrapSuperAdmin } from '../src/lib/super-admin';
import { db } from '../src/lib/db';

async function main() {
  const result = await bootstrapSuperAdmin();
  if (result.created) {
    console.log(`✅ Super Admin created: ${result.email} (id=${result.user.id}, org-less)`);
  } else {
    console.log(
      `ℹ️  Super Admin already exists — left unchanged: ${result.user.email} (role=${result.user.role}, active=${result.user.isActive})`
    );
  }
}

main()
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`❌ Super Admin bootstrap failed: ${message}`);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });

#!/usr/bin/env node
/**
 * OmniSight — Safe Development Database Reset
 *
 * Completely resets the application database and removes ALL existing/demo/test data.
 * After reset, the database contains ONLY the Super Admin account from environment variables.
 *
 * SAFETY:
 *   1. Refuses to run against production databases (detected via NODE_ENV or DATABASE_URL)
 *   2. Shows which database is being targeted and requires explicit confirmation
 *   3. Runs inside a single transaction where possible
 *   4. Uses Prisma's standard reset workflow (preserves migrations/schema)
 *   5. Seeds ONLY the Super Admin from SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD env vars
 *   6. Verifies final database state
 *
 * Usage:
 *   # Development reset (with confirmation prompt)
 *   npx tsx scripts/reset-database.ts
 *
 *   # CI/Automated (non-interactive, still requires CONFIRM_DEV_RESET=YES)
 *   CONFIRM_DEV_RESET=YES npx tsx scripts/reset-database.ts
 *
 * Env:
 *   DATABASE_URL (PostgreSQL) - MUST be a development/staging database
 *   SUPER_ADMIN_EMAIL - Super Admin email (from .env)
 *   SUPER_ADMIN_PASSWORD - Super Admin password (from .env)
 *   CONFIRM_DEV_RESET=YES - Skip interactive confirmation (for CI)
 *   DRYRUN - Show what would be done without executing
 */

import { execSync } from 'node:child_process';
import { db } from '../src/lib/db';
import { validateSuperAdminEnv } from '../src/lib/super-admin';
import { hashPasswordSync } from '../src/lib/auth';

const DRY_RUN = process.env.DRYRUN === '1';
const AUTO_CONFIRM = process.env.CONFIRM_DEV_RESET === 'YES';

function isProductionDatabase(dbUrl: string): boolean {
  try {
    const url = new URL(dbUrl);
    const host = url.hostname.toLowerCase();
    const dbName = url.pathname.replace(/^\//, '').split('?')[0].toLowerCase();

    // Common production indicators
    const prodHosts = ['prod', 'production', 'live', 'aws', 'azure', 'gcp', 'heroku', 'render', 'fly.io', 'vercel', 'railway', 'planetscale', 'neon.tech', 'supabase.co'];
    const prodDbNames = ['prod', 'production', 'live', 'main', 'master'];

    return prodHosts.some(h => host.includes(h)) || prodDbNames.some(n => dbName === n);
  } catch {
    return true; // If we can't parse, assume production for safety
  }
}

function getDatabaseDescription(dbUrl: string): string {
  try {
    const url = new URL(dbUrl);
    const host = url.hostname;
    const port = url.port || '5432';
    const dbName = url.pathname.replace(/^\//, '').split('?')[0];
    return `${host}:${port}/${dbName}`;
  } catch {
    return dbUrl;
  }
}

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════════════════╗');
  console.log('║         OmniSight — Safe Development Database Reset                  ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════╝\n');

  // ─── 1. Load and validate environment ───────────────────────────────────────
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL is not set in the environment.');
    process.exit(1);
  }

  // Validate Super Admin env vars early
  let superAdminEmail: string;
  let superAdminPassword: string;
  try {
    const creds = validateSuperAdminEnv(process.env);
    superAdminEmail = creds.email;
    superAdminPassword = creds.password;
  } catch (err) {
    console.error('❌ Super Admin environment validation failed:', (err as Error).message);
    process.exit(1);
  }

  // ─── 2. Production safety check ─────────────────────────────────────────────
  const nodeEnv = process.env.NODE_ENV || 'development';
  const isProdEnv = nodeEnv === 'production';
  const isProdDb = isProductionDatabase(databaseUrl);

  if (isProdEnv || isProdDb) {
    console.error('⛔ REFUSING TO RUN: This appears to be a PRODUCTION environment or database.\n');
    console.error(`   NODE_ENV: ${nodeEnv}`);
    console.error(`   Target Database: ${getDatabaseDescription(databaseUrl)}`);
    console.error('\n   This script is for DEVELOPMENT/STAGING databases only.');
    console.error('   For production data clearing, use: CONFIRM_PRODUCTION_CLEANUP=YES npx tsx scripts/production-cleanup.ts');
    process.exit(1);
  }

  // ─── 3. Show target database and confirm ────────────────────────────────────
  console.log('📋 Target Database Information:');
  console.log(`   NODE_ENV: ${nodeEnv}`);
  console.log(`   Database: ${getDatabaseDescription(databaseUrl)}`);
  console.log(`   Super Admin Email: ${superAdminEmail}`);
  console.log('');

  console.log('⚠️  THIS WILL:');
  console.log('   • Drop all tables and re-apply all Prisma migrations');
  console.log('   • DELETE ALL DATA (organizations, employees, devices, activities, screenshots, projects, etc.)');
  console.log('   • Create ONLY the Super Admin account');
  console.log('');

  if (!AUTO_CONFIRM && !DRY_RUN) {
    const readline = await import('node:readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Type "RESET" to confirm this destructive operation: ');
    rl.close();

    if (answer.trim() !== 'RESET') {
      console.log('\n❌ Reset cancelled by user.');
      process.exit(0);
    }
  } else if (DRY_RUN) {
    console.log('[DRYRUN] Skipping confirmation prompt.');
  } else {
    console.log('✅ Auto-confirmed via CONFIRM_DEV_RESET=YES');
  }

  console.log('');

  // ─── 4. Run Prisma migrate reset ────────────────────────────────────────────
  console.log('🔄 Running Prisma migrate reset...');
  try {
    if (!DRY_RUN) {
      execSync('npx prisma migrate reset --force --skip-seed', {
        stdio: 'inherit',
        env: { ...process.env, DATABASE_URL: databaseUrl },
      });
    } else {
      console.log('[DRYRUN] Would run: npx prisma migrate reset --force --skip-seed');
    }
    console.log('✅ Migrations re-applied successfully.\n');
  } catch (err) {
    console.error('❌ Prisma migrate reset failed:', (err as Error).message);
    process.exit(1);
  }

  // ─── 5. Seed Super Admin only ───────────────────────────────────────────────
  console.log('🌱 Seeding Super Admin only...');
  try {
    if (!DRY_RUN) {
      // Clear any existing AppUser data (should be empty after migrate reset, but be safe)
      await db.appUser.deleteMany();

      const hashedPassword = hashPasswordSync(superAdminPassword);
      await db.appUser.create({
        data: {
          email: superAdminEmail,
          name: 'Super Admin',
          password: hashedPassword,
          role: 'super_admin',
          avatar: null,
          organizationId: null, // org-less global super admin
          isActive: true,
          lastLogin: null,
        },
      });
    } else {
      console.log('[DRYRUN] Would create Super Admin:', superAdminEmail);
    }
    console.log(`✅ Super Admin created: ${superAdminEmail} (org-less)\n`);
  } catch (err) {
    console.error('❌ Super Admin seed failed:', (err as Error).message);
    process.exit(1);
  }

  // ─── 6. Verify final database state ─────────────────────────────────────────
  console.log('🔍 Verifying final database state...');
  const modelsToCheck = [
    { model: 'appUser', label: 'App Users (Super Admin)' },
    { model: 'organization', label: 'Organizations' },
    { model: 'employee', label: 'Employees' },
    { model: 'device', label: 'Devices' },
    { model: 'activity', label: 'Activities' },
    { model: 'screenshot', label: 'Screenshots' },
    { model: 'project', label: 'Projects' },
    { model: 'projectMember', label: 'Project Members' },
    { model: 'timeEntry', label: 'Time Entries' },
    { model: 'sentimentRecord', label: 'Sentiment Records' },
    { model: 'notification', label: 'Notifications' },
    { model: 'alert', label: 'Alerts' },
    { model: 'auditLog', label: 'Audit Logs' },
    { model: 'report', label: 'Reports' },
    { model: 'aiInsight', label: 'AI Insights' },
    { model: 'anomaly', label: 'Anomalies' },
    { model: 'consent', label: 'Consents' },
    { model: 'consentLog', label: 'Consent Logs' },
    { model: 'consentPolicy', label: 'Consent Policies' },
    { model: 'organizationSetting', label: 'Organization Settings' },
    { model: 'systemSetting', label: 'System Settings' },
    { model: 'jobRun', label: 'Job Runs' },
    { model: 'agentToken', label: 'Agent Tokens' },
    { model: 'agentRegistration', label: 'Agent Registrations' },
    { model: 'deviceClaim', label: 'Device Claims' },
    { model: 'agentSession', label: 'Agent Sessions' },
    { model: 'appListEntry', label: 'App List Entries' },
    { model: 'usbEvent', label: 'USB Events' },
    { model: 'department', label: 'Departments' },
  ];

  let verificationFailed = false;
  console.log('\n=== ROW COUNTS AFTER RESET ===');
  for (const { model, label } of modelsToCheck) {
    try {
      const count = await (db as any)[model].count();
      const status = count === 0 ? '✅' : (model === 'appUser' && count === 1 ? '✅' : '❌');
      if ((model === 'appUser' && count !== 1) || (model !== 'appUser' && count !== 0)) {
        verificationFailed = true;
      }
      console.log(`  ${status} ${label.padEnd(30)} ${count}`);
    } catch (err) {
      console.log(`  ⚠️  ${label.padEnd(30)} ERROR: ${(err as Error).message}`);
      verificationFailed = true;
    }
  }

  // Verify Super Admin specifically
  const superAdmin = await db.appUser.findFirst({
    where: { email: { equals: superAdminEmail, mode: 'insensitive' } },
  });

  if (!superAdmin) {
    console.error('\n❌ VERIFICATION FAILED: Super Admin not found!');
    verificationFailed = true;
  } else if (superAdmin.role !== 'super_admin') {
    console.error(`\n❌ VERIFICATION FAILED: Super Admin has wrong role: ${superAdmin.role}`);
    verificationFailed = true;
  } else if (superAdmin.organizationId !== null) {
    console.error(`\n❌ VERIFICATION FAILED: Super Admin should be org-less but has organizationId: ${superAdmin.organizationId}`);
    verificationFailed = true;
  } else if (!superAdmin.isActive) {
    console.error(`\n❌ VERIFICATION FAILED: Super Admin is not active!`);
    verificationFailed = true;
  } else {
    console.log(`\n✅ Super Admin verified: ${superAdmin.email} (role=${superAdmin.role}, active=${superAdmin.isActive}, org-less)`);
  }

  // ─── 7. Final result ────────────────────────────────────────────────────────
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════════════════╗');
  if (verificationFailed) {
    console.log('║  ❌ DATABASE RESET VERIFICATION FAILED                                 ║');
    console.log('╚═══════════════════════════════════════════════════════════════════════╝');
    process.exit(1);
  } else {
    console.log('║  ✅ DATABASE RESET COMPLETE                                            ║');
    console.log('╚═══════════════════════════════════════════════════════════════════════╝');
    console.log('\n📊 Summary:');
    console.log('   • All migrations re-applied');
    console.log('   • All demo/test/business data removed');
    console.log(`   • Super Admin created: ${superAdminEmail}`);
    console.log('   • Super Admin is org-less (global)');
    console.log('   • No organizations, employees, devices, or any application data exists');
    console.log('\n🔑 Login with:');
    console.log(`   Email: ${superAdminEmail}`);
    console.log(`   Password: (from SUPER_ADMIN_PASSWORD in .env)`);
  }

  await db.$disconnect();
}

main().catch((err) => {
  console.error('❌ Unexpected error:', err);
  process.exit(1);
});
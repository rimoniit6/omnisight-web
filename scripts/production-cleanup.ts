#!/usr/bin/env node
/**
 * OmniSight — Production Database Cleanup (demo/test data removal)
 *
 * Removes ALL demo/sample/test/seed BUSINESS data from the connected
 * PostgreSQL database while preserving:
 *   - the Super Admin account (SUPER_ADMIN_EMAIL from env)
 *   - system configuration (SystemSetting) and job state (JobRun)
 *
 * SAFETY (destructive — read carefully):
 *   1. Refuses to run unless CONFIRM_PRODUCTION_CLEANUP=YES is set.
 *   2. Creates a timestamped pg_dump custom-format backup in backups/pg/
 *      BEFORE deleting anything.
 *   3. Prints row counts before/after for every affected table.
 *   4. Runs inside a single transaction (all-or-nothing).
 *   5. Deletes in dependency order (children before parents).
 *
 * NOT touched: AppUser (only demo users removed, super admin kept),
 * SystemSetting, JobRun, screenshots/ physical files are removed for the
 * deleted rows only.
 *
 * Usage:  CONFIRM_PRODUCTION_CLEANUP=YES npx tsx scripts/production-cleanup.ts
 * Env:    DATABASE_URL (PostgreSQL), SUPER_ADMIN_EMAIL (which account to keep)
 *         PG_BASE_URL / PGBIN (optional, for the backup)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, unlinkSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { db } from '../src/lib/db';

// ─── 0. Confirmation gate ───────────────────────────────────────────────────
const CONFIRM = process.env.CONFIRM_PRODUCTION_CLEANUP ?? '';
if (CONFIRM !== 'YES' && CONFIRM !== 'DRYRUN') {
  console.error(
    '⛔ Refusing to run destructive cleanup.\n' +
      '   Set CONFIRM_PRODUCTION_CLEANUP=YES to execute (a pg_dump backup is taken first).\n' +
      '   Dry run (no deletes): CONFIRM_PRODUCTION_CLEANUP=DRYRUN npx tsx scripts/production-cleanup.ts'
  );
  process.exit(1);
}

const DRY_RUN = CONFIRM === 'DRYRUN';

// Super admin to preserve — must come from env, never hardcoded.
const SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
if (!SUPER_ADMIN_EMAIL) {
  console.error('⛔ SUPER_ADMIN_EMAIL must be set in the environment so the Super Admin account is preserved.');
  process.exit(1);
}

// ─── 1. Backup (pg_dump, custom format, compressed, timestamped) ───────────
async function main() {
  await runCleanup();
}

async function runCleanup() {
const PG_BASE = process.env.PG_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const PGBIN = process.env.PGBIN || 'C:\\Program Files\\PostgreSQL\\18\\bin';
const SOURCE_DB = new URL(process.env.DATABASE_URL || '').pathname.replace(/^\//, '').split('?')[0] || 'workai';
const BACKUP_DIR = join(process.cwd(), 'backups', 'pg');

function pg(tool: string, args: string[]) {
  return execFileSync(join(PGBIN, tool), args, { stdio: ['ignore', 'pipe', 'pipe'] });
}
function redact(url: string): string {
  return url.replace(/\/\/[^@/]+@/, '//***:***@');
}

let backupFile: string | null = null;
if (!DRY_RUN) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  backupFile = join(BACKUP_DIR, `workai-cleanup-${ts}.dump`);
  console.log(`[backup] pg_dump → ${basename(backupFile)}`);
  pg('pg_dump.exe', [`${PG_BASE}/${SOURCE_DB}`, '--format=custom', '--compress=9', '--file=' + backupFile, '--no-owner']);
  console.log(`[backup] done (${backupFile})`);
} else {
  console.log('[dry-run] backup skipped (DRYRUN mode)');
}

// ─── 2. Row counts before ───────────────────────────────────────────────────
const BUSINESS_MODELS = [
  'sentimentRecord', 'timeEntry', 'projectMember', 'project', 'consentLog', 'consent',
  'consentPolicy', 'organizationSetting', 'agentToken', 'agentRegistration', 'usbEvent',
  'appListEntry', 'screenshot', 'anomaly', 'activity', 'auditLog', 'aiInsight', 'alert',
  'notification', 'report', 'monitoringPolicy', 'deviceClaim', 'device', 'employee',
  'department', 'organization',
] as const;

type ModelName = (typeof BUSINESS_MODELS)[number];

const before = {} as Record<string, number>;
for (const m of BUSINESS_MODELS) {
  try {
    before[m] = await (db as unknown as Record<string, { count: () => Promise<number> }>)[m].count();
  } catch {
    before[m] = -1;
  }
}
before.appUser = await db.appUser.count();

console.log('\n=== ROW COUNTS BEFORE ===');
for (const m of BUSINESS_MODELS) console.log(`  ${m.padEnd(22)} ${before[m]}`);
console.log(`  ${'appUser'.padEnd(22)} ${before.appUser}  (super admin ${SUPER_ADMIN_EMAIL} is preserved)`);

// ─── 3. Transactional, dependency-ordered deletes ──────────────────────────
if (!DRY_RUN) {
  console.log('\n=== DELETING demo business data (transactional) ===');
  await db.$transaction(async (tx) => {
    const t = tx as unknown as Record<string, { deleteMany: () => Promise<{ count: number }> }>;
    const report: string[] = [];
    for (const m of BUSINESS_MODELS) {
      const r = await t[m].deleteMany();
      report.push(`${m}:${r.count}`);
    }
    // Delete demo AppUsers — everything except the env-configured Super Admin.
    // Resolve the stored (possibly differently-cased) email first so the
    // exclusion is exact.
    const keptAdmin = await tx.appUser.findFirst({
      where: { email: { equals: SUPER_ADMIN_EMAIL, mode: 'insensitive' } },
    });
    const demoUsers = await tx.appUser.deleteMany({
      where: { email: keptAdmin ? { not: keptAdmin.email } : { not: SUPER_ADMIN_EMAIL } },
    });
    report.push(`appUser(demo):${demoUsers.count}`);
    console.log('  deleted: ' + report.join('  '));
  });
  console.log('  transaction committed ✓');
} else {
  console.log('\n[dry-run] no deletes executed');
}

// ─── 4. Screenshot physical files (only for deleted rows) ──────────────────
if (!DRY_RUN) {
  const uploadDir = join(process.cwd(), 'uploads', 'screenshots');
  let removed = 0;
  if (existsSync(uploadDir)) {
    for (const f of readdirSync(uploadDir)) {
      try {
        unlinkSync(join(uploadDir, f));
        removed++;
      } catch {
        /* best-effort */
      }
    }
  }
  console.log(`\n[files] removed ${removed} screenshot file(s) from uploads/screenshots`);
}

// ─── 5. Verification (row counts after) ────────────────────────────────────
const after = {} as Record<string, number>;
for (const m of BUSINESS_MODELS) {
  try {
    after[m] = await (db as unknown as Record<string, { count: () => Promise<number> }>)[m].count();
  } catch {
    after[m] = -1;
  }
}
after.appUser = await db.appUser.count();
const superAdmin = await db.appUser.findFirst({
  where: { email: { equals: SUPER_ADMIN_EMAIL, mode: 'insensitive' } },
});

console.log('\n=== ROW COUNTS AFTER ===');
let failed = false;
for (const m of BUSINESS_MODELS) {
  console.log(`  ${m.padEnd(22)} ${after[m]}`);
  if (before[m] > 0 && after[m] !== 0) failed = true;
}
console.log(`  ${'appUser'.padEnd(22)} ${after.appUser}`);
if (!superAdmin) {
  console.error('⛔ Super Admin was NOT preserved — this is a critical failure.');
  failed = true;
} else if (superAdmin.email !== SUPER_ADMIN_EMAIL) {
  console.error(`⛔ Preserved account mismatch: expected ${SUPER_ADMIN_EMAIL}, got ${superAdmin.email}`);
  failed = true;
} else {
  console.log(`  super admin preserved: ${superAdmin.email} (role=${superAdmin.role}, active=${superAdmin.isActive})`);
}

console.log(`\n${DRY_RUN ? '[dry-run] no changes applied' : `backup: ${backupFile}`}`);
if (failed) {
  console.error('⛔ CLEANUP VERIFICATION FAILED — review the counts above.');
  process.exit(1);
}
console.log('✅ Production cleanup complete: zero demo business data; Super Admin preserved.');
}

main()
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`⛔ Cleanup failed: ${message}`);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });

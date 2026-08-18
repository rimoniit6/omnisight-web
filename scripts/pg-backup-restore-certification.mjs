#!/usr/bin/env node
/**
 * OmniSight — Production PostgreSQL Backup & Restore Certification
 *
 * Actually executes a pg_dump backup of the live `workai` database, then
 * restores it into a THROWAWAY disposable database and verifies:
 *   - restore completed (exit 0, no errors)
 *   - every table has the same row count as the source
 *   - foreign keys are intact (no orphan rows)
 *   - critical unique constraints still hold (device agentKey, consent pair,
 *     project membership pair, org slug)
 *   - application-level connectivity (Prisma SELECT 1 + a representative read)
 *
 * SAFETY:
 *   - The SOURCE database is only ever READ (pg_dump --format=custom is
 *     non-locking for readers; no writes are performed against workai).
 *   - Restore targets a brand-new disposable database (workai_restore_cert_<ts>)
 *     which is DROPPED at the end.
 *   - Backup files land in `backups/pg/` with timestamped, compressed names.
 *
 * Run:  node scripts/pg-backup-restore-certification.mjs
 * Env:  PG_BASE_URL (default postgresql://postgres:123456@localhost:5432)
 *       PGBIN (default /c/Program Files/PostgreSQL/18/bin)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { PrismaClient, Prisma } from '@prisma/client';

const PG_BASE = process.env.PG_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const PGBIN = process.env.PGBIN || 'C:\\Program Files\\PostgreSQL\\18\\bin';
const SOURCE_DB = process.env.SOURCE_DB || 'workai';
const BACKUP_DIR = join(process.cwd(), 'backups', 'pg');

const pg = (tool, args) =>
  execFileSync(join(PGBIN, tool), args, { stdio: ['ignore', 'pipe', 'pipe'] });

function redact(url) {
  return url.replace(/\/\/[^@/]+@/, '//***:***@');
}

console.log(`[backup] source      : ${redact(PG_BASE)}/${SOURCE_DB}`);
console.log(`[backup] pg binaries : ${PGBIN}`);

// ── 1. BACKUP (compressed, timestamped, custom format) ─────────────────────
mkdirSync(BACKUP_DIR, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const backupFile = join(BACKUP_DIR, `workai-${ts}.dump`);

console.log(`[backup] pg_dump → ${basename(backupFile)}`);
const dumpOut = pg('pg_dump.exe', [
  `${PG_BASE}/${SOURCE_DB}`,
  '--format=custom',
  '--compress=9',
  '--file=' + backupFile,
  '--no-owner',
]);
console.log(`[backup] pg_dump exit 0 (${dumpOut.toString().trim() || 'no warnings'})`);

// Row counts from the SOURCE before restore (authoritative baseline).
const src = new PrismaClient();
const TABLES = [
  // Prisma model names, lower-camel — mirrors ALL 29 models in schema.prisma.
  'organization', 'appUser', 'employee', 'department', 'project', 'projectMember',
  'device', 'deviceClaim', 'agentToken', 'consent', 'consentPolicy', 'consentLog',
  'activity', 'screenshot', 'auditLog', 'timeEntry', 'notification', 'systemSetting',
  'monitoringPolicy', 'organizationSetting', 'alert', 'sentimentRecord', 'aiInsight',
  'report', 'jobRun', 'agentRegistration', 'appListEntry', 'usbEvent', 'anomaly',
];
const sourceCounts = {};
for (const t of TABLES) {
  try {
    const model = t[0].toLowerCase() + t.slice(1);
    sourceCounts[t] = await src[model].count();
  } catch (e) {
    sourceCounts[t] = `ERR:${e.message.split('\n')[0]}`;
  }
}
console.log(`[backup] source row counts captured for ${Object.keys(sourceCounts).filter((k) => typeof sourceCounts[k] === 'number').length} tables`);

// ── 2. RESTORE into a disposable database ──────────────────────────────────
const restoreDb = `workai_restore_cert_${Date.now().toString(36)}`;
console.log(`[restore] creating disposable DB "${restoreDb}"`);
pg('createdb.exe', ['-h', 'localhost', '-U', 'postgres', '-T', 'template0', restoreDb]);
try {
  console.log(`[restore] pg_restore → ${restoreDb}`);
  const restoreOut = pg('pg_restore.exe', [
    '--dbname=' + `${PG_BASE}/${restoreDb}`,
    '--no-owner',
    '--verbose',
    backupFile,
  ]);
  const out = restoreOut.toString();
  const errors = out.split('\n').filter((l) => /^pg_restore: error/.test(l));
  if (errors.length > 0) {
    console.error('[restore] pg_restore reported errors:');
    errors.slice(0, 10).forEach((e) => console.error('  ' + e));
    process.exitCode = 1;
  } else {
    console.log('[restore] pg_restore exit 0, zero errors');
  }

  // ── 3. VERIFY: row-count parity + FK + unique constraints ───────────────
  const rst = new PrismaClient({ datasources: { db: { url: `${PG_BASE}/${restoreDb}?schema=public` } } });
  const mismatches = [];
  for (const t of TABLES) {
    if (typeof sourceCounts[t] !== 'number') continue;
    const model = t[0].toLowerCase() + t.slice(1);
    const restored = await rst[model].count();
    const mark = restored === sourceCounts[t] ? 'OK ' : 'FAIL';
    if (restored !== sourceCounts[t]) mismatches.push(`${t}: ${sourceCounts[t]} -> ${restored}`);
    console.log(`[verify] ${mark} ${t.padEnd(24)} ${String(sourceCounts[t]).padStart(6)} → ${String(restored).padStart(6)}`);
  }
  if (mismatches.length) {
    console.error('[verify] ROW-COUNT MISMATCHES: ' + mismatches.join(', '));
    process.exitCode = 1;
  } else {
    console.log(`[verify] row-count parity: ${TABLES.filter((t) => typeof sourceCounts[t] === 'number').length}/${TABLES.length} tables match ✅`);
  }

  // FK integrity — orphan scan on the RESTORED db.
  const fkChecks = [
    ['Employee.organizationId', `SELECT count(*) FROM "Employee" e LEFT JOIN "Organization" o ON o.id=e."organizationId" WHERE o.id IS NULL`],
    ['Device.organizationId', `SELECT count(*) FROM "Device" d LEFT JOIN "Organization" o ON o.id=d."organizationId" WHERE o.id IS NULL`],
    ['ProjectMember.organizationId', `SELECT count(*) FROM "ProjectMember" pm LEFT JOIN "Organization" o ON o.id=pm."organizationId" WHERE o.id IS NULL`],
    ['Device.employeeId', `SELECT count(*) FROM "Device" d LEFT JOIN "Employee" e ON e.id=d."employeeId" WHERE d."employeeId" IS NOT NULL AND e.id IS NULL`],
    ['ConsentLog.consentId', `SELECT count(*) FROM "ConsentLog" cl LEFT JOIN "Consent" c ON c.id=cl."consentId" WHERE cl."consentId" IS NOT NULL AND c.id IS NULL`],
    ['Activity.employeeId', `SELECT count(*) FROM "Activity" a LEFT JOIN "Employee" e ON e.id=a."employeeId" WHERE a."employeeId" IS NOT NULL AND e.id IS NULL`],
  ];
  let fkFail = 0;
  for (const [name, sql] of fkChecks) {
    const rows = await rst.$queryRawUnsafe(sql);
    const n = Number(rows[0]?.count ?? 0);
    const mark = n === 0 ? 'OK ' : 'FAIL';
    if (n !== 0) fkFail++;
    console.log(`[verify] ${mark} FK ${name.padEnd(30)} orphans=${n}`);
  }
  if (fkFail) process.exitCode = 1;
  else console.log(`[verify] FK integrity: ${fkChecks.length}/${fkChecks.length} checks clean ✅`);

  // Unique INDEXES (Prisma emits CREATE UNIQUE INDEX for @unique on PG —
  // they appear in pg_indexes/pg_index with indisunique, NOT as
  // pg_constraint contype='u' table constraints). Verify the critical ones
  // exist, then PROBE with a REAL duplicate value (must be rejected).
  const uniqueIdx = await rst.$queryRaw`
    SELECT i.relname AS name FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_namespace n ON n.oid = i.relnamespace
    WHERE x.indisunique AND n.nspname = 'public'
  `;
  const idxNames = new Set(uniqueIdx.map((r) => r.name));
  // NOTE: DeviceClaim.deviceId is deliberately NOT unique — the zero-touch
  // flow creates a FRESH claim per registration (re-registering devices get
  // new claims; old ones are never resurrected), so multiple claims may share
  // one deviceId over its lifecycle. The schema's non-unique
  // DeviceClaim_deviceId_idx is the correct shape; a unique index here would
  // break re-registration.
  const requiredIdx = [
    'Organization_slug_key',
    'Device_agentKey_key',
    'Consent_employeeId_consentType_key',
    'ConsentPolicy_organizationId_consentType_version_key',
    'ProjectMember_projectId_employeeId_key',
    'AgentToken_token_key',
    'Employee_employeeId_key',
  ];
  for (const name of requiredIdx) {
    const mark = idxNames.has(name) ? 'OK ' : 'FAIL';
    if (!idxNames.has(name)) process.exitCode = 1;
    console.log(`[verify] ${mark} unique index ${name}`);
  }

  // Duplicate-value probes (REAL duplicates — must be rejected). Only a
  // genuine UNIQUE violation (Prisma P2002 / pg 23505) counts as PASS — any
  // other failure (NOT NULL, FK, type) is reported as a probe error instead
  // of a false "duplicate rejected" OK.
  // Accept model-level P2002 or raw-query P2010 whose underlying PG error is
  // 23505 (unique_violation) — surfaced in e.meta.code. Anything else (NOT
  // NULL, FK, type) is NOT a unique rejection.
  const isUniqueViolation = (e) =>
    e instanceof Prisma.PrismaClientKnownRequestError &&
    (e.code === 'P2002' || (e.code === 'P2010' && e.meta?.code === '23505'));

  const slugRow = await rst.$queryRaw`SELECT slug FROM "Organization" LIMIT 1`;
  if (slugRow.length) {
    try {
      await rst.$executeRaw`INSERT INTO "Organization" ("id","name","slug","createdAt","updatedAt") SELECT 'dup-org-test','dup', ${slugRow[0].slug}, now(), now()`;
      console.log('[verify] FAIL Organization.slug duplicate was accepted');
      process.exitCode = 1;
    } catch (e) {
      if (isUniqueViolation(e)) console.log('[verify] OK  Organization.slug rejects duplicate (P2002)');
      else { console.log('[verify] FAIL Organization.slug probe: unexpected error ' + (e?.message ?? e)); process.exitCode = 1; }
    }
  }
  const empRow = await rst.$queryRaw`SELECT "employeeId" FROM "Employee" LIMIT 1`;
  if (empRow.length) {
    try {
      await rst.$executeRaw`INSERT INTO "Employee" ("id","employeeId","firstName","lastName","email","status","organizationId","createdAt","updatedAt","agentApproved") SELECT 'dup-emp-test', ${empRow[0].employeeId}, 'Dup','Emp', 'dup@test.local','active', o.id, now(), now(), false FROM "Organization" o LIMIT 1`;
      console.log('[verify] FAIL Employee.employeeId duplicate was accepted');
      process.exitCode = 1;
    } catch (e) {
      if (isUniqueViolation(e)) console.log('[verify] OK  Employee.employeeId rejects duplicate (P2002)');
      else { console.log('[verify] FAIL Employee.employeeId probe: unexpected error ' + (e?.message ?? e)); process.exitCode = 1; }
    }
  }
  console.log('[verify] unique indexes verified on restored DB ✅');

  // ── 4. APP connectivity smoke (Prisma against restored DB) ───────────────
  const orgCount = await rst.organization.count();
  console.log(`[verify] application connectivity: Prisma SELECT on restored DB → ${orgCount} orgs ✅`);
  await rst.$disconnect();
} finally {
  // ── 5. CLEANUP: drop the disposable database ─────────────────────────────
  try {
    pg('dropdb.exe', ['-h', 'localhost', '-U', 'postgres', '--if-exists', restoreDb]);
    console.log(`[cleanup] dropped disposable DB "${restoreDb}"`);
  } catch (e) {
    console.warn(`[cleanup] could not drop ${restoreDb}: ${e.message.split('\n')[0]}`);
  }
}

// ── 6. RETENTION: keep the 5 most recent backups ────────────────────────────
const dumps = readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.dump')).sort();
while (dumps.length > 5) {
  const stale = dumps.shift();
  unlinkSync(join(BACKUP_DIR, stale));
  console.log(`[retention] removed stale backup ${stale}`);
}
const sizeMb = (statSync(backupFile).size / (1024 * 1024)).toFixed(2);
console.log(`[backup] certified backup: ${basename(backupFile)} (${sizeMb} MB, compressed custom format)`);
console.log(process.exitCode ? 'BACKUP-RESTORE-CERTIFICATION: FAILED' : 'BACKUP-RESTORE-CERTIFICATION: PASSED');

await src.$disconnect();

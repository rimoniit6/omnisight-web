// OmniSight — SQLite → PostgreSQL data migration (G4)
//
// Reads the current SQLite database (db/custom.db by default) read-only and
// writes every table into the PostgreSQL database pointed to by DATABASE_URL.
//
// Guarantees:
//   - FK-safe insert order (Department.managerId resolved in two phases)
//   - Parameterized inserts only (no SQL injection — column/table names come
//     from SQLite's own catalog, values are bound params)
//   - Typed values: datetime columns are sent as Date (UTC-normalized),
//     int/float as numbers, boolean columns as booleans — PostgreSQL does not
//     implicitly cast a `text` bound parameter to timestamp/int/boolean, so
//     untyped text would fail (42804).
//   - Validation: per-table row counts + FK orphan queries + representative
//     application queries. Exits non-zero on any mismatch.
//   - Idempotent: refuses to run if PG already contains Organization rows
//     unless --force is passed (then it clears all tables first).
//
// Usage:
//   DATABASE_URL='postgresql://...' node scripts/migrate-sqlite-to-postgres.mjs [sqlite-path] [--force]
//
// Requires: node >= 22.5 (node:sqlite), Prisma client generated for postgresql.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const force = args.includes('--force');
const sqlitePath = args.find((a) => !a.startsWith('--')) || join(root, 'db', 'custom.db');

if (!existsSync(sqlitePath)) {
  console.error(`SQLite source not found: ${sqlitePath}`);
  process.exit(1);
}

// ─── Table metadata (insert order is FK-safe) ───────────────────────────────
// Department is inserted without managerId, then updated after Employee.
const TABLE_ORDER = [
  'Organization',
  'SystemSetting',
  'AppUser',
  'Department',
  'Employee',
  'Device',
  'DeviceClaim',
  'Activity',
  'MonitoringPolicy',
  'Notification',
  'Alert',
  'AuditLog',
  'Report',
  'AiInsight',
  'AgentRegistration',
  'AgentToken',
  'Screenshot',
  'AppListEntry',
  'UsbEvent',
  'Anomaly',
  'ConsentPolicy',
  'Consent',
  'ConsentLog',
  'OrganizationSetting',
  'JobRun',
  'Project',
  'ProjectMember',
  'TimeEntry',
  'SentimentRecord',
];

// DateTime columns per table (mirrors the Prisma schema exactly).
const DATETIME_COLS = {
  Organization: ['createdAt', 'updatedAt'],
  Department: ['createdAt', 'updatedAt'],
  Employee: ['joinDate', 'leaveDate', 'createdAt', 'updatedAt'],
  Device: ['lastHeartbeat', 'registeredAt', 'updatedAt'],
  DeviceClaim: ['approvedAt', 'rejectedAt', 'expiresAt', 'createdAt', 'updatedAt'],
  Activity: ['timestamp', 'createdAt'],
  MonitoringPolicy: ['createdAt', 'updatedAt'],
  Notification: ['readAt', 'createdAt', 'updatedAt'],
  Alert: ['createdAt', 'updatedAt'],
  AuditLog: ['createdAt'],
  Report: ['periodStart', 'periodEnd', 'createdAt', 'updatedAt'],
  AiInsight: ['createdAt', 'updatedAt'],
  AppUser: ['lastLogin', 'createdAt', 'updatedAt'],
  AgentRegistration: ['createdAt', 'updatedAt'],
  AgentToken: ['expiresAt', 'lastUsedAt', 'createdAt'],
  Screenshot: ['capturedAt', 'createdAt'],
  AppListEntry: ['createdAt', 'updatedAt'],
  UsbEvent: ['createdAt'],
  Anomaly: ['resolvedAt', 'createdAt', 'updatedAt'],
  ConsentPolicy: ['effectiveAt', 'publishedAt', 'createdAt', 'updatedAt'],
  Consent: ['grantedAt', 'revokedAt', 'expiresAt', 'expiredAt', 'createdAt', 'updatedAt'],
  ConsentLog: ['anonymizedAt', 'createdAt'],
  OrganizationSetting: ['updatedAt'],
  JobRun: ['startedAt', 'finishedAt', 'lastRunAt', 'leaseExpiresAt'],
  Project: ['startDate', 'deadline', 'createdAt', 'updatedAt'],
  ProjectMember: ['joinedAt', 'leftAt', 'createdAt', 'updatedAt'],
  TimeEntry: ['date', 'createdAt', 'updatedAt'],
  SentimentRecord: ['periodStart', 'periodEnd', 'createdAt', 'updatedAt'],
  SystemSetting: ['updatedAt'],
};

// Non-text columns per table (int/float/bool). Everything else is text.
const COLUMN_TYPES = {
  Organization: { maxSeats: 'int', currentSeats: 'int' },
  Employee: { agentApproved: 'bool' },
  Activity: { duration: 'int' },
  MonitoringPolicy: {
    screenshotEnabled: 'bool', screenshotFrequency: 'int', screenshotRetentionDays: 'int',
    appTrackingEnabled: 'bool', websiteTrackingEnabled: 'bool', idleDetectionEnabled: 'bool',
    idleTimeoutMinutes: 'int', workingHoursOnly: 'bool',
  },
  AiInsight: { confidence: 'float' },
  AppUser: { isActive: 'bool' },
  Screenshot: { fileSize: 'int', width: 'int', height: 'int', blurScore: 'float', flagged: 'bool' },
  AppListEntry: { isActive: 'bool' },
  UsbEvent: { blocked: 'bool' },
  Anomaly: { score: 'float', confidence: 'float' },
  JobRun: { lastDurationMs: 'int' },
  Project: { estimatedHours: 'float', hourlyRate: 'float' },
  ProjectMember: { hoursPerWeek: 'float' },
  TimeEntry: { hours: 'float', billable: 'bool' },
  SentimentRecord: { score: 'float' },
};

/** Normalize a SQLite datetime to ISO-8601 UTC.
 *  Handles the two encodings found in the legacy DB: ISO-8601 strings (with
 *  optional 'Z' / offset) and NUMERIC unix epochs (milliseconds; seconds if
 *  < 1e12 — legacy Prisma-on-SQLite writes both). Naive strings are UTC. */
function toIso(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    const ms = value < 1e12 ? value * 1000 : value; // seconds → milliseconds
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }
  if (typeof value !== 'string' || value === '') return value;
  const naive = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value);
  try {
    const d = naive ? new Date(value.replace(' ', 'T') + 'Z') : new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toISOString();
  } catch {
    return value;
  }
}

/** Convert a raw SQLite value to the JS type PostgreSQL expects for the column. */
function toPgValue(value, table, col) {
  if (value === null || value === undefined) return null;
  const type = COLUMN_TYPES[table]?.[col] ?? (DATETIME_COLS[table]?.includes(col) ? 'datetime' : 'text');
  switch (type) {
    case 'bool': {
      if (typeof value === 'boolean') return value;
      return value === 1 || value === '1' || value === 'true' || value === 'TRUE' || value === 't' || value === 'yes';
    }
    case 'int': {
      const n = Number(value);
      return Number.isFinite(n) ? Math.trunc(n) : null;
    }
    case 'float': {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case 'datetime': {
      const iso = toIso(value);
      if (typeof iso !== 'string' || iso === '') return null;
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    default: {
      return typeof value === 'string' ? value : String(value);
    }
  }
}

const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
const db = new PrismaClient();

// NOT NULL columns per table (authoritative — read from PG catalog).
const NOT_NULL = {};
{
  const rows = await db.$queryRawUnsafe(
    `SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public'`
  );
  for (const r of rows) {
    if (r.is_nullable === 'NO') {
      (NOT_NULL[r.table_name] ||= new Set()).add(r.column_name);
    }
  }
}
const notNullFills = {}; // table.col -> count of rows defaulted

function defaultFor(colType) {
  switch (colType) {
    case 'bool': return false;
    case 'int':
    case 'float': return 0;
    case 'datetime': return new Date(0); // sentinel: unknown timestamp
    default: return '';
  }
}

/** Coerce null values on NOT NULL columns to a type-appropriate default (tracked). */
function coerceNotNull(values, cols, table) {
  const nn = NOT_NULL[table];
  if (!nn) return values;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === null && nn.has(cols[i])) {
      const type = COLUMN_TYPES[table]?.[cols[i]] ?? (DATETIME_COLS[table]?.includes(cols[i]) ? 'datetime' : 'text');
      values[i] = defaultFor(type);
      const key = `${table}.${cols[i]}`;
      notNullFills[key] = (notNullFills[key] || 0) + 1;
    }
  }
  return values;
}

function sqliteTableNames() {
  return sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
}

function sqliteColumns(table) {
  return sqlite.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
}

function pgCount(table) {
  return db.$queryRawUnsafe(`SELECT COUNT(*)::int AS c FROM "${table}"`).then((r) => Number(r[0].c));
}

function colType(table, col) {
  return COLUMN_TYPES[table]?.[col] ?? (DATETIME_COLS[table]?.includes(col) ? 'datetime' : 'text');
}

/** SQL expression for the Nth bound parameter with an explicit PG cast.
 *  Prisma's $executeRawUnsafe sends ALL bound params as text, so PostgreSQL
 *  will not implicitly cast them — every non-text column needs an explicit
 *  cast. Datetime values are parsed as timestamptz then converted to the UTC
 *  wall clock, so the stored value matches what SQLite held (Prisma's
 *  timestamp(3) columns are UTC-semantics). */
function valueExpr(table, col, idx) {
  const p = `$${idx + 1}`;
  switch (colType(table, col)) {
    case 'int': return `${p}::integer`;
    case 'float': return `${p}::double precision`;
    case 'bool': return `${p}::boolean`;
    case 'datetime': return `(${p}::timestamptz AT TIME ZONE 'UTC')::timestamp(3)`;
    default: return p;
  }
}

/** Build one `(expr, expr, ...)` VALUES group for a row; appends params. */
function valueGroup(table, cols, values, params) {
  const start = params.length;
  params.push(...values);
  return `(${cols.map((c, j) => valueExpr(table, c, start + j)).join(', ')})`;
}

async function insertTable(table) {
  const cols = sqliteColumns(table);
  if (cols.length === 0) {
    console.log(`  ${table}: (no columns)`);
    return;
  }
  const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all();
  if (rows.length === 0) {
    console.log(`  ${table}: 0 rows (empty)`);
    return;
  }

  const colList = cols.map((c) => `"${c}"`).join(', ');
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const params = [];
    const groups = [];
    for (const row of batch) {
      const values = coerceNotNull(cols.map((c) => toPgValue(row[c], table, c)), cols, table);
      groups.push(valueGroup(table, cols, values, params));
    }
    await db.$executeRawUnsafe(
      `INSERT INTO "${table}" (${colList}) VALUES ${groups.join(', ')}`,
      ...params
    );
  }
  console.log(`  ${table}: ${rows.length} rows inserted`);
}

// ─── Pre-flight guard ────────────────────────────────────────────────────────
const existingOrgs = await pgCount('Organization').catch(async (e) => {
  console.error('PG not migrated? Run: npx prisma migrate deploy');
  throw e;
});
if (existingOrgs > 0 && !force) {
  console.error(
    `PG already contains ${existingOrgs} Organization rows. Refusing to duplicate data.\n` +
      'If you really want to start over, pass --force (clears all tables first).'
  );
  process.exit(1);
}
if (existingOrgs > 0 && force) {
  console.log('--force: clearing existing PG tables first…');
  for (const t of [...TABLE_ORDER].reverse()) {
    await db.$executeRawUnsafe(`TRUNCATE TABLE "${t}" CASCADE`).catch(() => undefined);
  }
}

// ─── Migrate ────────────────────────────────────────────────────────────────
console.log(`SQLite source: ${sqlitePath}`);
console.log(`Tables to migrate: ${TABLE_ORDER.length}`);

// Phase 0: tables Department depends on (Organization, then independent tables).
for (const table of ['Organization', 'SystemSetting', 'AppUser']) {
  await insertTable(table);
}

// Phase 1: departments WITHOUT managerId (the manager FK resolves in phase 2,
// after Employee rows exist).
const deptCols = sqliteColumns('Department');
const deptInsertCols = deptCols.filter((c) => c !== 'managerId');
const deptRows = sqlite.prepare('SELECT * FROM "Department"').all();
for (const row of deptRows) {
  const values = coerceNotNull(
    deptInsertCols.map((c) => toPgValue(row[c], 'Department', c)),
    deptInsertCols,
    'Department'
  );
  const group = valueGroup('Department', deptInsertCols, values, []);
  await db.$executeRawUnsafe(
    `INSERT INTO "Department" (${deptInsertCols.map((c) => `"${c}"`).join(', ')}) VALUES ${group}`,
    ...values
  );
}
console.log(`  Department: ${deptRows.length} rows inserted (managerId deferred)`);

for (const table of TABLE_ORDER) {
  if (table === 'Department' || table === 'Organization' || table === 'SystemSetting' || table === 'AppUser') continue;
  await insertTable(table);
}

// Phase 2: resolve Department.managerId (circular FK with Employee).
let managerResolved = 0;
for (const row of deptRows) {
  if (row.managerId) {
    await db.$executeRawUnsafe(
      `UPDATE "Department" SET "managerId" = $1 WHERE "id" = $2`,
      String(row.managerId),
      String(row.id)
    );
    managerResolved++;
  }
}
console.log(`  Department.managerId: ${managerResolved} resolved`);

// ─── Validation ─────────────────────────────────────────────────────────────
if (Object.keys(notNullFills).length > 0) {
  console.log('\n=== NOT-NULL DEFAULTS APPLIED (legacy empty/null on required columns) ===');
  for (const [key, n] of Object.entries(notNullFills)) {
    console.log(`  ${key}: ${n} row(s) defaulted (datetime -> epoch, text -> '', number -> 0)`);
  }
}
console.log('\n=== VALIDATION ===');
let failures = 0;
const sqliteTables = sqliteTableNames();
for (const table of TABLE_ORDER) {
  if (!sqliteTables.includes(table)) {
    console.log(`  SKIP  ${table} (not present in SQLite)`);
    continue;
  }
  const sCount = Number(sqlite.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c);
  const pCount = await pgCount(table);
  const ok = sCount === pCount;
  if (!ok) failures++;
  console.log(`  ${ok ? 'OK ' : 'FAIL'} ${table.padEnd(28)} sqlite=${sCount} pg=${pCount}`);
}
for (const t of sqliteTables) {
  if (!TABLE_ORDER.includes(t)) console.log(`  NOTE ${t} exists in SQLite but has no model — not migrated`);
}

// FK orphan checks (high-value relationships).
const fkChecks = [
  ['Device.organizationId', `SELECT COUNT(*)::int FROM "Device" d LEFT JOIN "Organization" o ON d."organizationId"=o."id" WHERE o."id" IS NULL`],
  ['Device.employeeId', `SELECT COUNT(*)::int FROM "Device" d LEFT JOIN "Employee" e ON d."employeeId"=e."id" WHERE d."employeeId" IS NOT NULL AND e."id" IS NULL`],
  ['DeviceClaim.deviceId', `SELECT COUNT(*)::int FROM "DeviceClaim" c LEFT JOIN "Device" d ON c."deviceId"=d."id" WHERE d."id" IS NULL`],
  ['DeviceClaim.employeeId', `SELECT COUNT(*)::int FROM "DeviceClaim" c LEFT JOIN "Employee" e ON c."employeeId"=e."id" WHERE c."employeeId" IS NOT NULL AND e."id" IS NULL`],
  ['Activity.employeeId', `SELECT COUNT(*)::int FROM "Activity" a LEFT JOIN "Employee" e ON a."employeeId"=e."id" WHERE e."id" IS NULL`],
  ['Activity.deviceId', `SELECT COUNT(*)::int FROM "Activity" a LEFT JOIN "Device" d ON a."deviceId"=d."id" WHERE a."deviceId" IS NOT NULL AND d."id" IS NULL`],
  ['Screenshot.employeeId', `SELECT COUNT(*)::int FROM "Screenshot" s LEFT JOIN "Employee" e ON s."employeeId"=e."id" WHERE e."id" IS NULL`],
  ['Consent.employeeId', `SELECT COUNT(*)::int FROM "Consent" c LEFT JOIN "Employee" e ON c."employeeId"=e."id" WHERE e."id" IS NULL`],
  ['Consent.policyId', `SELECT COUNT(*)::int FROM "Consent" c LEFT JOIN "ConsentPolicy" p ON c."policyId"=p."id" WHERE c."policyId" IS NOT NULL AND p."id" IS NULL`],
  ['ConsentLog.consentId', `SELECT COUNT(*)::int FROM "ConsentLog" l LEFT JOIN "Consent" c ON l."consentId"=c."id" WHERE c."id" IS NULL`],
  ['ProjectMember.projectId', `SELECT COUNT(*)::int FROM "ProjectMember" m LEFT JOIN "Project" p ON m."projectId"=p."id" WHERE p."id" IS NULL`],
  ['ProjectMember.employeeId', `SELECT COUNT(*)::int FROM "ProjectMember" m LEFT JOIN "Employee" e ON m."employeeId"=e."id" WHERE e."id" IS NULL`],
  ['TimeEntry.projectId', `SELECT COUNT(*)::int FROM "TimeEntry" t LEFT JOIN "Project" p ON t."projectId"=p."id" WHERE p."id" IS NULL`],
  ['Project.departmentId', `SELECT COUNT(*)::int FROM "Project" p LEFT JOIN "Department" d ON p."departmentId"=d."id" WHERE p."departmentId" IS NOT NULL AND d."id" IS NULL`],
  ['Department.managerId', `SELECT COUNT(*)::int FROM "Department" d LEFT JOIN "Employee" e ON d."managerId"=e."id" WHERE d."managerId" IS NOT NULL AND e."id" IS NULL`],
];
for (const [label, sql] of fkChecks) {
  const n = Number((await db.$queryRawUnsafe(sql))[0].count);
  if (n > 0) failures++;
  console.log(`  ${n === 0 ? 'OK ' : 'FAIL'} FK ${label.padEnd(28)} orphans=${n}`);
}

// Representative application queries.
const [orgs, devices, claims, pending, consents, granted, activities, shots] = await Promise.all([
  db.organization.count(),
  db.device.count(),
  db.deviceClaim.count(),
  db.deviceClaim.count({ where: { status: 'pending' } }),
  db.consent.count(),
  db.consent.count({ where: { status: 'granted' } }),
  db.activity.count(),
  db.screenshot.count(),
]);
console.log('\n=== REPRESENTATIVE QUERIES (PG) ===');
console.log(`  organizations=${orgs} devices=${devices} claims=${claims} (pending=${pending})`);
console.log(`  consents=${consents} (granted=${granted}) activities=${activities} screenshots=${shots}`);

sqlite.close();
await db.$disconnect();

console.log(failures === 0 ? '\n=== SQLite → PostgreSQL MIGRATION: PASS ===' : `\n=== MIGRATION: ${failures} VALIDATION FAILURES ===`);
process.exit(failures === 0 ? 0 : 1);

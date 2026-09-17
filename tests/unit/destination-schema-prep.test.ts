// Destination-schema preparation unit tests (schema-sync replacement).
//
// The old `prisma db push` of the FULL schema onto non-empty destinations
// refused destructively. These tests lock in the replacement: the FULL script
// is REDUCED to exactly the migration-plan tables plus a reduced Organization
// anchor — a destination may only ever carry what the copy/verify phases use.
//
//   SSC-1  subsetDestinationSchemaSql keeps plan tables + the reduced
//          Organization anchor and drops platform/control-plane tables, with
//          NO destructive DDL (no DROP/TRUNCATE) and no schema creation.
//   SSC-2  The reduced Organization carries EXACTLY the 9 anchor columns + its
//          primary key — no logo/subscriptionId/deploymentMode/… control-plane
//          fields. Its anchor-only unique index is kept.
//   SSC-3  Org-internal foreign keys and plan-table indexes are kept; any FK
//          referencing a dropped platform table, and any index on a dropped
//          Organization column, is dropped.
//   SSC-4  Enum types used ONLY by dropped platform columns are not emitted.
//   SSC-5  splitSqlStatements yields ';'-terminated, re-joinable statements.
//   SSC-6  parseDiffScript tolerates the leading CreateSchema block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  subsetDestinationSchemaSql,
  splitSqlStatements,
  parseDiffScript,
  ORGANIZATION_ANCHOR_COLUMNS,
} from '../../src/lib/migration/db-migrate';

// Realistic `prisma migrate diff --from-empty --script` output for the FULL
// schema: platform tables (Plan, AppUser, Subscription), the full Organization
// model, plan tables (Department, Project, Employee, Device, AuditLog),
// indexes and foreign keys. Note Subscription's enum is declared AFTER its
// table — order in the diff must not matter to the parser.
const SAMPLE_DIFF = `-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "DeploymentMode" AS ENUM ('MANAGED', 'CUSTOMER_DB');

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isSelfHosted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "AppUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "planId" TEXT NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'CANCELED', 'PAST_DUE');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logo" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Dhaka',
    "language" TEXT NOT NULL DEFAULT 'en',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "address" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "subscriptionId" TEXT,
    "trialEndsAt" TIMESTAMP(3),
    "screenshotInterval" INTEGER NOT NULL DEFAULT 10,
    "activeDeviceCount" INTEGER NOT NULL DEFAULT 0,
    "lastDataExpiryReminderAt" TIMESTAMP(3),
    "deploymentMode" "DeploymentMode" NOT NULL DEFAULT 'MANAGED',
    "deploymentModeUnresolved" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "managerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "departmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "departmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AppUser_email_key" ON "AppUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "Organization_subscriptionId_idx" ON "Organization"("subscriptionId");

-- CreateIndex
CREATE INDEX "Employee_departmentId_idx" ON "Employee"("departmentId");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_idx" ON "AuditLog"("organizationId");

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
`;

test('SSC-1: subset keeps plan tables + reduced Organization, drops platform tables, no destructive DDL', () => {
  const out = subsetDestinationSchemaSql(SAMPLE_DIFF);
  for (const table of ['Organization', 'Department', 'Project', 'Employee', 'Device', 'AuditLog']) {
    assert.match(out, new RegExp(`CREATE TABLE "${table}"`), `expected plan table ${table}`);
  }
  for (const dropped of ['Plan', 'AppUser', 'Subscription', 'OrganizationBranding']) {
    assert.doesNotMatch(out, new RegExp(`CREATE TABLE "${dropped}"`), `platform table ${dropped} must not be created`);
  }
  assert.doesNotMatch(out, /CREATE SCHEMA/, 'no schema ownership statement');
  assert.doesNotMatch(out, /\bDROP\b/i, 'never destructive');
  assert.doesNotMatch(out, /\bTRUNCATE\b/i, 'never destructive');
});

test('SSC-2: reduced Organization has EXACTLY the anchor columns + primary key', () => {
  const out = subsetDestinationSchemaSql(SAMPLE_DIFF);
  const org = out.match(/CREATE TABLE "Organization" \(([\s\S]*?)\);/)?.[1];
  assert.ok(org, 'reduced Organization CREATE TABLE must be present');
  for (const col of ORGANIZATION_ANCHOR_COLUMNS) {
    assert.match(org, new RegExp(`"${col}"`), `anchor column "${col}" must be present`);
  }
  assert.match(org, /CONSTRAINT "Organization_pkey" PRIMARY KEY \("id"\)/, 'primary key kept');
  for (const dropped of ['logo', 'subscriptionId', 'deploymentMode', 'deploymentModeUnresolved', 'trialEndsAt', 'screenshotInterval', 'activeDeviceCount', 'address', 'phone', 'email', 'lastDataExpiryReminderAt']) {
    assert.doesNotMatch(org!, new RegExp(`"${dropped}"`), `control-plane column "${dropped}" must not appear`);
  }
  const columnLines = org!.split('\n').map((l) => l.trim()).filter((l) => /^"/.test(l));
  assert.equal(columnLines.length, ORGANIZATION_ANCHOR_COLUMNS.length, 'exactly the anchor columns, no more');
  assert.match(out, /CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"/, 'anchor unique index kept');
});

test('SSC-3: org-internal FKs/indexes kept; platform references and dropped-column indexes dropped', () => {
  const out = subsetDestinationSchemaSql(SAMPLE_DIFF);
  assert.match(out, /ALTER TABLE "Employee" ADD CONSTRAINT "Employee_departmentId_fkey" FOREIGN KEY \("departmentId"\) REFERENCES "Department"/, 'org-internal FK kept');
  assert.match(out, /ALTER TABLE "Device" ADD CONSTRAINT "Device_employeeId_fkey"/, 'org-internal FK kept');
  assert.doesNotMatch(out, /Organization_subscriptionId_fkey/, 'FK to a platform table must be dropped');
  assert.doesNotMatch(out, /AppUser_email_key/, 'index on a platform table must be dropped');
  assert.doesNotMatch(out, /Organization_subscriptionId_idx/, 'index on a dropped Organization column must be dropped');
  assert.match(out, /CREATE INDEX "Employee_departmentId_idx"/, 'plan-table index kept');
});

test('SSC-4: no enum emitted when it is used only by dropped platform columns', () => {
  const out = subsetDestinationSchemaSql(SAMPLE_DIFF);
  assert.doesNotMatch(out, /CREATE TYPE/, 'DeploymentMode / SubscriptionStatus are not used by kept tables');
});

test('SSC-5: splitSqlStatements yields ";"-terminated, re-joinable statements', () => {
  const out = subsetDestinationSchemaSql(SAMPLE_DIFF);
  const statements = splitSqlStatements(out);
  assert.ok(statements.length > 0, 'there is at least one statement');
  let hasTable = false;
  for (const statement of statements) {
    const trimmed = statement.trim();
    assert.ok(trimmed.length > 0, 'no empty statement');
    assert.ok(trimmed.endsWith(';'), `statement must end in ';': ${trimmed.slice(0, 60)}`);
    if (/CREATE TABLE "Organization"/.test(trimmed)) hasTable = true;
  }
  const joined = statements.join('\n').replace(/\s+/g, '');
  assert.equal(joined, out.replace(/\s+/g, ''), 're-joining preserves the script');
  assert.ok(hasTable, 'the reduced Organization table survives splitting');
});

test('SSC-6: parseDiffScript tolerates the leading CreateSchema block and mixed section order', () => {
  const statements = parseDiffScript(SAMPLE_DIFF);
  assert.ok(statements.length > 0);
  const kinds = new Set(statements.map((s) => s.kind));
  assert.ok(kinds.has('table'), 'tables parsed');
  assert.ok(kinds.has('index'), 'indexes parsed');
  assert.ok(kinds.has('fk'), 'foreign keys parsed');
  // No Section is left dangling: the Subscription table parsing must not have
  // swallowed the enum header declared after it.
  const enumStmts = statements.filter((s) => s.kind === 'enum');
  assert.equal(enumStmts.length, 2, 'both enum declarations parsed despite odd ordering');
});
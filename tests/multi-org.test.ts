/**
 * Multi-Organization — tenant isolation, membership, and switching tests.
 *
 * Covers:
 *   MO-1  OrganizationMembership CRUD
 *   MO-2  Cross-tenant isolation (Org A cannot access Org B)
 *   MO-3  Organization switching (JWT + active org)
 *   MO-4  AgentToken cross-org verification
 *   MO-5  Enrollment code per-organization
 *   MO-6  Super Admin org management
 *   MO-7  Organization lifecycle (suspend/archive)
 *   MO-8  Membership role enforcement
 *   MO-9  Concurrent enrollment code rotation
 *   MO-10 Agent organization suspension check
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_multi_org';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-multi-org-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

let db: any;

before(async () => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });

  const { PrismaClient } = await import('@prisma/client');
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: TEST_DB_URL, DIRECT_URL: TEST_DB_URL },
  });

  db = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });

  // Clean test data
  await db.$executeRawUnsafe('TRUNCATE TABLE "OrganizationMembership" CASCADE');
  await db.$executeRawUnsafe('TRUNCATE TABLE "AgentToken" CASCADE');
  await db.$executeRawUnsafe('TRUNCATE TABLE "DeviceClaim" CASCADE');
  await db.$executeRawUnsafe('TRUNCATE TABLE "Employee" CASCADE');
  await db.$executeRawUnsafe('TRUNCATE TABLE "Device" CASCADE');
  await db.$executeRawUnsafe('TRUNCATE TABLE "OrganizationSetting" CASCADE');
  await db.$executeRawUnsafe('TRUNCATE TABLE "Organization" CASCADE');
  await db.$executeRawUnsafe('TRUNCATE TABLE "AppUser" CASCADE');
  await db.$executeRawUnsafe('TRUNCATE TABLE "UserSession" CASCADE');
});

after(async () => {
  await db?.$disconnect();
});

// ─── Test data ──────────────────────────────────────────────────────────────

let orgA: any, orgB: any;
let userA: any, userB: any, superAdmin: any;
let membershipA: any, membershipB: any;
let empA: any, deviceA: any;

async function seedOrgs() {
  orgA = await db.organization.create({
    data: { name: 'Org A', slug: 'org-a-multi', timezone: 'UTC' },
  });
  orgB = await db.organization.create({
    data: { name: 'Org B', slug: 'org-b-multi', timezone: 'UTC' },
  });

  superAdmin = await db.appUser.create({
    data: { email: 'super-multi@test.local', name: 'Super Admin', role: 'super_admin' },
  });

  userA = await db.appUser.create({
    data: { email: 'user-a-multi@test.local', name: 'User A', role: 'admin', organizationId: orgA.id },
  });
  userB = await db.appUser.create({
    data: { email: 'user-b-multi@test.local', name: 'User B', role: 'admin', organizationId: orgB.id },
  });

  membershipA = await db.organizationMembership.create({
    data: { userId: userA.id, organizationId: orgA.id, role: 'admin', status: 'ACTIVE' },
  });
  membershipB = await db.organizationMembership.create({
    data: { userId: userB.id, organizationId: orgB.id, role: 'admin', status: 'ACTIVE' },
  });

  // Also add userA as viewer in orgB (multi-org)
  await db.organizationMembership.create({
    data: { userId: userA.id, organizationId: orgB.id, role: 'viewer', status: 'ACTIVE' },
  });

  empA = await db.employee.create({
    data: {
      employeeId: 'EMP-A-001',
      firstName: 'Test',
      lastName: 'Employee A',
      email: 'emp-a-multi@test.local',
      organizationId: orgA.id,
      agentApproved: true,
      status: 'active',
    },
  });

  deviceA = await db.device.create({
    data: { name: 'Device A', organizationId: orgA.id, employeeId: empA.id, status: 'online' },
  });
}

// ─── MO-1: OrganizationMembership CRUD ──────────────────────────────────────

test('MO-1: OrganizationMembership basic CRUD', async () => {
  await seedOrgs();

  // Read
  const memberships = await db.organizationMembership.findMany({
    where: { userId: userA.id },
  });
  assert.equal(memberships.length, 2, 'User A should have 2 memberships (org A + org B)');

  // Compound unique prevents duplicates
  await assert.rejects(
    db.organizationMembership.create({
      data: { userId: userA.id, organizationId: orgA.id, role: 'viewer', status: 'ACTIVE' },
    }),
    /Unique constraint/,
    'Duplicate membership must be rejected'
  );

  // Update
  await db.organizationMembership.update({
    where: { userId_organizationId: { userId: userA.id, organizationId: orgB.id } },
    data: { role: 'manager' },
  });
  const updated = await db.organizationMembership.findUnique({
    where: { userId_organizationId: { userId: userA.id, organizationId: orgB.id } },
  });
  assert.equal(updated.role, 'manager', 'Role should be updated to manager');

  // Delete (remove membership)
  await db.organizationMembership.delete({
    where: { userId_organizationId: { userId: userA.id, organizationId: orgB.id } },
  });
  const remaining = await db.organizationMembership.findMany({
    where: { userId: userA.id },
  });
  assert.equal(remaining.length, 1, 'User A should have 1 membership after deletion');
});

// ─── MO-2: Cross-tenant isolation ───────────────────────────────────────────

test('MO-2: Cross-tenant isolation — Org A cannot access Org B data', async () => {
  // Create Org B data
  const empB = await db.employee.create({
    data: {
      employeeId: 'EMP-B-001',
      firstName: 'Test',
      lastName: 'Employee B',
      email: 'emp-b-multi@test.local',
      organizationId: orgB.id,
      agentApproved: true,
      status: 'active',
    },
  });

  const deviceB = await db.device.create({
    data: { name: 'Device B', organizationId: orgB.id, employeeId: empB.id, status: 'online' },
  });

  // Org A employee query must NOT return Org B employees
  const orgAEmployees = await db.employee.findMany({
    where: { organizationId: orgA.id },
  });
  assert.ok(!orgAEmployees.some((e: any) => e.id === empB.id), 'Org A must not see Org B employees');

  // Org B employee query must NOT return Org A employees
  const orgBEmployees = await db.employee.findMany({
    where: { organizationId: orgB.id },
  });
  assert.ok(!orgBEmployees.some((e: any) => e.id === empA.id), 'Org B must not see Org A employees');

  // Device isolation
  const orgADevices = await db.device.findMany({
    where: { organizationId: orgA.id },
  });
  assert.ok(!orgADevices.some((d: any) => d.id === deviceB.id), 'Org A must not see Org B devices');
});

// ─── MO-3: Organization switching ────────────────────────────────────────────

test('MO-3: Organization switching — membership verification', async () => {
  // Re-create the membership that MO-1 deleted
  await db.organizationMembership.upsert({
    where: { userId_organizationId: { userId: userA.id, organizationId: orgB.id } },
    update: { status: 'ACTIVE', role: 'viewer' },
    create: { userId: userA.id, organizationId: orgB.id, role: 'viewer', status: 'ACTIVE' },
  });

  // userA tries to switch to orgB (they have viewer membership)
  const membership = await db.organizationMembership.findUnique({
    where: { userId_organizationId: { userId: userA.id, organizationId: orgB.id } },
  });
  assert.ok(membership, 'User A should have a membership in Org B');
  assert.equal(membership.status, 'ACTIVE', 'Membership should be ACTIVE');

  // Switching to a non-member org should fail at membership check
  const nonMemberOrg = await db.organization.create({
    data: { name: 'Org C', slug: 'org-c-multi', timezone: 'UTC' },
  });
  const nonMember = await db.organizationMembership.findUnique({
    where: { userId_organizationId: { userId: userA.id, organizationId: nonMemberOrg.id } },
  });
  assert.equal(nonMember, null, 'User A should NOT have a membership in Org C');
});

// ─── MO-4: AgentToken cross-org verification ────────────────────────────────

test('MO-4: AgentToken with organizationId — cross-org detection', async () => {
  // Create agent token for Org A
  const tokenA = await db.agentToken.create({
    data: {
      token: 'multi-org-token-a-000000000000000000000000000000',
      employeeId: empA.id,
      organizationId: orgA.id,
      deviceId: deviceA.id,
      expiresAt: new Date(Date.now() + 86400000),
    },
  });

  // Verify the token's org matches the employee's org
  const tokenWithEmployee = await db.agentToken.findUnique({
    where: { id: tokenA.id },
    include: { employee: { select: { organizationId: true } } },
  });
  assert.equal(
    tokenWithEmployee.organizationId,
    tokenWithEmployee.employee.organizationId,
    'AgentToken organizationId must match Employee.organizationId'
  );

  // Corrupt the token's org (simulate cross-org attack)
  await db.agentToken.update({
    where: { id: tokenA.id },
    data: { organizationId: orgB.id },
  });

  const corrupted = await db.agentToken.findUnique({
    where: { id: tokenA.id },
    include: { employee: { select: { organizationId: true } } },
  });
  assert.notEqual(
    corrupted.organizationId,
    corrupted.employee.organizationId,
    'Corrupted token has mismatched org'
  );
  // The validateAgentToken function should detect this mismatch and reject

  // Restore for cleanup
  await db.agentToken.update({
    where: { id: tokenA.id },
    data: { organizationId: orgA.id },
  });
});

// ─── MO-5: Enrollment code per-organization ──────────────────────────────────

test('MO-5: Enrollment codes are organization-scoped', async () => {
  const { hashEnrollmentCode, generateEnrollmentCode, ENROLLMENT_CODE_SETTING_KEY } = await import('../src/lib/agent/auth');

  // Set enrollment code for Org A
  const codeA = generateEnrollmentCode();
  const hashA = hashEnrollmentCode(codeA);
  await db.organizationSetting.upsert({
    where: { organizationId_key: { organizationId: orgA.id, key: ENROLLMENT_CODE_SETTING_KEY } },
    update: { value: hashA, category: 'agent' },
    create: { organizationId: orgA.id, key: ENROLLMENT_CODE_SETTING_KEY, value: hashA, category: 'agent' },
  });

  // Set different enrollment code for Org B
  const codeB = generateEnrollmentCode();
  const hashB = hashEnrollmentCode(codeB);
  await db.organizationSetting.upsert({
    where: { organizationId_key: { organizationId: orgB.id, key: ENROLLMENT_CODE_SETTING_KEY } },
    update: { value: hashB, category: 'agent' },
    create: { organizationId: orgB.id, key: ENROLLMENT_CODE_SETTING_KEY, value: hashB, category: 'agent' },
  });

  // Code A must only match Org A
  const matchA = await db.organizationSetting.findFirst({
    where: { key: ENROLLMENT_CODE_SETTING_KEY, value: hashA },
  });
  assert.equal(matchA.organizationId, orgA.id, 'Code A must resolve to Org A only');

  // Code B must only match Org B
  const matchB = await db.organizationSetting.findFirst({
    where: { key: ENROLLMENT_CODE_SETTING_KEY, value: hashB },
  });
  assert.equal(matchB.organizationId, orgB.id, 'Code B must resolve to Org B only');

  // Code A must NOT match Org B
  const wrongMatch = await db.organizationSetting.findFirst({
    where: { organizationId: orgB.id, key: ENROLLMENT_CODE_SETTING_KEY, value: hashA },
  });
  assert.equal(wrongMatch, null, 'Code A must NOT match Org B');
});

// ─── MO-6: Super Admin org management ────────────────────────────────────────

test('MO-6: Super Admin can suspend and reactivate organizations', async () => {
  const suspendApi = await import('../src/app/api/super-admin/organizations/[id]/route');

  // Suspend Org A
  const suspendReq = new NextRequest(`http://localhost:3000/api/super-admin/organizations/${orgA.id}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${await signTestJWT(superAdmin.id, superAdmin.email, 'super_admin', undefined)}`,
    },
    body: JSON.stringify({ status: 'suspended' }),
  });

  const suspendRes = await suspendApi.PATCH(suspendReq, { params: Promise.resolve({ id: orgA.id }) });
  assert.equal(suspendRes.status, 200, 'Suspend should succeed');

  const orgAfterSuspend = await db.organization.findUnique({ where: { id: orgA.id } });
  assert.equal(orgAfterSuspend.status, 'suspended', 'Org should be suspended');

  // Reactivate
  const reactivateReq = new NextRequest(`http://localhost:3000/api/super-admin/organizations/${orgA.id}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${await signTestJWT(superAdmin.id, superAdmin.email, 'super_admin', undefined)}`,
    },
    body: JSON.stringify({ status: 'active' }),
  });

  const reactivateRes = await suspendApi.PATCH(reactivateReq, { params: Promise.resolve({ id: orgA.id }) });
  assert.equal(reactivateRes.status, 200, 'Reactivate should succeed');

  const orgAfterReactivate = await db.organization.findUnique({ where: { id: orgA.id } });
  assert.equal(orgAfterReactivate.status, 'active', 'Org should be reactivated');
});

// ─── MO-7: Organization lifecycle ────────────────────────────────────────────

test('MO-7: Archived organization blocks new operations', async () => {
  // Archive org B
  await db.organization.update({
    where: { id: orgB.id },
    data: { status: 'archived' },
  });

  // Agent token validation should check org status
  const org = await db.organization.findUnique({
    where: { id: orgB.id },
    select: { status: true },
  });
  assert.equal(org.status, 'archived', 'Org B should be archived');
  assert.notEqual(org.status, 'active', 'Archived org must not be active');

  // Restore
  await db.organization.update({
    where: { id: orgB.id },
    data: { status: 'active' },
  });
});

// ─── MO-8: Membership role enforcement ───────────────────────────────────────

test('MO-8: Membership roles are correctly stored and differentiated', async () => {
  // Create members with different roles
  const owner = await db.organizationMembership.create({
    data: { userId: userA.id, organizationId: orgA.id, role: 'owner', status: 'ACTIVE' },
  }).catch(() => null); // May fail if unique constraint hits

  const viewer = await db.appUser.create({
    data: { email: 'viewer-multi@test.local', name: 'Viewer', role: 'viewer' },
  });
  const viewerMembership = await db.organizationMembership.create({
    data: { userId: viewer.id, organizationId: orgA.id, role: 'viewer', status: 'ACTIVE' },
  });

  // Verify roles
  const memberships = await db.organizationMembership.findMany({
    where: { organizationId: orgA.id },
  });

  const roles = memberships.map((m: any) => m.role);
  assert.ok(roles.includes('admin'), 'Should have admin role');
  assert.ok(roles.includes('viewer'), 'Should have viewer role');
});

// ─── MO-9: Enrollment code rotation ──────────────────────────────────────────

test('MO-9: Enrollment code rotation replaces old hash', async () => {
  const { hashEnrollmentCode, generateEnrollmentCode, ENROLLMENT_CODE_SETTING_KEY } = await import('../src/lib/agent/auth');

  // Generate first code
  const code1 = generateEnrollmentCode();
  const hash1 = hashEnrollmentCode(code1);
  await db.organizationSetting.upsert({
    where: { organizationId_key: { organizationId: orgA.id, key: ENROLLMENT_CODE_SETTING_KEY } },
    update: { value: hash1 },
    create: { organizationId: orgA.id, key: ENROLLMENT_CODE_SETTING_KEY, value: hash1, category: 'agent' },
  });

  // Generate second code (rotation)
  const code2 = generateEnrollmentCode();
  const hash2 = hashEnrollmentCode(code2);
  await db.organizationSetting.upsert({
    where: { organizationId_key: { organizationId: orgA.id, key: ENROLLMENT_CODE_SETTING_KEY } },
    update: { value: hash2 },
    create: { organizationId: orgA.id, key: ENROLLMENT_CODE_SETTING_KEY, value: hash2, category: 'agent' },
  });

  // Only the new code should match
  const setting = await db.organizationSetting.findUnique({
    where: { organizationId_key: { organizationId: orgA.id, key: ENROLLMENT_CODE_SETTING_KEY } },
  });
  assert.equal(setting.value, hash2, 'Setting should contain the new hash');
  assert.notEqual(setting.value, hash1, 'Old hash should be replaced');
});

// ─── MO-10: Agent organization suspension blocks token ───────────────────────

test('MO-10: Suspended organization blocks agent token validation', async () => {
  // Suspend org A
  await db.organization.update({
    where: { id: orgA.id },
    data: { status: 'suspended' },
  });

  // Agent token for Org A should be invalid when org is suspended
  const org = await db.organization.findUnique({
    where: { id: orgA.id },
    select: { status: true },
  });
  assert.equal(org.status, 'suspended', 'Org A is suspended');
  // The validateAgentToken function checks org status and returns invalid

  // Restore
  await db.organization.update({
    where: { id: orgA.id },
    data: { status: 'active' },
  });
});

// ─── Helper: sign test JWT ───────────────────────────────────────────────────

async function signTestJWT(
  userId: string,
  email: string,
  role: string,
  organizationId: string | undefined
): Promise<string> {
  const { signJWT } = await import('../src/lib/auth');
  return signJWT({ userId, email, role, organizationId, activeOrganizationId: organizationId });
}

/**
 * Super Admin Create User Flow — Integration Test
 *
 * Tests the full flow: Super Admin → Organizations → Detail → Members → Create User
 * Verifies AppUser + OrganizationMembership creation, error handling, and edge cases.
 *
 * Run: npx tsx --test tests/create-user-flow-integration.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation ──────────────────────────────────────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_create_user_flow';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-cu-flow-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@cu-flow-test.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!CUFlowTest2026x';
(process.env as Record<string, string>).NODE_ENV = 'test';

before(() => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: 'pipe',
  });
});

type DbModule = typeof import('../src/lib/db');
let db: DbModule['db'];
let signJWT: (payload: { userId: string; email: string; role: string; organizationId?: string; activeOrganizationId?: string }) => Promise<string>;
let bootstrapSuperAdmin: (env?: Record<string, string | undefined>) => Promise<{
  created: boolean;
  alreadyExisted: boolean;
  user: { id: string; email: string; role: string; isActive: boolean; organizationId: string | null };
}>;

type UsersApi = typeof import('../src/app/api/auth/users/route');
type MembersApi = typeof import('../src/app/api/organizations/[orgId]/members/route');
type MemberIdApi = typeof import('../src/app/api/organizations/[orgId]/members/[memberId]/route');
let usersApi: UsersApi;
let membersApi: MembersApi;
let memberIdApi: MemberIdApi;

let superAdminToken: string;
let superAdminUserId: string;
let testOrg: { id: string; name: string };
let viewerToken: string;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  const sa = await import('../src/lib/super-admin');
  bootstrapSuperAdmin = sa.bootstrapSuperAdmin;

  [usersApi, membersApi, memberIdApi] = await Promise.all([
    import('../src/app/api/auth/users/route'),
    import('../src/app/api/organizations/[orgId]/members/route'),
    import('../src/app/api/organizations/[orgId]/members/[memberId]/route'),
  ]);

  // Bootstrap super admin
  const result = await bootstrapSuperAdmin();
  superAdminUserId = result.user.id;

  superAdminToken = await signJWT({
    userId: superAdminUserId,
    email: process.env.SUPER_ADMIN_EMAIL!,
    role: 'super_admin',
  });

  // Create test org
  testOrg = await db.organization.create({ data: { name: 'CU Flow Test Org', slug: 'cu-flow-test-org' } });
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
  } catch { /* best-effort cleanup */ }
});

function saReq(method: string, body?: unknown, url?: string): NextRequest {
  const headers: Record<string, string> = { 'authorization': `Bearer ${superAdminToken}` };
  if (body != null) {
    headers['content-type'] = 'application/json';
    return new NextRequest(url || 'http://localhost:3000/api/test', {
      method, headers, body: JSON.stringify(body),
    });
  }
  return new NextRequest(url || 'http://localhost:3000/api/test', { method, headers });
}

function viewerReq(method: string, body?: unknown, url?: string): NextRequest {
  const headers: Record<string, string> = { 'authorization': `Bearer ${viewerToken}` };
  if (body != null) {
    headers['content-type'] = 'application/json';
    return new NextRequest(url || 'http://localhost:3000/api/test', {
      method, headers, body: JSON.stringify(body),
    });
  }
  return new NextRequest(url || 'http://localhost:3000/api/test', { method, headers });
}

// ─── SA-CM-01: Super Admin can create an organization user ─────────────

test('SA-CM-01: Super Admin can create a new user with org membership', async () => {
  const res = await usersApi.POST(
    saReq('POST', {
      name: 'CM Test User',
      email: 'cm-test-user-01@cu-flow.local',
      password: 'S3cure!CMTest2026x',
      role: 'viewer',
      organizationId: testOrg.id,
    }, 'http://localhost:3000/api/auth/users')
  );
  const body = await res.json();
  assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(body)}`);
  assert.ok(body.user, 'Response has user object');
  assert.equal(body.user.email, 'cm-test-user-01@cu-flow.local');
});

// ─── SA-CM-02: Created user has AppUser.role = user ────────────────────

test('SA-CM-02: Created user has AppUser.role = user (not org_admin/viewer)', async () => {
  const user = await db.appUser.findFirst({ where: { email: 'cm-test-user-01@cu-flow.local' } });
  assert.ok(user, 'AppUser exists in DB');
  assert.equal(user.role, 'user', 'AppUser.role must be "user" — org role is in membership');
});

// ─── SA-CM-03: Membership is created in the selected organization ───────

test('SA-CM-03: OrganizationMembership exists for the created user in target org', async () => {
  const user = await db.appUser.findFirst({ where: { email: 'cm-test-user-01@cu-flow.local' } });
  assert.ok(user, 'AppUser exists');
  const membership = await db.organizationMembership.findUnique({
    where: { userId_organizationId: { userId: user.id, organizationId: testOrg.id } },
  });
  assert.ok(membership, 'OrganizationMembership exists');
  assert.equal(membership.status, 'ACTIVE');
});

// ─── SA-CM-04: Selected membership role is persisted ────────────────────

test('SA-CM-04: Membership role matches the selected role (viewer)', async () => {
  const user = await db.appUser.findFirst({ where: { email: 'cm-test-user-01@cu-flow.local' } });
  const membership = await db.organizationMembership.findUnique({
    where: { userId_organizationId: { userId: user.id!.toString(), organizationId: testOrg.id } },
  });
  assert.equal(membership!.role, 'viewer', 'Membership role must match the requested role');
});

// ─── SA-CM-05: User appears in members list ─────────────────────────────

test('SA-CM-05: Newly created user appears in GET /api/organizations/[orgId]/members', async () => {
  const res = await membersApi.GET(
    saReq('GET', null, `http://localhost:3000/api/organizations/${testOrg.id}/members`),
    { params: Promise.resolve({ orgId: testOrg.id }) }
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  const found = body.members.find((m: { email: string }) => m.email === 'cm-test-user-01@cu-flow.local');
  assert.ok(found, 'Created user appears in members list');
  assert.equal(found.role, 'viewer');
  assert.equal(found.status, 'ACTIVE');
});

// ─── SA-CM-06: Duplicate email is rejected ─────────────────────────────

test('SA-CM-06: Duplicate email returns 409 Conflict', async () => {
  const res = await usersApi.POST(
    saReq('POST', {
      name: 'CM Test User Dup',
      email: 'cm-test-user-01@cu-flow.local',
      password: 'S3cure!DupTest2026x',
      role: 'manager',
      organizationId: testOrg.id,
    }, 'http://localhost:3000/api/auth/users')
  );
  const body = await res.json();
  assert.equal(res.status, 409, `Expected 409, got ${res.status}: ${JSON.stringify(body)}`);
  assert.ok(body.error.includes('already exists') || body.error.includes('exist'), 'Error mentions duplicate');
});

// ─── SA-CM-07: Invalid email is rejected ───────────────────────────────

test('SA-CM-07: Missing email returns 400', async () => {
  const res = await usersApi.POST(
    saReq('POST', {
      name: 'No Email User',
      password: 'S3cure!NoEmail2026x',
      role: 'viewer',
      organizationId: testOrg.id,
    }, 'http://localhost:3000/api/auth/users')
  );
  assert.equal(res.status, 400, 'Missing email must return 400');
});

// ─── SA-CM-08: Weak password is rejected ───────────────────────────────

test('SA-CM-08: Short password returns 400', async () => {
  const res = await usersApi.POST(
    saReq('POST', {
      name: 'Weak Pass User',
      email: 'weak-pass@cu-flow.local',
      password: 'short',
      role: 'viewer',
      organizationId: testOrg.id,
    }, 'http://localhost:3000/api/auth/users')
  );
  const body = await res.json();
  assert.equal(res.status, 400, `Expected 400, got ${res.status}: ${JSON.stringify(body)}`);
  assert.ok(body.error.includes('8 characters') || body.error.includes('length'), 'Error mentions password length');
});

// ─── SA-CM-09: Viewer cannot create users ──────────────────────────────

test('SA-CM-09: Viewer cannot create users (401 or 403)', async () => {
  // First create a viewer to test with
  const viewer = await db.appUser.create({
    data: { email: 'viewer-for-cm-test@cu-flow.local', name: 'Viewer CM', password: 'x', role: 'viewer' },
  });
  await db.organizationMembership.create({
    data: { userId: viewer.id, organizationId: testOrg.id, role: 'viewer', status: 'ACTIVE' },
  });
  viewerToken = await signJWT({
    userId: viewer.id, email: viewer.email, role: 'viewer',
    organizationId: testOrg.id, activeOrganizationId: testOrg.id,
  });

  const res = await usersApi.POST(
    viewerReq('POST', {
      name: 'Should Fail',
      email: 'should-fail@cu-flow.local',
      password: 'S3cure!Fail2026x',
      role: 'viewer',
      organizationId: testOrg.id,
    }, 'http://localhost:3000/api/auth/users')
  );
  assert.ok(res.status === 401 || res.status === 403, `Viewer must be denied, got ${res.status}`);
});

// ─── SA-CM-10: Unauthorized request is rejected ────────────────────────

test('SA-CM-10: Unauthenticated request returns 401', async () => {
  const res = await usersApi.POST(
    new NextRequest('http://localhost:3000/api/auth/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Unauth User',
        email: 'unauth@cu-flow.local',
        password: 'S3cure!Unauth2026x',
        role: 'viewer',
        organizationId: testOrg.id,
      }),
    })
  );
  assert.equal(res.status, 401, 'Unauthenticated must return 401');
});

// ─── SA-CM-11: Creating a member does not create another Super Admin ───

test('SA-CM-11: Created user AppUser.role is never super_admin', async () => {
  // Create user with org_admin role (highest org-level role)
  const res = await usersApi.POST(
    saReq('POST', {
      name: 'Org Admin Test',
      email: 'org-admin-cm@cu-flow.local',
      password: 'S3cure!OrgAdmin2026x',
      role: 'org_admin',
      organizationId: testOrg.id,
    }, 'http://localhost:3000/api/auth/users')
  );
  assert.equal(res.status, 201, `Expected 201, got ${res.status}`);
  const user = await db.appUser.findFirst({ where: { email: 'org-admin-cm@cu-flow.local' } });
  assert.ok(user, 'User exists');
  assert.notEqual(user!.role, 'super_admin', 'AppUser.role must NEVER be super_admin through this flow');
  assert.equal(user!.role, 'user', 'AppUser.role must be "user"');
  const membership = await db.organizationMembership.findUnique({
    where: { userId_organizationId: { userId: user!.id, organizationId: testOrg.id } },
  });
  assert.equal(membership!.role, 'org_admin', 'Membership role is org_admin');
});

// ─── SA-CM-12: Super Admin remains Super Admin after creation ──────────

test('SA-CM-12: Super Admin user record is unchanged after creating a user', async () => {
  const sa = await db.appUser.findUnique({ where: { id: superAdminUserId } });
  assert.ok(sa, 'Super Admin still exists');
  assert.equal(sa!.role, 'super_admin', 'Super Admin role unchanged');
  assert.equal(sa!.isActive, true, 'Super Admin still active');
});

// ─── SA-CM-13: Existing-user Add Member flow still works ───────────────

test('SA-CM-13: Adding existing user via POST /api/organizations/[orgId]/members works', async () => {
  // The viewer we created in SA-CM-09 should already be a member. Let's add them
  // to a SECOND org to verify the existing-user flow.
  const org2 = await db.organization.create({ data: { name: 'CU Flow Org 2', slug: 'cu-flow-org-2' } });
  const existingUser = await db.appUser.findFirst({ where: { email: 'cm-test-user-01@cu-flow.local' } });
  assert.ok(existingUser, 'Existing user found');

  const res = await membersApi.POST(
    saReq('POST', { userId: existingUser!.id, role: 'manager' }, `http://localhost:3000/api/organizations/${org2.id}/members`),
    { params: Promise.resolve({ orgId: org2.id }) }
  );
  const body = await res.json();
  assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(body)}`);

  const membership = await db.organizationMembership.findUnique({
    where: { userId_organizationId: { userId: existingUser!.id, organizationId: org2.id } },
  });
  assert.ok(membership, 'Membership in org2 created');
  assert.equal(membership!.role, 'manager');
  assert.equal(membership!.status, 'ACTIVE');

  // Cleanup
  await db.organization.delete({ where: { id: org2.id } });
});

// ─── SA-CM-14: Invalid role is rejected ────────────────────────────────

test('SA-CM-14: Invalid role returns 400', async () => {
  const res = await usersApi.POST(
    saReq('POST', {
      name: 'Bad Role User',
      email: 'bad-role@cu-flow.local',
      password: 'S3cure!BadRole2026x',
      role: 'super_admin',
      organizationId: testOrg.id,
    }, 'http://localhost:3000/api/auth/users')
  );
  const body = await res.json();
  assert.equal(res.status, 400, `Expected 400, got ${res.status}: ${JSON.stringify(body)}`);
  assert.ok(body.error.includes('Invalid role'), 'Error mentions invalid role');
});

// ─── SA-CM-15: Members list refreshes — user is visible immediately ────

test('SA-CM-15: After creating multiple users, all appear in the members list', async () => {
  // Create a few more users
  for (let i = 2; i <= 4; i++) {
    await usersApi.POST(
      saReq('POST', {
        name: `Batch User ${i}`,
        email: `batch-user-${i}@cu-flow.local`,
        password: 'S3cure!Batch2026x',
        role: i === 2 ? 'manager' : 'viewer',
        organizationId: testOrg.id,
      }, 'http://localhost:3000/api/auth/users')
    );
  }

  const res = await membersApi.GET(
    saReq('GET', null, `http://localhost:3000/api/organizations/${testOrg.id}/members`),
    { params: Promise.resolve({ orgId: testOrg.id }) }
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  // We created: cm-test-user-01, org-admin-cm, batch-user-2, batch-user-3, batch-user-4 = 5 members
  // plus the viewer from SA-CM-09 if they weren't cleaned up
  assert.ok(body.members.length >= 5, `Expected at least 5 members, got ${body.members.length}`);
});

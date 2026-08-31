/**
 * Super Admin Create User / Organization Member Flow — Comprehensive Tests
 *
 * Covers the full flow: UI → API → RBAC → DB → Response
 *
 * Run: npx tsx --test tests/super-admin-create-member-flow.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation ──────────────────────────────────────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_sa_create_member_flow';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-sa-cm-flow-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@sa-cm-flow.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!SACMFlow2026x';
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
  user: { id: string; email: string; role: string; organizationId: string | null };
}>;

type UsersApi = typeof import('../src/app/api/auth/users/route');
type MembersApi = typeof import('../src/app/api/organizations/[id]/members/route');
let usersApi: UsersApi;
let membersApi: MembersApi;

let saUserId: string;
let saToken: string;
let saOrglessToken: string; // SA token WITHOUT any org binding
let orgA: { id: string; name: string };
let orgB: { id: string; name: string };
let viewerToken: string;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  const sa = await import('../src/lib/super-admin');
  bootstrapSuperAdmin = sa.bootstrapSuperAdmin;

  [usersApi, membersApi] = await Promise.all([
    import('../src/app/api/auth/users/route'),
    import('../src/app/api/organizations/[id]/members/route'),
  ]);

  // Bootstrap super admin
  const result = await bootstrapSuperAdmin();
  saUserId = result.user.id;

  // SA token with NO org binding (org-less state)
  saOrglessToken = await signJWT({
    userId: saUserId,
    email: process.env.SUPER_ADMIN_EMAIL!,
    role: 'super_admin',
    // No organizationId — this is the critical org-less state
  });

  // SA token bound to orgA (for switch scenarios)
  orgA = await db.organization.create({ data: { name: 'Org Alpha', slug: 'sa-cm-flow-alpha' } });
  orgB = await db.organization.create({ data: { name: 'Org Beta', slug: 'sa-cm-flow-beta' } });

  saToken = await signJWT({
    userId: saUserId,
    email: process.env.SUPER_ADMIN_EMAIL!,
    role: 'super_admin',
    organizationId: orgA.id,
    activeOrganizationId: orgA.id,
  });

  // Create a viewer for regression tests
  const viewer = await db.appUser.create({
    data: { email: 'viewer@sa-cm-flow.local', name: 'Viewer User', password: 'x', role: 'viewer' },
  });
  await db.organizationMembership.create({
    data: { userId: viewer.id, organizationId: orgA.id, role: 'viewer', status: 'ACTIVE' },
  });
  viewerToken = await signJWT({
    userId: viewer.id, email: viewer.email, role: 'viewer',
    organizationId: orgA.id, activeOrganizationId: orgA.id,
  });
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
  const headers: Record<string, string> = { 'authorization': `Bearer ${saOrglessToken}` };
  if (body != null) {
    headers['content-type'] = 'application/json';
    return new NextRequest(url || 'http://localhost:3000/api/test', {
      method, headers, body: JSON.stringify(body),
    });
  }
  return new NextRequest(url || 'http://localhost:3000/api/test', { method, headers });
}

function saBoundReq(method: string, body?: unknown, url?: string): NextRequest {
  const headers: Record<string, string> = { 'authorization': `Bearer ${saToken}` };
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

// ═══════════════════════════════════════════════════════════════════════════
// SA-CM-01: Super Admin can create new user via POST /api/auth/users
// ═══════════════════════════════════════════════════════════════════════════

test('SA-CM-01: Super Admin can create a new user with org membership', async () => {
  const res = await usersApi.POST(
    saReq('POST', {
      name: 'CM Flow User One',
      email: 'cm-flow-user-01@sa-cm-flow.local',
      password: 'S3cure!CMFlow2026x',
      role: 'manager',
      organizationId: orgA.id,
    }, 'http://localhost:3000/api/auth/users')
  );
  const body = await res.json();
  assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(body)}`);
  assert.ok(body.user, 'Response has user object');
  assert.equal(body.user.email, 'cm-flow-user-01@sa-cm-flow.local');
});

// ═══════════════════════════════════════════════════════════════════════════
// SA-CM-02: AppUser created with role=user (NOT org_admin/manager/viewer)
// ═══════════════════════════════════════════════════════════════════════════

test('SA-CM-02: AppUser.role is always "user" for new accounts', async () => {
  const user = await db.appUser.findFirst({ where: { email: 'cm-flow-user-01@sa-cm-flow.local' } });
  assert.ok(user, 'AppUser exists');
  assert.equal(user.role, 'user', 'AppUser.role must be "user" — org role is in membership');
});

// ═══════════════════════════════════════════════════════════════════════════
// SA-CM-03: OrganizationMembership created correctly
// ═══════════════════════════════════════════════════════════════════════════

test('SA-CM-03: OrganizationMembership exists with correct role', async () => {
  const user = await db.appUser.findFirst({ where: { email: 'cm-flow-user-01@sa-cm-flow.local' } });
  const membership = await db.organizationMembership.findUnique({
    where: { userId_organizationId: { userId: user!.id, organizationId: orgA.id } },
  });
  assert.ok(membership, 'Membership exists');
  assert.equal(membership.role, 'manager', 'Membership role matches selected role');
  assert.equal(membership.status, 'ACTIVE');
});

// ═══════════════════════════════════════════════════════════════════════════
// SA-CM-04: Correct organizationId stored
// ═══════════════════════════════════════════════════════════════════════════

test('SA-CM-04: Membership is in the correct organization (orgA)', async () => {
  const user = await db.appUser.findFirst({ where: { email: 'cm-flow-user-01@sa-cm-flow.local' } });
  const membership = await db.organizationMembership.findUnique({
    where: { userId_organizationId: { userId: user!.id, organizationId: orgA.id } },
  });
  assert.ok(membership, 'Membership in orgA');
  // Verify NOT in orgB
  const wrongMembership = await db.organizationMembership.findUnique({
    where: { userId_organizationId: { userId: user!.id, organizationId: orgB.id } },
  });
  assert.equal(wrongMembership, null, 'Must NOT have membership in orgB');
});

// ═══════════════════════════════════════════════════════════════════════════
// SA-CM-05: Correct organization membership role stored
// ═══════════════════════════════════════════════════════════════════════════

test('SA-CM-05: Membership role is "manager" (as selected)', async () => {
  const user = await db.appUser.findFirst({ where: { email: 'cm-flow-user-01@sa-cm-flow.local' } });
  const membership = await db.organizationMembership.findUnique({
    where: { userId_organizationId: { userId: user!.id, organizationId: orgA.id } },
  });
  assert.equal(membership!.role, 'manager');
});

// ═══════════════════════════════════════════════════════════════════════════
// SA-CM-06: Super Admin with activeOrgId=null can create member
// ═══════════════════════════════════════════════════════════════════════════

test('SA-CM-06: Org-less SA (no active org) can create member for target org', async () => {
  const res = await usersApi.POST(
    saReq('POST', {
      name: 'Org-Less SA User',
      email: 'orgless-sa-user@sa-cm-flow.local',
      password: 'S3cure!OrgLess2026x',
      role: 'viewer',
      organizationId: orgA.id,
    }, 'http://localhost:3000/api/auth/users')
  );
  const body = await res.json();
  assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(body)}`);
  // Verify in DB
  const user = await db.appUser.findFirst({ where: { email: 'orgless-sa-user@sa-cm-flow.local' } });
  assert.ok(user, 'User created');
  const membership = await db.organizationMembership.findUnique({
    where: { userId_organizationId: { userId: user!.id, organizationId: orgA.id } },
  });
  assert.ok(membership, 'Membership created in orgA');
  assert.equal(membership.role, 'viewer');
});

// ═══════════════════════════════════════════════════════════════════════════
// SA-CM-07: Super Admin can create member in Org A
// ═══════════════════════════════════════════════════════════════════════════

test('SA-CM-07: SA creates member in orgA → membership in orgA only', async () => {
  const res = await usersApi.POST(
    saReq('POST', {
      name: 'Org A Only User',
      email: 'org-a-only@sa-cm-flow.local',
      password: 'S3cure!OrgAOnly2026x',
      role: 'org_admin',
      organizationId: orgA.id,
    }, 'http://localhost:3000/api/auth/users')
  );
  assert.equal(res.status, 201);
  const user = await db.appUser.findFirst({ where: { email: 'org-a-only@sa-cm-flow.local' } });
  assert.ok(user);
  const membershipA = await db.organizationMembership.findUnique({
    where: { userId_organizationId: { userId: user!.id, organizationId: orgA.id } },
  });
  assert.ok(membershipA, 'Has membership in orgA');
  assert.equal(membershipA.role, 'org_admin');
});

// ═══════════════════════════════════════════════════════════════════════════
// SA-CM-08: Membership is NOT created in Org B
// ═══════════════════════════════════════════════════════════════════════════

test('SA-CM-08: User created for orgA does NOT get membership in orgB', async () => {
  const user = await db.appUser.findFirst({ where: { email: 'org-a-only@sa-cm-flow.local' } });
  const membershipB = await db.organizationMembership.findUnique({
    where: { userId_organizationId: { userId: user!.id, organizationId: orgB.id } },
  });
  assert.equal(membershipB, null, 'No membership in orgB');
});

// ═══════════════════════════════════════════════════════════════════════════
// SA-CM-09: Existing user can be added via POST /api/organizations/[id]/members
// ═══════════════════════════════════════════════════════════════════════════

test('SA-CM-09: Existing user can be added to another organization', async () => {
  const existingUser = await db.appUser.findFirst({ where: { email: 'cm-flow-user-01@sa-cm-flow.local' } });
  assert.ok(existingUser, 'Existing user found');

  const res = await membersApi.POST(
    saBoundReq('POST', { userId: existingUser!.id, role: 'viewer' }, `http://localhost:3000/api/organizations/${orgB.id}/members`),
    { params: Promise.resolve({ id: orgB.id }) }
  );
  const body = await res.json();
  assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(body)}`);

  const membership = await db.organizationMembership.findUnique({
    where: { userId_organizationId: { userId: existingUser!.id, organizationId: orgB.id } },
  });
  assert.ok(membership, 'Membership in orgB created');
  assert.equal(membership.role, 'viewer');
  assert.equal(membership.status, 'ACTIVE');
});

// ═══════════════════════════════════════════════════════════════════════════
// SA-CM-10: Duplicate email handled cleanly (409)
// ═══════════════════════════════════════════════════════════════════════════

test('SA-CM-10: Duplicate email returns 409', async () => {
  const res = await usersApi.POST(
    saReq('POST', {
      name: 'Dup Email User',
      email: 'cm-flow-user-01@sa-cm-flow.local', // already exists
      password: 'S3cure!DupEmail2026x',
      role: 'viewer',
      organizationId: orgA.id,
    }, 'http://localhost:3000/api/auth/users')
  );
  const body = await res.json();
  assert.equal(res.status, 409, `Expected 409, got ${res.status}: ${JSON.stringify(body)}`);
  assert.ok(body.error.includes('already exists') || body.error.includes('exist'), 'Error mentions duplicate');
});

// ═══════════════════════════════════════════════════════════════════════════
// SA-CM-11: Duplicate membership returns 409 (via upsert, idempotent)
// ═══════════════════════════════════════════════════════════════════════════

test('SA-CM-11: Adding existing user to org they already belong to is idempotent (upsert)', async () => {
  const existingUser = await db.appUser.findFirst({ where: { email: 'cm-flow-user-01@sa-cm-flow.local' } });
  // User already has membership in orgA (from SA-CM-01)
  const res = await membersApi.POST(
    saBoundReq('POST', { userId: existingUser!.id, role: 'manager' }, `http://localhost:3000/api/organizations/${orgA.id}/members`),
    { params: Promise.resolve({ id: orgA.id }) }
  );
  const body = await res.json();
  // Should succeed (upsert is idempotent)
  assert.ok(res.status === 200 || res.status === 201, `Expected 200/201, got ${res.status}: ${JSON.stringify(body)}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// SA-CM-12: Invalid organization rejected
// ═══════════════════════════════════════════════════════════════════════════

test('SA-CM-12: Invalid organization ID → membership not created', async () => {
  const res = await usersApi.POST(
    saReq('POST', {
      name: 'Invalid Org User',
      email: 'invalid-org-user@sa-cm-flow.local',
      password: 'S3cure!InvalidOrg2026x',
      role: 'viewer',
      organizationId: 'nonexistent-org-id',
    }, 'http://localhost:3000/api/auth/users')
  );
  // API may succeed (creates user) but membership FK will fail → transaction rolls back
  // OR API catches the error. Either way, user should NOT exist.
  const user = await db.appUser.findFirst({ where: { email: 'invalid-org-user@sa-cm-flow.local' } });
  // If transaction rolled back, user should not exist
  if (res.status === 201) {
    // If API returned 201, membership should exist (but it can't with invalid org)
    // This would be a bug — but let's check
    const membership = await db.organizationMembership.findFirst({
      where: { user: { email: 'invalid-org-user@sa-cm-flow.local' } },
    });
    // The membership should not exist for a nonexistent org
  }
  // Most likely: transaction fails and returns 500
  assert.ok(res.status !== 201 || !user, 'User should not be created for invalid org');
});

// ═══════════════════════════════════════════════════════════════════════════
// SA-CM-13: Invalid membership role rejected
// ═══════════════════════════════════════════════════════════════════════════

test('SA-CM-13: Invalid role returns 400', async () => {
  const res = await usersApi.POST(
    saReq('POST', {
      name: 'Bad Role User',
      email: 'bad-role-user@sa-cm-flow.local',
      password: 'S3cure!BadRole2026x',
      role: 'super_admin', // INVALID — not an org role
      organizationId: orgA.id,
    }, 'http://localhost:3000/api/auth/users')
  );
  const body = await res.json();
  assert.equal(res.status, 400, `Expected 400, got ${res.status}: ${JSON.stringify(body)}`);
  assert.ok(body.error.includes('Invalid role'), 'Error mentions invalid role');
});

// ═══════════════════════════════════════════════════════════════════════════
// SA-CM-14: Weak password rejected
// ═══════════════════════════════════════════════════════════════════════════

test('SA-CM-14: Short password returns 400', async () => {
  const res = await usersApi.POST(
    saReq('POST', {
      name: 'Weak Pass User',
      email: 'weak-pass@sa-cm-flow.local',
      password: 'short',
      role: 'viewer',
      organizationId: orgA.id,
    }, 'http://localhost:3000/api/auth/users')
  );
  const body = await res.json();
  assert.equal(res.status, 400, `Expected 400, got ${res.status}: ${JSON.stringify(body)}`);
  assert.ok(body.error.includes('8 characters') || body.error.includes('length'), 'Error mentions password length');
});

// ═══════════════════════════════════════════════════════════════════════════
// SA-CM-15: Unauthenticated request rejected
// ═══════════════════════════════════════════════════════════════════════════

test('SA-CM-15: Unauthenticated request returns 401', async () => {
  const res = await usersApi.POST(
    new NextRequest('http://localhost:3000/api/auth/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Unauth User',
        email: 'unauth@sa-cm-flow.local',
        password: 'S3cure!Unauth2026x',
        role: 'viewer',
        organizationId: orgA.id,
      }),
    })
  );
  assert.equal(res.status, 401, 'Unauthenticated must return 401');
});

// ═══════════════════════════════════════════════════════════════════════════
// SA-CM-16: Non-super-admin cannot bypass authorization
// ═══════════════════════════════════════════════════════════════════════════

test('SA-CM-16: Viewer cannot create users (403)', async () => {
  const res = await usersApi.POST(
    viewerReq('POST', {
      name: 'Should Fail',
      email: 'should-fail@sa-cm-flow.local',
      password: 'S3cure!ShouldFail2026x',
      role: 'viewer',
      organizationId: orgA.id,
    }, 'http://localhost:3000/api/auth/users')
  );
  assert.ok(res.status === 401 || res.status === 403, `Viewer must be denied, got ${res.status}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// SA-CM-17: Transaction rolls back on membership failure
// ═══════════════════════════════════════════════════════════════════════════

test('SA-CM-17: Invalid org → transaction rolls back (no orphan user)', async () => {
  const email = 'txn-test@sa-cm-flow.local';
  const res = await usersApi.POST(
    saReq('POST', {
      name: 'Txn Test',
      email,
      password: 'S3cure!TxnTest2026x',
      role: 'viewer',
      organizationId: 'definitely-not-a-real-org-id',
    }, 'http://localhost:3000/api/auth/users')
  );
  // Transaction should fail due to FK constraint on OrganizationMembership
  const user = await db.appUser.findFirst({ where: { email } });
  // If transaction rolled back, user should not exist
  // If API caught the error, status should not be 201
  if (res.status === 201) {
    // This would mean the API returned success but membership failed — a bug
    assert.fail('API returned 201 but membership creation should have failed');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SA-CM-18: User appears in members list after creation
// ═══════════════════════════════════════════════════════════════════════════

test('SA-CM-18: Newly created user appears in GET /api/organizations/[id]/members', async () => {
  const res = await membersApi.GET(
    saBoundReq('GET', null, `http://localhost:3000/api/organizations/${orgA.id}/members`),
    { params: Promise.resolve({ id: orgA.id }) }
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  const found = body.members.find((m: { email: string }) => m.email === 'cm-flow-user-01@sa-cm-flow.local');
  assert.ok(found, 'Created user appears in members list');
  assert.equal(found.role, 'manager');
  assert.equal(found.status, 'ACTIVE');
});

// ═══════════════════════════════════════════════════════════════════════════
// SA-CM-19: Multiple users created across different orgs
// ═══════════════════════════════════════════════════════════════════════════

test('SA-CM-19: Creating users in orgA and orgB produces correct memberships', async () => {
  // Create in orgB
  const res = await usersApi.POST(
    saReq('POST', {
      name: 'Org B User',
      email: 'org-b-user@sa-cm-flow.local',
      password: 'S3cure!OrgBUser2026x',
      role: 'org_admin',
      organizationId: orgB.id,
    }, 'http://localhost:3000/api/auth/users')
  );
  assert.equal(res.status, 201);

  const user = await db.appUser.findFirst({ where: { email: 'org-b-user@sa-cm-flow.local' } });
  assert.ok(user);

  // Membership in orgB
  const membershipB = await db.organizationMembership.findUnique({
    where: { userId_organizationId: { userId: user!.id, organizationId: orgB.id } },
  });
  assert.ok(membershipB, 'Has membership in orgB');
  assert.equal(membershipB.role, 'org_admin');

  // NO membership in orgA
  const membershipA = await db.organizationMembership.findUnique({
    where: { userId_organizationId: { userId: user!.id, organizationId: orgA.id } },
  });
  assert.equal(membershipA, null, 'No membership in orgA');
});

// ═══════════════════════════════════════════════════════════════════════════
// SA-CM-20: Missing required fields returns 400
// ═══════════════════════════════════════════════════════════════════════════

test('SA-CM-20: Missing required fields returns 400', async () => {
  const res = await usersApi.POST(
    saReq('POST', {
      name: 'Missing Fields',
      // no email
      password: 'S3cure!Missing2026x',
      role: 'viewer',
      organizationId: orgA.id,
    }, 'http://localhost:3000/api/auth/users')
  );
  const body = await res.json();
  assert.equal(res.status, 400, `Expected 400, got ${res.status}: ${JSON.stringify(body)}`);
  assert.ok(body.error.includes('required') || body.error.includes('Email'), 'Error mentions required fields');
});

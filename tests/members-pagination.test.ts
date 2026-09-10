/**
 * Members list pagination — regression tests for the members GET API.
 *
 * Covers:
 *   MP-1  Super admin and org admin can both list members
 *   MP-2  No params → pageSize defaults to 25, full membership on one page
 *   MP-3  pageSize=10 splits 13 members into 2 pages with no overlap/dup
 *   MP-4  pageSize 25/50/100 each return the full set in stable order
 *   MP-5  Page beyond the last page → 200 with empty members + correct meta
 *   MP-6  Invalid page/pageSize rejected with 400 (bounded page sizes)
 *   MP-7  Response order matches DB order (createdAt asc, id asc tiebreak)
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_members_pagination).
 * Run: node --import tsx --test tests/members-pagination.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation (set BEFORE any app module import) ──────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_members_pagination';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-members-pagination-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'Test-Password-123!';
(process.env as Record<string, string>).NODE_ENV = 'test';

// ─── Dynamic imports (after env setup) ────────────────────────────────────
type DbModule = typeof import('../src/lib/db');
type AuthModule = typeof import('../src/lib/auth');
type MembersRoute = typeof import('../src/app/api/organizations/[orgId]/members/route');

let db: DbModule['db'];
let signJWT: AuthModule['signJWT'];
let hashPassword: AuthModule['hashPassword'];
let membersRoute: MembersRoute;

let org: { id: string };
let superAdminToken: string;
let orgAdminToken: string;
let orgAdminUserId: string;
let memberUserIds: string[];

before(async () => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    env: { ...process.env, DATABASE_URL: TEST_DB_URL, DIRECT_URL: TEST_DB_URL },
    stdio: 'pipe',
  });

  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  const authModule = await import('../src/lib/auth');
  signJWT = authModule.signJWT;
  hashPassword = authModule.hashPassword;
  membersRoute = await import('../src/app/api/organizations/[orgId]/members/route');

  // Super admin (control-plane actor).
  const superAdmin = await db.appUser.create({
    data: {
      email: 'admin@test.local',
      name: 'Super Admin',
      password: await hashPassword('Test-Password-123!'),
      role: 'super_admin',
      isActive: true,
    },
  });
  superAdminToken = await signJWT({ userId: superAdmin.id, email: superAdmin.email, role: 'super_admin' });

  org = await db.organization.create({
    data: { name: 'Pagination Org', slug: 'pagination-org' },
  });

  // Org admin (real membership so the tenant check passes).
  const orgAdmin = await db.appUser.create({
    data: {
      email: 'owner@pagination.test',
      name: 'Org Owner',
      password: await hashPassword('Test-Password-123!'),
      role: 'user',
      isActive: true,
    },
  });
  await db.organizationMembership.create({
    data: { userId: orgAdmin.id, organizationId: org.id, role: 'org_admin', status: 'ACTIVE' },
  });
  orgAdminUserId = orgAdmin.id;
  orgAdminToken = await signJWT({
    userId: orgAdmin.id,
    email: orgAdmin.email,
    role: 'org_admin',
    organizationId: org.id,
    activeOrganizationId: org.id,
  });

  // 12 additional memberships → total of 13 members in the org.
  const ids: string[] = [];
  for (let i = 1; i <= 12; i++) {
    const u = await db.appUser.create({
      data: {
        email: `member${String(i).padStart(2, '0')}@pagination.test`,
        name: `Member ${i}`,
        password: await hashPassword('Test-Password-123!'),
        role: 'user',
        isActive: true,
      },
    });
    await db.organizationMembership.create({
      data: { userId: u.id, organizationId: org.id, role: 'viewer', status: 'ACTIVE' },
    });
    ids.push(u.id);
  }
  memberUserIds = ids;
});

after(async () => {
  await db?.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
  } catch {
    /* best-effort cleanup */
  }
});

function req(token: string | null, url?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  return new NextRequest(url || `http://localhost:3000/api/organizations/${org.id}/members`, {
    method: 'GET',
    headers,
  });
}

function membersUrl(query: string): string {
  return `http://localhost:3000/api/organizations/${org.id}/members${query}`;
}

async function getMembers(token: string, query = '') {
  const res = await membersRoute.GET(req(token, membersUrl(query)), {
    params: Promise.resolve({ orgId: org.id }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

// ─── MP-1: Both actor types can list ───────────────────────────────────────

test('MP-1: super admin and org admin can both list members', async () => {
  const sa = await getMembers(superAdminToken);
  assert.equal(sa.status, 200);
  const oa = await getMembers(orgAdminToken);
  assert.equal(oa.status, 200);
});

// ─── MP-2: No params → sensible default ────────────────────────────────────

test('MP-2: no params defaults to page 1 / pageSize 25 and returns everything', async () => {
  const { status, body } = await getMembers(superAdminToken);
  assert.equal(status, 200);
  assert.equal(body.members.length, 13);
  assert.deepEqual(body.pagination, { page: 1, pageSize: 25, total: 13, pages: 1 });
});

// ─── MP-3: pageSize=10 splits 13 members across 2 pages ────────────────────

test('MP-3: pageSize=10 → 2 pages, no overlap, no duplicates, union = all 13', async () => {
  const page1 = await getMembers(superAdminToken, '?page=1&pageSize=10');
  assert.equal(page1.status, 200);
  assert.equal(page1.body.members.length, 10);
  assert.deepEqual(page1.body.pagination, { page: 1, pageSize: 10, total: 13, pages: 2 });

  const page2 = await getMembers(superAdminToken, '?page=2&pageSize=10');
  assert.equal(page2.status, 200);
  assert.equal(page2.body.members.length, 3);
  assert.deepEqual(page2.body.pagination, { page: 2, pageSize: 10, total: 13, pages: 2 });

  const p1ids = page1.body.members.map((m: { userId: string }) => m.userId);
  const p2ids = page2.body.members.map((m: { userId: string }) => m.userId);
  const all = [...p1ids, ...p2ids];
  assert.equal(new Set(all).size, 13, 'no overlap or duplicates across pages');
  assert.deepEqual(
    [...new Set(all)].sort(),
    [orgAdminUserId, ...memberUserIds].sort(),
    'union of pages == every membership in the org'
  );
});

// ─── MP-4: pageSize 25/50/100 each return the full set ─────────────────────

test('MP-4: pageSize 25/50/100 each return the full set on one page', async () => {
  for (const pageSize of [25, 50, 100]) {
    const { status, body } = await getMembers(superAdminToken, `?pageSize=${pageSize}`);
    assert.equal(status, 200);
    assert.equal(body.members.length, 13);
    assert.deepEqual(body.pagination, { page: 1, pageSize, total: 13, pages: 1 });
  }
});

// ─── MP-5: page beyond the last page ───────────────────────────────────────

test('MP-5: page beyond the last page returns empty members + correct meta', async () => {
  const { status, body } = await getMembers(superAdminToken, '?page=99&pageSize=10');
  assert.equal(status, 200);
  assert.deepEqual(body.members, []);
  assert.deepEqual(body.pagination, { page: 99, pageSize: 10, total: 13, pages: 2 });
});

// ─── MP-6: Validation ──────────────────────────────────────────────────────

test('MP-6: invalid page/pageSize values are rejected with 400', async () => {
  for (const q of [
    '?pageSize=7',
    '?pageSize=200',
    '?pageSize=abc',
    '?pageSize=0',
    '?pageSize=-5',
    '?page=0',
    '?page=-1',
    '?page=1.5',
    '?page=abc',
  ]) {
    const { status } = await getMembers(orgAdminToken, q);
    assert.equal(status, 400, `expected 400 for ${q}`);
  }
});

// ─── MP-7: Stable ordering matches the DB order ────────────────────────────

test('MP-7: response order matches DB order (createdAt asc, id asc)', async () => {
  const expected = await db.organizationMembership.findMany({
    where: { organizationId: org.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { userId: true },
  });
  const expectedIds = expected.map((m) => m.userId);
  assert.equal(expectedIds.length, 13);

  const { body } = await getMembers(superAdminToken, '?pageSize=100');
  const gotIds = body.members.map((m: { userId: string }) => m.userId);
  assert.deepEqual(gotIds, expectedIds);
});
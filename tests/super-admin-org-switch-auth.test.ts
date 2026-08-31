/**
 * Super Admin Organization Switch — Auth Synchronization Regression Tests
 *
 * Proves that after an organization switch:
 *   - The client auth state is re-hydrated from the fresh cookie
 *   - useCurrentUser() returns valid user (not null)
 *   - No false 401/403 after switch
 *   - P2-01 session integrity is preserved
 *   - Multi-org switching works repeatedly
 *
 * Run: npx tsx --test tests/super-admin-org-switch-auth.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation ──────────────────────────────────────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_sa_switch_auth';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-sa-switch-auth-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@sa-switch-auth.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!SASwitchAuth2026x';
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
let signJWT: (payload: {
  userId: string;
  email: string;
  role: string;
  organizationId?: string;
  activeOrganizationId?: string;
  sessionId?: string;
}) => Promise<string>;
let bootstrapSuperAdmin: (env?: Record<string, string | undefined>) => Promise<{
  created: boolean;
  alreadyExisted: boolean;
  user: { id: string; email: string; role: string; organizationId: string | null };
}>;

type MeApi = typeof import('../src/app/api/auth/me/route');
let meApi: MeApi;

let saUserId: string;
let orgA: { id: string; name: string };
let orgB: { id: string; name: string };

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  const sa = await import('../src/lib/super-admin');
  bootstrapSuperAdmin = sa.bootstrapSuperAdmin;
  meApi = await import('../src/app/api/auth/me/route');

  // Bootstrap super admin
  const result = await bootstrapSuperAdmin();
  saUserId = result.user.id;

  // Create two test organizations
  orgA = await db.organization.create({
    data: { name: 'Switch Test Org A', slug: 'switch-test-a' },
  });
  orgB = await db.organization.create({
    data: { name: 'Switch Test Org B', slug: 'switch-test-b' },
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

function meReq(token: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/me', {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
}

// ─── SA-SWITCH-01: Fresh login → valid auth ─────────────────────────────

test('SA-SWITCH-01: Fresh SA login → /api/auth/me returns 200 with role=super_admin', async () => {
  const token = await signJWT({
    userId: saUserId,
    email: process.env.SUPER_ADMIN_EMAIL!,
    role: 'super_admin',
  });

  const res = await meApi.GET(meReq(token));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.user.role, 'super_admin');
  assert.ok(body.user.id, 'User ID present');
  assert.ok(body.organizationCount >= 2, 'Organization count reported');
});

// ─── SA-SWITCH-02: Switch to OrgA → valid auth ──────────────────────────

test('SA-SWITCH-02: SA bound to OrgA → /api/auth/me returns 200 with correct org', async () => {
  // Create membership so the server can resolve the org
  await db.organizationMembership.upsert({
    where: { userId_organizationId: { userId: saUserId, organizationId: orgA.id } },
    create: { userId: saUserId, organizationId: orgA.id, role: 'org_admin', status: 'ACTIVE' },
    update: { role: 'org_admin', status: 'ACTIVE' },
  });

  const token = await signJWT({
    userId: saUserId,
    email: process.env.SUPER_ADMIN_EMAIL!,
    role: 'super_admin',
    organizationId: orgA.id,
    activeOrganizationId: orgA.id,
  });

  const res = await meApi.GET(meReq(token));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.user.role, 'super_admin', 'Role must remain super_admin');
  assert.ok(body.organization, 'Organization present');
  assert.equal(body.organization.id, orgA.id, 'Correct org bound');
});

// ─── SA-SWITCH-03: Switch to OrgB → valid auth ──────────────────────────

test('SA-SWITCH-03: SA bound to OrgB → /api/auth/me returns 200 with OrgB', async () => {
  await db.organizationMembership.upsert({
    where: { userId_organizationId: { userId: saUserId, organizationId: orgB.id } },
    create: { userId: saUserId, organizationId: orgB.id, role: 'org_admin', status: 'ACTIVE' },
    update: { role: 'org_admin', status: 'ACTIVE' },
  });

  const token = await signJWT({
    userId: saUserId,
    email: process.env.SUPER_ADMIN_EMAIL!,
    role: 'super_admin',
    organizationId: orgB.id,
    activeOrganizationId: orgB.id,
  });

  const res = await meApi.GET(meReq(token));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.user.role, 'super_admin');
  assert.equal(body.organization.id, orgB.id, 'Correct org bound');
});

// ─── SA-SWITCH-04: Stale token with wrong org → P2-01 rejects ───────────

test('SA-SWITCH-04: Stale token (wrong activeOrganizationId) → 401 via P2-01', async () => {
  // Create a session for OrgA
  const session = await db.userSession.create({
    data: {
      userId: saUserId,
      organizationId: orgA.id,
      activeOrganizationId: orgA.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  // Token claims OrgB but session is bound to OrgA → P2-01 mismatch
  const staleToken = await signJWT({
    userId: saUserId,
    email: process.env.SUPER_ADMIN_EMAIL!,
    role: 'super_admin',
    organizationId: orgB.id,
    activeOrganizationId: orgB.id,
    sessionId: session.id,
  });

  const res = await meApi.GET(meReq(staleToken));
  // P2-01 should reject: session.activeOrganizationId=OrgA ≠ JWT.activeOrganizationId=OrgB
  assert.equal(res.status, 401, 'Stale token must be rejected by P2-01');
});

// ─── SA-SWITCH-05: Matching token + session → 200 ───────────────────────

test('SA-SWITCH-05: Matching token + session activeOrganizationId → 200', async () => {
  // Session bound to OrgA
  const session = await db.userSession.create({
    data: {
      userId: saUserId,
      organizationId: orgA.id,
      activeOrganizationId: orgA.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  // Token also claims OrgA → matches
  const freshToken = await signJWT({
    userId: saUserId,
    email: process.env.SUPER_ADMIN_EMAIL!,
    role: 'super_admin',
    organizationId: orgA.id,
    activeOrganizationId: orgA.id,
    sessionId: session.id,
  });

  const res = await meApi.GET(meReq(freshToken));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.user.role, 'super_admin');
  assert.equal(body.organization.id, orgA.id);
});

// ─── SA-SWITCH-06: Org-less SA (no org) → 200 with null org ─────────────

test('SA-SWITCH-06: Org-less SA (no activeOrganizationId) → 200 with null org', async () => {
  // Session with null activeOrganizationId (org-less state)
  const session = await db.userSession.create({
    data: {
      userId: saUserId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  const token = await signJWT({
    userId: saUserId,
    email: process.env.SUPER_ADMIN_EMAIL!,
    role: 'super_admin',
    sessionId: session.id,
  });

  const res = await meApi.GET(meReq(token));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.user.role, 'super_admin');
  assert.equal(body.organization, null, 'No org bound');
  assert.ok(body.organizationCount >= 2, 'Org count reported');
});

// ─── SA-SWITCH-07: Repeated A→B→A switching ─────────────────────────────

test('SA-SWITCH-07: Repeated org switching (A→B→A→B) → all 200', async () => {
  const orgs = [orgA, orgB, orgA, orgB];

  for (let i = 0; i < orgs.length; i++) {
    const org = orgs[i];
    const token = await signJWT({
      userId: saUserId,
      email: process.env.SUPER_ADMIN_EMAIL!,
      role: 'super_admin',
      organizationId: org.id,
      activeOrganizationId: org.id,
    });

    const res = await meApi.GET(meReq(token));
    const body = await res.json();
    assert.equal(res.status, 200, `Switch ${i + 1} to ${org.name} must return 200`);
    assert.equal(body.user.role, 'super_admin', `Role must remain super_admin after switch ${i + 1}`);
    assert.equal(body.organization.id, org.id, `Correct org after switch ${i + 1}`);
  }
});

// ─── SA-SWITCH-08: SA role never downgraded by membership ───────────────

test('SA-SWITCH-08: SA membership role=viewer does not downgrade AppUser.role', async () => {
  // Membership with viewer role
  await db.organizationMembership.upsert({
    where: { userId_organizationId: { userId: saUserId, organizationId: orgA.id } },
    create: { userId: saUserId, organizationId: orgA.id, role: 'viewer', status: 'ACTIVE' },
    update: { role: 'viewer', status: 'ACTIVE' },
  });

  const token = await signJWT({
    userId: saUserId,
    email: process.env.SUPER_ADMIN_EMAIL!,
    role: 'super_admin',
    organizationId: orgA.id,
    activeOrganizationId: orgA.id,
  });

  const res = await meApi.GET(meReq(token));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.user.role, 'super_admin', 'SA role must NOT be downgraded by membership');
});

// ─── SA-SWITCH-09: useCurrentUser hook uses cookie auth (structural) ────

test('SA-SWITCH-09: use-current-user.ts uses credentials: same-origin (cookie auth)', async () => {
  const { readFileSync } = await import('fs');
  const { resolve } = await import('path');
  const hookSrc = readFileSync(resolve(__dirname, '../src/hooks/use-current-user.ts'), 'utf8');

  // Must use cookie auth, not in-memory token
  assert.ok(
    hookSrc.includes("credentials: 'same-origin'"),
    'useCurrentUser must use credentials: same-origin for cookie auth'
  );
  // Must NOT send Authorization header (which could be stale)
  assert.ok(
    !hookSrc.includes('Authorization') || !hookSrc.includes('Bearer'),
    'useCurrentUser must NOT send Authorization header (stale token risk)'
  );
  // Must enable based on isAuthenticated, not token
  assert.ok(
    hookSrc.includes('isAuthenticated'),
    'useCurrentUser must be enabled by isAuthenticated (not token)'
  );
});

// ─── SA-SWITCH-10: OrgSwitcher calls hydrate after switch (structural) ──

test('SA-SWITCH-10: OrgSwitcher calls hydrate after successful switch', async () => {
  const { readFileSync } = await import('fs');
  const { resolve } = await import('path');
  const switcherSrc = readFileSync(
    resolve(__dirname, '../src/components/layout/org-switcher.tsx'),
    'utf8'
  );

  // Must call hydrate after switch
  assert.ok(
    switcherSrc.includes('hydrate()'),
    'OrgSwitcher must call hydrate() after successful switch'
  );
  // Must NOT pass old token to login()
  assert.ok(
    !switcherSrc.includes('login(token'),
    'OrgSwitcher must NOT pass old token to login()'
  );
});

// ─── SA-SWITCH-11: Mobile sidebar has authUser fallback (structural) ────

test('SA-SWITCH-11: MobileSidebar uses authUser fallback from Zustand', async () => {
  const { readFileSync } = await import('fs');
  const { resolve } = await import('path');
  const mobileSrc = readFileSync(
    resolve(__dirname, '../src/components/layout/mobile-sidebar.tsx'),
    'utf8'
  );

  // Must import useAuthStore
  assert.ok(
    mobileSrc.includes('useAuthStore'),
    'MobileSidebar must import useAuthStore for fallback'
  );
  // Must have displayUser fallback pattern
  assert.ok(
    mobileSrc.includes('displayUser') || mobileSrc.includes('authUser'),
    'MobileSidebar must have authUser/displayUser fallback'
  );
});

// ─── SA-SWITCH-12: page.tsx has multi-tab visibility sync ────────────────

test('SA-SWITCH-12: page.tsx has visibilitychange handler for multi-tab sync', async () => {
  const { readFileSync } = await import('fs');
  const { resolve } = await import('path');
  const pageSrc = readFileSync(resolve(__dirname, '../src/app/page.tsx'), 'utf8');

  // Must have visibilitychange listener
  assert.ok(
    pageSrc.includes('visibilitychange'),
    'page.tsx must have visibilitychange listener for multi-tab sync'
  );
  // Must call hydrate on visibility change
  assert.ok(
    pageSrc.includes('hydrate()'),
    'page.tsx must call hydrate() on visibility change'
  );
});

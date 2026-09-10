/**
 * Super Admin Post-Login Routing — Regression Tests (§16)
 *
 * Proves the platform rule: authentication success must NOT place the
 * Super Admin into a tenant operational context.
 *
 *   SUPER_ADMIN_POST_LOGIN_REDIRECT   — page.tsx redirects SA entry to sa-overview;
 *                                       org-less SA login response carries org=null
 *   SUPER_ADMIN_NO_TENANT_DASHBOARD   — no tenant dashboard for SA (structural)
 *   SUPER_ADMIN_NO_ORG_SWITCHER       — OrgSwitcher excludes super_admin
 *   SUPER_ADMIN_MEMBERSHIP_DRIVEN_ORG — SA org context follows ACTIVE membership:
 *                                       bound SA keeps org in login payload (OB-9);
 *                                       membership-less SA stays org-less (OB-2).
 *                                       The platform role is never downgraded.
 *   SUPER_ADMIN_OVERVIEW_LOADS        — Overview calls only control-plane metrics
 *   ORG_ADMIN_STILL_REACHES_TENANT_DASHBOARD — org users keep org context at login
 *   MULTI_MEMBERSHIP_SWITCHING_UNCHANGED     — switch API still live (structural)
 *
 * Run: npx tsx --test tests/super-admin-post-login.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { NextRequest } from 'next/server';

// ─── Test DB isolation ──────────────────────────────────────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_sa_post_login';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-sa-post-login-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@sa-post-login.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!SAPostLogin2026x';
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
let bootstrapSuperAdmin: (env?: Record<string, string | undefined>) => Promise<{
  created: boolean;
  alreadyExisted: boolean;
  user: { id: string; email: string; role: string; organizationId: string | null };
}>;

type LoginApi = typeof import('../src/app/api/auth/login/route');
let loginApi: LoginApi;

let orgA: { id: string; name: string };

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  const sa = await import('../src/lib/super-admin');
  bootstrapSuperAdmin = sa.bootstrapSuperAdmin;
  loginApi = await import('../src/app/api/auth/login/route');

  await bootstrapSuperAdmin();

  orgA = await db.organization.create({
    data: { name: 'Post Login Org A', slug: 'post-login-a' },
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

function loginReq(email: string, password: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

// ─── SUPER_ADMIN_POST_LOGIN_REDIRECT ────────────────────────────────────

test('SUPER_ADMIN_POST_LOGIN_REDIRECT: SA login response carries organization=null', async () => {
  const res = await loginApi.POST(
    loginReq(process.env.SUPER_ADMIN_EMAIL!, process.env.SUPER_ADMIN_PASSWORD!)
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.user.role, 'super_admin');
  assert.equal(
    body.organization,
    null,
    'SA login must NOT auto-attach a tenant organization (was the root cause of the tenant-dashboard landing)'
  );
});

test('SUPER_ADMIN_POST_LOGIN_REDIRECT: page.tsx redirects SA entry page to sa-overview', async () => {
  const pageSrc = readFileSync(resolve(__dirname, '../src/app/page.tsx'), 'utf8');
  assert.ok(
    pageSrc.includes("setCurrentPage('sa-overview')"),
    'AuthGuard must redirect super_admin entry from tenant dashboard to Control Center Overview'
  );
  assert.ok(
    pageSrc.includes("authUser?.role === 'super_admin' && currentPage === 'dashboard'"),
    'Entry redirect must be role-gated and only correct the default dashboard page'
  );
});

// ─── SUPER_ADMIN_NO_TENANT_DASHBOARD ────────────────────────────────────

test('SUPER_ADMIN_NO_TENANT_DASHBOARD: SA entry correction is one-time and role-gated', async () => {
  const pageSrc = readFileSync(resolve(__dirname, '../src/app/page.tsx'), 'utf8');
  // The correction must be a one-time mount effect, not a nav lock
  assert.ok(
    pageSrc.includes('entryPageResolved'),
    'Entry redirect must be one-time (does not restrict later navigation)'
  );
  // The shell registry still contains the tenant dashboard for org users
  assert.ok(
    pageSrc.includes('dashboard: DashboardPage'),
    'Tenant dashboard must remain available for legitimate organization users'
  );
});

// ─── SUPER_ADMIN_NO_ORG_SWITCHER ────────────────────────────────────────

test('SUPER_ADMIN_NO_ORG_SWITCHER: OrgSwitcher early-returns null for super_admin', async () => {
  const switcherSrc = readFileSync(
    resolve(__dirname, '../src/components/layout/org-switcher.tsx'),
    'utf8'
  );
  assert.ok(
    /if \(!token \|\| isSuperAdmin/.test(switcherSrc),
    'OrgSwitcher must not render for super_admin'
  );
  assert.ok(
    !switcherSrc.includes('Create Organization'),
    'OrgSwitcher must not contain the SA quick-create dialog'
  );
});

// ─── SUPER_ADMIN_ORG_CONTEXT_IS_MEMBERSHIP_DRIVEN ────────────────────────

test('SUPER_ADMIN_ORG_CONTEXT_WITH_ACTIVE_MEMBERSHIP: bound SA login keeps org context without losing super_admin', async () => {
  const sa = (await bootstrapSuperAdmin()).user;
  await db.organizationMembership.upsert({
    where: { userId_organizationId: { userId: sa.id, organizationId: orgA.id } },
    create: { userId: sa.id, organizationId: orgA.id, role: 'org_admin', status: 'ACTIVE' },
    update: { role: 'org_admin', status: 'ACTIVE' },
  });

  // With an ACTIVE membership the authoritative contract (organization-bootstrap
  // OB-9) requires the org in the login payload — org context follows membership.
  const res = await loginApi.POST(
    loginReq(process.env.SUPER_ADMIN_EMAIL!, process.env.SUPER_ADMIN_PASSWORD!)
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.user.role, 'super_admin', 'an ACTIVE membership must never downgrade the platform role');
  assert.equal(body.organization?.id, orgA.id, 'SA with an ACTIVE membership resolves org context at login (OB-9)');
});

test('SUPER_ADMIN_NO_MEMBERSHIP_STAYS_ORG_LESS: membership-less SA login returns organization=null', async () => {
  const sa = (await bootstrapSuperAdmin()).user;
  // Remove any membership AND session history so restoreLastActiveOrg (membership.ts)
  // has nothing to re-attach — this isolates the OB-2 org-less contract.
  await db.organizationMembership.deleteMany({ where: { userId: sa.id } });
  await db.userSession.deleteMany({ where: { userId: sa.id } });

  const res = await loginApi.POST(
    loginReq(process.env.SUPER_ADMIN_EMAIL!, process.env.SUPER_ADMIN_PASSWORD!)
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.user.role, 'super_admin');
  assert.equal(body.organization, null, 'an org-less super_admin stays org-less at login (OB-2)');
});

// ─── SUPER_ADMIN_OVERVIEW_LOADS ─────────────────────────────────────────

test('SUPER_ADMIN_OVERVIEW_LOADS: Overview calls only control-plane metrics (no tenant KPIs)', async () => {
  const overviewSrc = readFileSync(
    resolve(__dirname, '../src/components/super-admin/sa-overview-page.tsx'),
    'utf8'
  );
  assert.ok(
    overviewSrc.includes("'/api/super-admin/metrics'"),
    'Overview must fetch control-plane metrics'
  );
  // No tenant operational endpoints
  for (const forbidden of ['/api/employees', '/api/devices', '/api/screenshots', '/api/activities', '/api/alerts']) {
    assert.ok(
      !overviewSrc.includes(forbidden),
      `Overview must NOT call tenant endpoint ${forbidden}`
    );
  }
});

// ─── ORG_ADMIN_STILL_REACHES_TENANT_DASHBOARD ───────────────────────────

test('ORG_ADMIN_STILL_REACHES_TENANT_DASHBOARD: org user login keeps organization context', async () => {
  const { hashPassword } = await import('../src/lib/auth');
  const orgAdmin = await db.appUser.create({
    data: {
      email: 'orgadmin@sa-post-login.local',
      name: 'Org Admin',
      password: await hashPassword('OrgAdmin!2026x'),
      role: 'org_admin',
    },
  });
  await db.organizationMembership.create({
    data: { userId: orgAdmin.id, organizationId: orgA.id, role: 'org_admin', status: 'ACTIVE' },
  });

  const res = await loginApi.POST(loginReq('orgadmin@sa-post-login.local', 'OrgAdmin!2026x'));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.user.role, 'org_admin');
  assert.ok(body.organization, 'Org user keeps organization context at login');
  assert.equal(body.organization.id, orgA.id, 'Correct organization bound');
});

// ─── MULTI_MEMBERSHIP_SWITCHING_UNCHANGED ───────────────────────────────

test('MULTI_MEMBERSHIP_SWITCHING_UNCHANGED: switch API route exists with membership verification', async () => {
  const switchSrc = readFileSync(
    resolve(__dirname, '../src/app/api/me/organization/switch/route.ts'),
    'utf8'
  );
  assert.ok(
    switchSrc.includes('organizationMembership.findUnique'),
    'Switch API must verify ACTIVE membership server-side'
  );
  assert.ok(
    switchSrc.includes("SESSION_COOKIE_NAME"),
    'Switch API must re-issue the session cookie'
  );
  assert.ok(
    switchSrc.includes("deploymentMode !== 'MANAGED'"),
    'SA switch must remain MANAGED-only server-side'
  );
});

// ─── First-run bootstrap gate REMOVED (PRD §43: org creation is a
// Super Admin capability, not a mandatory first-login requirement).
// AuthGuard no longer forces Super Admin to create an org when 0 exist.

// ─── Stale client state cannot override role (§15) ──────────────────────

test('STALE_STATE: auth store never persists token/org to localStorage', async () => {
  const storeSrc = readFileSync(resolve(__dirname, '../src/lib/store.ts'), 'utf8');
  // The token must be memory-only; no persistence of AUTH state to storage.
  // (Non-auth UI state like 'worklens-tour-completed' is fine.)
  const persistedKeys = [...storeSrc.matchAll(/localStorage\.setItem\('([^']+)'/g)].map(m => m[1]);
  for (const key of persistedKeys) {
    assert.ok(
      !/token|org/i.test(key),
      `Auth store must not persist auth-related key '${key}' to localStorage`
    );
  }
  assert.ok(
    !storeSrc.includes("localStorage.setItem('token'") && !storeSrc.includes('activeOrganization'),
    'Auth store must not persist the JWT or an active organization id'
  );
});

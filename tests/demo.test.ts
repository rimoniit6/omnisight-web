// OmniSight — Demo-First Experience test suite (Phases 19–20).
//
// Dedicated throwaway database, same pattern as tests/security.test.ts:
//   • per-suite DB (workai_test_demo) pushed with `prisma db push`
//   • env set BEFORE app-module imports
//   • in-process route invocation via tests/helpers/request.ts
//
// Covers:
//   • demo guards: fail-closed resolution, isDemo marker, cached id
//   • bootstrap/seed idempotency (single demo org, stable counts)
//   • /api/demo/enter: success path, rate limit, server-side org resolution
//   • session isolation: demo JWT resolves ONLY to the demo org
//   • IDOR: foreign employee/screenshot/activity → 403/404
//   • org-switch denial for the demo session
//   • proxy read-only enforcement (mutating paths blocked, GETs allowed)
//   • simulator scoping (demo rows only; lease no-op on second claim)
//   • reset safety (demo rows removed + recreated; customer rows untouched)
//   • landing CTA wiring (hero + navbar point at /api/demo/enter)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { req } from './helpers/request';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_demo';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-demo-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';
process.env.DEMO_USER_EMAIL = 'demo-explorer@test.local';
process.env.DEMO_USER_NAME = 'Demo Explorer';
process.env.DEMO_USER_PASSWORD = 'demo-explorer-password';

// SHORT-LIVED PROCESS (see src/lib/cache-invalidation.ts): the pg LISTEN
// client opened lazily by org-db/org-storage imports keeps the event loop
// alive forever and `node --test` never terminates. run-tests.mjs exports
// NEXT_RUNTIME=nodejs for app-runtime fidelity; this suite does not exercise
// any NEXT_RUNTIME-dependent branch, so we drop it before app-module imports
// so the long-lived-process listener is skipped — exactly as the module
// documents for test runners.
delete process.env.NEXT_RUNTIME;

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

// Module handles populated in before().
type DbModule = typeof import('../src/lib/db');
let db: DbModule['db'];
let signJWT: typeof import('../src/lib/auth').signJWT;
type GuardsModule = typeof import('../src/lib/demo/guards');
let guards: GuardsModule;
let enterRoute: typeof import('../src/app/api/demo/enter/route');
let meRoute: typeof import('../src/app/api/auth/me/route');
let switchRoute: typeof import('../src/app/api/me/organization/switch/route');
let proxyModule: typeof import('../src/proxy');
let simulatorModule: typeof import('../src/lib/demo/simulator');
let resetModule: typeof import('../src/lib/jobs/demo-reset');
let bootstrapModule: typeof import('../scripts/bootstrap-demo');
let seedModule: typeof import('../src/lib/demo/seed');
let claimJob: typeof import('../src/lib/jobs/run').claimJob;
let finishJob: typeof import('../src/lib/jobs/run').finishJob;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  guards = await import('../src/lib/demo/guards');
  enterRoute = await import('../src/app/api/demo/enter/route');
  meRoute = await import('../src/app/api/auth/me/route');
  switchRoute = await import('../src/app/api/me/organization/switch/route');
  proxyModule = await import('../src/proxy');
  simulatorModule = await import('../src/lib/demo/simulator');
  resetModule = await import('../src/lib/jobs/demo-reset');
  seedModule = await import('../src/lib/demo/seed');
  ({ claimJob, finishJob } = await import('../src/lib/jobs/run'));
  bootstrapModule = await import('../scripts/bootstrap-demo');

  // Plan reference catalog — the demo bootstrap requires a Plan for the
  // fictional demo subscription (mirrors src/lib/seed.ts upserts).
  await db.plan.upsert({
    where: { name: 'Business' },
    update: { isActive: true },
    create: {
      name: 'Business',
      description: 'Advanced monitoring with app blocking and location',
      priceMonthly: 9900,
      priceYearly: 99000,
      currency: 'BDT',
      maxDevices: 500,
      retentionDays: 365,
      features: ['basic_tracking', 'screenshots', 'reports', 'export', 'break_detection', 'app_blocking', 'location_tracking'],
      isActive: true,
    },
  });

  // A "customer" organization with its own admin + employee (isolation
  // fixture — created here so the DB is guaranteed ready and module handles
  // are assigned before ANY test or later hook runs).
  const customer = await db.organization.create({ data: { name: 'Customer Org', slug: 'customer-org' } });
  customerOrgId = customer.id;
  const customerAdmin = await db.appUser.create({
    data: {
      email: 'customer-admin@test.local',
      name: 'Customer Admin',
      password: 'x',
      role: 'org_admin',
      isActive: true,
      organizationId: customerOrgId,
    },
  });
  customerAdminToken = await signJWT({
    userId: customerAdmin.id,
    email: customerAdmin.email,
    role: 'org_admin',
    organizationId: customerOrgId,
    activeOrganizationId: customerOrgId,
  });
  const ce = await db.employee.create({
    data: {
      employeeId: 'CUST-001',
      firstName: 'Cust',
      lastName: 'Employee',
      email: 'cust-001@test.local',
      organizationId: customerOrgId,
      status: 'active',
    },
  });
  customerEmployeeRowId = ce.id;
});

after(async () => {
  // Stop the pg LISTEN client started lazily by org-db/org-storage imports —
  // without this its reconnect timer keeps the test process alive after the
  // last test (the suite reports 20/20 but node --test waits ~4 min).
  try {
    const { resetCacheInvalidationState } = await import('../src/lib/cache-invalidation');
    await resetCacheInvalidationState();
  } catch { /* not started — nothing to stop */ }
  await db.$disconnect().catch(() => {});
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
  } catch {
    /* best-effort cleanup */
  }
});

// ─── Shared fixtures ────────────────────────────────────────────────────────

let demoOrgId = '';
let customerOrgId = '';
let demoUserId = '';
let demoToken = '';
let customerAdminToken = '';
let customerEmployeeRowId = '';

async function bootstrapAndSeedDemo() {
  // bootstrap-demo exports bootstrapDemo() — idempotent provisioning.
  const boot = await bootstrapModule.bootstrapDemo();
  demoOrgId = boot.demoOrgId;
  demoUserId = boot.demoUserId;
  await guards.assertDemoOrg(demoOrgId);

  // Deterministic dataset (wipe + seed — safe and idempotent for the demo org).
  await seedModule.resetDemoData(demoOrgId);
  return boot;
}

// ─── 1. Guards / bootstrap ──────────────────────────────────────────────────

test('DEMO-G1: resolveDemoOrganization fails closed when demo is not provisioned', async () => {
  await assert.rejects(() => guards.resolveDemoOrganization(), (e: unknown) => e instanceof guards.DemoOrgError);
});

test('DEMO-G2: bootstrap creates exactly one demo org with MANAGED model and isDemo marker', async () => {
  const boot = await bootstrapAndSeedDemo();
  const org = await db.organization.findUnique({ where: { id: boot.demoOrgId } });
  assert.ok(org);
  assert.equal(org.isDemo, true);
  assert.equal(org.deploymentMode, 'MANAGED');
  const user = await db.appUser.findUnique({ where: { id: boot.demoUserId } });
  assert.ok(user);
  assert.notEqual(user.role, 'super_admin'); // platform power must stay out of reach
  const memberships = await db.organizationMembership.findMany({ where: { userId: boot.demoUserId } });
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].organizationId, demoOrgId);
  assert.equal(memberships[0].role, 'manager');
  assert.equal(memberships[0].status, 'ACTIVE');
});

test('DEMO-G3: bootstrap is idempotent — second run does not duplicate', async () => {
  const second = await bootstrapModule.bootstrapDemo();
  assert.equal(second.demoOrgId, demoOrgId);
  assert.equal(second.demoUserId, demoUserId);
  const demoOrgs = await db.organization.findMany({ where: { isDemo: true } });
  assert.equal(demoOrgs.length, 1);
  const demoUsers = await db.appUser.findMany({ where: { email: process.env.DEMO_USER_EMAIL! } });
  assert.equal(demoUsers.length, 1);
});

test('DEMO-G4: assertDemoOrg rejects a non-demo organization', async () => {
  await assert.rejects(() => guards.assertDemoOrg(customerOrgId), (e: unknown) => e instanceof guards.DemoOrgError);
});

// ─── 2. Entry route ─────────────────────────────────────────────────────────

test('DEMO-E1: GET /api/demo/enter mints a session and redirects to /', async () => {
  const res = await enterRoute.GET(req(null, { ip: '203.0.113.10' }));
  assert.equal(res.status, 302);
  const loc = res.headers.get('location');
  assert.equal(loc, 'http://localhost:3000/');
  const setCookie = res.headers.get('set-cookie') || '';
  assert.ok(setCookie.length > 0, 'session cookie must be set');
  // The cookie name comes from the app's SESSION_COOKIE_NAME (default
  // 'worklens_token') — read the first cookie value generically.
  const cookieValue = setCookie.split(';')[0].split('=')[1] ?? '';
  assert.ok(cookieValue.length > 0);
  demoToken = cookieValue;
  // Decode the JWT payload (no verify — we just read the claims).
  const payload = JSON.parse(Buffer.from(cookieValue.split('.')[1], 'base64url').toString('utf8')) as {
    activeOrganizationId?: string; role?: string;
  };
  assert.equal(payload.activeOrganizationId, demoOrgId);
  assert.equal(payload.role, 'manager');
});

test('DEMO-E1b: proxy treats /api/demo/enter as public (no token required)', async () => {
  // Regression for the production 401: the proxy MUST short-circuit the exact
  // entry path to NextResponse.next() WITHOUT any auth token — the route
  // handler (invoked in DEMO-E1) is the authorizer.
  const NextRequestMod = await import('next/server');
  const request = new NextRequestMod.NextRequest('http://localhost:3000/api/demo/enter', { method: 'GET' });
  const res = await proxyModule.proxy(request);
  assert.notEqual(res.status, 401, 'demo entry must not be rejected by the proxy auth gate');
  assert.equal(res.headers.get('x-middleware-next'), '1');
});

test('DEMO-E1c: proxy still rejects an unauthenticated protected route (control)', async () => {
  const NextRequestMod = await import('next/server');
  const request = new NextRequestMod.NextRequest('http://localhost:3000/api/employees', { method: 'GET' });
  const res = await proxyModule.proxy(request);
  assert.equal(res.status, 401, 'adding /api/demo/enter to PUBLIC_PREFIXES must not weaken other routes');
});

test('DEMO-E2: /api/auth/me reports isDemo=true for the demo session', async () => {
  const res = await meRoute.GET(req(demoToken));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.isDemo, true);
  assert.equal(body.organization.id, demoOrgId);
  assert.equal(body.user.role, 'manager');
});

test('DEMO-E2b: demo session row is consistent (organizationId + activeOrganizationId) and passes verifySessionToken', async () => {
  // 1. The minted JWT carries a sessionId — the UserSession row must hold the
  //    SAME organization in both organizationId and activeOrganizationId so it
  //    matches the JWT's activeOrganizationId claim (P2-01 consistency).
  const payload = JSON.parse(Buffer.from(demoToken.split('.')[1], 'base64url').toString('utf8')) as {
    sessionId?: string; activeOrganizationId?: string;
  };
  assert.ok(payload.sessionId, 'demo JWT must carry a sessionId');
  const session = await db.userSession.findUnique({
    where: { id: payload.sessionId! },
    select: { organizationId: true, activeOrganizationId: true, revokedAt: true, expiresAt: true },
  });
  assert.ok(session, 'session row must exist');
  assert.equal(session.organizationId, demoOrgId);
  assert.equal(session.activeOrganizationId, demoOrgId, 'session.activeOrganizationId must match JWT claim');
  assert.equal(session.revokedAt, null);

  // 2. The token passes the FULL normal session-validation path (JWT verify +
  //    isWebSessionActive + verifySessionActiveOrg) — no demo-specific mechanism.
  const { verifySessionToken } = await import('../src/lib/session');
  const verified = await verifySessionToken(demoToken);
  assert.ok(verified, 'demo session must pass the normal verifySessionToken path');
  assert.equal(verified.activeOrganizationId, demoOrgId);
});

test('DEMO-E3: /api/auth/me reports isDemo=false for a customer session', async () => {
  const res = await meRoute.GET(req(customerAdminToken));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.isDemo, false);
});

test('DEMO-E4: demo org switch to a customer organization is denied', async () => {
  const res = await switchRoute.POST(req(demoToken, { body: { organizationId: customerOrgId } }));
  assert.ok([403, 404].includes(res.status), `expected 403/404, got ${res.status}`);
});

// ─── 3. Simulator ───────────────────────────────────────────────────────────

test('DEMO-S1: simulator writes only into the demo organization', async () => {
  simulatorModule = await import('../src/lib/demo/simulator');
  const before = {
    demo: await db.activity.count({ where: { employee: { organizationId: demoOrgId } } }),
    customer: await db.activity.count({ where: { employee: { organizationId: customerOrgId } } }),
  };
  const result = await simulatorModule.runDemoSimulatorJob(new Date());
  assert.equal(result.ran, true);
  const afterDemo = await db.activity.count({ where: { employee: { organizationId: demoOrgId } } });
  const afterCustomer = await db.activity.count({ where: { employee: { organizationId: customerOrgId } } });
  assert.ok(afterDemo >= before.demo, 'demo activity should not shrink');
  assert.equal(afterCustomer, before.customer, 'customer rows must be untouched');
});

test('DEMO-S2: simulator lease prevents duplicate concurrent runs', async () => {
  // Claim the lease manually, then call the job — it must no-op.
  const claimed = await claimJob('demo_simulator');
  assert.equal(claimed, true);
  const result = await simulatorModule.runDemoSimulatorJob(new Date());
  assert.equal(result.ran, false);
  await finishJob('demo_simulator');
});

// ─── 4. Reset safety ────────────────────────────────────────────────────────

test('DEMO-R1: reset removes and recreates ONLY demo rows; customer rows unchanged', async () => {
  const customerCountsBefore = {
    employees: await db.employee.count({ where: { organizationId: customerOrgId } }),
    devices: await db.device.count({ where: { organizationId: customerOrgId } }),
  };
  const result = await resetModule.resetDemoDataset(demoOrgId);
  assert.ok(result.seed.employees > 0, 'baseline must be recreated');
  const customerCountsAfter = {
    employees: await db.employee.count({ where: { organizationId: customerOrgId } }),
    devices: await db.device.count({ where: { organizationId: customerOrgId } }),
  };
  assert.deepEqual(customerCountsAfter, customerCountsBefore);
  // Demo employees are back (deterministic baseline).
  const demoEmployees = await db.employee.count({ where: { organizationId: demoOrgId } });
  assert.ok(demoEmployees > 0);
});

test('DEMO-R2: demo baseline age is small right after a reset', async () => {
  const age = await resetModule.demoBaselineAgeDays(new Date());
  assert.ok(age >= 0 && age < 1, `expected fresh baseline, got ${age}`);
});

// ─── 5. Proxy read-only enforcement ─────────────────────────────────────────

test('DEMO-P1: demo mutation to /api/employees is blocked by the proxy', async () => {
  const request = new (await import('next/server')).NextRequest('http://localhost:3000/api/employees', {
    method: 'POST',
    headers: { authorization: `Bearer ${demoToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ firstName: 'X' }),
  });
  const res = await proxyModule.proxy(request);
  assert.equal(res.status, 403);
});

test('DEMO-P2: demo GET to /api/employees is allowed by the proxy', async () => {
  const request = new (await import('next/server')).NextRequest('http://localhost:3000/api/employees', {
    method: 'GET',
    headers: { authorization: `Bearer ${demoToken}` },
  });
  const res = await proxyModule.proxy(request);
  assert.equal(res.status, 200, 'GET must pass the proxy (route handler scopes by org)');
});

test('DEMO-P3: customer mutation to /api/employees is NOT blocked by the demo rule', async () => {
  const request = new (await import('next/server')).NextRequest('http://localhost:3000/api/employees', {
    method: 'POST',
    headers: { authorization: `Bearer ${customerAdminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ firstName: 'X' }),
  });
  const res = await proxyModule.proxy(request);
  assert.notEqual(res.status, 403, 'non-demo sessions must not hit the demo read-only rule');
});

// ─── 6. IDOR sweep (Phase 20) ───────────────────────────────────────────────

test('DEMO-I1: demo session cannot read a customer employee', async () => {
  const api = await import('../src/app/api/employees/[id]/route');
  const res = await api.GET(req(demoToken), { params: Promise.resolve({ id: customerEmployeeRowId }) });
  assert.ok([403, 404].includes(res.status));
});

test('DEMO-I2: demo session cannot mutate a customer employee', async () => {
  const api = await import('../src/app/api/employees/[id]/route');
  const res = await api.PUT(
    req(demoToken, { body: { firstName: 'Hacked' } }),
    { params: Promise.resolve({ id: customerEmployeeRowId }) }
  );
  assert.ok([403, 404].includes(res.status));
});

test('DEMO-I3: demo session cannot read a customer screenshot image metadata', async () => {
  // Create a customer-owned screenshot row directly.
  const screenshot = await db.screenshot.create({
    data: {
      organizationId: customerOrgId,
      employeeId: customerEmployeeRowId,
      filePath: 'screenshots/customer/never-uploaded.png',
      fileName: 'never-uploaded.png',
      fileSize: 1,
    },
  });
  const api = await import('../src/app/api/screenshots/[id]/route');
  const res = await api.GET(req(demoToken), { params: Promise.resolve({ id: screenshot.id }) });
  assert.ok([403, 404].includes(res.status));
});

test('DEMO-I4: demo session cannot switch into the customer org (JWT manipulation variant)', async () => {
  // A tampered token claiming the customer org but signed with the demo
  // user id — signature is valid (same secret) but the user's membership is
  // demo-only, so the switch must still fail.
  const tampered = await signJWT({
    userId: demoUserId,
    email: process.env.DEMO_USER_EMAIL!,
    role: 'org_admin', // escalated role claim
    organizationId: customerOrgId,
    activeOrganizationId: customerOrgId,
  });
  const res = await switchRoute.POST(req(tampered, { body: { organizationId: customerOrgId } }));
  assert.ok([403, 404, 401].includes(res.status));
});

// ─── 7. Landing CTA wiring ──────────────────────────────────────────────────

test('DEMO-L1: hero + navbar link to the demo entry endpoint', async () => {
  const hero = await readFile('src/components/landing/HeroSection.tsx', 'utf8');
  assert.ok(hero.includes('"/api/demo/enter"') || hero.includes("'/api/demo/enter'"), 'hero CTA must target /api/demo/enter');
  const nav = await readFile('src/components/landing/LandingNavbar.tsx', 'utf8');
  assert.ok(nav.includes('/api/demo/enter'), 'navbar CTA must target /api/demo/enter');
});

/**
 * Smart Testing Checklist — PHASE 3: Multi-Organization & Tenant Isolation.
 *
 * In-process server tests for org switching and tenant scoping:
 *   M-01  org switch issues a new JWT with the updated activeOrganizationId and
 *         updates the server-authoritative session row
 *   M-02  switching to an org the user is NOT a member of -> 403
 *   M-03  suspended membership / paused org -> 403 (fail closed)
 *   M-04  super admin = MANAGED orgs only; PRIVATE/CUSTOMER_DB orgs rejected
 *   M-05  projects API is strictly org-scoped (tenant A never sees tenant B)
 *   M-06  org-less super admin gets an EMPTY project list (never a global dump)
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_checklist_phase3).
 * Run: npx tsx --test tests/checklist-phase-3-multi-org.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { req } from './helpers/request';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_checklist_phase3';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-checklist-p3-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

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
let verifyJWT: (token: string) => Promise<Record<string, unknown> | null>;
let switchApi: typeof import('../src/app/api/me/organization/switch/route');
let projectsApi: typeof import('../src/app/api/projects/route');

before(async () => {
  db = (await import('../src/lib/db')).db;
  ({ signJWT, verifyJWT } = await import('../src/lib/auth'));
  switchApi = await import('../src/app/api/me/organization/switch/route');
  projectsApi = await import('../src/app/api/projects/route');
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
  } catch {
    /* best-effort cleanup */
  }
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

async function seedOrg(name: string, opts: { deploymentMode?: 'MANAGED' | 'CUSTOMER_DB' | 'PRIVATE' } = {}) {
  return db.organization.create({
    data: { name, slug: name.toLowerCase().replace(/[^a-z0-9]/g, '-'), ...(opts.deploymentMode ? { deploymentMode: opts.deploymentMode } : {}) },
  });
}

async function seedUser(email: string, organizationId: string, role = 'admin') {
  return db.appUser.create({
    data: { email, name: email.split('@')[0], password: 'x', role, isActive: true, organizationId },
  });
}

async function seedMembership(userId: string, organizationId: string, role = 'admin', status = 'ACTIVE') {
  return db.organizationMembership.create({ data: { userId, organizationId, role, status } });
}

/** A session-bound JWT (matching a live UserSession row) for one active org. */
async function tokenFor(userId: string, email: string, role: string, activeOrgId: string, orgId: string) {
  const session = await db.userSession.create({
    data: { userId, organizationId: orgId, activeOrganizationId: activeOrgId, expiresAt: new Date(Date.now() + 3600_000) },
  });
  return signJWT({ userId, email, role, organizationId: orgId, activeOrganizationId: activeOrgId, sessionId: session.id });
}

async function doSwitch(token: string, organizationId: string) {
  const response = await switchApi.POST(req(token, { method: 'POST', body: { organizationId } }));
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body, response };
}

// ─── M-01: valid org switch ─────────────────────────────────────────────────

test('M-01: switch updates the JWT (activeOrganizationId) and the session row', async () => {
  const orgA = await seedOrg('M01 Alpha');
  const orgB = await seedOrg('M01 Beta');
  const user = await seedUser('m01@test.local', orgA.id);
  await seedMembership(user.id, orgA.id, 'manager');
  await seedMembership(user.id, orgB.id, 'manager');

  const token = await tokenFor(user.id, 'm01@test.local', 'manager', orgA.id, orgA.id);
  const r = await doSwitch(token, orgB.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.activeOrganizationId, orgB.id);
  assert.equal((r.body as { role?: string }).role, 'manager', 'role sourced from the membership row');

  // The switch re-issues the JWT via the session cookie (not the body), so the
  // signed cookie value is the fresh token to verify.
  const switchedToken = r.response.cookies.get('worklens_token')?.value;
  assert.ok(switchedToken, 'switch must set a fresh session cookie');
  assert.ok(switchedToken !== token, 'the re-issued JWT differs from the pre-switch token');
  const payload = await verifyJWT(switchedToken);
  assert.equal(payload?.activeOrganizationId, orgB.id);
  assert.equal(payload?.role, 'manager', 'role re-sourced from the membership row, not the old JWT');
  assert.equal(payload?.sessionId, (await verifyJWT(token))?.sessionId, 'sessionId preserved across switch');

  // Server-authoritative session row updated to the new org.
  const session = await db.userSession.findFirst({ where: { userId: user.id } });
  assert.equal(session?.activeOrganizationId, orgB.id);
  assert.equal(session?.organizationId, orgA.id, 'original session org unchanged');
});

// ─── M-02: non-member switch rejected ───────────────────────────────────────

test('M-02: switching to an org without an active membership -> 403', async () => {
  const orgA = await seedOrg('M02 Alpha');
  const foreign = await seedOrg('M02 Foreign');
  const user = await seedUser('m02@test.local', orgA.id);
  await seedMembership(user.id, orgA.id, 'viewer');

  const token = await tokenFor(user.id, 'm02@test.local', 'viewer', orgA.id, orgA.id);
  const r = await doSwitch(token, foreign.id);
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.error, 'Not a member of that organization');
});

// ─── M-03: suspended membership / paused org fail closed ────────────────────

test('M-03: suspended membership and paused org are both rejected with 403', async () => {
  // Suspended membership in the target org.
  const orgA = await seedOrg('M03 Alpha');
  const orgS = await seedOrg('M03 Susp');
  const user = await seedUser('m03@test.local', orgA.id);
  await seedMembership(user.id, orgA.id, 'viewer');
  await seedMembership(user.id, orgS.id, 'viewer', 'SUSPENDED');
  const token = await tokenFor(user.id, 'm03@test.local', 'viewer', orgA.id, orgA.id);
  const susp = await doSwitch(token, orgS.id);
  assert.equal(susp.status, 403, JSON.stringify(susp.body));
  assert.equal(susp.body.error, 'Not a member of that organization');

  // ACTIVE membership but the org itself is paused.
  const orgP = await seedOrg('M03 Paused');
  await db.organization.update({ where: { id: orgP.id }, data: { status: 'paused' } });
  await seedMembership(user.id, orgP.id, 'viewer');
  const paused = await doSwitch(token, orgP.id);
  assert.equal(paused.status, 403, JSON.stringify(paused.body));
  assert.equal(paused.body.error, 'Organization is not active');
});

// ─── M-04: super admin switch boundary ──────────────────────────────────────

test('M-04: super admin switches only into MANAGED organizations', async () => {
  const managed = await seedOrg('M04 Managed'); // default deploymentMode = MANAGED
  const privateOrg = await seedOrg('M04 Private', { deploymentMode: 'PRIVATE' });
  const customerDb = await seedOrg('M04 Customer', { deploymentMode: 'CUSTOMER_DB' });
  const superAdmin = await seedUser('m04@test.local', managed.id, 'super_admin');

  const token = await tokenFor(superAdmin.id, 'm04@test.local', 'super_admin', managed.id, managed.id);
  const ok = await doSwitch(token, managed.id);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.role, 'super_admin', 'super admin keeps its global role');

  for (const org of [privateOrg, customerDb]) {
    const r = await doSwitch(token, org.id);
    assert.equal(r.status, 403, `PRIVATE/CUSTOMER_DB switch must be rejected: ${JSON.stringify(r.body)}`);
    assert.match(String(r.body.error), /MANAGED organizations/, 'rejection names the MANAGED-only boundary');
  }
});

// ─── M-05: strict tenant scoping of the projects API ────────────────────────

test('M-05: the projects list is scoped to the active organization only', async () => {
  const orgA = await seedOrg('M05 TenantA');
  const orgB = await seedOrg('M05 TenantB');
  const userA = await seedUser('m05-a@test.local', orgA.id, 'admin');
  await seedMembership(userA.id, orgA.id, 'admin');
  await db.project.create({ data: { name: 'A-secret-project', organizationId: orgA.id } });
  await db.project.create({ data: { name: 'B-secret-project', organizationId: orgB.id } });

  const tokenA = await tokenFor(userA.id, 'm05-a@test.local', 'admin', orgA.id, orgA.id);
  const res = await projectsApi.GET(req(tokenA, { url: 'http://localhost/api/projects' }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: { name: string }[]; total: number };
  assert.ok(body.data.every((p) => p.name === 'A-secret-project'), 'only tenant A rows visible');
  assert.equal(body.total, 1, 'tenant A total is 1 — B is invisible');

  // The same request under tenant B sees only B's row.
  const userB = await seedUser('m05-b@test.local', orgB.id, 'admin');
  await seedMembership(userB.id, orgB.id, 'admin');
  const tokenB = await tokenFor(userB.id, 'm05-b@test.local', 'admin', orgB.id, orgB.id);
  const resB = await projectsApi.GET(req(tokenB, { url: 'http://localhost/api/projects' }));
  const bodyB = (await resB.json()) as { data: { name: string }[]; total: number };
  assert.deepEqual(bodyB.data.map((p) => p.name), ['B-secret-project']);
  assert.equal(bodyB.total, 1);
});

// ─── M-06: org-less super admin gets an empty list ──────────────────────────

test('M-06: an org-less super admin receives an empty projects page (never a cross-tenant dump)', async () => {
  const org = await seedOrg('M06 HasData');
  await db.project.create({ data: { name: 'Some-data-project', organizationId: org.id } });
  const user = await db.appUser.create({
    data: { email: 'm06@test.local', name: 'M06', password: 'x', role: 'super_admin', isActive: true, organizationId: null },
  });
  const session = await db.userSession.create({
    data: { userId: user.id, organizationId: null, expiresAt: new Date(Date.now() + 3600_000) },
  });
  const token = await signJWT({ userId: user.id, email: 'm06@test.local', role: 'super_admin', sessionId: session.id });

  const res = await projectsApi.GET(req(token, { url: 'http://localhost/api/projects' }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: unknown[]; total: number };
  assert.deepEqual(body.data, [], 'org-less super admin must see an empty list');
  assert.equal(body.total, 0);
});
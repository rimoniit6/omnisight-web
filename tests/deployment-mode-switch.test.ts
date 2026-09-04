/**
 * Phase 1 Step 12: deployment-mode switch gating + tenant routing tests.
 *
 * Proves:
 *  DM-01  Super Admin GET /api/me/organizations lists MANAGED only
 *  DM-02  Super Admin POST /switch to MANAGED succeeds
 *  DM-03  Super Admin POST /switch to CUSTOMER_DB is rejected (403)
 *  DM-04  Super Admin POST /switch to PRIVATE is rejected (403)
 *  DM-05  Org member can still switch into their CUSTOMER_DB org (membership path)
 *  DM-06  resolveTenantDatabase distinguishes MANAGED/CUSTOMER_DB/PRIVATE
 *  DM-07  getTenantDb returns managed handle; throws fail-closed for CUSTOMER_DB
 *  DM-08  Activity rows carry direct organizationId; cross-org lookup denies
 *  DM-09  requireManagedTenantAccess allows MANAGED, denies CUSTOMER_DB
 *
 * Runs against a THROWAWAY PostgreSQL database.
 * Run: npx tsx --test tests/deployment-mode-switch.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_deployment_mode';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-deployment-mode-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@deployment-mode.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!DeplMode2026x';
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

let saId: string;
let memberId: string;
let managedOrg: { id: string };
let customerOrg: { id: string };
let privateOrg: { id: string };

function getReq(token: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/me/organizations', {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
}

function switchReq(token: string, organizationId: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/me/organization/switch', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ organizationId }),
  });
}

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  const sa = await db.appUser.create({
    data: { email: process.env.SUPER_ADMIN_EMAIL!, name: 'SA', role: 'super_admin', isActive: true },
  });
  saId = sa.id;

  managedOrg = await db.organization.create({
    data: { name: 'Managed Org', slug: 'dm-managed', deploymentMode: 'MANAGED' },
  });
  customerOrg = await db.organization.create({
    data: { name: 'Customer Org', slug: 'dm-customer', deploymentMode: 'CUSTOMER_DB' },
  });
  privateOrg = await db.organization.create({
    data: { name: 'Private Org', slug: 'dm-private', deploymentMode: 'PRIVATE' },
  });

  const member = await db.appUser.create({
    data: { email: 'member@dm.local', name: 'Member', role: 'user', isActive: true },
  });
  memberId = member.id;
  await db.organizationMembership.create({
    data: { userId: memberId, organizationId: customerOrg.id, role: 'org_admin', status: 'ACTIVE' },
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

async function saToken(): Promise<string> {
  return signJWT({ userId: saId, email: process.env.SUPER_ADMIN_EMAIL!, role: 'super_admin' });
}

// DM-01: SA lists MANAGED only
test('DM-01: Super Admin organization list contains MANAGED only', async () => {
  const { GET } = await import('../src/app/api/me/organizations/route');
  const res = await GET(getReq(await saToken()));
  assert.equal(res.status, 200);
  const body = await res.json();
  const ids = body.organizations.map((o: { id: string }) => o.id);
  assert.ok(ids.includes(managedOrg.id), 'MANAGED org must be listed');
  assert.ok(!ids.includes(customerOrg.id), 'CUSTOMER_DB org must NOT be listed');
  assert.ok(!ids.includes(privateOrg.id), 'PRIVATE org must NOT be listed');
});

// DM-02: SA switch to MANAGED succeeds
test('DM-02: Super Admin can switch to a MANAGED organization', async () => {
  const { POST } = await import('../src/app/api/me/organization/switch/route');
  const res = await POST(switchReq(await saToken(), managedOrg.id));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.activeOrganizationId, managedOrg.id);
});

// DM-03: SA switch to CUSTOMER_DB rejected
test('DM-03: Super Admin switch to CUSTOMER_DB is rejected', async () => {
  const { POST } = await import('../src/app/api/me/organization/switch/route');
  const res = await POST(switchReq(await saToken(), customerOrg.id));
  assert.equal(res.status, 403);
});

// DM-04: SA switch to PRIVATE rejected
test('DM-04: Super Admin switch to PRIVATE is rejected', async () => {
  const { POST } = await import('../src/app/api/me/organization/switch/route');
  const res = await POST(switchReq(await saToken(), privateOrg.id));
  assert.equal(res.status, 403);
});

// DM-05: member path unaffected
test('DM-05: Org member can switch into their CUSTOMER_DB org', async () => {
  const { POST } = await import('../src/app/api/me/organization/switch/route');
  const token = await signJWT({
    userId: memberId,
    email: 'member@dm.local',
    role: 'org_admin',
    organizationId: customerOrg.id,
    activeOrganizationId: customerOrg.id,
  });
  const res = await POST(switchReq(token, customerOrg.id));
  assert.equal(res.status, 200);
});

// DM-06: tenant database resolution distinguishes modes
test('DM-06: resolveTenantDatabase distinguishes all three modes', async () => {
  const { resolveTenantDatabase } = await import('../src/lib/tenant-db');
  const m = await resolveTenantDatabase(managedOrg.id);
  const c = await resolveTenantDatabase(customerOrg.id);
  const p = await resolveTenantDatabase(privateOrg.id);
  assert.equal(m.kind, 'managed');
  assert.equal(c.kind, 'customer');
  assert.equal(p.kind, 'private');
});

// DM-07: fail-closed handles
test('DM-07: getTenantDb managed handle; CUSTOMER_DB throws fail-closed', async () => {
  const { getTenantDb, TenantDatabaseError } = await import('../src/lib/tenant-db');
  const handle = await getTenantDb(managedOrg.id);
  assert.equal(handle.kind, 'managed');
  await assert.rejects(() => getTenantDb(customerOrg.id), TenantDatabaseError);
  await assert.rejects(() => getTenantDb(privateOrg.id), TenantDatabaseError);
});

// DM-08: Activity direct ownership + cross-org denial
test('DM-08: Activity rows carry organizationId; cross-org lookup denies', async () => {
  const emp = await db.employee.create({
    data: {
      employeeId: 'DM-E1',
      firstName: 'Dee',
      lastName: 'Em',
      email: 'dm-e1@dm.local',
      organizationId: managedOrg.id,
    },
  });
  const row = await db.activity.create({
    data: {
      type: 'application',
      title: 'probe',
      duration: 60,
      employeeId: emp.id,
      organizationId: managedOrg.id,
    },
  });
  assert.equal(row.organizationId, managedOrg.id);
  const cross = await db.activity.findFirst({
    where: { id: row.id, organizationId: customerOrg.id },
  });
  assert.equal(cross, null, 'cross-org lookup must return nothing');
});

// DM-09: managed tenant guard
test('DM-09: requireManagedTenantAccess allows MANAGED, denies CUSTOMER_DB', async () => {
  const { requireManagedTenantAccess } = await import('../src/lib/control-plane');
  const token = await saToken();
  const okReq = new NextRequest('http://localhost:3000/api/x', {
    headers: { authorization: `Bearer ${token}` },
  });
  const deniedReq = new NextRequest('http://localhost:3000/api/x', {
    headers: { authorization: `Bearer ${token}` },
  });
  const ok = await requireManagedTenantAccess(okReq, managedOrg.id);
  assert.equal(ok.ok, true);
  const denied = await requireManagedTenantAccess(deniedReq, customerOrg.id);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.status, 403);
});

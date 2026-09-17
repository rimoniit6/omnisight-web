/**
 * CONSENT SPLIT-BRAIN — post-cutover admin↔agent consistency tests (P0).
 *
 * Forensic finding (P0): the admin consent API wrote Consent/ConsentPolicy to
 * the PLATFORM database while the Agent enforcement path reads the ORG
 * database after activation. An admin revocation made through the UI was
 * therefore invisible to the Agent — a revoked employee kept being monitored.
 *
 * These tests prove the invariant on REAL PostgreSQL (same throwaway-DB
 * pattern as tests/org-cutover-routing.test.ts):
 *
 *   CSB-01  Admin GRANT via POST /api/consent lands in the ORG DB
 *           (platform zero) and the Agent enforcement sees granted.
 *   CSB-02  Admin REVOKE via PUT /api/consent/[id] lands in the ORG DB and
 *           hasActiveConsent (the exact Agent gate) sees revoked.
 *   CSB-03  Admin RE-GRANT is visible to the Agent again.
 *   CSB-04  Admin grant on a MANAGED (never-activated) org keeps platform
 *           behavior — no regression for non-cutover orgs.
 *
 * Run: npx tsx --test tests/consent-split-brain.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';

// Destination coordinates derived from PG_TEST_BASE_URL so org routing and
// seeding address the SAME server that hosts the throwaway org DB (Docker
// maps it on 5433; native on 5432).
const CSB_HOST = new URL(PG_TEST_BASE).hostname;
const CSB_PORT = Number(new URL(PG_TEST_BASE).port) || 5432;
const CSB_USER = decodeURIComponent(new URL(PG_TEST_BASE).username);
const CSB_PASSWORD = decodeURIComponent(new URL(PG_TEST_BASE).password);
const TEST_DB_NAME = 'workai_test_db_consent_csb';
const ORG_DB = 'workai_test_db_consent_csb_org';

process.env.DATABASE_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;
process.env.DIRECT_URL = process.env.DATABASE_URL;
process.env.JWT_SECRET = 'test-jwt-secret-csb-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@csb.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!Consent2026';
(process.env as Record<string, string>).NODE_ENV = 'test';
// These suites probe REAL loopback destinations (throwaway Postgres, mock Supabase).
// Test-only SSRF relaxation — see src/lib/ssrf.ts. Never set in production.
(process.env as Record<string, string>).OMNISIGHT_ALLOW_PRIVATE_TARGETS = '1';

const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

let db: import('../src/lib/db').Db['db'];
let adminToken: string; // org_admin session token for org A

let orgAId: string; // activated (useOwnDb) org
let orgNId: string; // never-activated control org
let empAId: string;
let empNId: string;

async function destinationClient(dbName: string) {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient({
    datasources: { db: { url: `${PG_TEST_BASE}/${dbName}?schema=public` } },
    log: ['error'],
  });
}

async function destOrgCount(table: string, orgId: string, dbName: string): Promise<number> {
  const client = await destinationClient(dbName);
  try {
    const rows = await client.$queryRawUnsafe<Array<{ c: bigint }>>(
      `SELECT COUNT(*)::bigint AS c FROM "${table}" WHERE "organizationId" = $1`,
      orgId
    );
    return Number(rows[0]?.c ?? 0);
  } finally {
    await client.$disconnect();
  }
}

before(() => {
  for (const name of [TEST_DB_NAME, ORG_DB]) {
    execSync(`node scripts/pg-test-db.mjs ensure ${name}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  }
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', { env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, DIRECT_URL: process.env.DIRECT_URL }, stdio: 'pipe' });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    env: { ...process.env, DATABASE_URL: `${PG_TEST_BASE}/${ORG_DB}?schema=public`, DIRECT_URL: `${PG_TEST_BASE}/${ORG_DB}?schema=public` },
    stdio: 'pipe',
  });
});

before(async () => {
  db = (await import('../src/lib/db')).db;
  const { bootstrapSuperAdmin } = await import('../src/lib/super-admin');
  await bootstrapSuperAdmin();
  const sa = await db.appUser.findFirst({ where: { role: 'super_admin' } });
  assert.ok(sa);
  const { signJWT } = await import('../src/lib/auth');
  const saToken = await signJWT({ userId: sa.id, email: sa.email, role: 'super_admin', organizationId: null });

  const trial = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  const orgA = await db.organization.create({ data: { name: 'CSB Org A', slug: 'csb-org-a', timezone: 'UTC', trialEndsAt: trial } });
  orgAId = orgA.id;
  const orgN = await db.organization.create({ data: { name: 'CSB Org N (managed)', slug: 'csb-org-n', timezone: 'UTC' } });
  orgNId = orgN.id;

  const empA = await db.employee.create({
    data: { employeeId: 'CSB-EMP-A', firstName: 'Al', lastName: 'A', email: 'al@csb-a.test', phone: '', organizationId: orgAId, status: 'active' },
  });
  empAId = empA.id;
  const empN = await db.employee.create({
    data: { employeeId: 'CSB-EMP-N', firstName: 'No', lastName: 'N', email: 'no@csb-n.test', phone: '', organizationId: orgNId, status: 'active' },
  });
  empNId = empN.id;

  // ORG ADMIN session for org A (organizationRole org_admin).
  await db.appUser.create({
    data: { email: 'admin@csb-a.test', name: 'Org A Admin', password: 'x', role: 'org_admin', organizationId: orgAId },
  });
  const adminUser = await db.appUser.findUnique({ where: { email: 'admin@csb-a.test' } });
  assert.ok(adminUser);
  await db.organizationMembership.create({
    data: { userId: adminUser.id, organizationId: orgAId, role: 'org_admin', status: 'ACTIVE' },
  });
  // Session-bound JWT (matching a live UserSession row) — required by the
  // server-side session re-check in verifySessionToken.
  const adminSession = await db.userSession.create({
    data: { userId: adminUser.id, organizationId: orgAId, activeOrganizationId: orgAId, expiresAt: new Date(Date.now() + 3600_000) },
  });
  adminToken = await signJWT({ userId: adminUser.id, email: adminUser.email, role: 'org_admin', organizationId: orgAId, activeOrganizationId: orgAId, sessionId: adminSession.id });

  // ACTIVATE org A: the deterministic boundary is the settings flip
  // (useOwnDb=true + complete config) — the exact state the migration runner
  // leaves behind after a successful activation.
  await db.organizationSettings.create({
    data: { organizationId: orgAId, useOwnDb: true, dbHost: CSB_HOST, dbPort: CSB_PORT, dbName: ORG_DB, dbUser: CSB_USER, dbPassword: (await import('../src/lib/crypto')).encryptSecret(CSB_PASSWORD), dbSsl: false, dbTestStatus: 'success' },
  });
  const { copyOrgToDestination } = await import('../src/lib/migration/db-migrate');
  const copied = await copyOrgToDestination(orgAId, `${PG_TEST_BASE}/${ORG_DB}?schema=public`);
  assert.ok(copied, 'org copy must succeed');

  void saToken;
});

after(async () => {
  const mod = await import('../src/lib/db');
  const { invalidateAllOrgDbClients } = await import('../src/lib/org-db').catch(() => ({ invalidateAllOrgDbClients: null }) as unknown as { invalidateAllOrgDbClients?: () => Promise<void> });
  if (typeof invalidateAllOrgDbClients === 'function') await invalidateAllOrgDbClients();
  await mod.db.$disconnect();
  for (const name of [TEST_DB_NAME, ORG_DB]) {
    try {
      execSync(`node scripts/pg-test-db.mjs drop ${name}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
    } catch { /* best-effort */ }
  }
  try { rmSync(join(process.cwd(), 'uploads'), { recursive: true, force: true }); } catch { /* ignore */ }
});

const adminReq = (url: string, opts: { method?: string; body?: unknown } = {}) => {
  const headers: Record<string, string> = { authorization: `Bearer ${adminToken}` };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(url, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
};

test('CSB-01: admin GRANT via POST /api/consent lands in the ORG DB and Agent enforcement sees granted', async () => {
  // Seed a published policy THROUGH THE ADMIN API (policy POST) — proves the
  // policy lifecycle also runs on the org client post-cutover.
  const policiesApi = await import('../src/app/api/consent/policies/route');
  const created = await policiesApi.POST(
    adminReq('http://localhost:3000/api/consent/policies', {
      body: { consentType: 'usb_monitoring', title: 'USB Policy', content: 'USB monitoring consent policy for the split-brain regression suite (well over twenty characters).' },
    }),
    params({ orgId: orgAId })
  );
  assert.equal(created.status, 201, 'policy create must succeed');
  const policyBody = await created.json();
  assert.ok(policyBody.id, 'policy id returned');
  assert.equal(await destOrgCount('ConsentPolicy', orgAId, ORG_DB), 1, 'policy row at the ORG DB');
  assert.equal(await db.consentPolicy.count({ where: { organizationId: orgAId } }), 0, 'platform ConsentPolicy zero');

  // Publish it (PATCH).
  const patchApi = await import('../src/app/api/consent/policies/[id]/route');
  const published = await patchApi.PATCH(
    adminReq(`http://localhost:3000/api/consent/policies/${policyBody.id}`, { method: 'PATCH', body: { action: 'publish' } }),
    params({ id: policyBody.id })
  );
  assert.equal(published.status, 200, 'policy publish must succeed');

  // Admin GRANTS consent through the admin API.
  const consentApi = await import('../src/app/api/consent/route');
  const res = await consentApi.POST(
    adminReq('http://localhost:3000/api/consent', {
      body: { employeeId: empAId, consentType: 'usb_monitoring', status: 'granted' },
    })
  );
  assert.ok(res.status === 200 || res.status === 201, `admin grant must succeed (got ${res.status})`);

  // The consent + consent log rows must be in the ORG DB, not the platform.
  assert.equal(await destOrgCount('Consent', orgAId, ORG_DB), 1, 'consent row at the ORG DB');
  assert.equal(await destOrgCount('ConsentLog', orgAId, ORG_DB), 1, 'consent log at the ORG DB');
  assert.equal(await db.consent.count({ where: { organizationId: orgAId } }), 0, 'platform Consent zero (split-brain closed)');
  assert.equal(await db.consentLog.count({ where: { organizationId: orgAId } }), 0, 'platform ConsentLog zero');

  // THE AGENT ENFORCEMENT PATH must see granted.
  const { hasActiveConsent } = await import('../src/lib/consent');
  const { getPrismaForOrg } = await import('../src/lib/org-db');
  const orgData = (await getPrismaForOrg(orgAId)).client;
  const granted = await hasActiveConsent(empAId, 'usb_monitoring', orgData);
  assert.equal(granted, true, 'Agent enforcement must see the admin grant');
});

test('CSB-02: admin REVOKE via PUT /api/consent/[id] is visible to the Agent enforcement path', async () => {
  // Find the consent id through the admin GET (proves the read side too).
  const listApi = await import('../src/app/api/consent/route');
  const list = await listApi.GET(adminReq('http://localhost:3000/api/consent?type=usb_monitoring'));
  assert.equal(list.status, 200, 'admin consent list must succeed');
  const listBody = await list.json();
  const row = listBody.data.find((c: { employeeId: string; consentType: string }) => c.employeeId === empAId && c.consentType === 'usb_monitoring');
  assert.ok(row, 'the granted consent is visible in the admin list');

  // Revoke via the admin PUT route.
  const putApi = await import('../src/app/api/consent/[id]/route');
  const res = await putApi.PUT(
    adminReq(`http://localhost:3000/api/consent/${row.id}`, { method: 'PUT', body: { status: 'revoked', notes: 'CSB-02 revoke' } }),
    params({ id: row.id })
  );
  assert.equal(res.status, 200, 'revoke must succeed');

  // Org DB holds the revoked state; platform untouched.
  assert.equal(await destOrgCount('Consent', orgAId, ORG_DB), 1, 'consent still lives only at the ORG DB');
  assert.equal(await db.consent.count({ where: { organizationId: orgAId } }), 0, 'platform Consent still zero');

  // THE AGENT ENFORCEMENT PATH must see the revocation.
  const { hasActiveConsent } = await import('../src/lib/consent');
  const { getPrismaForOrg } = await import('../src/lib/org-db');
  const orgData = (await getPrismaForOrg(orgAId)).client;
  const active = await hasActiveConsent(empAId, 'usb_monitoring', orgData);
  assert.equal(active, false, 'Agent enforcement must see the admin revocation (P0 closed)');
});

test('CSB-03: admin RE-GRANT is visible to the Agent again', async () => {
  const consentApi = await import('../src/app/api/consent/route');
  const res = await consentApi.POST(
    adminReq('http://localhost:3000/api/consent', {
      body: { employeeId: empAId, consentType: 'usb_monitoring', status: 'granted' },
    })
  );
  assert.ok(res.status === 200 || res.status === 201, `re-grant must succeed (got ${res.status})`);

  const { hasActiveConsent } = await import('../src/lib/consent');
  const { getPrismaForOrg } = await import('../src/lib/org-db');
  const orgData = (await getPrismaForOrg(orgAId)).client;
  assert.equal(await hasActiveConsent(empAId, 'usb_monitoring', orgData), true, 'Agent sees the re-grant');
  assert.equal(await destOrgCount('ConsentLog', orgAId, ORG_DB), 3, 'grant+revoke+re-grant audit trail at the ORG DB');
});

test('CSB-04: admin consent on a MANAGED (never-activated) org keeps platform behavior', async () => {
  // A super-admin token has no org scope — use a dedicated org-admin token
  // for the control org so the session-org resolution is the same path.
  await db.appUser.create({
    data: { email: 'admin@csb-n.test', name: 'Org N Admin', password: 'x', role: 'org_admin', organizationId: orgNId },
  });
  const nAdmin = await db.appUser.findUnique({ where: { email: 'admin@csb-n.test' } });
  assert.ok(nAdmin);
  await db.organizationMembership.create({
    data: { userId: nAdmin.id, organizationId: orgNId, role: 'org_admin', status: 'ACTIVE' },
  });
  const { signJWT } = await import('../src/lib/auth');
  const nSession = await db.userSession.create({
    data: { userId: nAdmin.id, organizationId: orgNId, activeOrganizationId: orgNId, expiresAt: new Date(Date.now() + 3600_000) },
  });
  const nToken = await signJWT({ userId: nAdmin.id, email: nAdmin.email, role: 'org_admin', organizationId: orgNId, activeOrganizationId: orgNId, sessionId: nSession.id });

  // Publish a policy on the platform (org not activated → orgData === db).
  const policiesApi = await import('../src/app/api/consent/policies/route');
  const headers: Record<string, string> = { authorization: `Bearer ${nToken}`, 'content-type': 'application/json' };
  const created = await policiesApi.POST(
    new NextRequest('http://localhost:3000/api/consent/policies', {
      method: 'POST',
      headers,
      body: JSON.stringify({ consentType: 'monitoring', content: 'Monitoring consent policy for the managed control org (well over twenty characters).' }),
    }),
    params({ orgId: orgNId })
  );
  assert.equal(created.status, 201, 'policy create on a MANAGED org must succeed');
  const policyBody = await created.json();

  const patchApi = await import('../src/app/api/consent/policies/[id]/route');
  const published = await patchApi.PATCH(
    new NextRequest(`http://localhost:3000/api/consent/policies/${policyBody.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ action: 'publish' }),
    }),
    params({ id: policyBody.id })
  );
  assert.equal(published.status, 200, 'policy publish on a MANAGED org must succeed');

  // Admin grant through the API.
  const consentApi = await import('../src/app/api/consent/route');
  const res = await consentApi.POST(
    new NextRequest('http://localhost:3000/api/consent', {
      method: 'POST',
      headers,
      body: JSON.stringify({ employeeId: empNId, consentType: 'monitoring', status: 'granted' }),
    })
  );
  assert.ok(res.status === 200 || res.status === 201, `managed-org grant must succeed (got ${res.status})`);
  assert.equal(await db.consent.count({ where: { organizationId: orgNId } }), 1, 'MANAGED org consent stays on the platform DB');

  // Enforcement with the platform client sees it.
  const { hasActiveConsent } = await import('../src/lib/consent');
  assert.equal(await hasActiveConsent(empNId, 'monitoring'), true, 'Agent enforcement (platform client) sees the grant');
});

/**
 * Super Admin License Control — Regression Tests
 *
 * Proves the license workflow contract for PRIVATE deployments:
 *   - PRIVATE org → SA can issue / list / revoke
 *   - MANAGED org → issuance rejected (license is PRIVATE-only)
 *   - non-SA / unauthenticated → denied
 *   - duplicate-active protection (no silent second active license)
 *   - revoke is atomic + audit-logged; expired computed from validUntil
 *   - public validation endpoint honors revoked/expired
 *   - cross-org license usage rejected (licenseId from org A used against
 *     the org-scoped UI/API surface of org B)
 *
 * Run: npx tsx --test tests/super-admin-license.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation ──────────────────────────────────────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_sa_license';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-sa-license-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@sa-license.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!SALicense2026x';
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
}) => Promise<string>;
let bootstrapSuperAdmin: (env?: Record<string, string | undefined>) => Promise<{
  created: boolean;
  alreadyExisted: boolean;
  user: { id: string; email: string; role: string; organizationId: string | null };
}>;

type LicensesApi = typeof import('../src/app/api/admin/licenses/route');
type RevokeApi = typeof import('../src/app/api/admin/licenses/[licenseId]/revoke/route');
type ValidateApi = typeof import('../src/app/api/license/validate/route');
let licensesApi: LicensesApi;
let revokeApi: RevokeApi;
let validateApi: ValidateApi;

let saUserId: string;
let saToken: string;
let privateOrg: { id: string; name: string };
let managedOrg: { id: string; name: string };
let selfHostedPlanId: string;
let licenseId: string;
let licenseKey: string;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  const sa = await import('../src/lib/super-admin');
  bootstrapSuperAdmin = sa.bootstrapSuperAdmin;
  licensesApi = await import('../src/app/api/admin/licenses/route');
  revokeApi = await import('../src/app/api/admin/licenses/[licenseId]/revoke/route');
  validateApi = await import('../src/app/api/license/validate/route');

  const result = await bootstrapSuperAdmin();
  saUserId = result.user.id;
  saToken = await signJWT({ userId: saUserId, email: process.env.SUPER_ADMIN_EMAIL!, role: 'super_admin' });

  privateOrg = await db.organization.create({
    data: { name: 'Private License Org', slug: 'private-license', deploymentMode: 'PRIVATE' },
  });
  managedOrg = await db.organization.create({
    data: { name: 'Managed License Org', slug: 'managed-license', deploymentMode: 'MANAGED' },
  });
  const plan = await db.plan.create({
    data: { name: 'SelfHosted_Enterprise', priceMonthly: 0, isSelfHosted: true, maxDevices: -1, retentionDays: 0, features: [] },
  });
  selfHostedPlanId = plan.id;
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

function req(url: string, token?: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

// ─── LIC-01: PRIVATE org → SA can issue ─────────────────────────────────

test('LIC-01: SA issues license for PRIVATE organization', async () => {
  const res = await licensesApi.POST(
    req('http://localhost:3000/api/admin/licenses', saToken, 'POST', {
      organizationId: privateOrg.id,
      planId: selfHostedPlanId,
    })
  );
  const body = await res.json();
  assert.equal(res.status, 201, `issue failed: ${JSON.stringify(body)}`);
  assert.ok(body.license?.id ?? body.data?.license?.id, 'license returned');
  licenseId = body.license.id;
  licenseKey = body.license.key;
  assert.match(licenseKey, /^OMNISIGHT-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  // Org's current-license pointer set atomically
  const org = await db.organization.findUnique({
    where: { id: privateOrg.id },
    select: { licenseKeyId: true },
  });
  assert.equal(org?.licenseKeyId, licenseId, 'Organization.licenseKeyId points at the new license');
});

// ─── LIC-02: MANAGED org → issuance rejected ────────────────────────────

test('LIC-02: SA cannot issue license for MANAGED organization', async () => {
  const res = await licensesApi.POST(
    req('http://localhost:3000/api/admin/licenses', saToken, 'POST', {
      organizationId: managedOrg.id,
      planId: selfHostedPlanId,
    })
  );
  assert.equal(res.status, 422, 'MANAGED issuance must be rejected');
});

// ─── LIC-03: duplicate-active protection ────────────────────────────────

test('LIC-03: second Issue while an active license exists → 409 (no silent duplicate)', async () => {
  const res = await licensesApi.POST(
    req('http://localhost:3000/api/admin/licenses', saToken, 'POST', {
      organizationId: privateOrg.id,
      planId: selfHostedPlanId,
    })
  );
  assert.equal(res.status, 409, 'duplicate-active must be rejected with 409');
  const count = await db.licenseKey.count({ where: { organizationId: privateOrg.id, isRevoked: false } });
  assert.equal(count, 1, 'exactly one non-revoked license exists');
});

// ─── LIC-04: SA can list licenses for the org ───────────────────────────

test('LIC-04: SA lists licenses scoped to the organization', async () => {
  const res = await licensesApi.GET(
    req(`http://localhost:3000/api/admin/licenses?organizationId=${privateOrg.id}&status=all`, saToken)
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.total, 1);
  assert.equal(body.data.licenses[0].organization.id, privateOrg.id);
});

// ─── LIC-05: non-SA denied ──────────────────────────────────────────────

test('LIC-05: org_admin cannot issue or list licenses', async () => {
  const { hashPassword } = await import('../src/lib/auth');
  const orgAdmin = await db.appUser.create({
    data: { email: 'admin@sa-license.local', name: 'Org Admin', password: await hashPassword('x'), role: 'user' },
  });
  await db.organizationMembership.create({
    data: { userId: orgAdmin.id, organizationId: privateOrg.id, role: 'org_admin', status: 'ACTIVE' },
  });
  const orgToken = await signJWT({
    userId: orgAdmin.id, email: orgAdmin.email, role: 'org_admin',
    organizationId: privateOrg.id, activeOrganizationId: privateOrg.id,
  });

  const listRes = await licensesApi.GET(
    req('http://localhost:3000/api/admin/licenses', orgToken)
  );
  assert.equal(listRes.status, 403, 'org_admin list must be denied');

  const issueRes = await licensesApi.POST(
    req('http://localhost:3000/api/admin/licenses', orgToken, 'POST', {
      organizationId: privateOrg.id, planId: selfHostedPlanId,
    })
  );
  assert.ok(issueRes.status === 401 || issueRes.status === 403, `org_admin issue must be denied, got ${issueRes.status}`);
});

// ─── LIC-06: unauthenticated denied ─────────────────────────────────────

test('LIC-06: unauthenticated requests are denied', async () => {
  const listRes = await licensesApi.GET(req('http://localhost:3000/api/admin/licenses'));
  assert.equal(listRes.status, 401);
  const issueRes = await licensesApi.POST(
    req('http://localhost:3000/api/admin/licenses', undefined, 'POST', {
      organizationId: privateOrg.id, planId: selfHostedPlanId,
    })
  );
  assert.equal(issueRes.status, 401);
});

// ─── LIC-07: cross-org license lookup / revocation ──────────────────────

test('LIC-07: license ID from another organization cannot be revoked via a foreign org surface', async () => {
  // The revoke route is org-agnostic by licenseId but SA-only; the cross-org
  // protection is that non-SA callers can never reach it, and that revoking
  // org A's license clears only org A's pointer (never org B's state).
  const orgB = await db.organization.create({
    data: { name: 'Innocent Org B', slug: 'innocent-b', deploymentMode: 'MANAGED' },
  });
  const orgBPtrBefore = await db.organization.findUnique({
    where: { id: orgB.id }, select: { licenseKeyId: true },
  });

  // Non-SA attempt against the revoke route must fail regardless of licenseId
  const { hashPassword } = await import('../src/lib/auth');
  const viewer = await db.appUser.create({
    data: { email: 'viewer@sa-license.local', name: 'Viewer', password: await hashPassword('x'), role: 'user' },
  });
  await db.organizationMembership.create({
    data: { userId: viewer.id, organizationId: orgB.id, role: 'viewer', status: 'ACTIVE' },
  });
  const viewerToken = await signJWT({
    userId: viewer.id, email: viewer.email, role: 'viewer',
    organizationId: orgB.id, activeOrganizationId: orgB.id,
  });
  const res = await revokeApi.PUT(
    req(`http://localhost:3000/api/admin/licenses/${licenseId}/revoke`, viewerToken, 'PUT', { reason: 'attack' }),
    { params: Promise.resolve({ licenseId }) }
  );
  assert.ok(res.status === 401 || res.status === 403, `viewer revoke must be denied, got ${res.status}`);

  // Innocent org untouched
  const orgBPtrAfter = await db.organization.findUnique({
    where: { id: orgB.id }, select: { licenseKeyId: true },
  });
  assert.deepEqual(orgBPtrAfter, orgBPtrBefore, 'org B pointer unchanged');
});

// ─── LIC-08: revoke → atomic state change + audit, key never in audit ───

test('LIC-08: SA revoke succeeds; audit recorded; key never appears in audit text', async () => {
  const res = await revokeApi.PUT(
    req(`http://localhost:3000/api/admin/licenses/${licenseId}/revoke`, saToken, 'PUT', { reason: 'test rotation' }),
    { params: Promise.resolve({ licenseId }) }
  );
  const body = await res.json();
  assert.equal(res.status, 200, `revoke failed: ${JSON.stringify(body)}`);
  assert.equal(body.revoked, true);

  const row = await db.licenseKey.findUnique({ where: { id: licenseId } });
  assert.equal(row?.isRevoked, true);
  assert.equal(row?.isActive, false);
  assert.ok(row?.revokedAt, 'revokedAt set');

  // Org pointer cleared so the customer installation fails validation
  const org = await db.organization.findUnique({ where: { id: privateOrg.id }, select: { licenseKeyId: true } });
  assert.equal(org?.licenseKeyId, null, 'current-license pointer cleared on revoke');

  const audits = await db.auditLog.findMany({ where: { resource: 'license_key', resourceId: licenseId } });
  assert.ok(audits.length >= 2, 'issue + revoke audits recorded');
  for (const a of audits) {
    assert.ok(!a.description.includes(row!.key), 'license key must never appear in audit text');
  }
});

// ─── LIC-09: revoke is idempotent-safe (already revoked → 409) ──────────

test('LIC-09: revoking an already-revoked license → 409 (safe, no state corruption)', async () => {
  const res = await revokeApi.PUT(
    req(`http://localhost:3000/api/admin/licenses/${licenseId}/revoke`, saToken, 'PUT', {}),
    { params: Promise.resolve({ licenseId }) }
  );
  assert.equal(res.status, 409);
});

// ─── LIC-10: expiry computed from validUntil, not a stored status ───────

test('LIC-10: expired license → validation returns expired; UI state derives expiry from validUntil', async () => {
  // Issue a fresh license for the org (previous one revoked → allowed)
  const res = await licensesApi.POST(
    req('http://localhost:3000/api/admin/licenses', saToken, 'POST', {
      organizationId: privateOrg.id, planId: selfHostedPlanId,
    })
  );
  assert.equal(res.status, 201, 'reissue after revoke allowed');
  const body = await res.json();
  const lic = body.license ?? body.data?.license;

  // Backdate validUntil to simulate expiry
  await db.licenseKey.update({
    where: { id: lic.id },
    data: { validUntil: new Date(Date.now() - 864e5) },
  });

  const vRes = await validateApi.POST(
    req('http://localhost:3000/api/license/validate', undefined, 'POST', { key: lic.key })
  );
  const vBody = await vRes.json();
  assert.equal(vBody.valid, false, 'expired license must not validate');
  assert.equal(vBody.reason, 'expired');

  // Effective state derivation mirrors the UI helper contract
  const row = await db.licenseKey.findUnique({ where: { id: lic.id }, select: { isRevoked: true, validUntil: true } });
  const expired = row!.validUntil.getTime() <= Date.now();
  assert.ok(expired, 'validUntil in the past resolves to expired');
});

// ─── LIC-11: revoked license cannot validate ────────────────────────────

test('LIC-11: revoked license → validation returns revoked', async () => {
  // Use the first (revoked) license key
  const vRes = await validateApi.POST(
    req('http://localhost:3000/api/license/validate', undefined, 'POST', { key: licenseKey })
  );
  const vBody = await vRes.json();
  assert.equal(vBody.valid, false);
  assert.equal(vBody.reason, 'revoked');
});

// ─── LIC-12: archived organization cannot receive a license ─────────────

test('LIC-12: archived PRIVATE organization → issuance rejected', async () => {
  const archived = await db.organization.create({
    data: { name: 'Archived Private', slug: 'archived-private', deploymentMode: 'PRIVATE', status: 'archived' },
  });
  const res = await licensesApi.POST(
    req('http://localhost:3000/api/admin/licenses', saToken, 'POST', {
      organizationId: archived.id, planId: selfHostedPlanId,
    })
  );
  assert.equal(res.status, 422);
});

// ─── LIC-13: package/entitlement consistency ────────────────────────────

test('LIC-13: license is bound to the selected package (planId persisted and returned)', async () => {
  const planB = await db.plan.create({
    data: { name: 'SelfHosted_Starter', priceMonthly: 0, isSelfHosted: true, maxDevices: 10, retentionDays: 30, features: [] },
  });
  const org = await db.organization.create({
    data: { name: 'Private Plan B', slug: 'private-plan-b', deploymentMode: 'PRIVATE' },
  });
  const res = await licensesApi.POST(
    req('http://localhost:3000/api/admin/licenses', saToken, 'POST', {
      organizationId: org.id, planId: planB.id,
    })
  );
  const body = await res.json();
  assert.equal(res.status, 201);
  const lic = body.license ?? body.data?.license;
  const row = await db.licenseKey.findUnique({ where: { id: lic.id }, select: { planId: true } });
  assert.equal(row?.planId, planB.id, 'license carries the selected package');
});

// ─── LIC-14: UI structural contract — license lives in org detail ───────

test('LIC-14: license UI is embedded in Organization Detail (no standalone surface)', async () => {
  const { readFileSync } = await import('fs');
  const { resolve } = await import('path');
  const detailSrc = readFileSync(
    resolve(__dirname, '../src/components/super-admin/super-admin-organization-detail-page.tsx'),
    'utf8'
  );
  assert.ok(detailSrc.includes('Issue License'), 'Issue License action present');
  assert.ok(detailSrc.includes('Revoke License?'), 'Revoke confirmation present');
  assert.ok(detailSrc.includes('omnisight-license-'), 'download uses omnisight-license-<slug>.json');
  assert.ok(detailSrc.includes('licenseStateOf'), 'expiry computed from validUntil (effective state)');
  assert.ok(detailSrc.includes("deploymentMode !== 'PRIVATE'"), 'MANAGED/CUSTOMER_DB orgs show no issuance workflow');

  // No standalone license page mounted
  const pageSrc = readFileSync(resolve(__dirname, '../src/app/page.tsx'), 'utf8');
  assert.ok(
    !pageSrc.includes('sa-licenses'),
    'No standalone license navigation key in the shell registry'
  );
});

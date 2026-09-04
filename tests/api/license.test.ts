/**
 * Self-hosted license key lifecycle — API integration.
 *
 * Covers the core Prompt 4 contract end-to-end against a throwaway DB:
 *   L-1  Super-admin can generate a key (canonical format, org pointer set)
 *   L-2  The public /api/license/validate endpoint accepts a valid key
 *         and never echoes the key back
 *   L-3  Validation rejects malformed / non-matching keys
 *   L-4  Revoking a key invalidates it and clears the org's active pointer
 *   L-5  Non-super admins are forbidden from the admin generate route
 *
 * Tokens are stateless JWTs signed with the app's own signJWT helper (matching
 * the existing test pattern), so no UserSession row is required.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_license).
 * Run: npx tsx --test tests/api/license.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import type { PrismaClient } from '@prisma/client';
import { req } from '../helpers/request';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_license';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-license-0123456789abcdef';

const KEY_RE = /^OMNISIGHT-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

let db: PrismaClient;
let signJWT: (payload: { userId: string; email: string; role: string; organizationId?: string }) => Promise<string>;
let generateApi: typeof import('../../src/app/api/admin/licenses/route');
let validateApi: typeof import('../../src/app/api/license/validate/route');
let revokeApi: typeof import('../../src/app/api/admin/licenses/[licenseId]/revoke/route');

let superAdminToken: string;
let adminToken: string;
let orgId: string;
let planId: string;

before(async () => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', { env: { ...process.env, DATABASE_URL: TEST_DB_URL }, stdio: 'pipe' });

  db = (await import('../../src/lib/db')).db;
  signJWT = (await import('../../src/lib/auth')).signJWT;
  generateApi = await import('../../src/app/api/admin/licenses/route');
  validateApi = await import('../../src/app/api/license/validate/route');
  revokeApi = await import('../../src/app/api/admin/licenses/[licenseId]/revoke/route');

  superAdminToken = await signJWT({ userId: 'lic-sa', email: 'lic-sa@corp.local', role: 'super_admin' });
  adminToken = await signJWT({ userId: 'lic-admin', email: 'lic-admin@corp.local', role: 'admin' });

  const org = await db.organization.create({ data: { name: 'License Corp', slug: 'license-corp' } });
  orgId = org.id;
  const plan = await db.plan.create({
    data: {
      name: 'Enterprise_SelfHosted',
      description: 'On-prem',
      priceMonthly: 0,
      maxDevices: -1,
      retentionDays: 0,
      isSelfHosted: true,
      isActive: true,
      features: [],
    },
  });
  planId = plan.id;
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  } catch {
    /* best effort */
  }
});

test('L-5: non-super admins are forbidden from generating keys', async () => {
  const res = await generateApi.POST(req(adminToken, { method: 'POST', body: { organizationId: orgId, planId }, ip: '198.51.100.5' }));
  assert.equal(res.status, 403);
});

test('L-1: super admin generates a canonical key and the org pointer is set', async () => {
  const res = await generateApi.POST(req(superAdminToken, { method: 'POST', body: { organizationId: orgId, planId }, ip: '198.51.100.10' }));
  assert.equal(res.status, 201, `expected 201, got ${res.status}`);
  const body = (await res.json()) as { license: { id: string; key: string; isActive: boolean; validUntil: string } };
  assert.match(body.license.key, KEY_RE, 'generated key must match canonical format');
  assert.equal(body.license.isActive, true);

  const withKey = await db.licenseKey.findUnique({ where: { id: body.license.id } });
  assert.equal(withKey?.planId, planId);
  assert.equal(withKey?.organizationId, orgId);

  const org = await db.organization.findUnique({ where: { id: orgId } });
  assert.equal(org?.licenseKeyId, body.license.id, 'org active license pointer is set');
});

test('L-2: a valid key validates on the public endpoint and is never echoed', async () => {
  const license = await db.licenseKey.findFirst({ where: { organizationId: orgId } });
  assert.ok(license);
  const res = await validateApi.POST(req(null, { method: 'POST', body: { key: license.key }, ip: '198.51.100.11' }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { valid: boolean; data?: { expiresAt: string; organizationName: string } };
  assert.equal(body.valid, true);
  assert.equal(body.data?.organizationName, 'License Corp');
  const text = JSON.stringify(body);
  assert.ok(!text.includes(license.key), 'the key is NEVER echoed back');

  const afterTouch = await db.licenseKey.findUnique({ where: { id: license.id } });
  assert.equal(afterTouch?.verificationCount, 1, 'verification is recorded');
});

test('L-3: malformed and unknown keys are rejected with generic reasons', async () => {
  const res = await validateApi.POST(req(null, { method: 'POST', body: { key: 'NOT-A-KEY' }, ip: '198.51.100.12' }));
  const bad = (await res.json()) as { valid: boolean; reason: string };
  assert.equal(bad.valid, false);
  assert.equal(bad.reason, 'invalid_format');

  const res2 = await validateApi.POST(
    req(null, { method: 'POST', body: { key: 'OMNISIGHT-ZZZZ-9999-AAAA' }, ip: '198.51.100.13' })
  );
  const unknown = (await res2.json()) as { valid: boolean; reason: string };
  assert.equal(unknown.valid, false);
  assert.equal(unknown.reason, 'invalid_key');
});

test('L-4: revoking a key invalidates it and clears the org pointer', async () => {
  const license = await db.licenseKey.findFirst({ where: { organizationId: orgId } });
  assert.ok(license);

  const res = await revokeApi.PUT(
    req(superAdminToken, { method: 'PUT', body: { reason: 'sold out' }, ip: '198.51.100.20' }),
    { params: Promise.resolve({ licenseId: license.id }) }
  );
  assert.equal(res.status, 200);

  const org = await db.organization.findUnique({ where: { id: orgId } });
  assert.equal(org?.licenseKeyId, null, 'org active license pointer cleared on revoke');

  const validateRes = await validateApi.POST(
    req(null, { method: 'POST', body: { key: license.key }, ip: '198.51.100.21' })
  );
  const body = (await validateRes.json()) as { valid: boolean; reason: string };
  assert.equal(body.valid, false, 'revoked key must fail validation');
  assert.equal(body.reason, 'revoked');
});

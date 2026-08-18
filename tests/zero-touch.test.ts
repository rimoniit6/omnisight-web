/**
 * Phase B — Zero-touch device discovery / claim / approval backend tests.
 *
 * Proves the zero-touch flow end to end (server side):
 *   discover -> pending DeviceClaim -> admin approve (bind employee,
 *   department via employee, projects) -> PATH A authenticate -> token works.
 *   Reject / revoke fail closed. Approval NEVER grants consent.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_zerotouch).
 * Run: npx tsx --test tests/zero-touch.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { NextRequest } from 'next/server';

// ─── Test DB isolation (must be set BEFORE any app module import) ──────────
// Each suite owns a dedicated throwaway PostgreSQL database; the schema is
// pushed with `prisma db push` (test-only convenience — production deploys
// with `prisma migrate deploy`). PG_TEST_BASE_URL overrides the default
// local instance (e.g. for CI).
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_zerotouch';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-zerotouch-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';
// The screenshot upload portion of this suite asserts against the local
// filesystem, so pin the local driver regardless of any developer's .env.
process.env.STORAGE_DRIVER = 'local';

before(() => {
  if (process.env.ZERO_TOUCH_TEST_MIGRATED_DB !== '1') {
    execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
    execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
      env: { ...process.env, DATABASE_URL: TEST_DB_URL },
      stdio: 'pipe',
    });
  }
});

type DbModule = typeof import('../src/lib/db');
let db: DbModule['db'];
let signJWT: (payload: { userId: string; email: string; role: string; organizationId?: string }) => Promise<string>;

type DiscoverApi = typeof import('../src/app/api/agent/discover/route');
type AuthApi = typeof import('../src/app/api/agent/authenticate/route');
type ClaimsApi = typeof import('../src/app/api/device-claims/route');
type ClaimApproveApi = typeof import('../src/app/api/device-claims/[id]/approve/route');
type ClaimRejectApi = typeof import('../src/app/api/device-claims/[id]/reject/route');
type ClaimRevokeApi = typeof import('../src/app/api/device-claims/[id]/revoke/route');
type ActivityApi = typeof import('../src/app/api/agent/activity/route');
type ScreenshotApi = typeof import('../src/app/api/agent/screenshot/route');
type ConfigApi = typeof import('../src/app/api/agent/config/route');
type ConsentMutationApi = typeof import('../src/app/api/agent/consent/route');

let discoverApi: DiscoverApi;
let authApi: AuthApi;
let claimsApi: ClaimsApi;
let claimApproveApi: ClaimApproveApi;
let claimRejectApi: ClaimRejectApi;
let claimRevokeApi: ClaimRevokeApi;
let activityApi: ActivityApi;
let screenshotApi: ScreenshotApi;
let configApi: ConfigApi;
let consentMutationApi: ConsentMutationApi;
let validateAgentToken: (req: Request) => Promise<{
  valid: boolean;
  employee?: { id: string; employeeId: string; firstName: string; lastName: string; organizationId: string };
  deviceId?: string;
  error?: string;
}>;
let hashEnrollmentCode: (code: string) => string;
let hasActiveConsent: (employeeId: string, consentType: string) => Promise<boolean>;
import type { ConsentStatus } from '../src/lib/consent';
type ApplyConsentTransition = (typeof import('../src/lib/consent'))['applyConsentTransition'];
let applyConsentTransition: ApplyConsentTransition;

// The discovery org. Since P2-3 hardening, discover derives the org from an
// EXPLICIT admin-issued enrollment code (never "the first organization"), so
// this suite seeds a per-org code and sends it on every anonymous discover.
let org: { id: string };
const ENROLL_CODE = 'test-enroll-code-zt-0123456789abcdef';

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  const agentAuthLib = await import('../src/lib/agent/auth');
  validateAgentToken = agentAuthLib.validateAgentToken;
  hashEnrollmentCode = agentAuthLib.hashEnrollmentCode;
  hasActiveConsent = (await import('../src/lib/consent')).hasActiveConsent;

  const [dApi, aApi, cApi, caApi, crApi, crvApi, actApi, shotApi, cfgApi, consentApi] = await Promise.all([
    import('../src/app/api/agent/discover/route'),
    import('../src/app/api/agent/authenticate/route'),
    import('../src/app/api/device-claims/route'),
    import('../src/app/api/device-claims/[id]/approve/route'),
    import('../src/app/api/device-claims/[id]/reject/route'),
    import('../src/app/api/device-claims/[id]/revoke/route'),
    import('../src/app/api/agent/activity/route'),
    import('../src/app/api/agent/screenshot/route'),
    import('../src/app/api/agent/config/route'),
    import('../src/app/api/agent/consent/route'),
  ]);
  discoverApi = dApi;
  authApi = aApi;
  claimsApi = cApi;
  claimApproveApi = caApi;
  claimRejectApi = crApi;
  claimRevokeApi = crvApi;
  activityApi = actApi;
  screenshotApi = shotApi;
  configApi = cfgApi;
  consentMutationApi = consentApi;
  applyConsentTransition = (await import('../src/lib/consent')).applyConsentTransition;

  // The discovery org carries an EXPLICIT enrollment code (stored only as a
  // hash) — anonymous zero-touch discover binds to it, never to the first org.
  org = await db.organization.create({ data: { name: 'Zero Touch Org', slug: 'zt-org' } });
  await db.organizationSetting.create({
    data: {
      organizationId: org.id,
      key: 'agent_enrollment_code',
      value: hashEnrollmentCode(ENROLL_CODE),
      category: 'agent',
    },
  });
});

after(async () => {
  await db.$disconnect();
  if (process.env.ZERO_TOUCH_TEST_MIGRATED_DB !== '1') {
    try {
      execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
        env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
        stdio: 'pipe',
      });
    } catch {
      /* best-effort cleanup */
    }
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function req(token: string | null, opts: { method?: string; body?: unknown; url?: string; ip?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (opts.ip) headers['x-forwarded-for'] = opts.ip;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(opts.url || 'http://localhost:3000/api/test', {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

function tokenFor(role: string, userId: string) {
  return signJWT({ userId, email: `${role}@${org.id.slice(-6)}.local`, role, organizationId: org.id });
}

async function seedEmployee(code: string, deptId: string | null = null) {
  return db.employee.create({
    data: {
      employeeId: code,
      firstName: code.split('-')[0],
      lastName: 'Test',
      email: `${code.toLowerCase()}@test.local`,
      organizationId: org.id,
      status: 'active',
      departmentId: deptId,
      agentApproved: false,
    },
  });
}

function discoverBody(deviceKey: string, hostname = 'PC-ZT') {
  return { deviceKey, hostname, os: 'Windows 11', osVersion: '23H2', processor: 'x64', memory: '16GB', agentVersion: '1.2.0', arch: 'x64', enrollmentCode: ENROLL_CODE };
}

async function discover(deviceKey: string, ip: string) {
  const res = await discoverApi.POST(req(null, { method: 'POST', body: discoverBody(deviceKey), ip }));
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

async function approve(adminToken: string, claimId: string, employeeId: string, projectIds: string[] = []) {
  const res = await claimApproveApi.POST(
    req(adminToken, { method: 'POST', body: { employeeId, projectIds }, ip: '198.51.100.9' }),
    { params: Promise.resolve({ id: claimId }) }
  );
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

/** Full zero-touch setup: discover -> approve -> PATH A authenticate -> token. */
async function setupActiveDevice(label: string, ip: string) {
  const emp = await seedEmployee(`${label}-EMP`);
  const { body } = await discover(`key-zt-${label.toLowerCase()}-device-abcdef`, ip);
  const admin = await tokenFor('admin', `u-${label}-admin`);
  const ar = await approve(admin, body.claimId as string, emp.id);
  assert.equal(ar.status, 200);
  const res = await authApi.POST(req(null, { method: 'POST', body: { deviceId: body.deviceId, deviceSecret: body.secret, agentVersion: '1.2.0' }, ip }));
  const parsed = await res.json().catch(() => ({})) as Record<string, unknown>;
  assert.equal(res.status, 200, JSON.stringify(parsed));
  return { emp, claim: body as Record<string, string>, token: parsed.token as string };
}

/** Publish a consent policy so grants can bind a version (mirrors consent.test.ts). */
async function publishPolicy(orgId: string, consentType: string, version: string) {
  // Idempotent: tests share one org/db, and the version is unique per
  // (org, type). Reuse an existing published version instead of colliding.
  const existing = await db.consentPolicy.findFirst({ where: { organizationId: orgId, consentType, version } });
  if (existing) return existing;
  return db.consentPolicy.create({
    data: {
      organizationId: orgId,
      consentType,
      title: `${consentType} policy`,
      content: 'Test policy',
      version,
      status: 'published',
      effectiveAt: new Date(),
      publishedAt: new Date(),
    },
  });
}

/** Set a consent through the audited state machine (grants need a published policy). */
async function setConsent(employeeId: string, orgId: string, consentType: string, to: 'granted' | 'revoked') {
  const existing = await db.consent.findFirst({ where: { employeeId, consentType } });
  await db.$transaction(async (tx) => {
    if (existing) {
      await applyConsentTransition(tx, { id: existing.id, status: existing.status as ConsentStatus, consentType, organizationId: orgId }, to, { performedBy: 'test' });
    } else {
      const created = await tx.consent.create({ data: { employeeId, consentType, status: 'pending', organizationId: orgId } });
      await applyConsentTransition(tx, { id: created.id, status: 'pending', consentType, organizationId: orgId }, to, { performedBy: 'test' });
    }
  });
}

// ─── B-1: discovery ─────────────────────────────────────────────────────────

test('ZT-1: discover creates a pending device + claim; returns one-time secret', async () => {
  const { status, body } = await discover('key-zt-0001-device-identity-abcdef', '203.0.113.1');
  assert.equal(status, 201);
  assert.equal(body.status, 'pending');
  assert.equal(typeof body.deviceId, 'string');
  assert.equal(typeof body.claimId, 'string');
  assert.equal(typeof body.secret, 'string');
  assert.ok((body.secret as string).length >= 40, 'secret must be cryptographically long');

  const claim = await db.deviceClaim.findUnique({ where: { id: body.claimId as string } });
  assert.ok(claim);
  assert.equal(claim.status, 'pending');
  assert.equal(claim.organizationId, org.id);
  // Secret is stored HASHED, never plaintext.
  assert.notEqual(claim.claimSecretHash, body.secret);
  assert.match(claim.claimSecretHash, /^[0-9a-f]{64}$/, 'sha256 hex hash');

  const device = await db.device.findUnique({ where: { id: body.deviceId as string } });
  assert.ok(device);
  assert.equal(device.status, 'inactive', 'discovered device must NOT be active');
  assert.equal(device.employeeId, null);
  assert.equal(device.organizationId, org.id);
});

test('ZT-2: duplicate discover is idempotent — same device, same claim, no new secret', async () => {
  const first = await discover('key-zt-0002-identity-stable-abcdef', '203.0.113.2');
  assert.equal(first.status, 201);
  const second = await discover('key-zt-0002-identity-stable-abcdef', '203.0.113.2');
  assert.equal(second.status, 200);
  assert.equal(second.body.deviceId, first.body.deviceId, 'device must not be recreated');
  assert.equal(second.body.claimId, first.body.claimId, 'claim must not be recreated');
  assert.equal(second.body.secret, undefined, 'secret is one-time — never re-issued');

  const deviceCount = await db.device.count({ where: { agentKey: 'key-zt-0002-identity-stable-abcdef' } });
  assert.equal(deviceCount, 1);
});

test('ZT-3: invalid discovery rejected (short deviceKey, missing hostname)', async () => {
  const bad1 = await discoverApi.POST(req(null, { method: 'POST', body: { deviceKey: 'short', hostname: 'PC' }, ip: '203.0.113.3' }));
  assert.equal(bad1.status, 400);

  const bad2 = await discoverApi.POST(req(null, { method: 'POST', body: { deviceKey: 'key-zt-0003-valid-length-abcdef', hostname: '' }, ip: '203.0.113.3' }));
  assert.equal(bad2.status, 400);
});

test('ZT-4: discovery rate limit enforced (429 after burst)', async () => {
  const ip = '203.0.113.99';
  const key = 'key-zt-0004-rate-limit-test-abcdef';
  let lastStatus = 0;
  for (let i = 0; i < 21; i++) {
    const res = await discoverApi.POST(req(null, { method: 'POST', body: discoverBody(key), ip }));
    lastStatus = res.status;
  }
  assert.equal(lastStatus, 429, '21st discovery within the window must be rate-limited');
});

// ─── B-4/5/6/7: approval ────────────────────────────────────────────────────

test('ZT-5: non-admin cannot approve a claim (403)', async () => {
  const { body } = await discover('key-zt-0005-nonadmin-approve-abcdef', '203.0.113.5');
  const emp = await seedEmployee('ZT5-EMP');
  const viewer = await tokenFor('viewer', 'u-zt5-viewer');
  const res = await approve(viewer, body.claimId as string, emp.id);
  assert.equal(res.status, 403);
});

test('ZT-6: admin can approve a claim — binds employee, department from employee, projects', async () => {
  const dept = await db.department.create({ data: { name: 'Engineering', organizationId: org.id } });
  const emp = await seedEmployee('ZT6-EMP', dept.id);
  const proj = await db.project.create({ data: { name: 'Project X', organizationId: org.id, status: 'active' } });
  const { body } = await discover('key-zt-0006-approve-flow-abcdef', '203.0.113.6');
  const admin = await tokenFor('admin', 'u-zt6-admin');

  const res = await approve(admin, body.claimId as string, emp.id, [proj.id]);
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const claim = await db.deviceClaim.findUnique({ where: { id: body.claimId as string }, include: { device: true, employee: { include: { department: true } } } });
  assert.equal(claim!.status, 'approved');
  assert.equal(claim!.employeeId, emp.id);
  assert.equal(claim!.approvedBy, 'u-zt6-admin');
  assert.ok(claim!.approvedAt);
  assert.equal(claim!.device!.employeeId, emp.id, 'device bound to employee');
  assert.equal(claim!.device!.status, 'online', 'device activated');
  assert.equal(claim!.employee!.departmentId, dept.id, 'department comes from the employee');

  const membership = await db.projectMember.findFirst({ where: { projectId: proj.id, employeeId: emp.id } });
  assert.ok(membership, 'project membership created via existing ProjectMember model');
  assert.equal(membership!.organizationId, org.id);
  assert.equal((await db.employee.findUnique({ where: { id: emp.id } }))!.agentApproved, true);
});

test('ZT-7: cross-org assignment rejected — admin cannot approve a foreign claim or foreign employee', async () => {
  const otherOrg = await db.organization.create({ data: { name: 'Other Org', slug: 'other-org' } });
  const foreignAdmin = await signJWT({ userId: 'u-foreign', email: 'foreign@other.local', role: 'admin', organizationId: otherOrg.id });
  const foreignEmp = await db.employee.create({
    data: { employeeId: 'F-EMP', firstName: 'F', lastName: 'Emp', email: 'f@other.local', organizationId: otherOrg.id, status: 'active' },
  });

  const { body } = await discover('key-zt-0007-crossorg-abcdef', '203.0.113.7');
  const admin = await tokenFor('admin', 'u-zt7-admin');

  // Foreign admin acting on our claim -> 404 (concealed).
  const foreignApprove = await approve(foreignAdmin, body.claimId as string, foreignEmp.id);
  assert.equal(foreignApprove.status, 404);

  // Our admin assigning a FOREIGN employee -> 422.
  const badEmp = await approve(admin, body.claimId as string, foreignEmp.id);
  assert.equal(badEmp.status, 422);
});

test('ZT-8: invalid / cross-org project rejected (422)', async () => {
  const otherOrg = await db.organization.create({ data: { name: 'Other Org 2', slug: 'other-org-2' } });
  const foreignProj = await db.project.create({ data: { name: 'Foreign Proj', organizationId: otherOrg.id, status: 'active' } });
  const emp = await seedEmployee('ZT8-EMP');
  const { body } = await discover('key-zt-0008-projects-abcdef', '203.0.113.8');
  const admin = await tokenFor('admin', 'u-zt8-admin');

  const crossOrg = await approve(admin, body.claimId as string, emp.id, [foreignProj.id]);
  assert.equal(crossOrg.status, 422, 'cross-org project must be rejected');

  const nonexistent = await approve(admin, body.claimId as string, emp.id, ['cuid-nope-0000']);
  assert.equal(nonexistent.status, 422, 'nonexistent project must be rejected');
});

test('ZT-9: approval NEVER creates consent (device approval != consent)', async () => {
  const emp = await seedEmployee('ZT9-EMP');
  const { body } = await discover('key-zt-0009-consent-gap-abcdef', '203.0.113.9');
  const admin = await tokenFor('admin', 'u-zt9-admin');

  const res = await approve(admin, body.claimId as string, emp.id);
  assert.equal(res.status, 200);

  const consentRows = await db.consent.count({ where: { employeeId: emp.id } });
  assert.equal(consentRows, 0, 'approval must not create any consent rows');

  for (const type of ['monitoring', 'screenshot', 'activity_tracking', 'keystroke', 'usb_monitoring', 'webcam_access', 'location', 'email_monitoring']) {
    assert.equal(await hasActiveConsent(emp.id, type), false, `consent ${type} must remain inactive`);
  }
});

test('ZT-10: a pre-existing pending consent stays pending after approval', async () => {
  const emp = await seedEmployee('ZT10-EMP');
  await db.consent.create({ data: { employeeId: emp.id, consentType: 'screenshot', status: 'pending', organizationId: org.id } });
  const { body } = await discover('key-zt-0010-pending-consent-abcdef', '203.0.113.10');
  const admin = await tokenFor('admin', 'u-zt10-admin');

  const res = await approve(admin, body.claimId as string, emp.id);
  assert.equal(res.status, 200);
  const consent = await db.consent.findFirst({ where: { employeeId: emp.id, consentType: 'screenshot' } });
  assert.equal(consent!.status, 'pending', 'approval must not change consent state');
  assert.equal(await hasActiveConsent(emp.id, 'screenshot'), false);
});

test('ZT-11: audit log created on approve', async () => {
  const emp = await seedEmployee('ZT11-EMP');
  const { body } = await discover('key-zt-0011-audit-abcdef', '203.0.113.11');
  const admin = await tokenFor('admin', 'u-zt11-admin');
  const beforeCount = await db.auditLog.count({ where: { organizationId: org.id, resource: 'device' } });

  const res = await approve(admin, body.claimId as string, emp.id);
  assert.equal(res.status, 200);
  const afterCount = await db.auditLog.count({ where: { organizationId: org.id, resource: 'device' } });
  assert.ok(afterCount > beforeCount, 'approve must write an audit log entry');
});

test('ZT-12: ONE ACTIVE DEVICE PER EMPLOYEE — approving a second device deactivates the first', async () => {
  const emp = await seedEmployee('ZT12-EMP');
  const admin = await tokenFor('admin', 'u-zt12-admin');

  const d1 = await discover('key-zt-0012a-device-abcdef', '203.0.113.12');
  const r1 = await approve(admin, d1.body.claimId as string, emp.id);
  assert.equal(r1.status, 200);
  const dev1 = await db.device.findUnique({ where: { id: d1.body.deviceId as string } });
  assert.equal(dev1!.status, 'online');

  const d2 = await discover('key-zt-0012b-device-abcdef', '203.0.113.12');
  const r2 = await approve(admin, d2.body.claimId as string, emp.id);
  assert.equal(r2.status, 200);

  const dev1After = await db.device.findUnique({ where: { id: d1.body.deviceId as string } });
  const dev2After = await db.device.findUnique({ where: { id: d2.body.deviceId as string } });
  assert.equal(dev1After!.status, 'inactive', 'first device must be deactivated');
  assert.equal(dev2After!.status, 'online', 'new device becomes the active device');
  const activeCount = await db.device.count({ where: { employeeId: emp.id, status: { in: ['online', 'offline'] } } });
  assert.equal(activeCount, 1, 'exactly one active device per employee');
});

// ─── B-6: PATH A authentication ─────────────────────────────────────────────

test('ZT-13: pending device cannot authenticate (403 pending)', async () => {
  const { body } = await discover('key-zt-0013-pending-auth-abcdef', '203.0.113.13');
  const res = await authApi.POST(req(null, { method: 'POST', body: { deviceId: body.deviceId, deviceSecret: body.secret }, ip: '203.0.113.13' }));
  const parsed = await res.json().catch(() => ({})) as Record<string, unknown>;
  assert.equal(res.status, 403);
  assert.equal(parsed.status, 'pending');
  assert.equal(parsed.token, undefined);
});

test('ZT-14: approved device can authenticate (PATH A) and the token works', async () => {
  const emp = await seedEmployee('ZT14-EMP');
  const { body } = await discover('key-zt-0014-approved-auth-abcdef', '203.0.113.14');
  const admin = await tokenFor('admin', 'u-zt14-admin');
  const ar = await approve(admin, body.claimId as string, emp.id);
  assert.equal(ar.status, 200);

  const res = await authApi.POST(req(null, { method: 'POST', body: { deviceId: body.deviceId, deviceSecret: body.secret, agentVersion: '1.2.0' }, ip: '203.0.113.14' }));
  const parsed = await res.json().catch(() => ({})) as Record<string, unknown>;
  assert.equal(res.status, 200, JSON.stringify(parsed));
  assert.equal(parsed.success, true);
  assert.equal(typeof parsed.token, 'string');
  assert.equal(parsed.employeeId, emp.employeeId);

  // The issued token passes validateAgentToken (proves heartbeat/upload gating).
  const check = await validateAgentToken(new Request('http://localhost:3000/api/agent/heartbeat', {
    headers: { authorization: `Bearer ${parsed.token}` },
  }));
  assert.equal(check.valid, true);
  assert.equal(check.deviceId, body.deviceId);
  assert.equal(check.employee!.id, emp.id);
});

test('ZT-15: rejected device cannot authenticate (403 rejected)', async () => {
  const emp = await seedEmployee('ZT15-EMP');
  const { body } = await discover('key-zt-0015-rejected-auth-abcdef', '203.0.113.15');
  const admin = await tokenFor('admin', 'u-zt15-admin');

  const reject = await claimRejectApi.POST(req(admin, { method: 'POST', body: { reason: 'Not an employee device' }, ip: '198.51.100.15' }), { params: Promise.resolve({ id: body.claimId as string }) });
  assert.equal(reject.status, 200);

  const res = await authApi.POST(req(null, { method: 'POST', body: { deviceId: body.deviceId, deviceSecret: body.secret }, ip: '203.0.113.15' }));
  const parsed = await res.json().catch(() => ({})) as Record<string, unknown>;
  assert.equal(res.status, 403);
  assert.equal(parsed.status, 'rejected');
  assert.equal(parsed.token, undefined);
  assert.equal((await db.device.findUnique({ where: { id: body.deviceId as string } }))!.status, 'inactive');
});

test('ZT-16: revoked device cannot authenticate — and existing tokens fail closed', async () => {
  const emp = await seedEmployee('ZT16-EMP');
  const { body } = await discover('key-zt-0016-revoked-auth-abcdef', '203.0.113.16');
  const admin = await tokenFor('admin', 'u-zt16-admin');
  const ar = await approve(admin, body.claimId as string, emp.id);
  assert.equal(ar.status, 200);

  const authRes = await authApi.POST(req(null, { method: 'POST', body: { deviceId: body.deviceId, deviceSecret: body.secret }, ip: '203.0.113.16' }));
  const parsed = await authRes.json().catch(() => ({})) as Record<string, unknown>;
  assert.equal(parsed.success, true);
  const token = parsed.token as string;

  // Revoke.
  const revoke = await claimRevokeApi.POST(req(admin, { method: 'POST', body: { reason: 'Stolen laptop' }, ip: '198.51.100.16' }), { params: Promise.resolve({ id: body.claimId as string }) });
  assert.equal(revoke.status, 200);

  // Re-authentication fails.
  const reAuth = await authApi.POST(req(null, { method: 'POST', body: { deviceId: body.deviceId, deviceSecret: body.secret }, ip: '203.0.113.16' }));
  const reParsed = await reAuth.json().catch(() => ({})) as Record<string, unknown>;
  assert.equal(reAuth.status, 403);
  assert.equal(reParsed.status, 'revoked');

  // The previously-issued token is now invalid (device inactive).
  const check = await validateAgentToken(new Request('http://localhost:3000/api/agent/activity', {
    headers: { authorization: `Bearer ${token}` },
  }));
  assert.equal(check.valid, false, 'revoked device token must fail closed immediately');
});

test('ZT-17: wrong device secret rejected (401) — no cross-device auth', async () => {
  const emp = await seedEmployee('ZT17-EMP');
  const { body } = await discover('key-zt-0017-wrong-secret-abcdef', '203.0.113.17');
  const admin = await tokenFor('admin', 'u-zt17-admin');
  const ar = await approve(admin, body.claimId as string, emp.id);
  assert.equal(ar.status, 200);

  const res = await authApi.POST(req(null, { method: 'POST', body: { deviceId: body.deviceId, deviceSecret: 'wrong-secret-value' }, ip: '203.0.113.17' }));
  assert.equal(res.status, 401);
});

test('ZT-18: legacy PATH B (employeeId + password) still works after Phase B', async () => {
  const emp = await seedEmployee('ZT18-EMP');
  const { hashPassword } = await import('../src/lib/auth');
  await db.employee.update({ where: { id: emp.id }, data: { agentPassword: await hashPassword('s3cret-pass'), agentApproved: true } });

  const res = await authApi.POST(req(null, { method: 'POST', body: { employeeId: emp.employeeId, password: 's3cret-pass', hostname: 'PC-LEGACY' }, ip: '203.0.113.18' }));
  const parsed = await res.json().catch(() => ({})) as Record<string, unknown>;
  assert.equal(res.status, 200, JSON.stringify(parsed));
  assert.equal(parsed.success, true);
  assert.equal(typeof parsed.token, 'string');
});

// ─── B-4: admin list view ───────────────────────────────────────────────────

test('ZT-19: admin list shows pending claims with device + assignment data', async () => {
  const emp = await seedEmployee('ZT19-EMP');
  const { body } = await discover('key-zt-0019-list-view-abcdef', '203.0.113.19');
  const admin = await tokenFor('admin', 'u-zt19-admin');
  await approve(admin, body.claimId as string, emp.id);

  const res = await claimsApi.GET(req(admin, { url: 'http://localhost:3000/api/device-claims?pageSize=50' }));
  const parsed = await res.json();
  assert.equal(res.status, 200);
  const claim = parsed.data.find((c: { id: string }) => c.id === body.claimId);
  assert.ok(claim, 'approved claim visible in admin list');
  assert.equal(claim.status, 'approved');
  assert.equal(claim.device.hostname, 'PC-ZT');
  assert.ok(claim.employee, 'employee assignment surfaced');
  assert.equal(claim.employee.employeeId, emp.employeeId);
});

test('ZT-20: unauthenticated admin claims list -> 401; foreign admin -> sees nothing', async () => {
  const anon = await claimsApi.GET(req(null));
  assert.equal(anon.status, 401);

  const otherOrg = await db.organization.create({ data: { name: 'Other Org 3', slug: 'other-org-3' } });
  const foreign = await signJWT({ userId: 'u-f3', email: 'f3@other.local', role: 'admin', organizationId: otherOrg.id });
  const res = await claimsApi.GET(req(foreign, { url: 'http://localhost:3000/api/device-claims?pageSize=50' }));
  const parsed = await res.json();
  assert.equal(parsed.total, 0, 'foreign admin sees no claims from our org');
});

// ─── B.5: server-side fail-closed enforcement at the ROUTE level ────────────
// Part 7/15: directly call the protected upload handlers. A revoked or missing
// consent must 403 and persist NOTHING — approval alone never enables uploads.

test('ZT-21: activity upload returns 403 and persists nothing without consent', async () => {
  const { emp, token } = await setupActiveDevice('ZT21', '203.0.113.21');
  assert.equal(await db.consent.count({ where: { employeeId: emp.id } }), 0, 'approved device starts with NO consent');

  const res = await activityApi.POST(req(token, {
    method: 'POST',
    body: { activities: [{ type: 'application', applicationName: 'chrome.exe', duration: 60 }] },
  }));
  assert.equal(res.status, 403, 'missing consent must fail closed');
  const persisted = await db.activity.count({ where: { employeeId: emp.id } });
  assert.equal(persisted, 0, 'no activity rows may be persisted without consent');
});

test('ZT-22: activity consent grant -> upload 200; revoke -> 403 again (route-level cycle)', async () => {
  const { emp, token } = await setupActiveDevice('ZT22', '203.0.113.22');
  await publishPolicy(org.id, 'activity_tracking', 'v1');

  // Revoked consent -> 403.
  await setConsent(emp.id, org.id, 'activity_tracking', 'granted');
  await setConsent(emp.id, org.id, 'activity_tracking', 'revoked');
  let res = await activityApi.POST(req(token, { method: 'POST', body: { activities: [{ type: 'application', applicationName: 'chrome.exe', duration: 30 }] } }));
  assert.equal(res.status, 403, 'revoked consent must block uploads');
  assert.equal(await db.activity.count({ where: { employeeId: emp.id } }), 0);

  // Grant -> 200 and data persisted.
  await setConsent(emp.id, org.id, 'activity_tracking', 'granted');
  res = await activityApi.POST(req(token, { method: 'POST', body: { activities: [{ type: 'application', applicationName: 'chrome.exe', duration: 30 }] } }));
  const grantedBody = await res.json().catch(() => ({})) as Record<string, unknown>;
  assert.equal(res.status, 200, JSON.stringify(grantedBody));
  assert.equal(grantedBody.count, 1);
  assert.equal(await db.activity.count({ where: { employeeId: emp.id } }), 1);

  // Revoke again -> 403, nothing new persisted.
  await setConsent(emp.id, org.id, 'activity_tracking', 'revoked');
  res = await activityApi.POST(req(token, { method: 'POST', body: { activities: [{ type: 'application', applicationName: 'vscode.exe', duration: 45 }] } }));
  assert.equal(res.status, 403, 're-revoked consent must block uploads again');
  assert.equal(await db.activity.count({ where: { employeeId: emp.id } }), 1, 'no additional rows after revoke');
});

test('ZT-23: screenshot upload fails closed without consent and follows grant/revoke', async () => {
  const { emp, token } = await setupActiveDevice('ZT23', '203.0.113.23');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

  const postShot = async (): Promise<Response> => {
    const fd = new FormData();
    fd.append('screenshot', new File([png], 'test.png', { type: 'image/png' }));
    fd.append('timestamp', new Date().toISOString());
    fd.append('appWindow', 'chrome');
    return screenshotApi.POST(new NextRequest('http://localhost:3000/api/agent/screenshot', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: fd,
    }));
  };

  // No consent -> 403, no file persisted.
  let res = await postShot();
  assert.equal(res.status, 403, 'screenshot without consent must fail closed');
  assert.equal(await db.screenshot.count({ where: { employeeId: emp.id } }), 0, 'no screenshot row without consent');

  // Grant screenshot consent -> 200.
  await publishPolicy(org.id, 'screenshot', 'v1');
  await setConsent(emp.id, org.id, 'screenshot', 'granted');
  res = await postShot();
  const okBody = await res.json().catch(() => ({})) as Record<string, unknown>;
  assert.equal(res.status, 200, JSON.stringify(okBody));
  assert.equal(typeof okBody.filename, 'string');
  // Clean up the uploaded fixture file (shared uploads dir).
  rmSync(join(process.cwd(), 'uploads', 'screenshots', okBody.filename as string), { force: true });
  assert.equal(await db.screenshot.count({ where: { employeeId: emp.id } }), 1);

  // Revoke -> 403 again, nothing new persisted.
  await setConsent(emp.id, org.id, 'screenshot', 'revoked');
  res = await postShot();
  assert.equal(res.status, 403, 'revoked screenshot consent must block uploads');
  assert.equal(await db.screenshot.count({ where: { employeeId: emp.id } }), 1, 'no new screenshot rows after revoke');
});

test('ZT-24: activity alone does NOT enable screenshot (consents are independent)', async () => {
  const { emp, token } = await setupActiveDevice('ZT24', '203.0.113.24');
  await publishPolicy(org.id, 'activity_tracking', 'v1');
  await setConsent(emp.id, org.id, 'activity_tracking', 'granted');

  // Activity works...
  let res: Response = await activityApi.POST(req(token, { method: 'POST', body: { activities: [{ type: 'application', applicationName: 'chrome.exe', duration: 30 }] } }));
  assert.equal(res.status, 200);

  // ...but screenshot is still blocked (no screenshot consent).
  const fd = new FormData();
  fd.append('screenshot', new File([Buffer.from('x')], 'x.png', { type: 'image/png' }));
  res = await screenshotApi.POST(new NextRequest('http://localhost:3000/api/agent/screenshot', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: fd,
  }));
  assert.equal(res.status, 403, 'activity consent must never imply screenshot consent');
  assert.equal(await db.screenshot.count({ where: { employeeId: emp.id } }), 0);
});

// ─── B.5: config assignment (server-derived employee/dept/projects) ─────────

test('ZT-25: /api/agent/config returns server-derived assignment (employee, department, projects)', async () => {
  const dept = await db.department.create({ data: { name: 'B5 Engineering', organizationId: org.id } });
  const emp = await seedEmployee('ZT25-EMP', dept.id);
  const projA = await db.project.create({ data: { name: 'Project A', organizationId: org.id, status: 'active' } });
  const projB = await db.project.create({ data: { name: 'Project B', organizationId: org.id, status: 'active' } });
  await db.projectMember.create({ data: { projectId: projA.id, employeeId: emp.id, organizationId: org.id, role: 'member' } });
  await db.projectMember.create({ data: { projectId: projB.id, employeeId: emp.id, organizationId: org.id, role: 'member' } });
  // A completed project must NOT be surfaced to the agent.
  const projDone = await db.project.create({ data: { name: 'Project Done', organizationId: org.id, status: 'completed' } });
  await db.projectMember.create({ data: { projectId: projDone.id, employeeId: emp.id, organizationId: org.id, role: 'member' } });

  const { body } = await discover('key-zt-0025-config-assign-abcdef', '203.0.113.25');
  const admin = await tokenFor('admin', 'u-zt25-admin');
  const ar = await approve(admin, body.claimId as string, emp.id);
  assert.equal(ar.status, 200);
  const auth = await authApi.POST(req(null, { method: 'POST', body: { deviceId: body.deviceId, deviceSecret: body.secret }, ip: '203.0.113.25' }));
  const authBody = await auth.json().catch(() => ({})) as Record<string, unknown>;
  const res = await configApi.GET(req(authBody.token as string, { url: 'http://localhost:3000/api/agent/config' }));
  const parsed = await res.json();
  assert.equal(res.status, 200);

  const assignment = parsed.assignment;
  assert.ok(assignment, 'config must include assignment');
  assert.equal(assignment.employeeId, emp.employeeId);
  assert.equal(assignment.employeeName, `${emp.firstName} ${emp.lastName}`);
  assert.equal(assignment.department.name, 'B5 Engineering', 'department derived from Employee.departmentId');
  const names = assignment.projects.map((p: { name: string }) => p.name).sort();
  assert.deepEqual(names, ['Project A', 'Project B'], 'active projects only, from ProjectMember');
});

test('ZT-26: config assignment reflects admin changes (department move + project removal)', async () => {
  const deptY = await db.department.create({ data: { name: 'B5 Design', organizationId: org.id } });
  const emp = await seedEmployee('ZT26-EMP', deptY.id);
  const proj = await db.project.create({ data: { name: 'Project C', organizationId: org.id, status: 'active' } });
  await db.projectMember.create({ data: { projectId: proj.id, employeeId: emp.id, organizationId: org.id, role: 'member' } });

  const { body } = await discover('key-zt-0026-config-refresh-abcdef', '203.0.113.26');
  const admin = await tokenFor('admin', 'u-zt26-admin');
  assert.equal((await approve(admin, body.claimId as string, emp.id)).status, 200);
  const auth = await authApi.POST(req(null, { method: 'POST', body: { deviceId: body.deviceId, deviceSecret: body.secret }, ip: '203.0.113.26' }));
  const authBody = await auth.json().catch(() => ({})) as Record<string, unknown>;
  const getConfig = async () => (await configApi.GET(req(authBody.token as string, { url: 'http://localhost:3000/api/agent/config' }))).json();

  let cfg = await getConfig();
  assert.equal(cfg.assignment.department.name, 'B5 Design');
  assert.deepEqual(cfg.assignment.projects.map((p: { name: string }) => p.name), ['Project C']);

  // Admin moves the employee to another department and removes the project.
  await db.employee.update({ where: { id: emp.id }, data: { departmentId: null } });
  await db.projectMember.update({ where: { projectId_employeeId: { projectId: proj.id, employeeId: emp.id } }, data: { leftAt: new Date() } });

  cfg = await getConfig();
  assert.equal(cfg.assignment.department, null, 'no department assigned is surfaced as null (never fabricated)');
  assert.deepEqual(cfg.assignment.projects, [], 'left project no longer surfaced');
});

// ─── Phase D hardening: token generation + spoof-resistant client IP ────────

test('ZT-27: concurrent approval of two devices for the same employee leaves exactly ONE active device', async () => {
  const emp = await seedEmployee('ZT27-EMP');
  const admin = await tokenFor('admin', 'u-zt27-admin');

  const d1 = await discover('key-zt-0027a-concurrent-abcdef', '203.0.113.27');
  const d2 = await discover('key-zt-0027b-concurrent-abcdef', '203.0.113.27');

  // Fire both approvals without awaiting between them (true overlap).
  const results = await Promise.allSettled([
    claimApproveApi.POST(
      req(admin, { method: 'POST', body: { employeeId: emp.id, projectIds: [] }, ip: '198.51.100.27' }),
      { params: Promise.resolve({ id: d1.body.claimId as string }) }
    ),
    claimApproveApi.POST(
      req(admin, { method: 'POST', body: { employeeId: emp.id, projectIds: [] }, ip: '198.51.100.27' }),
      { params: Promise.resolve({ id: d2.body.claimId as string }) }
    ),
  ]);

  // Both must succeed (each claim is separate; the rule is enforced by the
  // transactional deactivation inside each approve, serialized by SQLite).
  for (const r of results) {
    assert.equal(r.status, 'fulfilled', 'both approvals must complete');
    if (r.status === 'fulfilled') assert.equal(r.value.status, 200);
  }

  // Exactly one device remains active for the employee — never zero, never two.
  const active = await db.device.count({
    where: { employeeId: emp.id, status: { in: ['online', 'offline'] } },
  });
  assert.equal(active, 1, 'concurrent approvals must leave exactly one active device');
  const online = await db.device.count({ where: { employeeId: emp.id, status: 'online' } });
  assert.equal(online, 1, 'the surviving device must be online');

  // Both claims are approved (history preserved); only the device is demoted.
  const approvedClaims = await db.deviceClaim.count({ where: { employeeId: emp.id, status: 'approved' } });
  assert.equal(approvedClaims, 2, 'both claims stay approved in history');
});

test('ZT-28: generateToken is always cryptographically random — never Math.random fallback', async () => {
  const { generateToken } = await import('../src/lib/agent/auth');
  const tokens = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const t = generateToken(64);
    assert.equal(t.length, 64);
    assert.match(t, /^[A-Za-z0-9]{64}$/);
    tokens.add(t);
  }
  assert.equal(tokens.size, 100, 'tokens must be unique');
});

test('ZT-29: getClientIp uses the rightmost x-forwarded-for entry (spoof-resistant, matches rate-limit)', async () => {
  const { getClientIp } = await import('../src/lib/agent/auth');
  // A client can only prepend to x-forwarded-for; the trusted proxy appends
  // the real IP last. The audit/device IP must be the RIGHTMOST entry.
  const spoofed = new Request('http://localhost:3000/api/agent/heartbeat', {
    headers: { 'x-forwarded-for': '1.2.3.4, 198.51.100.55' },
  });
  assert.equal(getClientIp(spoofed), '198.51.100.55');
  // x-real-ip takes precedence when present.
  const real = new Request('http://localhost:3000/api/agent/heartbeat', {
    headers: { 'x-forwarded-for': '1.2.3.4, 198.51.100.56', 'x-real-ip': '203.0.113.77' },
  });
  assert.equal(getClientIp(real), '203.0.113.77');
  // No headers -> unknown.
  assert.equal(getClientIp(new Request('http://localhost:3000/api/agent/heartbeat')), 'unknown');
});

// ─── Credential-loss recovery (approved device re-registration) ─────────────
// A one-time secret is issued exactly once; an approved device whose agent
// lost its local copy (fresh install / wiped userData) can NEVER recover it.
// The secure recovery: the agent re-registers (reRegister:true) and the server
// issues a FRESH pending claim (new secret) + admin re-approval, closing the
// old approved claim so its stale secret can never authenticate again.

test('ZT-30: approved device re-registering gets a FRESH claim; old claim closed, old secret dead', async () => {
  const emp = await seedEmployee('ZT30-EMP');
  const admin = await tokenFor('admin', 'u-zt30-admin');

  // 1) Normal flow: discover -> approve -> authenticate -> valid token.
  const first = await discover('key-zt-0030-recovery-abcdef', '203.0.113.30');
  assert.equal((await approve(admin, first.body.claimId as string, emp.id)).status, 200);
  const authRes = await authApi.POST(req(null, { method: 'POST', body: { deviceId: first.body.deviceId, deviceSecret: first.body.secret }, ip: '203.0.113.30' }));
  assert.equal(authRes.status, 200, 'first authentication must succeed');
  const oldSecret = first.body.secret as string;
  const oldClaimId = first.body.claimId as string;

  // 2) A plain poll (no reRegister) still sees the approved claim — no secret.
  const poll = await discover('key-zt-0030-recovery-abcdef', '203.0.113.30');
  assert.equal(poll.status, 200);
  assert.equal(poll.body.status, 'approved');
  assert.equal(poll.body.claimId, oldClaimId, 'plain poll keeps the same claim');
  assert.equal(poll.body.secret, undefined, 'approved claim never re-issues its one-time secret');

  // 3) Credential loss happens after the device has been offline long enough
  //    for its 24h token to lapse (a wiped disk / reinstall always takes
  //    longer than a token lifetime). The DoS guard requires the token to be
  //    dead before re-registration may supersede an approved claim.
  await db.agentToken.updateMany({
    where: { deviceId: first.body.deviceId as string },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });

  // 4) Credential lost → agent re-registers (reRegister:true) → FRESH pending
  //    claim with a NEW secret; the old approved claim is closed.
  const reReg = await discoverApi.POST(req(null, {
    method: 'POST',
    body: { ...discoverBody('key-zt-0030-recovery-abcdef'), reRegister: true },
    ip: '203.0.113.30',
  }));
  const reBody = await reReg.json().catch(() => ({})) as Record<string, unknown>;
  assert.equal(reReg.status, 201, JSON.stringify(reBody));
  assert.equal(reBody.status, 'pending');
  assert.notEqual(reBody.claimId, oldClaimId, 'a fresh claim supersedes the old one');
  assert.ok((reBody.secret as string).length >= 40, 'a fresh one-time secret is issued');

  const oldClaim = await db.deviceClaim.findUnique({ where: { id: oldClaimId } });
  assert.equal(oldClaim!.status, 'expired', 'superseded approved claim is closed');

  // 5) The old secret cannot authenticate against the new (pending) claim.
  const oldAuth = await authApi.POST(req(null, { method: 'POST', body: { deviceId: first.body.deviceId, deviceSecret: oldSecret }, ip: '203.0.113.30' }));
  const oldAuthBody = await oldAuth.json().catch(() => ({})) as Record<string, unknown>;
  assert.equal(oldAuth.status, 403, JSON.stringify(oldAuthBody));
  assert.equal(oldAuthBody.status, 'pending', 'device awaits re-approval');
  assert.equal(oldAuthBody.token, undefined);
});

test('ZT-31: recovery completes — re-approval of the fresh claim + new secret authenticates', async () => {
  const emp = await seedEmployee('ZT31-EMP');
  const admin = await tokenFor('admin', 'u-zt31-admin');

  const first = await discover('key-zt-0031-recovery2-abcdef', '203.0.113.31');
  assert.equal((await approve(admin, first.body.claimId as string, emp.id)).status, 200);

  // Credential lost → agent re-registers → FRESH pending claim + new secret.
  const reReg = await discoverApi.POST(req(null, {
    method: 'POST',
    body: { ...discoverBody('key-zt-0031-recovery2-abcdef'), reRegister: true },
    ip: '203.0.113.31',
  }));
  const reBody = await reReg.json().catch(() => ({})) as Record<string, unknown>;
  assert.equal(reReg.status, 201, JSON.stringify(reBody));

  // Still pending — the new secret must NOT authenticate yet.
  const before = await authApi.POST(req(null, { method: 'POST', body: { deviceId: reBody.deviceId, deviceSecret: reBody.secret }, ip: '203.0.113.31' }));
  assert.equal(before.status, 403);
  assert.equal((await before.json().catch(() => ({})) as Record<string, unknown>).status, 'pending');

  // Admin re-approves the NEW claim → the new secret authenticates end to end.
  const ar = await approve(admin, reBody.claimId as string, emp.id);
  assert.equal(ar.status, 200, JSON.stringify(ar.body));
  const after = await authApi.POST(req(null, { method: 'POST', body: { deviceId: reBody.deviceId, deviceSecret: reBody.secret, agentVersion: '1.2.0' }, ip: '203.0.113.31' }));
  const afterBody = await after.json().catch(() => ({})) as Record<string, unknown>;
  assert.equal(after.status, 200, JSON.stringify(afterBody));
  assert.equal(typeof afterBody.token, 'string');

  // The recovered token passes the real protected-route gate.
  const check = await validateAgentToken(new Request('http://localhost:3000/api/agent/heartbeat', {
    headers: { authorization: `Bearer ${afterBody.token}` },
  }));
  assert.equal(check.valid, true, 'recovered token must work on heartbeat');
  assert.equal(check.deviceId, reBody.deviceId);
});

test('ZT-32: reRegister replay on a device with a LIVE token is ignored (DoS guard)', async () => {
  const emp = await seedEmployee('ZT32-EMP');
  const admin = await tokenFor('admin', 'u-zt32-admin');

  const first = await discover('key-zt-0032-dos-guard-abcdef', '203.0.113.32');
  assert.equal((await approve(admin, first.body.claimId as string, emp.id)).status, 200);
  const authRes = await authApi.POST(req(null, { method: 'POST', body: { deviceId: first.body.deviceId, deviceSecret: first.body.secret }, ip: '203.0.113.32' }));
  assert.equal(authRes.status, 200, 'device authenticated — a live token now exists');

  // An attacker replaying reRegister (the agentKey is client-supplied, not a
  // secret) must NOT kill the working device's credential or force an admin
  // re-approval. The server only honors reRegister when no live token exists.
  const replay = await discoverApi.POST(req(null, {
    method: 'POST',
    body: { ...discoverBody('key-zt-0032-dos-guard-abcdef'), reRegister: true },
    ip: '203.0.113.32',
  }));
  const replayBody = await replay.json().catch(() => ({})) as Record<string, unknown>;
  assert.equal(replay.status, 200, JSON.stringify(replayBody));
  assert.equal(replayBody.status, 'approved', 'live device stays approved');
  assert.equal(replayBody.claimId, first.body.claimId, 'no fresh claim is issued');
  assert.equal(replayBody.secret, undefined, 'no new secret is minted');

  const claim = await db.deviceClaim.findUnique({ where: { id: first.body.claimId as string } });
  assert.equal(claim!.status, 'approved', 'the approved claim is never closed');
  assert.equal(
    await db.deviceClaim.count({ where: { deviceId: first.body.deviceId as string, status: 'pending' } }),
    0,
    'no pending claim appears for re-approval'
  );

  // The device's existing secret still authenticates — nothing was broken.
  const still = await authApi.POST(req(null, { method: 'POST', body: { deviceId: first.body.deviceId, deviceSecret: first.body.secret }, ip: '203.0.113.32' }));
  assert.equal(still.status, 200, 'original secret still works after the replay');
});

// ─── Expiry lifecycle (P3-3: lazy transition on read — no scheduler) ────────

test('EXP-1: a pending claim past its redemption window flips to expired on list GET; it can never be approved', async () => {
  const emp = await seedEmployee('EXP1-EMP');
  const admin = await tokenFor('admin', 'u-exp1-admin');
  const { body } = await discover('key-zt-exp1-expired-abcdef', '198.51.100.61');

  // Force the claim past its redemption window (the real TTL is ~30 days).
  await db.deviceClaim.update({
    where: { id: body.claimId as string },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });

  // 1. Approving BEFORE any list read → 422 (the route's own expiry guard).
  const direct = await approve(admin, body.claimId as string, emp.id);
  assert.equal(direct.status, 422, 'approving an un-flipped expired claim must fail with 422');

  // 2. The list GET lazily flips it (read-time only — no background job).
  const res = await claimsApi.GET(req(admin, { url: 'http://localhost:3000/api/device-claims?status=pending' }));
  const pendingBody = await res.json() as { data: Array<{ id: string }> };
  assert.ok(!pendingBody.data.some((c) => c.id === body.claimId), 'expired claim must vanish from the pending list');

  const stored = await db.deviceClaim.findUnique({ where: { id: body.claimId as string } });
  assert.equal(stored!.status, 'expired', 'lazy transition must persist expired');

  // 3. It IS visible under the expired filter (the admin can see why it's gone).
  const expRes = await claimsApi.GET(req(admin, { url: 'http://localhost:3000/api/device-claims?status=expired' }));
  const expBody = await expRes.json() as { data: Array<{ id: string; status: string }> };
  assert.ok(expBody.data.some((c) => c.id === body.claimId && c.status === 'expired'));

  // 4. Post-transition mutations are rejected — an expired claim is dead.
  const afterFlip = await approve(admin, body.claimId as string, emp.id);
  assert.equal(afterFlip.status, 400, 'approving an already-expired claim must fail with 400');
  const reject = await claimRejectApi.POST(
    req(admin, { method: 'POST', body: { reason: 'too late' }, ip: '198.51.100.61' }),
    { params: Promise.resolve({ id: body.claimId as string }) }
  );
  assert.equal(reject.status, 400, 'rejecting an already-expired claim must fail with 400');
});

test('EXP-2: a re-registering device gets a FRESH pending claim — the expired claim is never resurrected', async () => {
  const { body } = await discover('key-zt-exp2-rediscover-abcdef', '198.51.100.62');
  await db.deviceClaim.update({
    where: { id: body.claimId as string },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });

  // Flip via the list read (lazy transition).
  const admin = await tokenFor('admin', 'u-exp2-admin');
  await claimsApi.GET(req(admin, { url: 'http://localhost:3000/api/device-claims' }));
  const stored = await db.deviceClaim.findUnique({ where: { id: body.claimId as string } });
  assert.equal(stored!.status, 'expired');

  // The agent re-registers with the same deviceKey — a NEW claim is issued.
  const re = await discover('key-zt-exp2-rediscover-abcdef', '198.51.100.62');
  assert.equal(re.status, 201);
  assert.notEqual(re.body.claimId, body.claimId, 'a fresh claim id must be issued');
  assert.equal(re.body.status, 'pending');
  const fresh = await db.deviceClaim.findUnique({ where: { id: re.body.claimId as string } });
  assert.equal(fresh!.status, 'pending');
  assert.equal(
    await db.deviceClaim.count({ where: { deviceId: body.deviceId as string, status: 'pending' } }),
    1,
    'exactly one actionable pending claim per device'
  );
});

test('EXP-3: finalized claims (approved/rejected) are never flipped to expired by the list read', async () => {
  const emp = await seedEmployee('EXP3-EMP');
  const admin = await tokenFor('admin', 'u-exp3-admin');
  const d1 = await discover('key-zt-exp3-final-a-abcdef', '198.51.100.63');
  const d2 = await discover('key-zt-exp3-final-b-abcdef', '198.51.100.63');

  // Finalize BOTH while they are still valid.
  assert.equal((await approve(admin, d1.body.claimId as string, emp.id)).status, 200);
  assert.equal(
    (await claimRejectApi.POST(
      req(admin, { method: 'POST', body: { reason: 'no' }, ip: '198.51.100.63' }),
      { params: Promise.resolve({ id: d2.body.claimId as string }) }
    )).status,
    200
  );

  // Force BOTH past their redemption window, then read the list.
  await db.deviceClaim.update({
    where: { id: d1.body.claimId as string },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  await db.deviceClaim.update({
    where: { id: d2.body.claimId as string },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  await claimsApi.GET(req(admin, { url: 'http://localhost:3000/api/device-claims' }));

  const c1 = await db.deviceClaim.findUnique({ where: { id: d1.body.claimId as string } });
  const c2 = await db.deviceClaim.findUnique({ where: { id: d2.body.claimId as string } });
  assert.equal(c1!.status, 'approved', 'an approved claim must never be flipped to expired');
  assert.equal(c2!.status, 'rejected', 'a rejected claim must never be flipped to expired');
});

// ─── Server-side summary / pagination / search / org-less semantics ─────────

test('STATS-1: summary counts are complete server-side groupBy — never a first-page projection', async () => {
  const admin = await tokenFor('admin', 'u-stats1-admin');
  // 25 fresh pending claims — only ~20 would fit on the first page, so a
  // first-page projection would under-report.
  for (let i = 0; i < 25; i++) {
    await discover(`key-zt-stats1-${String(i).padStart(2, '0')}-abcdef`, '198.51.100.64');
  }

  const res = await claimsApi.GET(req(admin, { url: 'http://localhost:3000/api/device-claims?summary=true' }));
  const body = await res.json() as { summary: Record<string, number>; total: number };
  const groundTruth = await db.deviceClaim.count({ where: { organizationId: org.id, status: 'pending' } });
  assert.equal(body.summary.pending, groundTruth, 'summary.pending must match the real queue (not page 1)');
  assert.ok(body.summary.pending >= 25, 'at least the 25 created claims must be counted');
  const summed =
    body.summary.pending + body.summary.approved + body.summary.rejected +
    body.summary.revoked + body.summary.cancelled + body.summary.expired;
  assert.equal(summed, body.total, 'summary statuses must sum to the org total');
});

test('PS-1: device-claims pageSize is clamped to 1..100 (malformed input cannot force an unbounded query)', async () => {
  const admin = await tokenFor('admin', 'u-ps1-admin');
  const big = await claimsApi.GET(req(admin, { url: 'http://localhost:3000/api/device-claims?pageSize=1000' }));
  assert.equal((await big.json()).pageSize, 100);
  const tiny = await claimsApi.GET(req(admin, { url: 'http://localhost:3000/api/device-claims?pageSize=0' }));
  assert.equal((await tiny.json()).pageSize, 1);
  const bad = await claimsApi.GET(req(admin, { url: 'http://localhost:3000/api/device-claims?page=abc&pageSize=banana' }));
  const badBody = await bad.json() as { page: number; pageSize: number };
  assert.equal(badBody.page, 1);
  assert.equal(badBody.pageSize, 20);
});

test('Q-1: device-claims search narrows by hostname and bound employee name', async () => {
  const emp = await seedEmployee('QSEARCH-EMP');
  const admin = await tokenFor('admin', 'u-q1-admin');
  const { body } = await discover('key-zt-qsearch-abcdef', '198.51.100.65');
  // Binding the employee happens on approve (claim.employee is the assignment).
  assert.equal((await approve(admin, body.claimId as string, emp.id)).status, 200);

  const byHostname = await claimsApi.GET(req(admin, { url: 'http://localhost:3000/api/device-claims?q=PC-ZT' }));
  const hb = await byHostname.json() as { data: Array<{ id: string }> };
  assert.ok(hb.data.some((c) => c.id === body.claimId), 'hostname search must find the claim');

  const byEmployee = await claimsApi.GET(req(admin, { url: 'http://localhost:3000/api/device-claims?q=QSEARCH' }));
  const eb = await byEmployee.json() as { data: Array<{ id: string }> };
  assert.ok(eb.data.some((c) => c.id === body.claimId), 'employee-name search must find the assigned claim');

  const none = await claimsApi.GET(req(admin, { url: 'http://localhost:3000/api/device-claims?q=zzz-nothing-matches' }));
  assert.equal((await none.json()).data.length, 0);
});

test('SA-1: org-less super-admin receives an empty claims page — never business data', async () => {
  const saToken = await signJWT({ userId: 'u-sa-global', email: 'sa@global.local', role: 'super_admin' });
  const res = await claimsApi.GET(req(saToken, { url: 'http://localhost:3000/api/device-claims?summary=true' }));
  const body = await res.json() as { data: unknown[]; total: number; summary: Record<string, number> };
  assert.equal(body.data.length, 0);
  assert.equal(body.total, 0);
  assert.equal(body.summary.pending, 0);
  assert.equal(body.summary.expired, 0);
});

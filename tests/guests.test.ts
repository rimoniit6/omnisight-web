/**
 * Guest / zero-touch person-level enrollment — server-side tests.
 *
 * Proves the full guest lifecycle:
 *   discover -> pending DeviceClaim -> admin approve { mode: "guest" } (no
 *   employeeId, no AgentAccount, no consent) -> synthesized guest-backed
 *   Employee (type = "guest") -> PATH A device-secret authenticate -> token
 *   works -> telemetry gated by consent -> suspend / reactivate / revoke /
 *   convert -> tenant isolation + RBAC + duplicate/concurrency protection.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_guests).
 * Run: npx tsx --test tests/guests.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_guests';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-guests-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

before(() => {
  if (process.env.GUESTS_TEST_MIGRATED_DB !== '1') {
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
type ApproveApi = typeof import('../src/app/api/device-claims/[id]/approve/route');
type GuestsApi = typeof import('../src/app/api/guests/route');
type RevokeApi = typeof import('../src/app/api/guests/[id]/revoke/route');
type SuspendApi = typeof import('../src/app/api/guests/[id]/suspend/route');
type ReactivateApi = typeof import('../src/app/api/guests/[id]/reactivate/route');
type ConvertApi = typeof import('../src/app/api/guests/[id]/convert/route');
type ActivityApi = typeof import('../src/app/api/agent/activity/route');

let discoverApi: DiscoverApi;
let authApi: AuthApi;
let approveApi: ApproveApi;
let guestsApi: GuestsApi;
let revokeApi: RevokeApi;
let suspendApi: SuspendApi;
let reactivateApi: ReactivateApi;
let convertApi: ConvertApi;
let activityApi: ActivityApi;
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

let org: { id: string };
const ENROLL_CODE = 'test-enroll-code-guests-0123456789abcdef';

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  const agentAuthLib = await import('../src/lib/agent/auth');
  validateAgentToken = agentAuthLib.validateAgentToken;
  hashEnrollmentCode = agentAuthLib.hashEnrollmentCode;
  hasActiveConsent = (await import('../src/lib/consent')).hasActiveConsent;
  applyConsentTransition = (await import('../src/lib/consent')).applyConsentTransition;

  const [dApi, aApi, apApi, gApi, rvApi, spApi, rcApi, cvApi, actApi] = await Promise.all([
    import('../src/app/api/agent/discover/route'),
    import('../src/app/api/agent/authenticate/route'),
    import('../src/app/api/device-claims/[id]/approve/route'),
    import('../src/app/api/guests/route'),
    import('../src/app/api/guests/[id]/revoke/route'),
    import('../src/app/api/guests/[id]/suspend/route'),
    import('../src/app/api/guests/[id]/reactivate/route'),
    import('../src/app/api/guests/[id]/convert/route'),
    import('../src/app/api/agent/activity/route'),
  ]);
  discoverApi = dApi;
  authApi = aApi;
  approveApi = apApi;
  guestsApi = gApi;
  revokeApi = rvApi;
  suspendApi = spApi;
  reactivateApi = rcApi;
  convertApi = cvApi;
  activityApi = actApi;

  org = await db.organization.create({ data: { name: 'Guests Org', slug: 'guests-org' } });
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
  if (process.env.GUESTS_TEST_MIGRATED_DB !== '1') {
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

function discoverBody(deviceKey: string, hostname = 'PC-GUEST') {
  return { deviceKey, hostname, os: 'Windows 11', osVersion: '23H2', processor: 'x64', memory: '16GB', agentVersion: '1.2.0', arch: 'x64', enrollmentCode: ENROLL_CODE };
}

async function discover(deviceKey: string, ip: string) {
  const res = await discoverApi.POST(req(null, { method: 'POST', body: discoverBody(deviceKey), ip }));
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

async function approveGuest(adminToken: string, claimId: string) {
  const res = await approveApi.POST(
    req(adminToken, { method: 'POST', body: { mode: 'guest' }, ip: '198.51.100.9' }),
    { params: Promise.resolve({ id: claimId }) }
  );
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

/** Full guest setup: discover -> approve as guest -> PATH A authenticate. */
async function setupActiveGuest(label: string, ip: string) {
  const { body } = await discover(`key-g-${label.toLowerCase()}-device-abcdef`, ip);
  const admin = await tokenFor('admin', `u-${label}-admin`);
  const ar = await approveGuest(admin, body.claimId as string);
  assert.equal(ar.status, 200, JSON.stringify(ar.body));
  const res = await authApi.POST(req(null, { method: 'POST', body: { deviceId: body.deviceId, deviceSecret: body.secret, agentVersion: '1.2.0' }, ip }));
  const parsed = await res.json().catch(() => ({})) as Record<string, unknown>;
  assert.equal(res.status, 200, JSON.stringify(parsed));
  return { claim: body as Record<string, string>, token: parsed.token as string };
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

async function publishPolicy(orgId: string, consentType: string, version: string) {
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

// ─── G-1: guest approval (no employee credentials) ─────────────────────────

test('G-1: guest approval requires no employeeId and creates Guest + guest-backed Employee', async () => {
  // Monitoring consent is AUTO-GRANTED at approval, bound to the org's current
  // published policies — publish them so the grant can bind (a guest has no
  // employee portal to consent from; the approving admin is the authority).
  await publishPolicy(org.id, 'monitoring', 'v1');
  await publishPolicy(org.id, 'activity_tracking', 'v1');
  const { body } = await discover('key-g-0001-approve-guest-abcdef', '203.0.113.1');
  const admin = await tokenFor('admin', 'u-g1-admin');

  const res = await approveGuest(admin, body.claimId as string);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const data = res.body.data as Record<string, unknown>;

  const guestId = data.id as string;
  assert.equal(data.status, 'ACTIVE');
  assert.ok(data.approvedAt, 'approvedAt recorded');
  assert.equal(data.approvedBy, 'u-g1-admin');

  const guest = await db.guest.findUnique({ where: { id: guestId }, include: { employee: true, device: true } });
  assert.ok(guest);
  assert.equal(guest.organizationId, org.id);
  assert.equal(guest.employeeId, guest!.employee!.id);
  assert.equal(guest.employee.type, 'guest', 'employee is guest-typed');
  assert.equal(guest.employee.agentApproved, true);
  assert.match(guest.employee.employeeId, /^GUEST-[0-9A-F]{12}$/, 'clearly synthetic identity');
  assert.match(guest.employee.email, /@guests\.invalid$/, 'reserved email domain');
  assert.equal(guest.employee.organizationId, org.id);
  assert.equal(guest.device.employeeId, guest.employee.id, 'device bound to guest employee');
  assert.equal(guest.device.status, 'online', 'device activated');

  // No AgentAccount — hard invariant. Standard monitoring consent IS
  // auto-granted (bound to the published policies); everything else stays
  // inactive until a separate, deliberate grant.
  assert.equal(await db.agentAccount.count({ where: { employeeId: guest.employee.id } }), 0, 'no AgentAccount for guests');
  const consentTypes = (await db.consent.findMany({ where: { employeeId: guest.employee.id } })).map((c) => c.consentType).sort();
  assert.deepEqual(consentTypes, ['activity_tracking', 'monitoring'], 'monitoring + activity_tracking auto-granted at approval');
  assert.equal(await hasActiveConsent(guest.employee.id, 'activity_tracking'), true, 'activity_tracking active (published policy bound)');
  assert.equal(await hasActiveConsent(guest.employee.id, 'monitoring'), true, 'monitoring active (published policy bound)');
  for (const type of ['screenshot', 'keystroke', 'usb_monitoring', 'webcam_access', 'location', 'email_monitoring']) {
    assert.equal(await hasActiveConsent(guest.employee.id, type), false, `consent ${type} must remain inactive`);
  }
});

test('G-2: guest list API is org-scoped and status-filtered, never exposes secrets', async () => {
  await setupActiveGuest('G2', '203.0.113.2');
  const admin = await tokenFor('admin', 'u-g2-admin');

  const res = await guestsApi.GET(req(admin, { url: 'http://localhost:3000/api/guests?status=ACTIVE' }));
  const parsed = await res.json().catch(() => ({})) as { data?: Array<Record<string, unknown>>; total?: number };
  assert.equal(res.status, 200);
  assert.ok((parsed.total ?? 0) >= 1);
  const row = (parsed.data ?? []).find((g) => (g.employee as Record<string, unknown>).employeeId !== undefined);
  assert.ok(row, 'a guest row is returned');
  // No secrets: the payload carries identity + lifecycle metadata only.
  assert.equal((row.employee as Record<string, unknown>).type, 'guest');
  assert.equal('claimSecretHash' in row, false, 'no secret fields exposed');
  assert.equal('secret' in row, false, 'no secret fields exposed');
  assert.equal('deviceSecret' in (row.device as Record<string, unknown>), false, 'no device secret exposed');
});

test('G-3: guest cannot authenticate before approval (403 pending)', async () => {
  const { body } = await discover('key-g-0003-pending-auth-abcdef', '203.0.113.3');
  const res = await authApi.POST(req(null, { method: 'POST', body: { deviceId: body.deviceId, deviceSecret: body.secret }, ip: '203.0.113.3' }));
  const parsed = await res.json().catch(() => ({})) as Record<string, unknown>;
  assert.equal(res.status, 403);
  assert.equal(parsed.status, 'pending');
});

test('G-4: approved guest authenticates via PATH A and the token works', async () => {
  const { claim, token } = await setupActiveGuest('G4', '203.0.113.4');
  const check = await validateAgentToken(new Request('http://localhost:3000/api/agent/heartbeat', {
    headers: { authorization: `Bearer ${token}` },
  }));
  assert.equal(check.valid, true, 'guest token passes validateAgentToken');
  assert.equal(check.deviceId, claim.deviceId);
  const guest = await db.guest.findFirst({ where: { deviceId: claim.deviceId } });
  assert.equal(check.employee!.id, guest!.employeeId, 'token bound to guest-backed employee');
  assert.equal(check.employee!.organizationId, org.id);
});

test('G-5: guest telemetry upload works with the auto-granted consent — 403 after revoke, 200 after re-grant', async () => {
  const { claim, token } = await setupActiveGuest('G5', '203.0.113.5');
  const guest = await db.guest.findFirst({ where: { deviceId: claim.deviceId } });
  const employeeId = guest!.employeeId;

  const upload = () =>
    activityApi.POST(req(token, {
      method: 'POST',
      url: 'http://localhost:3000/api/agent/activity',
      body: { activities: [{ type: 'application', applicationName: 'chrome.exe', category: 'productive', duration: 10, timestamp: new Date().toISOString() }] },
      ip: '203.0.113.5',
    }));

  // Approval auto-granted activity_tracking consent (bound to the published
  // policy from G-1) — the guest's upload works immediately, no extra step.
  assert.equal(await hasActiveConsent(employeeId, 'activity_tracking'), true, 'consent auto-granted at approval');
  assert.equal((await upload()).status, 200, 'guest upload works with the auto-granted consent');
  assert.equal(await db.activity.count({ where: { employeeId } }), 1, 'activity attributed to guest-backed employee');

  // Revocation flips enforcement back to fail-closed (consent is never
  // bypassed — a revoked consent stops uploads exactly like any employee).
  await setConsent(employeeId, org.id, 'activity_tracking', 'revoked');
  assert.equal(await hasActiveConsent(employeeId, 'activity_tracking'), false);
  assert.equal((await upload()).status, 403, 'guest upload must be rejected after consent revocation');
  assert.equal(await db.activity.count({ where: { employeeId } }), 1, 'no rows written while consent revoked');

  // Re-grant through the audited state machine restores uploads.
  await setConsent(employeeId, org.id, 'activity_tracking', 'granted');
  assert.equal((await upload()).status, 200, 'guest upload works after re-grant');
  assert.equal(await db.activity.count({ where: { employeeId } }), 2, 'second row written after re-grant');
});

// ─── G-6: lifecycle mutations ───────────────────────────────────────────────

test('G-6: suspend fails closed — authentication and existing tokens rejected; reactivate restores', async () => {
  const { claim, token } = await setupActiveGuest('G6', '203.0.113.6');
  const admin = await tokenFor('admin', 'u-g6-admin');
  const guest = await db.guest.findFirst({ where: { deviceId: claim.deviceId } });

  // Suspend.
  const susp = await suspendApi.POST(
    req(admin, { method: 'POST', body: { reason: 'Review needed' }, ip: '198.51.100.6' }),
    { params: Promise.resolve({ id: guest!.id }) }
  );
  assert.equal(susp.status, 200, JSON.stringify(await susp.json()));

  const suspended = await db.guest.findUnique({ where: { id: guest!.id } });
  assert.equal(suspended!.status, 'SUSPENDED');
  assert.equal(suspended!.suspendedBy, 'u-g6-admin');
  assert.ok(suspended!.suspendedAt);
  assert.equal((await db.employee.findUnique({ where: { id: guest!.employeeId } }))!.status, 'inactive');
  assert.equal((await db.device.findUnique({ where: { id: claim.deviceId } }))!.status, 'inactive');

  // Re-auth fails closed.
  const reAuth = await authApi.POST(req(null, { method: 'POST', body: { deviceId: claim.deviceId, deviceSecret: claim.secret }, ip: '203.0.113.6' }));
  assert.equal(reAuth.status, 403, 'suspended guest cannot authenticate');

  // Existing token invalid (device inactive).
  const check = await validateAgentToken(new Request('http://localhost:3000/api/agent/activity', {
    headers: { authorization: `Bearer ${token}` },
  }));
  assert.equal(check.valid, false, 'suspended guest token fails closed');

  // Reactivate.
  const reac = await reactivateApi.POST(
    req(admin, { method: 'POST' }),
    { params: Promise.resolve({ id: guest!.id }) }
  );
  assert.equal(reac.status, 200, JSON.stringify(await reac.json()));
  const active = await db.guest.findUnique({ where: { id: guest!.id } });
  assert.equal(active!.status, 'ACTIVE');
  assert.equal(active!.suspendedAt, null);
  assert.equal((await db.employee.findUnique({ where: { id: guest!.employeeId } }))!.status, 'active');

  // Re-auth works again (device offline → eligible; PATH A brings it online).
  const authAgain = await authApi.POST(req(null, { method: 'POST', body: { deviceId: claim.deviceId, deviceSecret: claim.secret }, ip: '203.0.113.6' }));
  assert.equal(authAgain.status, 200, 'reactivated guest can authenticate again');
});

test('G-7: revoke is terminal — auth fails and token fails closed; audit recorded', async () => {
  const { claim, token } = await setupActiveGuest('G7', '203.0.113.7');
  const admin = await tokenFor('admin', 'u-g7-admin');
  const guest = await db.guest.findFirst({ where: { deviceId: claim.deviceId } });

  const rev = await revokeApi.POST(
    req(admin, { method: 'POST', body: { reason: 'Lost device' }, ip: '198.51.100.7' }),
    { params: Promise.resolve({ id: guest!.id }) }
  );
  assert.equal(rev.status, 200, JSON.stringify(await rev.json()));

  const revoked = await db.guest.findUnique({ where: { id: guest!.id } });
  assert.equal(revoked!.status, 'REVOKED');
  assert.equal(revoked!.revokedBy, 'u-g7-admin');

  const reAuth = await authApi.POST(req(null, { method: 'POST', body: { deviceId: claim.deviceId, deviceSecret: claim.secret }, ip: '203.0.113.7' }));
  assert.equal(reAuth.status, 403, 'revoked guest cannot authenticate');
  const check = await validateAgentToken(new Request('http://localhost:3000/api/agent/activity', {
    headers: { authorization: `Bearer ${token}` },
  }));
  assert.equal(check.valid, false, 'revoked guest token fails closed');

  const audit = await db.auditLog.findFirst({ where: { organizationId: org.id, action: 'guest_revoked', resourceId: guest!.id } });
  assert.ok(audit, 'guest_revoked audit event recorded');
  assert.equal(audit!.userId, 'u-g7-admin');
});

test('G-8: convert to employee — same employee row, telemetry preserved, guest row removed', async () => {
  const { claim } = await setupActiveGuest('G8', '203.0.113.8');
  const admin = await tokenFor('admin', 'u-g8-admin');
  const guest = await db.guest.findFirst({ where: { deviceId: claim.deviceId }, include: { employee: true } });
  const empId = guest!.employeeId;

  // Telemetry history exists before conversion.
  await db.activity.create({
    data: {
      employeeId: empId,
      type: 'application',
      applicationName: 'notepad.exe',
      category: 'neutral',
      duration: 120,
      timestamp: new Date(),
    },
  });

  const conv = await convertApi.POST(
    req(admin, {
      method: 'POST',
      body: { firstName: 'Jane', lastName: 'Doe', email: 'jane.doe@company.com', employeeId: 'JANE-DOE' },
      ip: '198.51.100.8',
    }),
    { params: Promise.resolve({ id: guest!.id }) }
  );
  assert.equal(conv.status, 200, JSON.stringify(await conv.json()));

  const employee = await db.employee.findUnique({ where: { id: empId } });
  assert.ok(employee, 'SAME employee row preserved');
  assert.equal(employee!.type, 'employee', 'flipped to employee');
  assert.equal(employee!.firstName, 'Jane');
  assert.equal(employee!.email, 'jane.doe@company.com');
  assert.equal(employee!.employeeId, 'JANE-DOE');
  assert.equal(employee!.guestId, null, 'guest association cleared');
  assert.equal(employee!.organizationId, org.id, 'organization unchanged');

  // Guest row removed from listings; telemetry attached to the same employee id.
  assert.equal(await db.guest.count({ where: { id: guest!.id } }), 0, 'guest row deleted');
  assert.equal(await db.activity.count({ where: { employeeId: empId } }), 1, 'telemetry preserved on same employee id');
  assert.equal(await db.agentAccount.count({ where: { employeeId: empId } }), 0, 'no AgentAccount auto-created');

  const audit = await db.auditLog.findFirst({ where: { organizationId: org.id, action: 'guest_converted', resourceId: guest!.id } });
  assert.ok(audit, 'guest_converted audit event recorded');
});

test('G-9: convert collisions rejected — email and employeeId must be unique', async () => {
  const { claim } = await setupActiveGuest('G9a', '203.0.113.9');
  const admin = await tokenFor('admin', 'u-g9-admin');
  const guest = await db.guest.findFirst({ where: { deviceId: claim.deviceId } });

  const taken = await db.employee.create({
    data: { employeeId: 'G9-EXISTING', firstName: 'Existing', lastName: 'Emp', email: 'existing@company.com', organizationId: org.id, status: 'active' },
  });

  // Email collision.
  const emailCollision = await convertApi.POST(
    req(admin, { method: 'POST', body: { firstName: 'A', lastName: 'B', email: 'existing@company.com' }, ip: '198.51.100.9' }),
    { params: Promise.resolve({ id: guest!.id }) }
  );
  assert.equal(emailCollision.status, 422, 'email collision must be rejected');

  // employeeId collision.
  const idCollision = await convertApi.POST(
    req(admin, { method: 'POST', body: { firstName: 'A', lastName: 'B', email: 'unique@company.com', employeeId: 'G9-EXISTING' }, ip: '198.51.100.9' }),
    { params: Promise.resolve({ id: guest!.id }) }
  );
  assert.equal(idCollision.status, 422, 'employeeId collision must be rejected');

  // Missing identity fields.
  const missing = await convertApi.POST(
    req(admin, { method: 'POST', body: { firstName: '', lastName: '', email: 'x@y.z' }, ip: '198.51.100.9' }),
    { params: Promise.resolve({ id: guest!.id }) }
  );
  assert.equal(missing.status, 422, 'missing identity fields must be rejected');
  assert.ok(taken);
});

// ─── G-10: tenant isolation + RBAC ──────────────────────────────────────────

test('G-10: cross-org guest approval concealed (404); guests list is org-scoped', async () => {
  const otherOrg = await db.organization.create({ data: { name: 'Other Guests Org', slug: 'other-guests-org' } });
  const foreignAdmin = await signJWT({ userId: 'u-foreign', email: 'foreign@other.local', role: 'admin', organizationId: otherOrg.id });
  const admin = await tokenFor('admin', 'u-g10-admin');

  const { body } = await discover('key-g-0010-crossorg-abcdef', '203.0.113.10');

  // Foreign admin acting on our claim -> 404 (concealed).
  const foreignApprove = await approveGuest(foreignAdmin, body.claimId as string);
  assert.equal(foreignApprove.status, 404);

  // Our admin approves it.
  const ownApprove = await approveGuest(admin, body.claimId as string);
  assert.equal(ownApprove.status, 200);

  // Foreign admin cannot see our guests.
  const foreignList = await guestsApi.GET(req(foreignAdmin, { url: 'http://localhost:3000/api/guests' }));
  const foreignParsed = await foreignList.json().catch(() => ({})) as { total?: number };
  assert.equal(foreignParsed.total ?? 0, 0, 'cross-org guest list must be empty');

  // Foreign admin lifecycle mutations on our guest -> 404.
  const guest = await db.guest.findFirst({ where: { deviceId: body.deviceId as string } });
  const foreignRevoke = await revokeApi.POST(
    req(foreignAdmin, { method: 'POST', body: { reason: 'x' }, ip: '198.51.100.10' }),
    { params: Promise.resolve({ id: guest!.id }) }
  );
  assert.equal(foreignRevoke.status, 404);
});

test('G-11: RBAC — approval is admin-only; guest lifecycle mutation is Org Admin OR Manager', async () => {
  const { body } = await discover('key-g-0011-rbac-abcdef', '203.0.113.11');
  const viewer = await tokenFor('viewer', 'u-g11-viewer');
  const employee = await tokenFor('employee', 'u-g11-emp');
  const manager = await tokenFor('manager', 'u-g11-mgr');

  // Approval (device-claims) is admin-only — manager is still denied here.
  for (const [label, token] of [['viewer', viewer], ['employee', employee], ['manager', manager]] as const) {
    const res = await approveGuest(token, body.claimId as string);
    assert.equal(res.status, 403, `${label} must not approve guests`);
  }

  // Admin approves; then guest lifecycle mutations (guests.manage) allow
  // Org Admin OR Manager, but deny viewer/employee.
  const admin = await tokenFor('admin', 'u-g11-admin');
  const ok = await approveGuest(admin, body.claimId as string);
  assert.equal(ok.status, 200);
  const guest = await db.guest.findFirst({ where: { deviceId: body.deviceId as string } });

  for (const [label, token] of [['viewer', viewer], ['employee', employee]] as const) {
    const res = await revokeApi.POST(
      req(token, { method: 'POST', body: { reason: 'x' }, ip: '198.51.100.11' }),
      { params: Promise.resolve({ id: guest!.id }) }
    );
    assert.equal(res.status, 403, `${label} must not revoke guests`);
  }

  // Manager may manage guest lifecycle.
  const mgrRes = await revokeApi.POST(
    req(manager, { method: 'POST', body: { reason: 'x' }, ip: '198.51.100.11' }),
    { params: Promise.resolve({ id: guest!.id }) }
  );
  assert.equal(mgrRes.status, 200, 'manager may revoke guests (guests.manage)');
});

// ─── G-12: duplicate / concurrency protection ───────────────────────────────

test('G-12: duplicate guest approval on the same claim is a 409, not a second guest', async () => {
  const { body } = await discover('key-g-0012-dupe-abcdef', '203.0.113.12');
  const admin = await tokenFor('admin', 'u-g12-admin');

  const first = await approveGuest(admin, body.claimId as string);
  assert.equal(first.status, 200);
  const second = await approveGuest(admin, body.claimId as string);
  assert.equal(second.status, 400, 'already-approved claim must be rejected');

  assert.equal(await db.guest.count({ where: { deviceId: body.deviceId as string } }), 1, 'only one guest row for the device');
});

test('G-13: two admins approving the same claim concurrently — exactly one wins, one 409', async () => {
  const { body } = await discover('key-g-0013-concurrent-abcdef', '203.0.113.13');
  const adminA = await tokenFor('admin', 'u-g13a-admin');
  const adminB = await tokenFor('admin', 'u-g13b-admin');

  const [ra, rb] = await Promise.all([
    approveGuest(adminA, body.claimId as string),
    approveGuest(adminB, body.claimId as string),
  ]);
  const statuses = [ra.status, rb.status].sort();
  assert.deepEqual(statuses, [200, 409], 'exactly one concurrent approval wins');
  assert.equal(await db.guest.count({ where: { deviceId: body.deviceId as string } }), 1, 'no duplicate guests');
  assert.equal(await db.employee.count({ where: { guestId: { not: null } } }), (await db.guest.count()), 'every guest has exactly one backing employee');
});

test('G-14: replay protection — rediscovery never re-issues the one-time secret', async () => {
  const first = await discover('key-g-0014-replay-abcdef', '203.0.113.14');
  assert.equal(first.status, 201);
  const second = await discover('key-g-0014-replay-abcdef', '203.0.113.14');
  assert.equal(second.status, 200);
  assert.equal(second.body.deviceId, first.body.deviceId);
  assert.equal(second.body.claimId, first.body.claimId);
  assert.equal(second.body.secret, undefined, 'one-time secret never re-issued');
});

test('G-15: expired claim cannot be approved as guest (422)', async () => {
  const { body } = await discover('key-g-0015-expired-abcdef', '203.0.113.15');
  await db.deviceClaim.update({
    where: { id: body.claimId as string },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });
  const admin = await tokenFor('admin', 'u-g15-admin');
  const res = await approveGuest(admin, body.claimId as string);
  assert.equal(res.status, 422, 'expired claim must be rejected');
});

test('G-16: pending guest enrollment cap — org limit blocks new guest enrollments, employees unaffected', async () => {
  // Isolated org so earlier tests' guests don't consume the cap.
  const capOrg = await db.organization.create({ data: { name: 'Cap Org', slug: 'cap-org' } });
  await db.organizationSetting.create({
    data: { organizationId: capOrg.id, key: 'agent_enrollment_code', value: hashEnrollmentCode('test-enroll-code-cap-0123456789'), category: 'agent' },
  });
  await db.organizationSetting.create({
    data: { organizationId: capOrg.id, key: 'guest_pending_limit', value: '2', category: 'agent' },
  });
  const admin = await signJWT({ userId: 'u-g16-admin', email: 'g16@cap.local', role: 'admin', organizationId: capOrg.id });

  const capDiscover = async (deviceKey: string, ip: string) => {
    const res = await discoverApi.POST(req(null, {
      method: 'POST',
      body: { deviceKey, hostname: 'PC-CAP', os: 'Windows 11', osVersion: '23H2', processor: 'x64', memory: '16GB', agentVersion: '1.2.0', arch: 'x64', enrollmentCode: 'test-enroll-code-cap-0123456789' },
      ip,
    }));
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
  };

  // First two guest approvals succeed.
  for (let i = 0; i < 2; i++) {
    const d = await capDiscover(`key-g-0016-cap-${i}-abcdef`, '203.0.113.16');
    const r = await approveGuest(admin, d.body.claimId as string);
    assert.equal(r.status, 200, `guest #${i} approval should succeed`);
  }

  // Third guest approval is blocked.
  const d3 = await capDiscover('key-g-0016-cap-2-abcdef', '203.0.113.16');
  const r3 = await approveGuest(admin, d3.body.claimId as string);
  assert.equal(r3.status, 422, 'guest enrollment cap must block further guest approvals');

  // Normal employee enrollment is NOT affected by the guest cap.
  const emp = await db.employee.create({
    data: { employeeId: 'G16-EMP', firstName: 'G16', lastName: 'Emp', email: 'g16@cap.local', organizationId: capOrg.id, status: 'active', agentApproved: false },
  });
  const d4 = await capDiscover('key-g-0016-emp-abcdef', '203.0.113.16');
  const r4 = await approveApi.POST(
    req(admin, { method: 'POST', body: { mode: 'employee', employeeId: emp.id }, ip: '198.51.100.16' }),
    { params: Promise.resolve({ id: d4.body.claimId as string }) }
  );
  assert.equal(r4.status, 200, 'employee approval must be unaffected by the guest cap');
});

test('G-17: concurrent guest approvals cannot bypass the per-org cap (org row lock)', async () => {
  // Isolated org with cap = 1: three devices race to be the single guest.
  const capOrg = await db.organization.create({ data: { name: 'Cap Org Concurrent', slug: 'cap-org-concurrent' } });
  await db.organizationSetting.create({
    data: { organizationId: capOrg.id, key: 'agent_enrollment_code', value: hashEnrollmentCode('test-enroll-code-capc-0123456789'), category: 'agent' },
  });
  await db.organizationSetting.create({
    data: { organizationId: capOrg.id, key: 'guest_pending_limit', value: '1', category: 'agent' },
  });
  const admin = await signJWT({ userId: 'u-g17-admin', email: 'g17@capc.local', role: 'admin', organizationId: capOrg.id });

  const capDiscover = async (deviceKey: string) => {
    const res = await discoverApi.POST(req(null, {
      method: 'POST',
      body: { deviceKey, hostname: 'PC-CAPC', os: 'Windows 11', osVersion: '23H2', processor: 'x64', memory: '16GB', agentVersion: '1.2.0', arch: 'x64', enrollmentCode: 'test-enroll-code-capc-0123456789' },
      ip: '203.0.113.17',
    }));
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
  };

  const claims: Array<{ deviceId: string; claimId: string }> = [];
  for (let i = 0; i < 3; i++) {
    const d = await capDiscover(`key-g-0017-capc-${i}-abcdef`);
    claims.push({ deviceId: d.body.deviceId as string, claimId: d.body.claimId as string });
  }

  // Fire all three approvals concurrently — the org lock serializes them so
  // exactly one succeeds and the other two hit the cap (422).
  const results = await Promise.all(claims.map((c) => approveGuest(admin, c.claimId)));
  const ok = results.filter((r) => r.status === 200).length;
  const capped = results.filter((r) => r.status === 422).length;
  assert.equal(ok, 1, 'exactly one concurrent guest approval must succeed under a cap of 1');
  assert.equal(capped, 2, 'the other two must be rejected by the cap');
  assert.equal(await db.guest.count({ where: { organizationId: capOrg.id, status: 'ACTIVE' } }), 1, 'exactly one guest row');
});

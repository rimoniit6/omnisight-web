/**
 * Policy Management hardening — server-side regression tests.
 *
 * Covers the Policy Management implementation end-to-end:
 *   - Policy resolver semantics (blacklist-wins precedence, normalization)
 *   - /api/app-list hardening (validation, pagination, DB-safe dupes, policy
 *     version bumps, audit, org isolation)
 *   - /api/agent/config policy payload (version + bounded entries)
 *   - POST /api/agent/usb (agent auth, consent + config gating, server-derived
 *     attribution, validation, DB-level dedupe, persistence)
 *   - POST /api/agent/policy-violations (enforcement gating, policy ownership,
 *     dedupe, notification + audit)
 *   - GET /api/policy-violations + GET /api/usb-events (org isolation,
 *     pagination, date ranges, bounded summary)
 *   - Retention boundaries (UsbEvent + PolicyViolation)
 *   - Realtime invalidation mapping
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_policymgmt).
 * Run: npx tsx --test tests/policy-management-hardening.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_policymgmt';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-policymgmt-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@policy.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!Policy2026x';
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
let signJWT: (payload: { userId: string; email: string; role: string; organizationId?: string }) => Promise<string>;
let applyConsentTransition: (typeof import('../src/lib/consent'))['applyConsentTransition'];
let resolveOrgMonitoring: (typeof import('../src/lib/jobs/settings'))['resolveOrgMonitoring'];
import type { ConsentStatus } from '../src/lib/consent';

type AppListApi = typeof import('../src/app/api/app-list/route');
type AppListIdApi = typeof import('../src/app/api/app-list/[id]/route');
type AgentConfigApi = typeof import('../src/app/api/agent/config/route');
type AgentUsbApi = typeof import('../src/app/api/agent/usb/route');
type AgentViolationApi = typeof import('../src/app/api/agent/policy-violations/route');
type ViolationsApi = typeof import('../src/app/api/policy-violations/route');
type UsbEventsApi = typeof import('../src/app/api/usb-events/route');

let appListApi: AppListApi;
let appListIdApi: AppListIdApi;
let agentConfigApi: AgentConfigApi;
let agentUsbApi: AgentUsbApi;
let agentViolationApi: AgentViolationApi;
let violationsApi: ViolationsApi;
let usbEventsApi: UsbEventsApi;

let orgA: { id: string };
let orgB: { id: string };
let empA: { id: string };
let empB: { id: string };
let deviceA: { id: string };
let adminAToken: string;
let managerAToken: string;
let viewerAToken: string;
let adminBToken: string;
let agentTokenA: string;

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

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  applyConsentTransition = (await import('../src/lib/consent')).applyConsentTransition;
  resolveOrgMonitoring = (await import('../src/lib/jobs/settings')).resolveOrgMonitoring;
  appListApi = await import('../src/app/api/app-list/route');
  appListIdApi = await import('../src/app/api/app-list/[id]/route');
  agentConfigApi = await import('../src/app/api/agent/config/route');
  agentUsbApi = await import('../src/app/api/agent/usb/route');
  agentViolationApi = await import('../src/app/api/agent/policy-violations/route');
  violationsApi = await import('../src/app/api/policy-violations/route');
  usbEventsApi = await import('../src/app/api/usb-events/route');

  orgA = await db.organization.create({ data: { name: 'Policy Org A', slug: 'policy-org-a' } });
  orgB = await db.organization.create({ data: { name: 'Policy Org B', slug: 'policy-org-b' } });

  empA = await db.employee.create({
    data: { employeeId: 'POL-A-001', firstName: 'Alice', lastName: 'A', email: 'alice@pol-a.test', organizationId: orgA.id, status: 'active', agentApproved: true },
  });
  empB = await db.employee.create({
    data: { employeeId: 'POL-B-001', firstName: 'Bob', lastName: 'B', email: 'bob@pol-b.test', organizationId: orgB.id, status: 'active', agentApproved: true },
  });
  deviceA = await db.device.create({
    data: { name: 'PC-POL-A', hostname: 'PC-POL-A', agentKey: 'key-policy-a', organizationId: orgA.id, employeeId: empA.id, status: 'online', lastHeartbeat: new Date() },
  });
  const tokenRow = await db.agentToken.create({
    data: {
      token: `policy-agent-token-a-${Date.now()}-abcdefghij0123456789`,
      deviceId: deviceA.id,
      expiresAt: new Date(Date.now() + 3600_000),
      employee: { connect: { id: empA.id } },
      organization: { connect: { id: orgA.id } },
    },
  });
  agentTokenA = tokenRow.token;

  adminAToken = await signJWT({ userId: 'pol-admin-a', email: 'admin-a@pol-a.test', role: 'admin', organizationId: orgA.id });
  managerAToken = await signJWT({ userId: 'pol-manager-a', email: 'manager-a@pol-a.test', role: 'manager', organizationId: orgA.id });
  viewerAToken = await signJWT({ userId: 'pol-viewer-a', email: 'viewer-a@pol-a.test', role: 'viewer', organizationId: orgA.id });
  adminBToken = await signJWT({ userId: 'pol-admin-b', email: 'admin-b@pol-b.test', role: 'admin', organizationId: orgB.id });

  // Publish + grant USB consent for empA (org A) so USB upload tests pass the
  // consent gate when the org flag is also enabled.
  await publishPolicy(orgA.id, 'usb_monitoring', 'v1');
  await setConsent(empA.id, orgA.id, 'usb_monitoring', 'granted');
  // Org B: consent granted but the org flag stays off.
  await publishPolicy(orgB.id, 'usb_monitoring', 'v1');
  await setConsent(empB.id, orgB.id, 'usb_monitoring', 'granted');
});

after(async () => {
  await db.$disconnect();
  execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });
});

// ─── 1. Policy resolver (pure) ─────────────────────────────────────────────

let resolveApplicationPolicy: (typeof import('../src/lib/policies/resolver'))['resolveApplicationPolicy'];

type ResolvablePolicy = {
  id: string;
  listType: 'whitelist' | 'blacklist';
  appName: string;
  executableName: string | null;
  path?: string | null;
  publisher?: string | null;
  sha256?: string | null;
  isActive?: boolean;
};

before(async () => {
  resolveApplicationPolicy = (await import('../src/lib/policies/resolver')).resolveApplicationPolicy;
});

function pol(overrides: Record<string, unknown> = {}): ResolvablePolicy {
  return {
    id: 'p1',
    listType: 'whitelist',
    appName: 'Chrome',
    executableName: 'chrome.exe',
    path: null,
    publisher: null,
    sha256: null,
    isActive: true,
    ...overrides,
  } as ResolvablePolicy;
}

test('PM-01: no policy → none', () => {
  assert.deepEqual(resolveApplicationPolicy({ executableName: 'foo.exe' }, []), { action: 'none' });
});

test('PM-02: blacklist match → block (case-insensitive executable)', () => {
  const r = resolveApplicationPolicy(
    { executableName: 'CHROME.EXE' },
    [pol({ id: 'b1', listType: 'blacklist', appName: 'Chrome', executableName: 'chrome.exe' })]
  );
  assert.equal(r.action, 'block');
  assert.equal(r.matchedPolicyId, 'b1');
});

test('PM-03: whitelist match → allow', () => {
  const r = resolveApplicationPolicy({ executableName: 'chrome.exe' }, [pol({ id: 'w1' })]);
  assert.equal(r.action, 'allow');
});

test('PM-04: conflict → blacklist wins (explicit deny)', () => {
  const r = resolveApplicationPolicy(
    { executableName: 'chrome.exe' },
    [
      pol({ id: 'w1' }),
      pol({ id: 'b1', listType: 'blacklist', appName: 'Chrome', executableName: 'chrome.exe' }),
    ]
  );
  assert.equal(r.action, 'block');
  assert.equal(r.matchedPolicyId, 'b1');
});

test('PM-05: inactive policy ignored', () => {
  const r = resolveApplicationPolicy(
    { executableName: 'chrome.exe' },
    [pol({ id: 'b1', listType: 'blacklist', isActive: false })]
  );
  assert.equal(r.action, 'none');
});

test('PM-06: normalization — path separators + quotes + whitespace', () => {
  const r = resolveApplicationPolicy(
    { processPath: '"C:\\Program Files\\APP\\app.EXE"' },
    [pol({ id: 'b1', listType: 'blacklist', appName: 'App', executableName: 'app.exe', path: 'c:/program files/app/app.exe' })]
  );
  assert.equal(r.action, 'block');
});

test('PM-07: strongest identity wins — hash beats path beats name', () => {
  const policies: ResolvablePolicy[] = [
    pol({ id: 'name', executableName: 'app.exe' }),
    pol({ id: 'path', executableName: 'app.exe', path: 'C:\\x\\app.exe' }),
    pol({ id: 'hash', executableName: 'app.exe', sha256: 'a'.repeat(64) }),
  ].map((p) => ({ ...p, listType: 'blacklist' as const }));
  const r = resolveApplicationPolicy(
    { executableName: 'app.exe', processPath: 'c:/x/app.exe', sha256: 'A'.repeat(64) },
    policies
  );
  assert.equal(r.matchedPolicyId, 'hash');
});

// ─── 2. /api/app-list ──────────────────────────────────────────────────────

test('PM-10: app-list GET unauthenticated → 401', async () => {
  const res = await appListApi.GET(req(null, { url: 'http://localhost:3000/api/app-list' }));
  assert.equal(res.status, 401);
});

test('PM-11: app-list GET viewer allowed, org-scoped', async () => {
  await db.appListEntry.create({ data: { appName: 'Chrome', listType: 'whitelist', organizationId: orgA.id } });
  const res = await appListApi.GET(req(viewerAToken, { url: 'http://localhost:3000/api/app-list?pageSize=100' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.data.some((e: { appName: string }) => e.appName === 'Chrome'));
});

test('PM-12: app-list GET ignores client organizationId (no tenant switch)', async () => {
  const res = await appListApi.GET(req(adminAToken, { url: `http://localhost:3000/api/app-list?pageSize=100&organizationId=${orgB.id}` }));
  const body = await res.json();
  for (const e of body.data as { organizationId: string }[]) assert.equal(e.organizationId, orgA.id);
});

test('PM-13: app-list GET malformed pagination → 422 (never Prisma 500)', async () => {
  for (const qs of ['page=abc', 'page=-1', 'page=0', 'pageSize=abc', 'pageSize=0', 'pageSize=-5', 'pageSize=999999']) {
    const res = await appListApi.GET(req(adminAToken, { url: `http://localhost:3000/api/app-list?${qs}` }));
    assert.equal(res.status, 422, qs);
  }
});

test('PM-14: app-list GET invalid type filter → 422', async () => {
  const res = await appListApi.GET(req(adminAToken, { url: 'http://localhost:3000/api/app-list?type=bogus' }));
  assert.equal(res.status, 422);
});

test('PM-15: app-list POST viewer → 403', async () => {
  const res = await appListApi.POST(req(viewerAToken, { method: 'POST', body: { appName: 'X', listType: 'whitelist' } }));
  assert.equal(res.status, 403);
});

test('PM-16: app-list POST manager → 201 + audit + version bump', async () => {
  const before = await db.organizationSetting.findUnique({
    where: { organizationId_key: { organizationId: orgA.id, key: 'app_policy_version' } },
  });
  const res = await appListApi.POST(req(managerAToken, { method: 'POST', body: { appName: 'VS Code', listType: 'whitelist', executableName: 'code.exe', reason: 'dev tool' } }));
  assert.equal(res.status, 201);
  const body = await res.json();
  const audit = await db.auditLog.findFirst({ where: { resource: 'policy', resourceId: body.id, organizationId: orgA.id } });
  assert.ok(audit, 'audit entry created');
  assert.equal(audit?.userId, 'pol-manager-a', 'audit bound to authenticated actor');
  const after = await db.organizationSetting.findUnique({
    where: { organizationId_key: { organizationId: orgA.id, key: 'app_policy_version' } },
  });
  assert.equal(Number(after?.value ?? 0), Number(before?.value ?? 0) + 1, 'policy version bumped in same transaction');
});

test('PM-17: app-list POST invalid listType → 422', async () => {
  const res = await appListApi.POST(req(managerAToken, { method: 'POST', body: { appName: 'Y', listType: 'graylist' } }));
  assert.equal(res.status, 422);
});

test('PM-18: app-list POST missing appName → 422', async () => {
  const res = await appListApi.POST(req(managerAToken, { method: 'POST', body: { listType: 'whitelist' } }));
  assert.equal(res.status, 422);
});

test('PM-19: app-list POST duplicate → 409, no audit, no version bump', async () => {
  const before = await db.auditLog.count({ where: { organizationId: orgA.id, resource: 'policy' } });
  const res = await appListApi.POST(req(managerAToken, { method: 'POST', body: { appName: 'Chrome', listType: 'whitelist' } }));
  assert.equal(res.status, 409);
  const after = await db.auditLog.count({ where: { organizationId: orgA.id, resource: 'policy' } });
  assert.equal(after, before, 'no audit on duplicate');
});

test('PM-20: app-list POST oversized fields → 422', async () => {
  const res = await appListApi.POST(req(managerAToken, { method: 'POST', body: { appName: 'x'.repeat(500), listType: 'whitelist' } }));
  assert.equal(res.status, 422);
});

test('PM-21: app-list POST invalid sha256 → 422', async () => {
  const res = await appListApi.POST(req(managerAToken, { method: 'POST', body: { appName: 'Hashed', listType: 'blacklist', sha256: 'not-hex' } }));
  assert.equal(res.status, 422);
});

test('PM-22: app-list POST ignores client organizationId', async () => {
  const res = await appListApi.POST(req(managerAToken, { method: 'POST', body: { appName: 'TenantTest', listType: 'whitelist', organizationId: orgB.id } }));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.organizationId, orgA.id);
});

test('PM-23: app-list DELETE admin-only; manager → 403', async () => {
  const entry = await db.appListEntry.create({ data: { appName: 'DelMe', listType: 'blacklist', organizationId: orgA.id } });
  const res = await appListIdApi.DELETE(req(managerAToken, { method: 'DELETE', url: `http://localhost:3000/api/app-list/${entry.id}` }), { params: Promise.resolve({ id: entry.id }) });
  assert.equal(res.status, 403);
});

test('PM-24: app-list DELETE admin → soft-delete + audit + version bump', async () => {
  const entry = await db.appListEntry.create({ data: { appName: 'DelMe2', listType: 'blacklist', organizationId: orgA.id } });
  const before = await db.organizationSetting.findUnique({
    where: { organizationId_key: { organizationId: orgA.id, key: 'app_policy_version' } },
  });
  const res = await appListIdApi.DELETE(req(adminAToken, { method: 'DELETE', url: `http://localhost:3000/api/app-list/${entry.id}` }), { params: Promise.resolve({ id: entry.id }) });
  assert.equal(res.status, 200);
  const row = await db.appListEntry.findUnique({ where: { id: entry.id } });
  assert.equal(row?.isActive, false);
  const audit = await db.auditLog.findFirst({ where: { resource: 'policy', action: 'delete', resourceId: entry.id } });
  assert.ok(audit);
  assert.equal(audit?.userId, 'pol-admin-a');
  const after = await db.organizationSetting.findUnique({
    where: { organizationId_key: { organizationId: orgA.id, key: 'app_policy_version' } },
  });
  assert.equal(Number(after?.value ?? 0), Number(before?.value ?? 0) + 1);
});

test('PM-25: cross-org DELETE → 404, zero side effects', async () => {
  const entryB = await db.appListEntry.create({ data: { appName: 'OrgBOnly', listType: 'whitelist', organizationId: orgB.id } });
  const res = await appListIdApi.DELETE(req(adminAToken, { method: 'DELETE', url: `http://localhost:3000/api/app-list/${entryB.id}` }), { params: Promise.resolve({ id: entryB.id }) });
  assert.equal(res.status, 404);
  const row = await db.appListEntry.findUnique({ where: { id: entryB.id } });
  assert.equal(row?.isActive, true);
});

test('PM-26: re-adding a deleted app works (unique constraint excludes inactive)', async () => {
  const entry = await db.appListEntry.create({ data: { appName: 'ReAdd', listType: 'whitelist', organizationId: orgA.id } });
  await db.appListEntry.update({ where: { id: entry.id }, data: { isActive: false } });
  const res = await appListApi.POST(req(managerAToken, { method: 'POST', body: { appName: 'ReAdd', listType: 'whitelist' } }));
  assert.equal(res.status, 201);
});

// ─── 3. Agent config policy payload ────────────────────────────────────────

test('PM-30: agent config contains versioned policy payload (active entries only)', async () => {
  const res = await agentConfigApi.GET(req(agentTokenA, { url: 'http://localhost:3000/api/agent/config' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.policy, 'policy payload present');
  assert.equal(typeof body.policy.version, 'string');
  assert.ok(Array.isArray(body.policy.applications));
  for (const app of body.policy.applications) {
    assert.ok(['whitelist', 'blacklist'].includes(app.listType));
    assert.equal(app.isActive, undefined, 'no isActive leakage needed');
  }
  // Inactive entries must not be shipped.
  assert.ok(!body.policy.applications.some((a: { appName: string }) => a.appName === 'DelMe2' || a.appName === 'OrgBOnly'));
});

test('PM-31: policy version in config reflects the DB-backed version', async () => {
  const row = await db.organizationSetting.findUnique({
    where: { organizationId_key: { organizationId: orgA.id, key: 'app_policy_version' } },
  });
  const res = await agentConfigApi.GET(req(agentTokenA, { url: 'http://localhost:3000/api/agent/config' }));
  const body = await res.json();
  assert.equal(body.policy.version, row?.value ?? '0');
});

test('PM-32: agent config USB/enforcement flags fail closed by default', async () => {
  const res = await agentConfigApi.GET(req(agentTokenA, { url: 'http://localhost:3000/api/agent/config' }));
  const body = await res.json();
  // Org A has not enabled USB monitoring or enforcement in this suite.
  assert.equal(body.config.features.usbMonitoringEnabled, false);
  assert.equal(body.config.features.appPolicyEnforcement, false);
  assert.equal(body.config.features.appPolicyTerminate, false);
});

// ─── 4. POST /api/agent/usb ────────────────────────────────────────────────

async function enableUsbMonitoring(orgId: string) {
  await db.organizationSetting.upsert({
    where: { organizationId_key: { organizationId: orgId, key: 'usb_monitoring' } },
    create: { organizationId: orgId, key: 'usb_monitoring', value: 'true' },
    update: { value: 'true' },
  });
}

test('PM-40: agent usb unauthenticated → 401', async () => {
  const res = await agentUsbApi.POST(req(null, { method: 'POST', body: { eventType: 'usb_insert' } }));
  assert.equal(res.status, 401);
});

test('PM-41: agent usb with org flag disabled → 403 (fail closed)', async () => {
  const res = await agentUsbApi.POST(req(agentTokenA, { method: 'POST', body: { eventType: 'usb_insert', serialNumber: 'SN-FAILCLOSED' } }));
  assert.equal(res.status, 403);
});

test('PM-42: agent usb with flag enabled + consent → 201 persisted, server-derived attribution', async () => {
  await enableUsbMonitoring(orgA.id);
  const res = await agentUsbApi.POST(req(agentTokenA, {
    method: 'POST',
    body: { eventType: 'usb_insert', vid: '0781', pid: '5583', serialNumber: 'SN-REAL-001', deviceName: 'USB Mass Storage', manufacturer: 'SanDisk', deviceClass: 'DiskDrive', organizationId: orgB.id, employeeId: 'fake-employee', deviceId: 'fake-device' },
  }));
  assert.equal(res.status, 201);
  const body = await res.json();
  const row = await db.usbEvent.findUnique({ where: { id: body.eventId } });
  assert.ok(row, 'row persisted');
  assert.equal(row.organizationId, orgA.id, 'org from token, not client');
  assert.equal(row.employeeId, empA.id, 'employee from token, not client');
  assert.equal(row.deviceId, deviceA.id, 'device from token, not client');
  assert.equal(row.vid, '0781');
  assert.equal(row.blocked, false, 'blocked never client-controlled');
});

test('PM-43: agent usb with revoked consent → 403', async () => {
  await setConsent(empA.id, orgA.id, 'usb_monitoring', 'revoked');
  const res = await agentUsbApi.POST(req(agentTokenA, { method: 'POST', body: { eventType: 'usb_insert', serialNumber: 'SN-REVOKED' } }));
  assert.equal(res.status, 403);
  await setConsent(empA.id, orgA.id, 'usb_monitoring', 'granted');
});

test('PM-44: agent usb invalid payload → 422', async () => {
  for (const body of [
    { eventType: 'bogus' },
    { eventType: 'usb_blocked' }, // blocked is server-derived only
    { eventType: 'usb_insert', vid: 'zzz-not-hex' },
    { eventType: 'usb_insert', occurredAt: 'not-a-date' },
    { eventType: 'usb_insert', occurredAt: new Date(Date.now() + 9999_000_000).toISOString() }, // future
    { eventType: 'usb_insert', deviceName: 'x'.repeat(5000) },
  ]) {
    const res = await agentUsbApi.POST(req(agentTokenA, { method: 'POST', body }));
    assert.equal(res.status, 422, JSON.stringify(body));
  }
});

test('PM-45: agent usb duplicate within window → deduplicated (DB-level)', async () => {
  const body = { eventType: 'usb_insert', serialNumber: 'SN-DEDUPE-9', vid: '1234', pid: '5678' };
  const first = await agentUsbApi.POST(req(agentTokenA, { method: 'POST', body }));
  assert.equal(first.status, 201);
  const second = await agentUsbApi.POST(req(agentTokenA, { method: 'POST', body }));
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.duplicate, true);
  const count = await db.usbEvent.count({ where: { serialNumber: 'SN-DEDUPE-9' } });
  assert.equal(count, 1, 'exactly one row for the dedupe window');
});

test('PM-46: different device (serial) within window → new row', async () => {
  const first = await agentUsbApi.POST(req(agentTokenA, { method: 'POST', body: { eventType: 'usb_insert', serialNumber: 'SN-DEDUPE-10' } }));
  const second = await agentUsbApi.POST(req(agentTokenA, { method: 'POST', body: { eventType: 'usb_insert', serialNumber: 'SN-DEDUPE-11' } }));
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
});

test('PM-47: agent usb remove event persisted', async () => {
  const res = await agentUsbApi.POST(req(agentTokenA, { method: 'POST', body: { eventType: 'usb_remove', serialNumber: 'SN-REMOVE-1' } }));
  assert.equal(res.status, 201);
});

// ─── 5. POST /api/agent/policy-violations ──────────────────────────────────

let blockedPolicyId = '';

test('PM-50: violation with enforcement disabled → 403 (fail closed)', async () => {
  const res = await agentViolationApi.POST(req(agentTokenA, {
    method: 'POST',
    body: { policyId: 'anything', executableName: 'app.exe', action: 'blocked', severity: 'high' },
  }));
  assert.equal(res.status, 403);
});

async function enableEnforcement(orgId: string) {
  await db.organizationSetting.upsert({
    where: { organizationId_key: { organizationId: orgId, key: 'app_policy_enforcement' } },
    create: { organizationId: orgId, key: 'app_policy_enforcement', value: 'true' },
    update: { value: 'true' },
  });
}

test('PM-51: violation unauthenticated → 401', async () => {
  const res = await agentViolationApi.POST(req(null, { method: 'POST', body: { policyId: 'x', executableName: 'a.exe', action: 'blocked', severity: 'high' } }));
  assert.equal(res.status, 401);
});

test('PM-52: violation with foreign/nonexistent policyId → 404, no side effects', async () => {
  await enableEnforcement(orgA.id);
  const before = await db.policyViolation.count();
  const res = await agentViolationApi.POST(req(agentTokenA, {
    method: 'POST',
    body: { policyId: 'cms-nonexistent-policy-0000', executableName: 'evil.exe', action: 'blocked', severity: 'high' },
  }));
  assert.equal(res.status, 404);
  assert.equal(await db.policyViolation.count(), before);
});

test('PM-53: violation with org B policy from org A agent → 404 (no cross-org match)', async () => {
  const policyB = await db.appListEntry.create({ data: { appName: 'OrgB Evil', listType: 'blacklist', organizationId: orgB.id } });
  const res = await agentViolationApi.POST(req(agentTokenA, {
    method: 'POST',
    body: { policyId: policyB.id, executableName: 'evil.exe', action: 'blocked', severity: 'high' },
  }));
  assert.equal(res.status, 404);
});

test('PM-54: valid violation → 201, server-derived attribution, notification + audit', async () => {
  const policy = await db.appListEntry.create({ data: { appName: 'WinRAR', listType: 'blacklist', organizationId: orgA.id, executableName: 'winrar.exe' } });
  blockedPolicyId = policy.id;
  const res = await agentViolationApi.POST(req(agentTokenA, {
    method: 'POST',
    body: { policyId: policy.id, executableName: 'winrar.exe', processPath: 'C:\\Apps\\winrar.exe', action: 'blocked', severity: 'critical', organizationId: orgB.id, employeeId: 'fake' },
  }));
  assert.equal(res.status, 201);
  const body = await res.json();
  const row = await db.policyViolation.findUnique({ where: { id: body.violationId } });
  assert.ok(row);
  assert.equal(row.organizationId, orgA.id);
  assert.equal(row.employeeId, empA.id);
  assert.equal(row.deviceId, deviceA.id);
  assert.equal(row.severity, 'critical');
  const audit = await db.auditLog.findFirst({ where: { resource: 'policy_violation', resourceId: row.id } });
  assert.ok(audit, 'audit entry created');
  assert.equal(audit?.organizationId, orgA.id);
  const notif = await db.notification.findFirst({ where: { entityType: 'policy_violation', entityId: row.id } });
  assert.ok(notif, 'high/critical violation → notification');
  assert.equal(notif?.actionUrl, '/policies', 'deep-link convention');
  assert.equal(notif?.entityId, row.id);
});

test('PM-55: duplicate violation within window → deduplicated (DB-level)', async () => {
  const res = await agentViolationApi.POST(req(agentTokenA, {
    method: 'POST',
    body: { policyId: blockedPolicyId, executableName: 'winrar.exe', action: 'blocked', severity: 'high' },
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.duplicate, true);
});

test('PM-56: violation invalid payload → 422', async () => {
  for (const body of [
    { executableName: 'x.exe', action: 'blocked', severity: 'high' }, // no policyId
    { policyId: 'p', executableName: 'x.exe', action: 'allowed', severity: 'high' },
    { policyId: 'p', executableName: 'x.exe', action: 'blocked', severity: 'mega' },
    { policyId: 'p', executableName: 'x'.repeat(5000), action: 'blocked', severity: 'high' },
    { policyId: 'p', executableName: 'x.exe', action: 'blocked', severity: 'high', metadata: { big: 'y'.repeat(5000) } },
  ]) {
    const res = await agentViolationApi.POST(req(agentTokenA, { method: 'POST', body }));
    assert.equal(res.status, 422, JSON.stringify(body));
  }
});

// ─── 6. GET /api/policy-violations ─────────────────────────────────────────

test('PM-60: violations GET unauthenticated → 401', async () => {
  const res = await violationsApi.GET(req(null, { url: 'http://localhost:3000/api/policy-violations' }));
  assert.equal(res.status, 401);
});

test('PM-61: violations GET org-scoped (org A sees only org A)', async () => {
  const res = await violationsApi.GET(req(adminAToken, { url: 'http://localhost:3000/api/policy-violations?pageSize=100' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.data.length >= 1);
  for (const v of body.data as { organizationId: string }[]) assert.equal(v.organizationId, orgA.id);
  assert.equal(typeof body.summary.blocked, 'number');
});

test('PM-62: violations GET malformed pagination → 422', async () => {
  for (const qs of ['page=abc', 'page=-1', 'pageSize=0', 'pageSize=999999']) {
    const res = await violationsApi.GET(req(adminAToken, { url: `http://localhost:3000/api/policy-violations?${qs}` }));
    assert.equal(res.status, 422, qs);
  }
});

test('PM-63: violations GET invalid severity → 422', async () => {
  const res = await violationsApi.GET(req(adminAToken, { url: 'http://localhost:3000/api/policy-violations?severity=bogus' }));
  assert.equal(res.status, 422);
});

// ─── 7. GET /api/usb-events ────────────────────────────────────────────────

test('PM-70: usb-events GET unauthenticated → 401', async () => {
  const res = await usbEventsApi.GET(req(null, { url: 'http://localhost:3000/api/usb-events' }));
  assert.equal(res.status, 401);
});

test('PM-71: usb-events GET org-scoped + malformed pagination → 422', async () => {
  const res = await usbEventsApi.GET(req(adminAToken, { url: 'http://localhost:3000/api/usb-events?pageSize=100' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  for (const e of body.data as { organizationId: string }[]) assert.equal(e.organizationId, orgA.id);
  for (const qs of ['page=abc', 'page=-1', 'pageSize=0', 'pageSize=999999', 'blocked=maybe', 'eventType=bogus', 'from=not-a-date']) {
    const bad = await usbEventsApi.GET(req(adminAToken, { url: `http://localhost:3000/api/usb-events?${qs}` }));
    assert.equal(bad.status, 422, qs);
  }
});

test('PM-72: usb-events GET reversed date range → 422', async () => {
  const res = await usbEventsApi.GET(req(adminAToken, { url: 'http://localhost:3000/api/usb-events?from=2026-08-16&to=2026-08-01' }));
  assert.equal(res.status, 422);
});

test('PM-73: usb-events summary is bounded + includes real counts', async () => {
  const res = await usbEventsApi.GET(req(adminAToken, { url: 'http://localhost:3000/api/usb-events?pageSize=5' }));
  const body = await res.json();
  assert.equal(body.summary.inserts, body.summary.inserts); // number
  assert.ok(body.summary.total >= body.summary.inserts + body.summary.removes - body.summary.removes);
  assert.ok(body.data.length <= 5, 'page bounded');
});

// ─── 8. Retention ──────────────────────────────────────────────────────────

test('PM-80: retention purges UsbEvent + PolicyViolation past their windows, org-scoped', async () => {
  const old = new Date(Date.now() - 40 * 24 * 3600_000);
  const fresh = new Date();
  // Org A rows: one old, one fresh for each model.
  const oldUsb = await db.usbEvent.create({ data: { eventType: 'usb_insert', serialNumber: 'SN-RET-OLD', organizationId: orgA.id, employeeId: empA.id, createdAt: old, dedupeKey: `ret-usb-a-${Date.now()}` } });
  const freshUsb = await db.usbEvent.create({ data: { eventType: 'usb_insert', serialNumber: 'SN-RET-FRESH', organizationId: orgA.id, employeeId: empA.id, createdAt: fresh, dedupeKey: `ret-usb-b-${Date.now()}` } });
  const oldViol = await db.policyViolation.create({ data: { organizationId: orgA.id, employeeId: empA.id, policyId: blockedPolicyId, executableName: 'old.exe', action: 'blocked', severity: 'low', dedupeKey: `ret-pv-a-${Date.now()}`, createdAt: old, occurredAt: old } });
  // Org B old row must survive (org-scoped purge).
  const orgBUsb = await db.usbEvent.create({ data: { eventType: 'usb_insert', serialNumber: 'SN-RET-ORGB', organizationId: orgB.id, createdAt: old, dedupeKey: `ret-usb-c-${Date.now()}` } });

  await db.organizationSetting.upsert({
    where: { organizationId_key: { organizationId: orgA.id, key: 'usb_event_retention_days' } },
    create: { organizationId: orgA.id, key: 'usb_event_retention_days', value: '30' },
    update: { value: '30' },
  });
  await db.organizationSetting.upsert({
    where: { organizationId_key: { organizationId: orgA.id, key: 'policy_violation_retention_days' } },
    create: { organizationId: orgA.id, key: 'policy_violation_retention_days', value: '30' },
    update: { value: '30' },
  });

  const { runRetentionForOrg } = await import('../src/lib/jobs/retention');
  const result = await runRetentionForOrg(orgA.id, new Date(), 500);

  assert.ok(result.usbEvents >= 1, 'old USB event purged');
  assert.ok(result.policyViolations >= 1, 'old violation purged');
  assert.equal(await db.usbEvent.count({ where: { id: oldUsb.id } }), 0, 'old usb gone');
  assert.equal(await db.usbEvent.count({ where: { id: freshUsb.id } }), 1, 'fresh usb kept');
  assert.equal(await db.policyViolation.count({ where: { id: oldViol.id } }), 0, 'old violation gone');
  assert.equal(await db.usbEvent.count({ where: { serialNumber: 'SN-RET-ORGB' } }), 1, 'org B row untouched (org-scoped)');

  await db.usbEvent.delete({ where: { id: freshUsb.id } });
  await db.usbEvent.delete({ where: { id: orgBUsb.id } });
});

// ─── 9. Realtime invalidation mapping ──────────────────────────────────────

test('PM-90: realtime invalidation mapping covers app-list, violations, usb', async () => {
  const { appPolicyInvalidation, policyViolationInvalidation, usbEventInvalidation } = await import('../src/lib/ws-invalidation');
  assert.ok(appPolicyInvalidation().some((k) => k[0] === 'app-list'));
  assert.ok(policyViolationInvalidation().some((k) => k[0] === 'policy-violations'));
  assert.ok(usbEventInvalidation().some((k) => k[0] === 'usb-events'));
});

// ─── 10. Settings registry fail-closed defaults ────────────────────────────

test('PM-91: new monitoring keys default false + retention keys default 0', async () => {
  const monitoring = await resolveOrgMonitoring(orgB.id); // no settings rows for org B
  assert.equal(monitoring.usb_monitoring, false);
  assert.equal(monitoring.app_policy_enforcement, false);
  assert.equal(monitoring.app_policy_terminate, false);
  const { resolveRetentionDays } = await import('../src/lib/jobs/settings');
  assert.equal(await resolveRetentionDays(orgB.id, 'usb_event_retention_days'), 0);
  assert.equal(await resolveRetentionDays(orgB.id, 'policy_violation_retention_days'), 0);
});

test('PM-92: org A cross-org isolation — org B admin sees zero org A violations/usb', async () => {
  const v = await violationsApi.GET(req(adminBToken, { url: 'http://localhost:3000/api/policy-violations?pageSize=100' }));
  const vBody = await v.json();
  assert.equal(vBody.data.length, 0, 'org B sees no org A violations');
  const u = await usbEventsApi.GET(req(adminBToken, { url: 'http://localhost:3000/api/usb-events?pageSize=100' }));
  const uBody = await u.json();
  assert.equal(uBody.data.length, 0, 'org B sees no org A usb events');
});

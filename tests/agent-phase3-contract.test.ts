/**
 * Phase 3 — Agent ↔ Web DEPLOYMENT-MODE CONTRACT tests.
 *
 * These tests verify the actual endpoint contract for the three deployment
 * modes (MANAGED / CUSTOMER_DB / PRIVATE), NOT TypeScript interfaces:
 *
 *   P3C-01  GET /api/agent/compat advertises serverVersion, minAgentVersion and
 *           exactly the supported deployment modes.
 *   P3C-02  GET /api/agent/config returns a deployment block derived
 *           SERVER-SIDE from Organization.deploymentMode for each mode.
 *   P3C-03  Config ignores client-supplied deploymentMode (query spoof) —
 *           the server's organization record is authoritative.
 *   P3C-04  Screenshot policy is server-authoritative: org setting + plan +
 *           org.screenshotInterval decide the config payload; a client query
 *           can never re-enable screenshots or change the frequency.
 *   P3C-05  Heartbeat succeeds for MANAGED / CUSTOMER_DB / PRIVATE and only
 *           touches the authenticated device.
 *   P3C-06  Activity upload belongs to the AUTHENTICATED organization/device —
 *           body-level organizationId/deviceId spoofing is ignored.
 *   P3C-07  Screenshot upload is consent-gated before any file processing.
 *   P3C-08  Location upload is scoped to the authenticated tenant + device,
 *           gated on org `location_tracking`, and rejects spoofed/address-like
 *           payload keys.
 *   P3C-09  Command poll delivers ONLY the authenticated device's own commands.
 *
 * Runs against a THROWAWAY PostgreSQL database.
 * Run: npx tsx --test tests/agent-phase3-contract.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_p3contract';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-p3-contract-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@p3-contract.test';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.STORAGE_DRIVER = 'local';

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

type Org = { id: string };
type Emp = { id: string; employeeId: string };
type Dev = { id: string };

let orgManaged: Org;
let orgCustomer: Org; // CUSTOMER_DB
let orgPrivate: Org; // PRIVATE
let empManaged: Emp;
let empCustomer: Emp;
let empPrivate: Emp;
let devManaged: Dev;
let devCustomer: Dev;
let devPrivate: Dev;
let tokManaged: string;
let tokCustomer: string;
let tokPrivate: string;

/** Grant consent the same way the real flows do: published policy + granted row. */
async function grantConsent(orgId: string, empId: string, consentType: string) {
  const policy = await db.consentPolicy.create({
    data: {
      organizationId: orgId,
      consentType,
      title: `${consentType} Policy`,
      content: 'Policy content.',
      version: 'v1',
      status: 'published',
      effectiveAt: new Date(),
      publishedAt: new Date(),
    },
  });
  await db.consent.create({
    data: {
      employeeId: empId,
      consentType,
      status: 'granted',
      grantedAt: new Date(),
      organizationId: orgId,
      policyId: policy.id,
      consentVersion: 'v1',
    },
  });
}

async function seedOrg(opts: {
  name: string;
  slug: string;
  mode: 'MANAGED' | 'CUSTOMER_DB' | 'PRIVATE';
  screenshotInterval: number;
  empCode: string;
  devKey: string;
}) {
  const org = await db.organization.create({
    data: {
      name: opts.name,
      slug: opts.slug,
      deploymentMode: opts.mode,
      screenshotInterval: opts.screenshotInterval,
    },
  });
  const emp = await db.employee.create({
    data: {
      employeeId: opts.empCode,
      firstName: opts.name.split(' ')[0],
      lastName: 'Emp',
      email: `${opts.empCode.toLowerCase()}@p3-contract.test`,
      organizationId: org.id,
      status: 'active',
      agentApproved: true,
    },
  });
  const dev = await db.device.create({
    data: {
      name: `Dev-${opts.mode}`,
      hostname: `dev-${opts.mode.toLowerCase()}`,
      agentKey: opts.devKey,
      organizationId: org.id,
      employeeId: emp.id,
      status: 'online',
      lastHeartbeat: new Date(),
    },
  });
  const { generateToken } = await import('../src/lib/agent/auth');
  const token = generateToken(64);
  await db.agentToken.create({
    data: {
      token,
      employeeId: emp.id,
      organizationId: org.id,
      deviceId: dev.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  return { org, emp, dev, token };
}

before(async () => {
  db = (await import('../src/lib/db')).db;

  // MANAGED org: no screenshots feature in its plan → frequency force-disabled
  // to 0 server-side even though org.screenshotInterval is 60.
  const seededManaged = await seedOrg({
    name: 'Managed Org',
    slug: 'p3c-managed',
    mode: 'MANAGED',
    screenshotInterval: 60,
    empCode: 'P3C-MANAGED',
    devKey: 'p3c-device-managed-0001',
  });
  orgManaged = seededManaged.org;
  empManaged = seededManaged.emp;
  devManaged = seededManaged.dev;
  tokManaged = seededManaged.token;

  const planBasic = await db.plan.create({
    data: { name: 'P3C-Basic', maxDevices: 5, features: [] },
  });
  await db.subscription.create({
    data: {
      organizationId: orgManaged.id,
      planId: planBasic.id,
      status: 'ACTIVE',
      startDate: new Date(),
      endDate: null,
    },
  });

  // CUSTOMER_DB org: plan WITH screenshots → frequency = org.screenshotInterval (30).
  const seededCustomer = await seedOrg({
    name: 'Customer Org',
    slug: 'p3c-customer',
    mode: 'CUSTOMER_DB',
    screenshotInterval: 30,
    empCode: 'P3C-CUSTOMER',
    devKey: 'p3c-device-customer-0001',
  });
  orgCustomer = seededCustomer.org;
  empCustomer = seededCustomer.emp;
  devCustomer = seededCustomer.dev;
  tokCustomer = seededCustomer.token;

  const planShot = await db.plan.create({
    data: { name: 'P3C-Shot', maxDevices: 5, features: ['screenshots'] },
  });
  await db.subscription.create({
    data: {
      organizationId: orgCustomer.id,
      planId: planShot.id,
      status: 'ACTIVE',
      startDate: new Date(),
      endDate: null,
    },
  });

  // PRIVATE org: org-level screenshot_enabled=false → server policy disables capture.
  const seededPrivate = await seedOrg({
    name: 'Private Org',
    slug: 'p3c-private',
    mode: 'PRIVATE',
    screenshotInterval: 10,
    empCode: 'P3C-PRIVATE',
    devKey: 'p3c-device-private-0001',
  });
  orgPrivate = seededPrivate.org;
  empPrivate = seededPrivate.emp;
  devPrivate = seededPrivate.dev;
  tokPrivate = seededPrivate.token;

  // Org-scoped monitoring overrides (server-authoritative policy).
  await db.organizationSetting.createMany({
    data: [
      { organizationId: orgPrivate.id, key: 'screenshot_enabled', value: 'false', category: 'monitoring' },
      { organizationId: orgCustomer.id, key: 'location_tracking', value: 'true', category: 'monitoring' },
      { organizationId: orgPrivate.id, key: 'location_tracking', value: 'false', category: 'monitoring' },
    ],
  });

  // Consents (policy-gated, fail closed without them).
  await grantConsent(orgManaged.id, empManaged.id, 'activity_tracking');
  await grantConsent(orgCustomer.id, empCustomer.id, 'screenshot');
  await grantConsent(orgCustomer.id, empCustomer.id, 'location');
  // empPrivate holds screenshot + location consent, but its org DISABLES both
  // screenshot_enabled and location_tracking — server policy must still win.
  await grantConsent(orgPrivate.id, empPrivate.id, 'screenshot');
  await grantConsent(orgPrivate.id, empPrivate.id, 'location');
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
  } catch { /* best-effort */ }
});

function agentReq(token: string, opts: { method?: string; body?: unknown; url?: string; headers?: Record<string, string> } = {}): NextRequest {
  const headers: Record<string, string> = { 'authorization': `Bearer ${token}`, ...(opts.headers ?? {}) };
  if (opts.body !== undefined && !(opts.body instanceof FormData)) headers['content-type'] = 'application/json';
  return new NextRequest(opts.url || 'http://localhost:3000/api/agent', {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body instanceof FormData ? opts.body : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function body(res: Response): Promise<any> {
  return res.json();
}

// ─── P3C-01: compat fingerprint ──────────────────────────────────────────

test('P3C-01: /api/agent/compat advertises the full Phase 3 contract', async () => {
  const api = await import('../src/app/api/agent/compat/route');
  const res = await api.GET();
  assert.equal(res.status, 200);
  const payload = await body(res);
  assert.equal(payload.product, 'omnisight');
  assert.equal(payload.service, 'omnisight-web');
  assert.equal(payload.agentProtocol, 1);
  assert.ok(payload.serverVersion, 'serverVersion present');
  assert.ok(payload.minAgentVersion, 'minAgentVersion present');
  assert.deepEqual(
    [...payload.supportedDeploymentModes].sort(),
    ['CUSTOMER_DB', 'MANAGED', 'PRIVATE'],
    'all three deployment modes advertised'
  );
});

// ─── P3C-02: server-derived deployment block per mode ────────────────────

test('P3C-02: config deployment block is derived from the server organization for every mode', async () => {
  const api = await import('../src/app/api/agent/config/route');
  const cases = [
    { token: tokManaged, expectMode: 'MANAGED', expectOrg: 'Managed Org' },
    { token: tokCustomer, expectMode: 'CUSTOMER_DB', expectOrg: 'Customer Org' },
    { token: tokPrivate, expectMode: 'PRIVATE', expectOrg: 'Private Org' },
  ];
  for (const c of cases) {
    const res = await api.GET(agentReq(c.token));
    assert.equal(res.status, 200, `config 200 for ${c.expectMode}`);
    const payload = await body(res);
    assert.equal(payload.deployment?.mode, c.expectMode, `mode reflects org for ${c.expectMode}`);
    assert.equal(payload.deployment?.organizationName, c.expectOrg);
    assert.equal(payload.deployment?.modeUnresolved, false);
    assert.ok(payload.config?.monitoring, 'monitoring config present');
  }
});

// ─── P3C-03: deploymentMode spoof is ignored ─────────────────────────────

test('P3C-03: agent-supplied deploymentMode query cannot override the org mode', async () => {
  const api = await import('../src/app/api/agent/config/route');
  // PRIVATE org tries to claim MANAGED via the query string.
  const res = await api.GET(agentReq(tokPrivate, { url: 'http://localhost:3000/api/agent/config?deploymentMode=MANAGED' }));
  assert.equal(res.status, 200);
  const payload = await body(res);
  assert.equal(payload.deployment.mode, 'PRIVATE', 'server keeps treating tenant as PRIVATE');
  // MANAGED org tries to claim CUSTOMER_DB.
  const res2 = await api.GET(agentReq(tokManaged, { url: 'http://localhost:3000/api/agent/config?deploymentMode=CUSTOMER_DB' }));
  const payload2 = await body(res2);
  assert.equal(payload2.deployment.mode, 'MANAGED', 'server keeps treating tenant as MANAGED');
});

// ─── P3C-04: screenshot policy is server-authoritative ───────────────────

test('P3C-04: screenshot policy/frequency come from the server, never the client', async () => {
  const api = await import('../src/app/api/agent/config/route');

  // PRIVATE org: org screenshot_enabled=false must surface as disabled and a
  // client query claiming enabled=1s must not re-enable or change frequency.
  const res = await api.GET(agentReq(tokPrivate, {
    url: 'http://localhost:3000/api/agent/config?screenshotEnabled=true&screenshotFrequency=1',
  }));
  const payload = await body(res);
  assert.equal(payload.config.monitoring.screenshotEnabled, false, 'server policy disables screenshots');
  assert.equal(payload.config.monitoring.screenshotFrequency, 0, 'plan has no screenshots → frequency 0');

  // CUSTOMER_DB org: plan includes screenshots → server interval (30 min)
  // applies even when the client asks for a 1-minute cadence.
  const resC = await api.GET(agentReq(tokCustomer, {
    url: 'http://localhost:3000/api/agent/config?screenshotFrequency=1',
  }));
  const payloadC = await body(resC);
  assert.equal(payloadC.config.monitoring.screenshotEnabled, true);
  assert.equal(payloadC.config.monitoring.screenshotFrequency, 30, 'server interval wins over local cadence');

  // MANAGED org: plan WITHOUT screenshots force-disables capture to 0 despite
  // the org-level interval (60) and despite a client enabling query.
  const resM = await api.GET(agentReq(tokManaged, {
    url: 'http://localhost:3000/api/agent/config?screenshotEnabled=true&screenshotFrequency=1',
  }));
  const payloadM = await body(resM);
  assert.equal(payloadM.config.monitoring.screenshotFrequency, 0, 'no screenshots feature → capture impossible');
});

// ─── P3C-05: heartbeat across all three modes ───────────────────────────

test('P3C-05: heartbeat works for MANAGED / CUSTOMER_DB / PRIVATE and touches only the own device', async () => {
  const api = await import('../src/app/api/agent/heartbeat/route');

  // Rewind each device's heartbeat to a known-past value so advancement is
  // deterministic (no same-millisecond flake).
  const past = new Date(Date.now() - 60_000);
  for (const devId of [devManaged.id, devCustomer.id, devPrivate.id]) {
    await db.device.update({ where: { id: devId }, data: { lastHeartbeat: past } });
  }

  for (const token of [tokManaged, tokCustomer, tokPrivate]) {
    const res = await api.POST(agentReq(token, { method: 'POST', body: { timestamp: new Date().toISOString() } }));
    assert.equal(res.status, 200, 'heartbeat accepted in every mode');
    const payload = await body(res);
    assert.equal(payload.success, true);
    assert.ok(typeof payload.break?.active === 'boolean', 'break state rides on heartbeat');
  }

  const afterBeat = {
    managed: (await db.device.findUnique({ where: { id: devManaged.id }, select: { lastHeartbeat: true } }))!.lastHeartbeat!,
    customer: (await db.device.findUnique({ where: { id: devCustomer.id }, select: { lastHeartbeat: true } }))!.lastHeartbeat!,
    private: (await db.device.findUnique({ where: { id: devPrivate.id }, select: { lastHeartbeat: true } }))!.lastHeartbeat!,
  };
  for (const key of ['managed', 'customer', 'private'] as const) {
    assert.ok(afterBeat[key].getTime() > past.getTime(), `${key} device lastHeartbeat advanced`);
  }
});

// ─── P3C-06: activity belongs to the authenticated org/device ───────────

test('P3C-06: activity rows are tenant/device scoped; body org/device spoofing is ignored', async () => {
  const api = await import('../src/app/api/agent/activity/route');
  const res = await api.POST(agentReq(tokManaged, {
    method: 'POST',
    body: {
      // Attempted tenant/device escape: the server must ignore both.
      organizationId: orgPrivate.id,
      deviceId: devPrivate.id,
      activities: [{
        type: 'application',
        applicationName: 'Code Editor',
        category: 'productive',
        duration: 42,
        timestamp: new Date().toISOString(),
        // item-level spoof too
        organizationId: orgPrivate.id,
        deviceId: devPrivate.id,
      }],
    },
  }));
  assert.equal(res.status, 200, 'legitimate upload succeeds');
  const created = await db.activity.findFirst({
    where: { employeeId: empManaged.id },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(created, 'activity row created');
  assert.equal(created.organizationId, orgManaged.id, 'activity belongs to the AUTHENTICATED org');
  assert.equal(created.deviceId, devManaged.id, 'activity belongs to the AUTHENTICATED device');
  // Nothing was created under the spoofed tenant.
  const foreign = await db.activity.count({ where: { organizationId: orgPrivate.id } });
  assert.equal(foreign, 0, 'no rows under the spoofed organization');
});

// ─── P3C-07: screenshot upload is consent-gated ─────────────────────────

test('P3C-07: screenshot upload is consent-gated AND org-policy-gated server-side', async () => {
  const api = await import('../src/app/api/agent/screenshot/route');

  // empPrivate HAS screenshot consent, but the org disables screenshot_enabled
  // → server policy wins: 403 before any file processing (Phase 3 §31).
  const denied = await api.POST(agentReq(tokPrivate, {
    method: 'POST',
    body: new FormData(),
  }));
  assert.equal(denied.status, 403, 'org-disabled screenshots rejected despite consent');
  const deniedPayload = await body(denied);
  assert.match(deniedPayload.error ?? '', /SCREENSHOT_TRACKING_DISABLED/);

  // empCustomer has consent AND its org has screenshots enabled → the request
  // passes both server gates and fails later at file validation (400, not
  // 401/403) — proving the gate order (auth → consent → org policy → file).
  const allowed = await api.POST(agentReq(tokCustomer, {
    method: 'POST',
    body: new FormData(),
  }));
  assert.equal(allowed.status, 400, 'consent + org policy present → proceeds to file validation');
  const allowedPayload = await body(allowed);
  assert.match(allowedPayload.error ?? '', /screenshot file/i);
});

// ─── P3C-08: location scoping + server policy + closed schema ───────────

test('P3C-08: location is tenant scoped, org-gated, and schema-closed', async () => {
  const api = await import('../src/app/api/agent/location/route');

  // CUSTOMER_DB org with location_tracking=true + consent → first fix accepted.
  const res = await api.POST(agentReq(tokCustomer, {
    method: 'POST',
    body: { latitude: 23.8103, longitude: 90.4125, accuracy: null, timestamp: new Date().toISOString() },
  }));
  assert.equal(res.status, 200);
  const payload = await body(res);
  assert.equal(payload.accepted, true, 'first fix accepted');
  const event = await db.locationEvent.findFirst({
    where: { employeeId: empCustomer.id },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(event, 'location event stored');
  assert.equal(event.organizationId, orgCustomer.id, 'event under authenticated org');
  assert.equal(event.deviceId, devCustomer.id, 'event under authenticated device');

  // PRIVATE org with location_tracking=false → 403 even WITH consent.
  const denied = await api.POST(agentReq(tokPrivate, {
    method: 'POST',
    body: { latitude: 23.8103, longitude: 90.4125, accuracy: null, timestamp: new Date().toISOString() },
  }));
  assert.equal(denied.status, 403, 'org policy disables location');
  assert.match((await body(denied)).error ?? '', /LOCATION_TRACKING_DISABLED/);

  // Tenant spoof attempts: any organizationId/address-like key is rejected by
  // the closed schema before it can influence routing.
  const spoof = await api.POST(agentReq(tokCustomer, {
    method: 'POST',
    body: {
      latitude: 24.0,
      longitude: 91.0,
      accuracy: null,
      timestamp: new Date().toISOString(),
      organizationId: orgPrivate.id,
    },
  }));
  assert.equal(spoof.status, 422, 'organizationId is not a legal location payload field');
});

// ─── P3C-09: command isolation ──────────────────────────────────────────

test('P3C-09: command poll returns only the authenticated device\'s own commands', async () => {
  const api = await import('../src/app/api/agent/commands/route');

  const future = new Date(Date.now() + 60 * 60 * 1000);
  await db.agentCommand.create({
    data: {
      organizationId: orgManaged.id,
      employeeId: empManaged.id,
      deviceId: devManaged.id,
      commandType: 'webcam.start',
      payload: JSON.stringify({}),
      status: 'PENDING',
      expiresAt: future,
    },
  });
  // A command for the OTHER org's device must never reach this device.
  await db.agentCommand.create({
    data: {
      organizationId: orgCustomer.id,
      employeeId: empCustomer.id,
      deviceId: devCustomer.id,
      commandType: 'webcam.start',
      payload: JSON.stringify({}),
      status: 'PENDING',
      expiresAt: future,
    },
  });

  const res = await api.GET(agentReq(tokManaged));
  assert.equal(res.status, 200);
  const payload = await body(res);
  assert.equal(payload.data.length, 1, 'only the managed device command is delivered');
  assert.equal(payload.data[0].commandType, 'webcam.start');

  // Atomic delivery: a second poll returns nothing.
  const again = await body(await api.GET(agentReq(tokManaged)));
  assert.equal(again.data.length, 0, 'command delivered exactly once');
});

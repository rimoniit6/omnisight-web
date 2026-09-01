/**
 * S-1 / MON-1 — org-scoped monitoring configuration + Organization.timezone.
 *
 * Proves that monitoring values are stored ONLY in OrganizationSetting, that
 * Org A's configuration never bleeds into Org B, that the typed registry
 * rejects invalid booleans/times/numbers, that missing rows resolve to
 * deterministic defaults, and that the global SystemSetting can never act as
 * a fallback for monitoring keys.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_adminmon).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation (set BEFORE any app module import) ──────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_adminmon';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-adminmon-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@adminmon.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!AdminMon2026x';
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

let orgA: { id: string };
let orgB: { id: string };
let adminAToken: string;
let adminBToken: string;
let viewerAToken: string;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  orgA = await db.organization.create({ data: { name: 'Org A', slug: 'org-a-mon', timezone: 'UTC' } });
  orgB = await db.organization.create({ data: { name: 'Org B', slug: 'org-b-mon', timezone: 'UTC' } });

  adminAToken = await signJWT({ userId: 'admin-a', email: 'admin@a.test', role: 'admin', organizationId: orgA.id });
  adminBToken = await signJWT({ userId: 'admin-b', email: 'admin@b.test', role: 'admin', organizationId: orgB.id });
  viewerAToken = await signJWT({ userId: 'viewer-a', email: 'viewer@a.test', role: 'viewer', organizationId: orgA.id });
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

function req(token: string | null, opts: { method?: string; body?: unknown; url?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(opts.url || 'http://localhost:3000/api/test', {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function getSetting(api: { GET: (r: NextRequest) => Promise<Response> }, token: string, key: string): Promise<Record<string, unknown> | undefined> {
  const res = await api.GET(req(token, { url: 'http://localhost:3000/api/settings/monitoring' }));
  const body = await res.json();
  return (body.data as Array<Record<string, unknown>>).find((s) => s.key === key);
}

test('MON-PROD-1: org A screenshot_enabled change does NOT bleed into org B', async () => {
  const api = await import('../src/app/api/settings/monitoring/route');

  const resA = await api.PUT(req(adminAToken, { method: 'PUT', body: { key: 'screenshot_enabled', value: false } }));
  assert.equal(resA.status, 200);

  const a = await getSetting(api, adminAToken, 'screenshot_enabled');
  assert.equal(a?.value, false, 'org A must now read false');

  // Org B was never touched: no org row exists, default (true) is returned.
  const b = await getSetting(api, adminBToken, 'screenshot_enabled');
  assert.equal(b?.value, true, 'org B must remain at the default');
  assert.equal(
    await db.organizationSetting.count({ where: { organizationId: orgB.id, key: 'screenshot_enabled' } }),
    0,
    'no screenshot_enabled row may exist for org B'
  );
});

test('MON-PROD-2: GET returns typed values + metadata (type/default/min/max)', async () => {
  const api = await import('../src/app/api/settings/monitoring/route');
  const res = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/settings/monitoring' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  const byKey = new Map((body.data as Array<Record<string, unknown>>).map((s) => [s.key, s]));

  assert.equal(byKey.get('heartbeat_interval')?.type, 'number');
  assert.equal(byKey.get('heartbeat_interval')?.min, 10);
  assert.equal(byKey.get('heartbeat_interval')?.max, 600);
  assert.equal(byKey.get('screenshot_enabled')?.type, 'boolean');
  assert.equal(byKey.get('work_start_time')?.type, 'time');
  assert.equal(typeof byKey.get('work_start_time')?.default, 'string');
  assert.equal(byKey.get('work_start_time')?.default, '09:00');
});

test('MON-PROD-3: invalid boolean rejected (422)', async () => {
  const api = await import('../src/app/api/settings/monitoring/route');
  const res = await api.PUT(req(adminAToken, { method: 'PUT', body: { key: 'screenshot_enabled', value: 'maybe' } }));
  assert.equal(res.status, 422);
});

test('MON-PROD-4: invalid time rejected (422)', async () => {
  const api = await import('../src/app/api/settings/monitoring/route');
  assert.equal(
    (await api.PUT(req(adminAToken, { method: 'PUT', body: { key: 'work_start_time', value: '25:99' } }))).status,
    422
  );
  assert.equal(
    (await api.PUT(req(adminAToken, { method: 'PUT', body: { key: 'work_end_time', value: '9am' } }))).status,
    422
  );
});

test('MON-PROD-5: invalid numbers rejected (out of range, non-numeric, float)', async () => {
  const api = await import('../src/app/api/settings/monitoring/route');
  assert.equal(
    (await api.PUT(req(adminAToken, { method: 'PUT', body: { key: 'heartbeat_interval', value: 5 } }))).status,
    422
  );
  assert.equal(
    (await api.PUT(req(adminAToken, { method: 'PUT', body: { key: 'heartbeat_interval', value: 'abc' } }))).status,
    422
  );
  assert.equal(
    (await api.PUT(req(adminAToken, { method: 'PUT', body: { key: 'heartbeat_interval', value: 1.5 } }))).status,
    422
  );
});

test('MON-PROD-6: unknown / arbitrary keys are rejected (400)', async () => {
  const api = await import('../src/app/api/settings/monitoring/route');
  const res = await api.PUT(req(adminAToken, { method: 'PUT', body: { key: 'random_unknown_key', value: 'x' } }));
  assert.equal(res.status, 400);
});

test('MON-PROD-7: defaults apply when the OrganizationSetting row is missing', async () => {
  const { resolveOrgMonitoring } = await import('../src/lib/jobs/settings');
  const freshOrg = await db.organization.create({ data: { name: 'Fresh Org', slug: 'fresh-org-mon' } });
  const resolved = await resolveOrgMonitoring(freshOrg.id);
  assert.equal(resolved.screenshot_enabled, true);
  assert.equal(resolved.heartbeat_interval, 60);
  assert.equal(resolved.screenshot_frequency, 10);
  assert.equal(resolved.work_start_time, '09:00');
  assert.equal(resolved.work_end_time, '18:00');
});

test('MON-PROD-8: SystemSetting fallback is IMPOSSIBLE for monitoring keys', async () => {
  // Corrupt/stale GLOBAL rows must never influence org resolution.
  await db.systemSetting.create({ data: { key: 'screenshot_enabled', value: 'false', category: 'monitoring' } });
  await db.systemSetting.create({ data: { key: 'heartbeat_interval', value: '5', category: 'monitoring' } });
  await db.systemSetting.create({ data: { key: 'work_start_time', value: '23:00', category: 'monitoring' } });

  const { resolveOrgMonitoring } = await import('../src/lib/jobs/settings');
  const resolved = await resolveOrgMonitoring(orgB.id); // org B has no org rows
  assert.equal(resolved.screenshot_enabled, true, 'global SystemSetting must never override the org default');
  assert.equal(resolved.heartbeat_interval, 60, 'global SystemSetting must never override the org default');
  assert.equal(resolved.work_start_time, '09:00', 'global SystemSetting must never override the org default');
});

test('MON-PROD-9: viewer cannot update monitoring settings (403)', async () => {
  const api = await import('../src/app/api/settings/monitoring/route');
  const res = await api.PUT(req(viewerAToken, { method: 'PUT', body: { key: 'heartbeat_interval', value: 60 } }));
  assert.equal(res.status, 403);
});

test('MON-PROD-10: PATCH /api/organization validates + persists timezone; Organization.timezone is authoritative', async () => {
  const api = await import('../src/app/api/organization/route');

  // Invalid IANA zone rejected.
  const bad = await api.PATCH(req(adminAToken, { method: 'PATCH', body: { timezone: 'Not/AZone' } }));
  assert.equal(bad.status, 400);

  // Valid zone accepted.
  const good = await api.PATCH(req(adminAToken, { method: 'PATCH', body: { timezone: 'Asia/Dhaka' } }));
  assert.equal(good.status, 200);

  const updated = await db.organization.findUnique({ where: { id: orgA.id }, select: { timezone: true } });
  assert.equal(updated?.timezone, 'Asia/Dhaka');

  // Audited.
  const audit = await db.auditLog.findFirst({ where: { organizationId: orgA.id, resource: 'organization' } });
  assert.ok(audit, 'timezone change must be audited');
  assert.ok((audit!.description ?? '').includes('Asia/Dhaka'));

  // GET returns the timezone; org B stays UTC (no cross-tenant bleed).
  const getRes = await api.GET(req(adminAToken, { url: 'http://localhost:3000/api/organization' }));
  const getBody = await getRes.json();
  assert.equal(getBody.timezone, 'Asia/Dhaka');

  const b = await db.organization.findUnique({ where: { id: orgB.id }, select: { timezone: true } });
  assert.equal(b?.timezone, 'UTC', 'org B timezone must be untouched');
});

test('MON-PROD-11: agent config resolves monitoring + timezone from org data (no SystemSetting, no MonitoringPolicy)', async () => {
  // Employee + approved agent token for org A (timezone Asia/Dhaka).
  const emp = await db.employee.create({
    data: {
      employeeId: 'MON-EMP-1',
      firstName: 'Agent',
      lastName: 'One',
      email: 'agent1@a.test',
      organizationId: orgA.id,
      status: 'active',
      agentApproved: true,
    },
  });
  await db.agentToken.create({
    data: {
      token: 'mon-prod-agent-token-0123456789abcdef0123456789abcdef',
      expiresAt: new Date(Date.now() + 3600_000),
      employee: { connect: { id: emp.id } },
      organization: { connect: { id: orgA.id } },
    },
  });

  const configApi = await import('../src/app/api/agent/config/route');
  const res = await configApi.GET(req('mon-prod-agent-token-0123456789abcdef0123456789abcdef'));
  assert.equal(res.status, 200);
  const body = await res.json();

  // Org A screenshot_enabled was set to false in MON-PROD-1 -> false here.
  assert.equal(body.config.monitoring.screenshotEnabled, false, 'agent config must read the ORG value');
  // Timezone comes from Organization.timezone (set to Asia/Dhaka in MON-PROD-10).
  assert.equal(body.config.monitoring.timezone, 'Asia/Dhaka', 'timezone must come from Organization.timezone');
  // Response contract for the desktop agent remains intact.
  assert.equal(typeof body.config.monitoring.heartbeatInterval, 'number');
  assert.equal(typeof body.config.features.breakModeEnabled, 'boolean');
  assert.equal(typeof body.config.limits.maxBatchSize, 'number');
  assert.equal(typeof body.assignment.employeeName, 'string');

  // Org B (no org rows, SystemSetting poisoned in MON-PROD-8) still defaults.
  const empB = await db.employee.create({
    data: {
      employeeId: 'MON-EMP-2',
      firstName: 'Agent',
      lastName: 'Two',
      email: 'agent2@b.test',
      organizationId: orgB.id,
      status: 'active',
      agentApproved: true,
    },
  });
  await db.agentToken.create({
    data: {
      token: 'mon-prod-agent-token-b-0123456789abcdef0123456789ab',
      expiresAt: new Date(Date.now() + 3600_000),
      employee: { connect: { id: empB.id } },
      organization: { connect: { id: orgB.id } },
    },
  });
  const resB = await configApi.GET(req('mon-prod-agent-token-b-0123456789abcdef0123456789ab'));
  const bodyB = await resB.json();
  assert.equal(bodyB.config.monitoring.screenshotEnabled, true, 'org B must use defaults, not poisoned SystemSetting');
  assert.equal(bodyB.config.monitoring.timezone, 'UTC', 'org B timezone is UTC');
});

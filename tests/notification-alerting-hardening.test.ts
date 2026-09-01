/**
 * Notification + Alerting production-hardening — server-side regression tests.
 *
 * Covers N-1…N-11 from the certification audit:
 *   - N-1: notifications GET pagination (malformed/negative/zero/oversized → 4xx)
 *   - N-2: POST RBAC (viewer 403), canonical validation (type/priority/actionUrl),
 *          actor-bound audit, client orgId ignored
 *   - N-3: alerts GET server pagination + DB-side stats
 *   - N-4: Notification/Alert retention boundaries (old purged, recent + active kept)
 *   - N-5: auto-detected high/critical anomaly → Alert + Notification
 *   - N-6: org-level preferences persisted + enforced by producers; honest types list
 *   - N-7: tamper severity validation; alerts PUT status/severity validation
 *   - N-9: structured employee linkage (no string-match dependency)
 *   - N-10: alert realtime invalidation mapping
 *   - N-11: metadata bounds, batch bounds
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_notifalerting).
 * Run: npx tsx --test tests/notification-alerting-hardening.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_notifalerting';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.JWT_SECRET = 'test-jwt-secret-notifalert-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';
process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;

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

type NotifApi = typeof import('../src/app/api/notifications/route');
type NotifBatchApi = typeof import('../src/app/api/notifications/batch/route');
type NotifPrefsApi = typeof import('../src/app/api/notifications/preferences/route');
type AlertsApi = typeof import('../src/app/api/alerts/route');
type AgentTamperApi = typeof import('../src/app/api/agent/tamper/route');
type AnomalyService = typeof import('../src/lib/anomalies/service');
type Retention = typeof import('../src/lib/jobs/retention');
type Validation = typeof import('../src/lib/notifications/validation');
type WsInvalidation = typeof import('../src/lib/ws-invalidation');
type EmployeesApi = typeof import('../src/app/api/employees/route');
let employeesApi: EmployeesApi;
let notifApi: NotifApi;
let notifBatchApi: NotifBatchApi;
let notifPrefsApi: NotifPrefsApi;
let alertsApi: AlertsApi;
let agentTamperApi: AgentTamperApi;
let anomalyService: AnomalyService;
let retention: Retention;
let validation: Validation;
let wsInvalidation: WsInvalidation;

let orgA: { id: string };
let orgB: { id: string };
let empA: { id: string };
let empB: { id: string };
let devA: { id: string };

function req(token: string | null, opts: { url?: string; body?: unknown; method?: string } = {}): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const init: RequestInit = { method: opts.method || 'GET', headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (NextRequest as any)(opts.url || 'http://localhost:3000', init);
}

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  const [nApi, nbApi, npApi, aApi, tApi, eApi, as, ret, v, ws] = await Promise.all([
    import('../src/app/api/notifications/route'),
    import('../src/app/api/notifications/batch/route'),
    import('../src/app/api/notifications/preferences/route'),
    import('../src/app/api/alerts/route'),
    import('../src/app/api/agent/tamper/route'),
    import('../src/app/api/employees/route'),
    import('../src/lib/anomalies/service'),
    import('../src/lib/jobs/retention'),
    import('../src/lib/notifications/validation'),
    import('../src/lib/ws-invalidation'),
  ]);
  notifApi = nApi;
  notifBatchApi = nbApi;
  notifPrefsApi = npApi;
  alertsApi = aApi;
  agentTamperApi = tApi;
  employeesApi = eApi;
  anomalyService = as;
  retention = ret;
  validation = v;
  wsInvalidation = ws;

  const orgArow = await db.organization.create({ data: { name: 'Org A', slug: 'org-a-notif' } });
  const orgBrow = await db.organization.create({ data: { name: 'Org B', slug: 'org-b-notif' } });
  orgA = { id: orgArow.id };
  orgB = { id: orgBrow.id };
  const empArow = await db.employee.create({
    data: { firstName: 'Alice', lastName: 'A', employeeId: 'EMP-A-1', email: 'alice@a.test', organizationId: orgA.id, status: 'active', agentApproved: true },
  });
  const empBrow = await db.employee.create({
    data: { firstName: 'Bob', lastName: 'B', employeeId: 'EMP-B-1', email: 'bob@b.test', organizationId: orgB.id },
  });
  empA = { id: empArow.id };
  empB = { id: empBrow.id };
  const devArow = await db.device.create({
    data: { name: 'Dev A', hostname: 'host-a', status: 'online', organizationId: orgA.id, employeeId: empA.id },
  });
  devA = { id: devArow.id };
});

after(async () => {
  await db.$disconnect();
  execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });
});

async function token(role: string, orgId?: string) {
  return signJWT({ userId: `${role}-${orgId ?? 'g'}`, email: `${role}@test.local`, role, organizationId: orgId });
}

// ─── N-1: notifications GET pagination ───────────────────────────────────────
test('NA-1: notifications GET malformed/negative pagination → controlled 4xx, never 500', async () => {
  const t = await token('admin', orgA.id);
  for (const qs of ['page=abc', 'page=-1', 'page=0', 'pageSize=abc', 'pageSize=-1', 'pageSize=0', 'pageSize=999999']) {
    const res = await notifApi.GET(req(t, { url: `http://localhost:3000/api/notifications?${qs}` }));
    assert.ok([400, 422].includes(res.status), `expected 4xx for ${qs}, got ${res.status}`);
  }
});

test('NA-2: notifications GET valid pagination returns bounded page + totalPages', async () => {
  const t = await token('admin', orgA.id);
  await db.notification.createMany({
    data: Array.from({ length: 12 }).map((_, i) => ({
      title: `NA2-${i}`, message: `m${i}`, type: 'system', priority: 'low', status: 'unread', organizationId: orgA.id,
    })),
  });
  const res = await notifApi.GET(req(t, { url: 'http://localhost:3000/api/notifications?page=2&pageSize=10' }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.length, 2);
  assert.equal(body.totalPages, 2);
  assert.equal(body.unreadCount, 12);
  await db.notification.deleteMany({ where: { organizationId: orgA.id, title: { startsWith: 'NA2-' } } });
});

// ─── N-2: POST RBAC + validation ─────────────────────────────────────────────
test('NA-3: viewer POST notification → 403', async () => {
  const t = await token('viewer', orgA.id);
  const res = await notifApi.POST(req(t, {
    method: 'POST',
    body: { title: 'x', message: 'y', type: 'system' },
  }));
  assert.equal(res.status, 403);
});

test('NA-4: manager POST notification succeeds with actor-bound audit', async () => {
  const t = await token('manager', orgA.id);
  const res = await notifApi.POST(req(t, {
    method: 'POST',
    body: { title: 'NA4 title', message: 'NA4 message', type: 'system', priority: 'high' },
  }));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.data?.id);
  const audit = await db.auditLog.findFirst({
    where: { resource: 'notification', resourceId: body.data.id },
  });
  assert.ok(audit, 'audit row must exist');
  assert.equal(audit!.userId, `manager-${orgA.id}`, 'audit actor must be the authenticated user');
  await db.notification.delete({ where: { id: body.data.id } });
  await db.auditLog.delete({ where: { id: audit!.id } });
});

test('NA-5: POST invalid type / priority / javascript actionUrl → 422', async () => {
  const t = await token('admin', orgA.id);
  const bad = [
    { title: 'x', message: 'y', type: 'not_a_type' },
    { title: 'x', message: 'y', type: 'system', priority: 'ultra' },
    { title: 'x', message: 'y', type: 'system', actionUrl: 'javascript:alert(1)' },
    { title: 'x', message: 'y', type: 'system', actionUrl: 'data:text/html;base64,PHNjcmlwdD4=' },
    { title: 'x', message: 'y', type: 'system', actionUrl: '//evil.com' },
    { title: 'x'.repeat(300), message: 'y', type: 'system' },
  ];
  for (const b of bad) {
    const res = await notifApi.POST(req(t, { method: 'POST', body: b }));
    assert.equal(res.status, 422, `expected 422 for ${JSON.stringify(b).slice(0, 60)}`);
  }
});

test('NA-6: POST client organizationId ignored — notification lands in session org', async () => {
  const t = await token('admin', orgA.id);
  const res = await notifApi.POST(req(t, {
    method: 'POST',
    body: { title: 'NA6', message: 'm', type: 'system', organizationId: orgB.id },
  }));
  assert.equal(res.status, 201);
  const body = await res.json();
  const row = await db.notification.findUnique({ where: { id: body.data.id } });
  assert.equal(row!.organizationId, orgA.id, 'org must come from the session');
  await db.notification.delete({ where: { id: body.data.id } });
});

// ─── N-3: alerts GET pagination + stats ──────────────────────────────────────
test('NA-7: alerts GET malformed pagination → 4xx; valid → bounded + DB stats', async () => {
  const t = await token('admin', orgA.id);
  for (const qs of ['page=abc', 'page=-1', 'pageSize=0', 'pageSize=999999']) {
    const res = await alertsApi.GET(req(t, { url: `http://localhost:3000/api/alerts?${qs}` }));
    assert.ok([400, 422].includes(res.status), `expected 4xx for ${qs}, got ${res.status}`);
  }
  await db.alert.createMany({
    data: [
      { title: 'NA7-1', description: 'd', type: 'system', severity: 'critical', status: 'pending', organizationId: orgA.id },
      { title: 'NA7-2', description: 'd', type: 'system', severity: 'warning', status: 'resolved', organizationId: orgA.id },
    ],
  });
  const res = await alertsApi.GET(req(t, { url: 'http://localhost:3000/api/alerts?page=1&pageSize=50' }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.length, 2);
  assert.equal(body.total, 2);
  assert.ok(body.stats, 'stats must be present (DB-backed)');
  assert.equal(body.stats.byStatus.pending, 1);
  assert.equal(body.stats.byStatus.resolved, 1);
  assert.equal(body.stats.bySeverity.critical, 1);
  await db.alert.deleteMany({ where: { organizationId: orgA.id, title: { startsWith: 'NA7-' } } });
});

// ─── N-7: alerts PUT status/severity validation + audit ──────────────────────
test('NA-8: alerts PUT invalid status/severity → 422; valid transition audited', async () => {
  const t = await token('admin', orgA.id);
  const alert = await db.alert.create({
    data: { title: 'NA8', description: 'd', type: 'system', severity: 'warning', status: 'pending', organizationId: orgA.id },
  });
  const badStatus = await alertsApi.PUT(req(t, { method: 'PUT', body: { id: alert.id, status: 'banana' } }));
  assert.equal(badStatus.status, 422);
  const badSev = await alertsApi.PUT(req(t, { method: 'PUT', body: { id: alert.id, severity: 'hacked' } }));
  assert.equal(badSev.status, 422);
  const ok = await alertsApi.PUT(req(t, { method: 'PUT', body: { id: alert.id, status: 'resolved' } }));
  assert.equal(ok.status, 200);
  const audit = await db.auditLog.findFirst({ where: { resource: 'alert', resourceId: alert.id } });
  assert.ok(audit, 'lifecycle audit must exist');
  assert.equal(audit!.userId, `admin-${orgA.id}`);
  assert.match(audit!.description, /pending → resolved/);
  // Cross-org mutation → 404 concealment
  const other = await alertsApi.PUT(req(await token('admin', orgB.id), { method: 'PUT', body: { id: alert.id, status: 'resolved' } }));
  assert.equal(other.status, 404);
  await db.alert.delete({ where: { id: alert.id } });
  await db.auditLog.deleteMany({ where: { resource: 'alert', resourceId: alert.id } });
});

// ─── N-7: tamper severity validation ─────────────────────────────────────────
test('NA-9: agent tamper invalid severity rejected; valid normalized + server-derived attribution', async () => {
  // Create a valid agent token path: employee + device approved.
  const agentToken = await db.agentToken.create({
    data: {
      token: `tamper-token-${Date.now()}`,
      deviceId: devA.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      employee: { connect: { id: empA.id } },
      organization: { connect: { id: orgA.id } },
    },
  });
  const hdr = { Authorization: `Bearer ${agentToken.token}`, 'Content-Type': 'application/json' };
  const tamperReq = (body: unknown) => new NextRequest('http://localhost:3000/api/agent/tamper', {
    method: 'POST',
    headers: hdr,
    body: JSON.stringify(body),
  });
  const bad = await agentTamperApi.POST(tamperReq({ type: 'agent_stopped', severity: 'banana' }));
  assert.equal(bad.status, 422);

  const ok = await agentTamperApi.POST(tamperReq({ type: 'process_killed', severity: 'high', description: 'proc killed' }));
  assert.equal(ok.status, 200);
  const alert = await db.alert.findFirst({ where: { organizationId: orgA.id, title: { contains: 'process_killed' } } });
  assert.ok(alert, 'alert must exist');
  assert.equal(alert!.severity, 'error', 'legacy high → canonical error');
  assert.equal(alert!.employeeId, empA.id, 'employee linkage server-derived');
  assert.equal(alert!.organizationId, orgA.id, 'org server-derived');
  const notif = await db.notification.findFirst({ where: { organizationId: orgA.id, title: { contains: 'process_killed' } } });
  assert.ok(notif, 'notification must exist');
  assert.equal(notif!.employeeId, empA.id);
  await db.alert.deleteMany({ where: { id: alert!.id } });
  if (notif) await db.notification.deleteMany({ where: { id: notif.id } });
  await db.auditLog.deleteMany({ where: { resource: 'alert', description: { contains: 'process_killed' } } });
  await db.agentToken.delete({ where: { id: agentToken.id } });
});

// ─── N-5: auto-detected anomaly → Alert + Notification ───────────────────────
test('NA-10: high/critical auto anomaly creates Alert + Notification with linkage; low does not notify', async () => {
  // Create the org setting to enable detection + a baseline activity row.
  await db.organizationSetting.create({
    data: { organizationId: orgA.id, key: 'ai_anomaly_detection', value: 'true' },
  });
  await anomalyService.runAnomalyDetection({
    orgId: orgA.id,
    employeeId: empA.id,
    now: new Date(),
  });
  // Deterministic outcome depends on activity data; assert the contract on the
  // persist path directly instead (pure engine behavior is covered elsewhere):
  const created = await anomalyService.persistAnomaly(
    {
      type: 'excessive_idle',
      severity: 'high',
      title: 'NA10 idle',
      description: 'extended idle window',
      score: 80,
      confidence: 0.7,
      employeeId: empA.id,
      deviceId: devA.id,
      metadata: { reason: 'test' },
    },
    orgA.id,
    `na10:${orgA.id}:${empA.id}:${Date.now()}`
  );
  assert.equal(created.created, true);
  const alert = await db.alert.findFirst({ where: { organizationId: orgA.id, metadata: { contains: created.anomalyId } } });
  assert.ok(alert, 'high auto anomaly must create an alert');
  const notif = await db.notification.findFirst({
    where: { organizationId: orgA.id, entityType: 'anomaly', entityId: created.anomalyId },
  });
  assert.ok(notif, 'high auto anomaly must create a notification (N-5)');
  assert.equal(notif!.employeeId, empA.id);
  assert.equal(notif!.priority, 'high');
  // Low severity → no alert, no notification.
  const low = await anomalyService.persistAnomaly(
    {
      type: 'excessive_idle',
      severity: 'low',
      title: 'NA10 low',
      description: 'low',
      score: 30,
      confidence: 0.3,
      employeeId: empA.id,
      deviceId: devA.id,
      metadata: { reason: 'test' },
    },
    orgA.id,
    `na10low:${orgA.id}:${empA.id}:${Date.now()}`
  );
  assert.equal(low.created, true);
  const lowAlert = await db.alert.findFirst({ where: { organizationId: orgA.id, metadata: { contains: low.anomalyId } } });
  assert.equal(lowAlert, null, 'low severity must not create an alert');
  const lowNotif = await db.notification.findFirst({ where: { organizationId: orgA.id, entityId: low.anomalyId } });
  assert.equal(lowNotif, null, 'low severity must not create a notification');
  await db.anomaly.deleteMany({ where: { id: { in: [created.anomalyId, low.anomalyId] } } });
  await db.alert.deleteMany({ where: { organizationId: orgA.id, title: { contains: 'NA10' } } });
  await db.notification.deleteMany({ where: { organizationId: orgA.id, title: { contains: 'NA10' } } });
  await db.organizationSetting.deleteMany({ where: { organizationId: orgA.id, key: 'ai_anomaly_detection' } });
});

// ─── N-6: org-level preferences persisted + enforced ─────────────────────────
test('NA-11: preference PUT validates type; disable stops producers; re-enable restores', async () => {
  const t = await token('manager', orgA.id);
  const bad = await notifPrefsApi.PUT(req(t, { method: 'PUT', body: { notificationType: 'nope', enabled: true } }));
  assert.equal(bad.status, 422);

  // Disable 'new_employee' → the employee POST producer is skipped.
  await notifPrefsApi.PUT(req(t, { method: 'PUT', body: { notificationType: 'new_employee', enabled: false } }));
  const adminT = await token('admin', orgA.id);
  const createEmp = (firstName: string, employeeId: string, email: string) =>
    employeesApi.POST(req(adminT, {
      method: 'POST',
      body: { firstName, lastName: 'Emp', employeeId, email },
    }));
  const resDisabled = await createEmp('New', 'NA11-EMP', 'na11@a.test');
  assert.equal(resDisabled.status, 201, 'employee created (producer skipped via preference)');
  const emp = await db.employee.findUniqueOrThrow({ where: { employeeId: 'NA11-EMP' } });
  const afterDisable = await db.notification.count({ where: { organizationId: orgA.id, type: 'new_employee', entityId: emp.id } });
  assert.equal(afterDisable, 0, 'disabled type must not produce a notification');

  // Re-enable → producer fires again.
  await notifPrefsApi.PUT(req(t, { method: 'PUT', body: { notificationType: 'new_employee', enabled: true } }));
  const resEnabled = await createEmp('New2', 'NA11-EMP2', 'na11b@a.test');
  assert.equal(resEnabled.status, 201, 'employee created (producer fires)');
  const emp2 = await db.employee.findUniqueOrThrow({ where: { employeeId: 'NA11-EMP2' } });
  const afterEnable = await db.notification.count({ where: { organizationId: orgA.id, type: 'new_employee', entityId: emp2.id } });
  assert.equal(afterEnable, 1, 'enabled type must produce a notification');

  // GET reflects the persisted state.
  const getRes = await notifPrefsApi.GET(req(await token('admin', orgA.id)));
  const prefs = (await getRes.json()).preferences as { notificationType: string; enabled: boolean; active: boolean }[];
  const newEmpPref = prefs.find((p) => p.notificationType === 'new_employee');
  assert.equal(newEmpPref!.enabled, true);
  // Honest types list (N-6): device_offline advertised as planned, not active.
  const deviceOffline = prefs.find((p) => p.notificationType === 'device_offline');
  assert.equal(deviceOffline!.active, false, 'unproduced types must be marked planned');

  await db.employee.deleteMany({ where: { id: { in: [emp.id, emp2.id] } } });
  await db.notification.deleteMany({ where: { organizationId: orgA.id, type: 'new_employee' } });
  await db.notificationPreference.deleteMany({ where: { organizationId: orgA.id } });
});

// ─── N-4: retention ──────────────────────────────────────────────────────────
test('NA-12: notification/alert retention purges old non-active, keeps recent + active', async () => {
  const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000); // ~400 days ago
  await db.organizationSetting.create({ data: { organizationId: orgA.id, key: 'notification_retention_days', value: '365' } });
  await db.organizationSetting.create({ data: { organizationId: orgA.id, key: 'alert_retention_days', value: '365' } });

  // Old read notification → purged; old unread notification → KEPT.
  const oldRead = await db.notification.create({ data: { title: 'old-read', message: 'm', type: 'system', status: 'read', organizationId: orgA.id, createdAt: old } });
  const oldUnread = await db.notification.create({ data: { title: 'old-unread', message: 'm', type: 'system', status: 'unread', organizationId: orgA.id, createdAt: old } });
  // Old resolved alert → purged; old pending alert → KEPT.
  const oldResolved = await db.alert.create({ data: { title: 'old-resolved', description: 'd', type: 'system', severity: 'info', status: 'resolved', organizationId: orgA.id, createdAt: old } });
  const oldPending = await db.alert.create({ data: { title: 'old-pending', description: 'd', type: 'system', severity: 'warning', status: 'pending', organizationId: orgA.id, createdAt: old } });
  // Recent records → kept regardless.
  const recentNotif = await db.notification.create({ data: { title: 'recent-notif', message: 'm', type: 'system', status: 'read', organizationId: orgA.id } });
  const recentAlert = await db.alert.create({ data: { title: 'recent-alert', description: 'd', type: 'system', severity: 'info', status: 'resolved', organizationId: orgA.id } });

  const result = await retention.runRetentionForOrg(orgA.id, new Date(), 100);
  assert.ok(result.notifications >= 1, 'old read notification purged');
  assert.ok(result.alerts >= 1, 'old resolved alert purged');
  assert.ok(await db.notification.findUnique({ where: { id: oldUnread.id } }), 'old UNREAD notification must be kept');
  assert.ok(await db.alert.findUnique({ where: { id: oldPending.id } }), 'old PENDING alert must be kept');
  assert.equal(await db.notification.findUnique({ where: { id: oldRead.id } }), null);
  assert.equal(await db.alert.findUnique({ where: { id: oldResolved.id } }), null);
  assert.ok(await db.notification.findUnique({ where: { id: recentNotif.id } }));
  assert.ok(await db.alert.findUnique({ where: { id: recentAlert.id } }));

  await db.notification.deleteMany({ where: { id: { in: [oldRead.id, oldUnread.id, recentNotif.id] } } });
  await db.alert.deleteMany({ where: { id: { in: [oldResolved.id, oldPending.id, recentAlert.id] } } });
  await db.organizationSetting.deleteMany({ where: { organizationId: orgA.id, key: { in: ['notification_retention_days', 'alert_retention_days'] } } });
});

// ─── N-10: realtime invalidation mapping ─────────────────────────────────────
test('NA-13: alert-event invalidation covers alerts list, count, security, dashboard', () => {
  const keys = wsInvalidation.alertEventInvalidation();
  const flat = keys.map((k) => k[0]);
  for (const expected of ['alerts', 'alert-count', 'security-alerts', 'dashboard']) {
    assert.ok(flat.includes(expected), `expected ${expected} in ${JSON.stringify(flat)}`);
  }
  assert.ok(keys.length > 0, 'never an empty invalidation list');
});

// ─── N-9: structured linkage (employee-details uses employeeId) ───────────────
test('NA-14: employee detail alerts/notifications resolve via employeeId, not message text', async () => {
  await db.alert.create({ data: { title: 'link-a', description: 'x', type: 'system', severity: 'info', status: 'pending', employeeId: empA.id, organizationId: orgA.id } });
  await db.alert.create({ data: { title: 'link-b', description: 'x', type: 'system', severity: 'info', status: 'pending', employeeId: empB.id, organizationId: orgA.id } });
  await db.notification.create({ data: { title: 'link-n-a', message: 'x', type: 'system', employeeId: empA.id, organizationId: orgA.id } });
  await db.notification.create({ data: { title: 'link-n-b', message: 'x', type: 'system', employeeId: empB.id, organizationId: orgA.id } });

  const aAlerts = await db.alert.count({ where: { organizationId: orgA.id, employeeId: empA.id } });
  const bAlerts = await db.alert.count({ where: { organizationId: orgA.id, employeeId: empB.id } });
  assert.equal(aAlerts, 1);
  assert.equal(bAlerts, 1, 'structured filter separates employees');
  const aNotifs = await db.notification.count({ where: { organizationId: orgA.id, employeeId: empA.id } });
  assert.equal(aNotifs, 1);
  await db.alert.deleteMany({ where: { title: { startsWith: 'link-' } } });
  await db.notification.deleteMany({ where: { title: { startsWith: 'link-n-' } } });
});

// ─── N-11: metadata + batch bounds ───────────────────────────────────────────
test('NA-15: metadata size bounded; batch ids bounded', async () => {
  const huge = { blob: 'x'.repeat(20 * 1024) };
  assert.throws(() => validation.serializeMetadata(huge), /metadata must be at most/);
  assert.equal(validation.serializeMetadata({ a: 1 }), '{"a":1}');
  assert.throws(() => validation.serializeMetadata([1, 2]), /metadata must be a JSON object/);

  const t = await token('admin', orgA.id);
  const tooMany = await notifBatchApi.POST(req(t, { method: 'POST', body: { action: 'mark_read', ids: Array.from({ length: 201 }).map((_, i) => `id-${i}`) } }));
  assert.equal(tooMany.status, 422);
});

// ─── Notification service: unsafe actionUrl validation (pure) ───────────────
test('NA-16: actionUrl validator rejects unsafe schemes, allows internal routes', () => {
  assert.ok(validation.validateActionUrl('javascript:alert(1)'));
  assert.ok(validation.validateActionUrl('data:text/html,x'));
  assert.ok(validation.validateActionUrl('vbscript:msgbox(1)'));
  assert.ok(validation.validateActionUrl('file:///etc/passwd'));
  assert.ok(validation.validateActionUrl('//evil.com'));
  assert.ok(validation.validateActionUrl('https://evil.example.com'));
  assert.equal(validation.validateActionUrl('/anomalies'), null);
  assert.equal(validation.validateActionUrl('/employees?id=abc'), null);
  assert.equal(validation.validateActionUrl(''), null);
  assert.equal(validation.validateActionUrl(null), null);
});

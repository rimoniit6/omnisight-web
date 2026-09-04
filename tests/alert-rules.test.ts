/**
 * Phase 5 — AlertRule engine + admin API + notification pipeline.
 *
 * Covers:
 *  - Pure evaluators: device_offline / excessive_idle / excessive_unproductive /
 *    outside_hours_activity (thresholds, exclusions, overnight windows).
 *  - Registry robustness: corrupt stored params resolve to safe defaults,
 *    never throw; unknown condition types are skipped.
 *  - Job behavior over a real DB: fail-closed master flag (OFF → never
 *    evaluated), firing creates Alert + Notification + one state row, replay
 *    within cooldown dedupes, cooldown expiry allows a second firing,
 *    concurrent evaluation can never double-fire (unique (rule, entity)),
 *    org/employee isolation, org notification preference honored (disabled
 *    type → alert still recorded, notification skipped).
 *  - Admin CRUD: create/list/update/delete, RBAC (anon 401, viewer 403,
 *    manager+ 2xx), tenant isolation (cross-org id 404, list scoped),
 *    validation (422), bounded count, delete cascades firing state.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_alertrules).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation (set BEFORE any app module import) ──────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_alertrules';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-alertrules-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@alertrules.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!AlertRules2026x';
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
let managerBToken: string;
let viewerAToken: string;

function req(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(url, init);
}
function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  orgA = await db.organization.create({ data: { name: 'Alert Org A', slug: 'alert-org-a', timezone: 'UTC' } });
  orgB = await db.organization.create({ data: { name: 'Alert Org B', slug: 'alert-org-b', timezone: 'Asia/Dhaka' } });

  adminAToken = await signJWT({ userId: 'admin-a', email: 'admin@a.test', role: 'admin', organizationId: orgA.id });
  managerBToken = await signJWT({ userId: 'mgr-b', email: 'mgr@b.test', role: 'manager', organizationId: orgB.id });
  viewerAToken = await signJWT({ userId: 'viewer-a', email: 'viewer@a.test', role: 'viewer', organizationId: orgA.id });
});

after(async () => {
  await db.$disconnect();
});

// ==================== Shared seeds ====================

/** UTC-midnight start of the CURRENT UTC calendar day (org A is UTC). */
function todayUtcStart(): Date {
  return new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
}

async function setOrgFlag(orgId: string, key: string, value: string) {
  await db.organizationSetting.upsert({
    where: { organizationId_key: { organizationId: orgId, key } },
    update: { value },
    create: { organizationId: orgId, key, value, category: 'monitoring' },
  });
}

async function createEmployee(orgId: string, tag: string) {
  const emp = await db.employee.create({
    data: {
      employeeId: `emp-alert-${tag}-${Math.random().toString(36).slice(2, 8)}`,
      firstName: tag,
      lastName: 'Alert',
      email: `${tag}@alert.test`,
      organizationId: orgId,
      status: 'active',
      agentApproved: true,
    },
  });
  return emp;
}

/** Employee with granted activity_tracking + monitoring consent. */
async function seedConsentedEmployee(orgId: string, tag: string) {
  const emp = await createEmployee(orgId, tag);
  for (const consentType of ['activity_tracking', 'monitoring']) {
    const policy = await db.consentPolicy.upsert({
      where: { organizationId_consentType_version: { organizationId: orgId, consentType, version: 'v1' } },
      update: {},
      create: {
        organizationId: orgId,
        consentType,
        title: `${consentType} policy`,
        content: 'test policy',
        version: 'v1',
        status: 'published',
        effectiveAt: new Date(),
        publishedAt: new Date(),
      },
    });
    await db.consent.create({
      data: {
        organizationId: orgId,
        employeeId: emp.id,
        policyId: policy.id,
        consentType,
        status: 'granted',
        consentVersion: policy.version,
        grantedAt: new Date(),
      },
    });
  }
  return emp;
}

/** Create an enabled rule row directly (bypasses API validation on purpose
 *  where tests need non-default params; values still canonical). */
async function createRule(orgId: string, overrides: Partial<{ name: string; conditionType: string; params: Record<string, number>; severity: string; cooldownMinutes: number; enabled: boolean }> = {}) {
  return db.alertRule.create({
    data: {
      organizationId: orgId,
      name: overrides.name ?? `rule-${Math.random().toString(36).slice(2, 8)}`,
      conditionType: overrides.conditionType ?? 'excessive_idle',
      params: JSON.stringify(overrides.params ?? { thresholdMinutes: 5 }),
      severity: overrides.severity ?? 'warning',
      cooldownMinutes: overrides.cooldownMinutes ?? 60,
      enabled: overrides.enabled ?? true,
    },
  });
}

/** Seed `minutes` of an activity kind for an employee INSIDE the current UTC
 *  day (org A timezone = UTC) at a fixed offset so tests are drift-proof. */
async function seedActivity(empId: string, rows: Array<{ type: string; category?: string | null; applicationName?: string | null; title?: string | null; duration: number; hourOffset: number }>) {
  const dayStart = todayUtcStart();
  // Phase 1: Activity requires direct organizationId — resolve from the employee (same rule as the DB backfill).
  const emp = await db.employee.findUniqueOrThrow({ where: { id: empId }, select: { organizationId: true } });
  for (const r of rows) {
    await db.activity.create({
      data: {
        employeeId: empId,
        organizationId: emp.organizationId,
        type: r.type,
        category: r.category ?? null,
        applicationName: r.applicationName ?? null,
        title: r.title ?? null,
        duration: r.duration,
        timestamp: new Date(dayStart.getTime() + r.hourOffset * 3600_000),
      },
    });
  }
}

// ==================== Pure evaluators ====================

test('AR-1: device_offline fires when heartbeat stale >= threshold; fresh/absent never fire', async () => {
  const { evaluateDeviceOffline } = await import('../src/lib/alerts/evaluate');
  const now = new Date('2026-09-03T12:00:00.000Z');
  const params = { thresholdMinutes: 15 };

  const stale = evaluateDeviceOffline({ id: 'd1', lastHeartbeat: new Date(now.getTime() - 40 * 60_000) }, params, now);
  assert.equal(stale.fired, true);
  assert.ok(stale.measured >= 15);

  const fresh = evaluateDeviceOffline({ id: 'd2', lastHeartbeat: new Date(now.getTime() - 2 * 60_000) }, params, now);
  assert.equal(fresh.fired, false);

  const none = evaluateDeviceOffline({ id: 'd3', lastHeartbeat: null }, params, now);
  assert.equal(none.fired, false);
});

test('AR-2: excessive_idle sums idle minutes today; exclusions honored; under-threshold never fires', async () => {
  const { evaluateExcessiveIdle } = await import('../src/lib/alerts/evaluate');
  const dayStart = todayUtcStart();
  const window = { dayStart, dayEndExclusive: new Date(dayStart.getTime() + 24 * 3600_000), workStartMinutes: 540, workEndMinutes: 1080 };
  const mk = (over: Partial<{ category: string | null; type: string | null; applicationName: string | null; title: string | null; duration: number }>) => ({
    timestamp: new Date(dayStart.getTime() + 3 * 3600_000),
    duration: 600,
    category: 'idle' as string | null,
    type: 'idle' as string | null,
    applicationName: null as string | null,
    title: null as string | null,
    ...over,
  });

  // 10 min idle at threshold 5 → fires with measured 10.
  const fired = evaluateExcessiveIdle(
    [mk({ duration: 600 })],
    { thresholdMinutes: 5 },
    window
  );
  assert.equal(fired.fired, true);
  assert.equal(fired.measured, 10);

  // Below threshold → does not fire.
  const under = evaluateExcessiveIdle([mk({ duration: 120 })], { thresholdMinutes: 5 }, window);
  assert.equal(under.fired, false);

  // Internal-agent rows and break mirrors are excluded from the idle total.
  const excluded = evaluateExcessiveIdle(
    [mk({ duration: 600 }), mk({ applicationName: 'OmniSightAgent.exe', duration: 600 }), mk({ title: 'Break Mode Started', category: 'idle', duration: 600 })],
    { thresholdMinutes: 5 },
    window
  );
  assert.equal(excluded.measured, 10, 'only the real idle row counts');

  // Rows outside the org-local day window are never counted.
  const outside = evaluateExcessiveIdle(
    [{ ...mk({ duration: 600 }), timestamp: new Date(dayStart.getTime() - 3600_000) }],
    { thresholdMinutes: 5 },
    window
  );
  assert.equal(outside.measured, 0);
});

test('AR-3: excessive_unproductive counts only server-authoritative unproductive seconds; idle never counts', async () => {
  const { evaluateExcessiveUnproductive } = await import('../src/lib/alerts/evaluate');
  const dayStart = todayUtcStart();
  const window = { dayStart, dayEndExclusive: new Date(dayStart.getTime() + 24 * 3600_000), workStartMinutes: 540, workEndMinutes: 1080 };
  const mk = (category: string | null) => ({
    timestamp: new Date(dayStart.getTime() + 4 * 3600_000),
    duration: 600,
    category,
    type: 'application' as string | null,
    applicationName: 'app.exe',
    title: null as string | null,
  });

  // 10 min unproductive at threshold 5 → fires.
  const fired = evaluateExcessiveUnproductive([mk('unproductive')], { thresholdMinutes: 5 }, window);
  assert.equal(fired.fired, true);
  assert.equal(fired.measured, 10);

  // Idle + productive + neutral seconds never count toward unproductive.
  const mixed = evaluateExcessiveUnproductive(
    [mk('unproductive'), mk('productive'), mk('neutral'), { ...mk('idle'), type: 'idle' }],
    { thresholdMinutes: 5 },
    window
  );
  assert.equal(mixed.measured, 10);
});

test('AR-4: outside_hours_activity counts app rows outside the work window; overnight windows respected', async () => {
  const { evaluateOutsideHoursActivity } = await import('../src/lib/alerts/evaluate');
  const dayStart = todayUtcStart();
  const mk = (hour: number, type = 'application') => ({
    timestamp: new Date(dayStart.getTime() + hour * 3600_000),
    duration: 60,
    category: 'neutral' as string | null,
    type: type as string | null,
    applicationName: 'app.exe',
    title: null as string | null,
  });

  // Default window 09:00–18:00. Rows at 08:00 and 20:00 are outside.
  const dayWindow = { dayStart, dayEndExclusive: new Date(dayStart.getTime() + 24 * 3600_000), workStartMinutes: 540, workEndMinutes: 1080 };
  const fired = evaluateOutsideHoursActivity([mk(20), mk(8), mk(12)], { thresholdCount: 2 }, dayWindow);
  assert.equal(fired.fired, true);
  assert.equal(fired.measured, 2, '12:00 is inside the window');

  // Non-application rows (website/idle) never count.
  const nonApp = evaluateOutsideHoursActivity([mk(20, 'website'), mk(20, 'idle')], { thresholdCount: 1 }, dayWindow);
  assert.equal(nonApp.measured, 0);

  // Overnight window 22:00–06:00: 23:00 and 03:00 are INSIDE, 12:00 outside.
  const overnight = { dayStart, dayEndExclusive: new Date(dayStart.getTime() + 24 * 3600_000), workStartMinutes: 1320, workEndMinutes: 360 };
  const night = evaluateOutsideHoursActivity([mk(23), mk(3), mk(12)], { thresholdCount: 1 }, overnight);
  assert.equal(night.measured, 1);
});

test('AR-5: corrupt stored params resolve to safe defaults; unknown types are skipped without throwing', async () => {
  const { resolveConditionParams } = await import('../src/lib/alerts/conditions');
  const { evaluateCondition } = await import('../src/lib/alerts/evaluate');
  const dayStart = todayUtcStart();
  const window = { dayStart, dayEndExclusive: new Date(dayStart.getTime() + 24 * 3600_000), workStartMinutes: 540, workEndMinutes: 1080 };

  // Corrupt JSON → defaults (never throws).
  assert.deepEqual(resolveConditionParams('excessive_idle', '{not json'), { thresholdMinutes: 120 });
  // Out-of-range values clamp to registry bounds (999999 → 1440 max, -3 → 1 min).
  assert.deepEqual(resolveConditionParams('excessive_idle', JSON.stringify({ thresholdMinutes: 999999 })), { thresholdMinutes: 1440 });
  assert.deepEqual(resolveConditionParams('outside_hours_activity', JSON.stringify({ thresholdCount: -3, junk: 1 })), { thresholdCount: 1 });
  // String numerics are accepted (matching resolver conventions).
  assert.deepEqual(resolveConditionParams('device_offline', JSON.stringify({ thresholdMinutes: '30' })), { thresholdMinutes: 30 });

  // Evaluating a condition with defaults on empty rows yields not-fired.
  const out = evaluateCondition(
    'excessive_unproductive',
    { activities: [{ timestamp: new Date(dayStart.getTime() + 3600_000), duration: 0, category: 'unproductive', type: 'application', applicationName: null, title: null }] },
    '{corrupt',
    window,
    new Date()
  );
  assert.equal(out.fired, false);
});

// ==================== Job behavior (real DB) ====================

test('AR-6: master flag OFF → rules are NEVER evaluated (fail closed)', async () => {
  const { runAlertRulesJob } = await import('../src/lib/jobs/alert-rules');
  await setOrgFlag(orgA.id, 'alert_rules_enabled', 'false');
  const emp = await seedConsentedEmployee(orgA.id, 'flagoff');
  const rule = await createRule(orgA.id, { conditionType: 'excessive_idle', params: { thresholdMinutes: 5 } });
  await seedActivity(emp.id, [{ type: 'idle', category: 'idle', duration: 1800, hourOffset: 3 }]);

  const result = await runAlertRulesJob(new Date());
  assert.ok(result.orgsSkipped >= 1, 'flag-off org must be skipped');
  assert.equal(await db.alert.count({ where: { organizationId: orgA.id } }), 0, 'no alerts with flag off');
  assert.equal(await db.alertRuleFiring.count({ where: { ruleId: rule.id } }), 0);

  await db.activity.deleteMany({ where: { employeeId: emp.id } });
  await db.alertRule.delete({ where: { id: rule.id } });
});

test('AR-7: firing creates Alert + Notification + one firing state row; activity rows untouched', async () => {
  const { evaluateAlertRulesForOrg } = await import('../src/lib/jobs/alert-rules');
  await setOrgFlag(orgA.id, 'alert_rules_enabled', 'true');
  const emp = await seedConsentedEmployee(orgA.id, 'fireone');
  const rule = await createRule(orgA.id, { name: 'Idle 5', conditionType: 'excessive_idle', params: { thresholdMinutes: 5 }, severity: 'warning' });
  await seedActivity(emp.id, [{ type: 'idle', category: 'idle', duration: 1800, hourOffset: 3 }]); // 30 min idle

  const activityBefore = await db.activity.count({ where: { employeeId: emp.id } });
  const out = await evaluateAlertRulesForOrg(orgA.id, new Date());
  assert.equal(out.alertsCreated, 1);
  assert.equal(out.alertsSuppressedByCooldown, 0);

  const alert = await db.alert.findFirst({ where: { organizationId: orgA.id, source: 'alert_rule' } });
  assert.ok(alert, 'alert created');
  assert.equal(alert.employeeId, emp.id);
  assert.equal(alert.severity, 'warning');
  const meta = JSON.parse(alert.metadata ?? '{}') as Record<string, unknown>;
  assert.equal(meta.ruleId, rule.id);
  assert.ok((meta.measured as number) >= 30);

  const notification = await db.notification.findFirst({ where: { organizationId: orgA.id, type: 'security' } });
  assert.ok(notification, 'notification created through the shared service');
  assert.equal(notification.entityType, 'employee');
  assert.equal(notification.employeeId, emp.id);

  const firing = await db.alertRuleFiring.findUnique({
    where: { ruleId_entityType_entityId: { ruleId: rule.id, entityType: 'employee', entityId: emp.id } },
  });
  assert.ok(firing, 'state row written');

  // Raw telemetry is NEVER modified by the alert engine.
  assert.equal(await db.activity.count({ where: { employeeId: emp.id } }), activityBefore);

  // Cleanup: keep DB predictable for later tests in this suite.
  await db.activity.deleteMany({ where: { employeeId: emp.id } });
  await db.alertRuleFiring.deleteMany({ where: { ruleId: rule.id } });
  await db.alert.deleteMany({ where: { organizationId: orgA.id } });
  await db.notification.deleteMany({ where: { organizationId: orgA.id } });
  await db.alertRule.delete({ where: { id: rule.id } });
});

test('AR-8: replay within cooldown dedupes — no second alert, counted as suppressed', async () => {
  const { evaluateAlertRulesForOrg } = await import('../src/lib/jobs/alert-rules');
  await setOrgFlag(orgA.id, 'alert_rules_enabled', 'true');
  const emp = await seedConsentedEmployee(orgA.id, 'replay');
  const rule = await createRule(orgA.id, { conditionType: 'excessive_idle', params: { thresholdMinutes: 5 }, cooldownMinutes: 60 });
  await seedActivity(emp.id, [{ type: 'idle', category: 'idle', duration: 1800, hourOffset: 3 }]);

  const t0 = new Date();
  const first = await evaluateAlertRulesForOrg(orgA.id, t0);
  assert.equal(first.alertsCreated, 1);

  // Same logical batch replayed moments later (lost response / crash replay).
  const second = await evaluateAlertRulesForOrg(orgA.id, new Date(t0.getTime() + 5_000));
  assert.equal(second.alertsCreated, 0);
  assert.equal(second.alertsSuppressedByCooldown, 1, 'replay suppressed by cooldown, not a failure');
  assert.equal(await db.alert.count({ where: { organizationId: orgA.id } }), 1, 'exactly one alert');

  await db.activity.deleteMany({ where: { employeeId: emp.id } });
  await db.alertRuleFiring.deleteMany({ where: { ruleId: rule.id } });
  await db.alert.deleteMany({ where: { organizationId: orgA.id } });
  await db.notification.deleteMany({ where: { organizationId: orgA.id } });
  await db.alertRule.delete({ where: { id: rule.id } });
});

test('AR-9: concurrent evaluation of the same rule+entity can never double-fire', async () => {
  const { evaluateAlertRulesForOrg } = await import('../src/lib/jobs/alert-rules');
  await setOrgFlag(orgA.id, 'alert_rules_enabled', 'true');
  const emp = await seedConsentedEmployee(orgA.id, 'concurrent');
  const rule = await createRule(orgA.id, { conditionType: 'excessive_idle', params: { thresholdMinutes: 5 }, cooldownMinutes: 60 });
  await seedActivity(emp.id, [{ type: 'idle', category: 'idle', duration: 1800, hourOffset: 3 }]);

  const t0 = new Date();
  const [a, b] = await Promise.all([
    evaluateAlertRulesForOrg(orgA.id, t0),
    evaluateAlertRulesForOrg(orgA.id, new Date(t0.getTime() + 50)),
  ]);

  assert.equal(a.alertsCreated + b.alertsCreated, 1, 'exactly one winning firing across both callers');
  assert.equal(await db.alert.count({ where: { organizationId: orgA.id } }), 1);
  assert.equal(
    await db.alertRuleFiring.count({ where: { ruleId: rule.id, entityId: emp.id } }),
    1,
    'unique (rule, entity) constraint prevents duplicate state'
  );

  await db.activity.deleteMany({ where: { employeeId: emp.id } });
  await db.alertRuleFiring.deleteMany({ where: { ruleId: rule.id } });
  await db.alert.deleteMany({ where: { organizationId: orgA.id } });
  await db.notification.deleteMany({ where: { organizationId: orgA.id } });
  await db.alertRule.delete({ where: { id: rule.id } });
});

test('AR-10: after cooldown elapses the same entity may fire again (bounded, not once-ever)', async () => {
  const { evaluateAlertRulesForOrg } = await import('../src/lib/jobs/alert-rules');
  await setOrgFlag(orgA.id, 'alert_rules_enabled', 'true');
  const emp = await seedConsentedEmployee(orgA.id, 'cooldown2');
  const rule = await createRule(orgA.id, { conditionType: 'excessive_idle', params: { thresholdMinutes: 5 }, cooldownMinutes: 60 });
  // Rows mid-day so both evaluations share the same org-local day window.
  await seedActivity(emp.id, [{ type: 'idle', category: 'idle', duration: 1800, hourOffset: 3 }]);

  const t0 = new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00.000Z`);
  const first = await evaluateAlertRulesForOrg(orgA.id, t0);
  assert.equal(first.alertsCreated, 1);

  const later = new Date(t0.getTime() + 61 * 60_000); // +61 min > cooldown, same day
  const second = await evaluateAlertRulesForOrg(orgA.id, later);
  assert.equal(second.alertsCreated, 1, 'cooldown elapsed → new firing allowed');
  assert.equal(await db.alert.count({ where: { organizationId: orgA.id } }), 2);
  assert.equal(await db.alertRuleFiring.count({ where: { ruleId: rule.id, entityId: emp.id } }), 1, 'state row updated in place');

  await db.activity.deleteMany({ where: { employeeId: emp.id } });
  await db.alertRuleFiring.deleteMany({ where: { ruleId: rule.id } });
  await db.alert.deleteMany({ where: { organizationId: orgA.id } });
  await db.notification.deleteMany({ where: { organizationId: orgA.id } });
  await db.alertRule.delete({ where: { id: rule.id } });
});

test('AR-11: disabled rules never fire; org isolation — org B activity can never fire org A rules', async () => {
  const { evaluateAlertRulesForOrg } = await import('../src/lib/jobs/alert-rules');
  await setOrgFlag(orgA.id, 'alert_rules_enabled', 'true');
  await setOrgFlag(orgB.id, 'alert_rules_enabled', 'true');

  const empA = await seedConsentedEmployee(orgA.id, 'tenantA');
  const empB = await seedConsentedEmployee(orgB.id, 'tenantB');

  // Disabled rule in A that would otherwise match empA's idle rows.
  const disabledRule = await createRule(orgA.id, { conditionType: 'excessive_idle', params: { thresholdMinutes: 5 }, enabled: false });
  // Enabled rule in A.
  const enabledRuleA = await createRule(orgA.id, { conditionType: 'excessive_idle', params: { thresholdMinutes: 5 } });
  // Org A's rule uses an org-B-scoped marker name so a cross-org leak would be obvious.
  await db.alertRule.update({ where: { id: enabledRuleA.id }, data: { name: 'A-only-idle-rule' } });

  // Org B's employee has plenty of idle rows — but B has NO enabled rules here.
  await seedActivity(empB.id, [{ type: 'idle', category: 'idle', duration: 3600, hourOffset: 3 }]);

  const out = await evaluateAlertRulesForOrg(orgA.id, new Date());
  assert.equal(out.alertsCreated, 0, 'disabled rule does not fire and no A activity exists');

  // Give empA idle rows in A: only the ENABLED A rule can fire (tenant-scoped).
  await seedActivity(empA.id, [{ type: 'idle', category: 'idle', duration: 1800, hourOffset: 3 }]);
  const out2 = await evaluateAlertRulesForOrg(orgA.id, new Date());
  assert.equal(out2.alertsCreated, 1);
  const alert = await db.alert.findFirst({ where: { organizationId: orgA.id } });
  assert.equal(alert?.employeeId, empA.id, 'only the A employee can fire A rules');

  // Org B evaluation never consults org A's rules.
  const outB = await evaluateAlertRulesForOrg(orgB.id, new Date());
  assert.equal(outB.alertsCreated, 0);
  assert.equal(await db.alert.count({ where: { organizationId: orgB.id } }), 0);

  await db.activity.deleteMany({ where: { employeeId: { in: [empA.id, empB.id] } } });
  await db.alertRuleFiring.deleteMany({ where: { ruleId: { in: [disabledRule.id, enabledRuleA.id] } } });
  await db.alert.deleteMany({ where: { organizationId: orgA.id } });
  await db.notification.deleteMany({ where: { organizationId: orgA.id } });
  await db.alertRule.deleteMany({ where: { id: { in: [disabledRule.id, enabledRuleA.id] } } });
});

test('AR-12: device_offline rule fires for a stale heartbeat and respects monitoring consent', async () => {
  const { evaluateAlertRulesForOrg } = await import('../src/lib/jobs/alert-rules');
  await setOrgFlag(orgA.id, 'alert_rules_enabled', 'true');
  const emp = await seedConsentedEmployee(orgA.id, 'devoff');

  // Monitored online device whose heartbeat went silent 2h ago.
  const staleDevice = await db.device.create({
    data: {
      name: 'Laptop-A',
      organizationId: orgA.id,
      employeeId: emp.id,
      status: 'online',
      lastHeartbeat: new Date(Date.now() - 2 * 3600_000),
    },
  });
  // Device with NO consent (consent-revoked employee) — must never fire.
  const revokedEmp = await createEmployee(orgA.id, 'devrevoked');
  await db.device.create({
    data: {
      name: 'Laptop-Revoked',
      organizationId: orgA.id,
      employeeId: revokedEmp.id,
      status: 'online',
      lastHeartbeat: new Date(Date.now() - 5 * 3600_000),
    },
  });

  const rule = await createRule(orgA.id, { conditionType: 'device_offline', params: { thresholdMinutes: 15 }, name: 'Offline 15m' });

  const out = await evaluateAlertRulesForOrg(orgA.id, new Date());
  assert.equal(out.alertsCreated, 1, 'only the consented device fires');

  const alert = await db.alert.findFirst({ where: { organizationId: orgA.id, source: 'alert_rule' } });
  assert.equal(alert?.deviceId, staleDevice.id, 'alert links the stale device');
  const meta = JSON.parse(alert?.metadata ?? '{}') as Record<string, unknown>;
  assert.equal(meta.entityType, 'device');
  assert.ok((meta.measured as number) >= 15);

  const notification = await db.notification.findFirst({ where: { organizationId: orgA.id, type: 'security' } });
  assert.equal(notification?.entityType, 'device');
  assert.equal(notification?.deviceId, staleDevice.id);

  await db.alertRuleFiring.deleteMany({ where: { ruleId: rule.id } });
  await db.alert.deleteMany({ where: { organizationId: orgA.id } });
  await db.notification.deleteMany({ where: { organizationId: orgA.id } });
  await db.alertRule.delete({ where: { id: rule.id } });
  await db.device.deleteMany({ where: { organizationId: orgA.id } });
});

test('AR-13: org notification preference is honored — disabled type skips the record, alert still created', async () => {
  const { evaluateAlertRulesForOrg } = await import('../src/lib/jobs/alert-rules');
  await setOrgFlag(orgA.id, 'alert_rules_enabled', 'true');
  const emp = await seedConsentedEmployee(orgA.id, 'notifpref');

  // Org A disables the 'security' notification type org-wide.
  await db.notificationPreference.upsert({
    where: { organizationId_notificationType: { organizationId: orgA.id, notificationType: 'security' } },
    update: { enabled: false },
    create: { organizationId: orgA.id, notificationType: 'security', enabled: false },
  });

  const rule = await createRule(orgA.id, { conditionType: 'excessive_idle', params: { thresholdMinutes: 5 } });
  await seedActivity(emp.id, [{ type: 'idle', category: 'idle', duration: 1800, hourOffset: 3 }]);

  const out = await evaluateAlertRulesForOrg(orgA.id, new Date());
  assert.equal(out.alertsCreated, 1, 'alert is still the observable record');
  assert.equal(await db.alert.count({ where: { organizationId: orgA.id } }), 1);
  assert.equal(
    await db.notification.count({ where: { organizationId: orgA.id, type: 'security' } }),
    0,
    'disabled notification type is never bypassed by the producer'
  );

  // Re-enable for the rest of the suite.
  await db.notificationPreference.upsert({
    where: { organizationId_notificationType: { organizationId: orgA.id, notificationType: 'security' } },
    update: { enabled: true },
    create: { organizationId: orgA.id, notificationType: 'security', enabled: true },
  });
  await db.activity.deleteMany({ where: { employeeId: emp.id } });
  await db.alertRuleFiring.deleteMany({ where: { ruleId: rule.id } });
  await db.alert.deleteMany({ where: { organizationId: orgA.id } });
  await db.alertRule.delete({ where: { id: rule.id } });
});

test('AR-14: deleting a rule cascades its firing state rows', async () => {
  const { evaluateAlertRulesForOrg } = await import('../src/lib/jobs/alert-rules');
  await setOrgFlag(orgA.id, 'alert_rules_enabled', 'true');
  const emp = await seedConsentedEmployee(orgA.id, 'cascade');
  const rule = await createRule(orgA.id, { conditionType: 'excessive_idle', params: { thresholdMinutes: 5 } });
  await seedActivity(emp.id, [{ type: 'idle', category: 'idle', duration: 1800, hourOffset: 3 }]);

  await evaluateAlertRulesForOrg(orgA.id, new Date());
  assert.equal(await db.alertRuleFiring.count({ where: { ruleId: rule.id } }), 1);

  await db.alertRule.delete({ where: { id: rule.id } });
  assert.equal(await db.alertRuleFiring.count({ where: { ruleId: rule.id } }), 0, 'firing state cascades on rule delete');

  await db.activity.deleteMany({ where: { employeeId: emp.id } });
  await db.alert.deleteMany({ where: { organizationId: orgA.id } });
  await db.notification.deleteMany({ where: { organizationId: orgA.id } });
});

test('AR-15: full runAlertRulesJob path executes under the lease and records results', async () => {
  const { runAlertRulesJob } = await import('../src/lib/jobs/alert-rules');
  await setOrgFlag(orgA.id, 'alert_rules_enabled', 'true');
  const emp = await seedConsentedEmployee(orgA.id, 'fulljob');
  const rule = await createRule(orgA.id, { name: 'Full Job Idle', conditionType: 'excessive_idle', params: { thresholdMinutes: 5 } });
  await seedActivity(emp.id, [{ type: 'idle', category: 'idle', duration: 1800, hourOffset: 3 }]);

  const result = await runAlertRulesJob(new Date());
  assert.ok(result.rulesEvaluated >= 1);
  assert.ok(result.alertsCreated >= 1);
  assert.ok(result.errors.length === 0, 'no org errors');

  const jobRun = await db.jobRun.findUnique({ where: { job: 'alert_rule_evaluation' } });
  assert.ok(jobRun, 'jobRun row exists');
  assert.equal(jobRun.status, 'completed');
  const lastResult = JSON.parse(jobRun.lastResult ?? '{}') as Record<string, number>;
  assert.ok((lastResult.alertsCreated ?? 0) >= 1, 'observable result recorded');

  // Reset jobRun so other suites in this DB can claim it again cleanly.
  await db.jobRun.deleteMany({ where: { job: 'alert_rule_evaluation' } });

  await db.activity.deleteMany({ where: { employeeId: emp.id } });
  await db.alertRuleFiring.deleteMany({ where: { ruleId: rule.id } });
  await db.alert.deleteMany({ where: { organizationId: orgA.id } });
  await db.notification.deleteMany({ where: { organizationId: orgA.id } });
  await db.alertRule.delete({ where: { id: rule.id } });
});

// ==================== Admin CRUD ====================

test('AR-20: RBAC — anon 401, viewer 403, manager/admin can create+list', async () => {
  const postRoute = (await import('../src/app/api/alert-rules/route')).POST;
  const getRoute = (await import('../src/app/api/alert-rules/route')).GET;
  const payload = { name: 'Offline check', conditionType: 'device_offline', params: { thresholdMinutes: 15 }, severity: 'warning', cooldownMinutes: 60, enabled: true };

  const anon = await postRoute(req('http://x/api/alert-rules', { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } }));
  assert.equal(anon.status, 401);

  const viewer = await postRoute(req('http://x/api/alert-rules', { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json', ...authHeader(viewerAToken) } }));
  assert.equal(viewer.status, 403);

  const created = await postRoute(req('http://x/api/alert-rules', { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json', ...authHeader(adminAToken) } }));
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.equal(body.data.organizationId, orgA.id);
  assert.equal(body.data.name, 'Offline check');
  assert.deepEqual(body.data.params, { thresholdMinutes: 15 });

  const list = await getRoute(req('http://x/api/alert-rules', { headers: authHeader(adminAToken) }));
  assert.equal(list.status, 200);
  const listBody = await list.json();
  assert.ok(listBody.data.some((r: { id: string }) => r.id === body.data.id));
  assert.equal(typeof listBody.data[0].firingCount, 'number');
  assert.ok('lastFiredAt' in listBody.data[0]);

  await db.alertRule.delete({ where: { id: body.data.id } });
});

test('AR-21: tenant isolation — org B cannot see or touch org A rules', async () => {
  const getRoute = (await import('../src/app/api/alert-rules/route')).GET;
  const patchRoute = (await import('../src/app/api/alert-rules/[id]/route')).PATCH;
  const deleteRoute = (await import('../src/app/api/alert-rules/[id]/route')).DELETE;

  const ruleA = await createRule(orgA.id, { name: 'A-secret-rule', conditionType: 'excessive_idle', params: { thresholdMinutes: 5 } });
  const ruleB = await createRule(orgB.id, { name: 'B-rule', conditionType: 'device_offline', params: { thresholdMinutes: 15 } });

  const listB = await getRoute(req('http://x/api/alert-rules', { headers: authHeader(managerBToken) }));
  const listBJson = await listB.json();
  assert.ok(!listBJson.data.some((r: { id: string }) => r.id === ruleA.id), 'org B never sees org A rules');
  assert.ok(listBJson.data.some((r: { id: string }) => r.id === ruleB.id));

  const patchB = await patchRoute(
    req('http://x/api/alert-rules/x', { method: 'PATCH', body: JSON.stringify({ name: 'hijack', conditionType: 'device_offline', params: { thresholdMinutes: 15 }, severity: 'warning', cooldownMinutes: 60, enabled: true }), headers: { 'content-type': 'application/json', ...authHeader(managerBToken) } }),
    { params: Promise.resolve({ id: ruleA.id }) }
  );
  assert.equal(patchB.status, 404, 'cross-org id concealed');

  const delB = await deleteRoute(req('http://x/api/alert-rules/x', { method: 'DELETE', headers: authHeader(managerBToken) }), { params: Promise.resolve({ id: ruleA.id }) });
  assert.equal(delB.status, 404);

  const still = await db.alertRule.findUnique({ where: { id: ruleA.id } });
  assert.ok(still && still.name === 'A-secret-rule');

  await db.alertRule.deleteMany({ where: { id: { in: [ruleA.id, ruleB.id] } } });
});

test('AR-22: validation — malformed payloads rejected with 422, never coerced', async () => {
  const postRoute = (await import('../src/app/api/alert-rules/route')).POST;
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ name: '', conditionType: 'device_offline', params: { thresholdMinutes: 15 }, severity: 'warning', cooldownMinutes: 60 }, 'name empty'],
    [{ name: 'x', conditionType: 'wat', params: { thresholdMinutes: 15 }, severity: 'warning', cooldownMinutes: 60 }, 'conditionType'],
    [{ name: 'x', conditionType: 'device_offline', params: { thresholdMinutes: 2 }, severity: 'warning', cooldownMinutes: 60 }, 'threshold below min'],
    [{ name: 'x', conditionType: 'device_offline', params: { thresholdMinutes: 999999 }, severity: 'warning', cooldownMinutes: 60 }, 'threshold above max'],
    [{ name: 'x', conditionType: 'device_offline', params: { thresholdMinutes: 15.5 }, severity: 'warning', cooldownMinutes: 60 }, 'non-integer threshold'],
    [{ name: 'x', conditionType: 'device_offline', params: { thresholdMinutes: 15, sneaky: 1 }, severity: 'warning', cooldownMinutes: 60 }, 'unknown param key'],
    [{ name: 'x', conditionType: 'device_offline', params: { thresholdMinutes: 15 }, severity: 'catastrophic', cooldownMinutes: 60 }, 'bad severity'],
    [{ name: 'x', conditionType: 'device_offline', params: { thresholdMinutes: 15 }, severity: 'warning', cooldownMinutes: 2 }, 'cooldown below min'],
    [{ name: 'x', conditionType: 'device_offline', params: { thresholdMinutes: 15 }, severity: 'warning', cooldownMinutes: 9999999 }, 'cooldown above max'],
    [{ name: 'x'.repeat(200), conditionType: 'device_offline', params: { thresholdMinutes: 15 }, severity: 'warning', cooldownMinutes: 60 }, 'name too long'],
    [{ conditionType: 'device_offline', params: { thresholdMinutes: 15 }, severity: 'warning', cooldownMinutes: 60 }, 'name missing'],
    [{ name: 'x', conditionType: 'device_offline', params: null, severity: 'warning', cooldownMinutes: 60 }, 'params missing'],
  ];
  for (const [payload, expected] of cases) {
    const res = await postRoute(req('http://x/api/alert-rules', { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json', ...authHeader(adminAToken) } }));
    assert.equal(res.status, 422, `expected 422 for ${expected}`);
  }
});

test('AR-23: rule count is bounded per org (422 at the cap)', async () => {
  const postRoute = (await import('../src/app/api/alert-rules/route')).POST;
  const { MAX_RULES_PER_ORG } = await import('../src/lib/alerts/conditions');
  // Seed exactly at the cap in org B (org A may carry leftover rules from
  // other tests — never assume a count).
  const existing = await db.alertRule.count({ where: { organizationId: orgB.id } });
  const toCreate = Math.max(0, MAX_RULES_PER_ORG - existing);
  for (let i = 0; i < toCreate; i++) {
    await db.alertRule.create({
      data: { organizationId: orgB.id, name: `cap-${i}`, conditionType: 'device_offline', params: '{"thresholdMinutes":15}', severity: 'warning', cooldownMinutes: 60 },
    });
  }
  const res = await postRoute(req('http://x/api/alert-rules', { method: 'POST', body: JSON.stringify({ name: 'one-too-many', conditionType: 'device_offline', params: { thresholdMinutes: 15 }, severity: 'warning', cooldownMinutes: 60 }), headers: { 'content-type': 'application/json', ...authHeader(managerBToken) } }));
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.match(body.error, /Maximum of/);
  await db.alertRule.deleteMany({ where: { organizationId: orgB.id } });
});

test('AR-24: update + delete mutate only the target org rule; delete removes firing state', async () => {
  const patchRoute = (await import('../src/app/api/alert-rules/[id]/route')).PATCH;
  const deleteRoute = (await import('../src/app/api/alert-rules/[id]/route')).DELETE;

  const rule = await createRule(orgA.id, { name: 'tmp', conditionType: 'excessive_idle', params: { thresholdMinutes: 5 }, severity: 'info' });
  const patched = await patchRoute(
    req('http://x/api/alert-rules/x', { method: 'PATCH', body: JSON.stringify({ name: 'renamed', conditionType: 'excessive_unproductive', params: { thresholdMinutes: 30 }, severity: 'critical', cooldownMinutes: 120, enabled: false }), headers: { 'content-type': 'application/json', ...authHeader(adminAToken) } }),
    { params: Promise.resolve({ id: rule.id }) }
  );
  assert.equal(patched.status, 200);
  const after = await db.alertRule.findUnique({ where: { id: rule.id } });
  assert.ok(after && after.name === 'renamed' && after.conditionType === 'excessive_unproductive' && after.severity === 'critical' && after.cooldownMinutes === 120 && after.enabled === false);
  assert.equal(JSON.parse(after.params).thresholdMinutes, 30);

  const del = await deleteRoute(req('http://x/api/alert-rules/x', { method: 'DELETE', headers: authHeader(adminAToken) }), { params: Promise.resolve({ id: rule.id }) });
  assert.equal(del.status, 200);
  assert.equal(await db.alertRule.findUnique({ where: { id: rule.id } }), null);
});

test('AR-25: GET list includes firing history derived from state rows', async () => {
  const { evaluateAlertRulesForOrg } = await import('../src/lib/jobs/alert-rules');
  const getRoute = (await import('../src/app/api/alert-rules/route')).GET;
  await setOrgFlag(orgA.id, 'alert_rules_enabled', 'true');

  const emp = await seedConsentedEmployee(orgA.id, 'history');
  const rule = await createRule(orgA.id, { name: 'History Idle', conditionType: 'excessive_idle', params: { thresholdMinutes: 5 } });
  await seedActivity(emp.id, [{ type: 'idle', category: 'idle', duration: 1800, hourOffset: 3 }]);
  await evaluateAlertRulesForOrg(orgA.id, new Date());

  const list = await getRoute(req('http://x/api/alert-rules', { headers: authHeader(adminAToken) }));
  const listBody = await list.json();
  const row = listBody.data.find((r: { id: string }) => r.id === rule.id);
  assert.ok(row, 'rule listed');
  assert.equal(row.firingCount, 1);
  assert.ok(row.lastFiredAt, 'last firing exposed');
  assert.equal(row.recentFirings.length, 1);
  assert.equal(row.recentFirings[0].entityType, 'employee');

  await db.activity.deleteMany({ where: { employeeId: emp.id } });
  await db.alertRuleFiring.deleteMany({ where: { ruleId: rule.id } });
  await db.alert.deleteMany({ where: { organizationId: orgA.id } });
  await db.notification.deleteMany({ where: { organizationId: orgA.id } });
  await db.alertRule.delete({ where: { id: rule.id } });
  await setOrgFlag(orgA.id, 'alert_rules_enabled', 'false');
});

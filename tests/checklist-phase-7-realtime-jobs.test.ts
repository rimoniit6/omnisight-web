/**
 * Smart Testing Checklist — PHASE 7: Realtime & Background Jobs.
 *
 * In-process tests for the live-updates mini-service's PURE modules and the
 * crash-safe background job infrastructure (JobRun leases):
 *   R-01  presence derivation (mini-services/live-updates/presence.ts):
 *         ONLINE from fresh heartbeat, transition-only events, offline sweep
 *   R-02  activity-ping payload privacy (activity-events.ts): only a NORMALIZED
 *         bare domain ever leaves for website rows; URLs are dropped
 *   R-03  poll cursor advance + durable SystemSetting-backed cursor store
 *   R-04  pg_notify channel contract + idempotent wake-up trigger creation
 *   J-01  JobRun lease: atomic claim, concurrent exclusion, finish, lapse reclaim
 *   J-02  expireConsents: granted+expired past -> expired + ConsentLog; future
 *         untouched; idempotent
 *   J-03  sweepExpiredAgentCredentials deletes ONLY expired rows
 *   J-04  runProjectTimeSyncJob lease guard (no-op while held, completes when free)
 *
 * Pure realtime modules are imported from mini-services/live-updates/* — the
 * server entrypoint (index.ts / a WebSocket listener) is deliberately NOT
 * imported. Runs against a THROWAWAY PostgreSQL database
 * (workai_test_checklist_phase7).
 * Run: npx tsx --test tests/checklist-phase-7-realtime-jobs.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_checklist_phase7';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-checklist-p7-0123456789abcdef';
// Presence threshold module constant is read at IMPORT time — set before.
process.env.PRESENCE_ONLINE_THRESHOLD_MS = '60000';

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
let warmPresenceMap: any;
let derivePresenceEvents: any;
let LIFECYCLE_PINNED_STATUSES: readonly string[];
let isBareDomain: (v: string | null | undefined) => boolean;
let buildActivityPing: any;
let nextPollCursor: any;
let loadPersistedCursor: any;
let persistCursor: any;
let CURSOR_SETTING_KEY: string;
let NOTIFY_CHANNEL: string;
let BROADCAST_TABLES: readonly string[];
let triggerNameFor: (t: string) => string;
let ensureNotifyTriggers: any;
let claimJob: (job: string) => Promise<boolean>;
let finishJob: (job: string, error?: string, lastResult?: Record<string, unknown> | null) => Promise<void>;
let runProjectTimeSyncJob: () => Promise<Record<string, unknown>>;
let expireConsents: (limit?: number) => Promise<number>;
let sweepExpiredAgentCredentials: () => Promise<{ expiredAgentTokens: number; expiredAgentSessions: number }>;

before(async () => {
  db = (await import('../src/lib/db')).db;
  const presence = await import('../mini-services/live-updates/presence');
  warmPresenceMap = presence.warmPresenceMap;
  derivePresenceEvents = presence.derivePresenceEvents;
  LIFECYCLE_PINNED_STATUSES = presence.LIFECYCLE_PINNED_STATUSES;
  const activityEvents = await import('../mini-services/live-updates/activity-events');
  isBareDomain = activityEvents.isBareDomain;
  buildActivityPing = activityEvents.buildActivityPing;
  const pollCursor = await import('../mini-services/live-updates/poll-cursor');
  nextPollCursor = pollCursor.nextPollCursor;
  const cursorStore = await import('../mini-services/live-updates/cursor-store');
  loadPersistedCursor = cursorStore.loadPersistedCursor;
  persistCursor = cursorStore.persistCursor;
  CURSOR_SETTING_KEY = cursorStore.CURSOR_SETTING_KEY;
  const notify = await import('../mini-services/live-updates/notify-triggers');
  NOTIFY_CHANNEL = notify.NOTIFY_CHANNEL;
  BROADCAST_TABLES = notify.BROADCAST_TABLES;
  triggerNameFor = notify.triggerNameFor;
  ensureNotifyTriggers = notify.ensureNotifyTriggers;
  const jobs = await import('../src/lib/jobs/run');
  claimJob = jobs.claimJob;
  finishJob = jobs.finishJob;
  runProjectTimeSyncJob = jobs.runProjectTimeSyncJob;
  expireConsents = (await import('../src/lib/jobs/expire-consents')).expireConsents;
  sweepExpiredAgentCredentials = (await import('../src/lib/jobs/sweep-agent-tokens')).sweepExpiredAgentCredentials;
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

// ─── Fixtures ───────────────────────────────────────────────────────────────

let seq = 0;
async function seedOrg(slug: string): Promise<string> {
  const org = await db.organization.create({ data: { name: slug, slug: `${slug}-${++seq}` } });
  return org.id;
}

async function seedEmployee(orgId: string, email: string) {
  return db.employee.create({
    data: {
      employeeId: `p7-EMP-${++seq}-${email}`,
      firstName: 'Phase7',
      lastName: email,
      email: `p7-${email}@test.local`,
      organizationId: orgId,
      status: 'active',
      agentApproved: true,
    },
  });
}

// ─── R-01: presence derivation ──────────────────────────────────────────────

test('R-01: presence — ONLINE from fresh heartbeat, transition-only events, offline sweep', () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  const fresh = new Date('2026-09-10T11:59:30.000Z'); // 30s ago -> online (threshold 60s)
  const map = new Map();

  const devices = [
    { employeeId: 'e1', organizationId: 'org1', lastHeartbeat: fresh, employeeName: 'Ada Lovelace' },
    { employeeId: null, organizationId: 'org1', lastHeartbeat: fresh, employeeName: null },
  ];

  const events = derivePresenceEvents(map, devices, now);
  assert.equal(events.length, 1, 'device without employeeId is ignored');
  assert.equal(events[0].employeeId, 'e1');
  assert.equal(events[0].online, true);
  assert.equal(events[0].employeeName, 'Ada Lovelace');
  assert.equal(events[0].lastSeenAt, fresh.toISOString());
  assert.equal(events[0].organizationId, 'org1');
  assert.equal(events[0].timestamp, now.toISOString());

  // A fresh heartbeat on an already-online employee is NOT an event (no spam).
  const heartbeatsAgain = derivePresenceEvents(map, devices, new Date(now.getTime() + 10_000));
  assert.equal(heartbeatsAgain.length, 0, 'same-state heartbeat must not emit');

  // Stale heartbeat with no new device row -> OFFLINE sweep transition.
  const staleNow = new Date(now.getTime() + 5 * 60_000);
  const swept = derivePresenceEvents(map, [], staleNow);
  assert.equal(swept.length, 1);
  assert.equal(swept[0].employeeId, 'e1');
  assert.equal(swept[0].online, false);
  assert.equal(swept[0].lastSeenAt, fresh.toISOString(), 'sweep keeps the newest observed heartbeat');

  const lifecycle = [...LIFECYCLE_PINNED_STATUSES];
  assert.deepEqual(lifecycle.sort(), ['inactive', 'maintenance', 'retired']);

  // warmPresenceMap seeds WITHOUT emitting.
  const warm = new Map();
  warmPresenceMap(warm, devices, now);
  assert.equal(warm.size, 1);
  assert.equal(warm.get('e1').online, true);
});

// ─── R-02: activity-ping payload privacy ────────────────────────────────────

test('R-02: activity-ping — only a bare domain may reach the wire for websites', () => {
  assert.equal(isBareDomain('github.com'), true);
  assert.equal(isBareDomain('sub.domain.example.co'), true);
  assert.equal(isBareDomain('github.com/path'), false);
  assert.equal(isBareDomain('https://github.com'), false);
  assert.equal(isBareDomain('user@example.com'), false);
  assert.equal(isBareDomain('example.com:443'), false);
  assert.equal(isBareDomain('UPPER.com'), false);
  assert.equal(isBareDomain(''), false);
  assert.equal(isBareDomain(null), false);

  const employee = { id: 'e1', firstName: 'Grace', lastName: 'Hopper', departmentId: 'd1' };

  const app = buildActivityPing(
    { id: 'a1', type: 'application', title: 'VS Code', applicationName: 'VS Code', url: 'https://github.com/a/b?q=1#frag', category: 'productive', duration: 120, createdAt: new Date('2026-09-10T12:00:00.000Z') },
    employee,
    'Engineering'
  );
  assert.equal(app.activityUrl, null, 'non-website rows never carry a URL');
  assert.equal(app.activityTitle, 'VS Code');
  assert.equal(app.department, 'Engineering');
  assert.equal(app.category, 'productive');

  const website = buildActivityPing(
    { id: 'a2', type: 'website', title: 'Docs', applicationName: null, url: 'GitHub.com', category: 'neutral', duration: 60, createdAt: new Date('2026-09-10T12:00:05.000Z') },
    employee,
    ''
  );
  assert.equal(website.activityUrl, 'github.com', 'lowered bare domain is safe to broadcast');
  assert.equal(website.department, 'Unassigned', 'empty department falls back');

  const rogueUrl = buildActivityPing(
    { id: 'a3', type: 'website', title: 'X', applicationName: null, url: 'https://evil.example/page', category: 'neutral', duration: 30, createdAt: new Date('2026-09-10T12:00:10.000Z') },
    employee,
    'Eng'
  );
  assert.equal(rogueUrl.activityUrl, null, 'a full URL is dropped, never leaked');

  const slashTrail = buildActivityPing(
    { id: 'a4', type: 'website', title: 'Y', applicationName: null, url: 'example.com/', category: 'neutral', duration: 30, createdAt: new Date('2026-09-10T12:00:15.000Z') },
    employee,
    'Eng'
  );
  assert.equal(slashTrail.activityUrl, null, 'trailing slash/query/fragment is rejected');
});

// ─── R-03: poll cursor + durable cursor store ───────────────────────────────

test('R-03: poll cursor advances to the newest processed row; cursor survives restarts', async () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  const newer = new Date('2026-09-10T12:00:30.000Z');
  const older = new Date('2026-09-10T11:59:50.000Z');

  assert.equal(nextPollCursor(now, [{ ts: newer }, { ts: older }]).getTime(), newer.getTime());
  assert.equal(nextPollCursor(now, []).getTime(), now.getTime(), 'never dips below now');
  assert.equal(nextPollCursor(now, [{ ts: older }]).getTime(), now.getTime());
  assert.equal(nextPollCursor(now, [{ ts: 'garbage' }]).getTime(), now.getTime(), 'non-timestamps are ignored');

  const fallback = new Date('2026-09-01T00:00:00.000Z');
  assert.equal((await loadPersistedCursor(db, () => fallback)).getTime(), fallback.getTime(), 'missing row -> fallback');

  const saved = new Date('2026-09-10T12:00:45.000Z');
  await persistCursor(db, saved);
  assert.equal(CURSOR_SETTING_KEY, 'live_updates.poll_cursor');
  assert.equal((await loadPersistedCursor(db, () => fallback)).getTime(), saved.getTime(), 'persisted cursor is restored');

  await db.systemSetting.upsert({
    where: { key: CURSOR_SETTING_KEY },
    create: { key: CURSOR_SETTING_KEY, value: 'corrupted-value' },
    update: { value: 'corrupted-value' },
  });
  assert.equal((await loadPersistedCursor(db, () => fallback)).getTime(), fallback.getTime(), 'corrupt value -> fallback');
});

// ─── R-04: notify channel + trigger contract ────────────────────────────────

test('R-04: pg_notify wake-up channel and idempotent triggers', async () => {
  assert.equal(NOTIFY_CHANNEL, 'omnisight_events');
  assert.ok(BROADCAST_TABLES.includes('Activity'));
  assert.ok(BROADCAST_TABLES.includes('Device'));
  assert.ok(BROADCAST_TABLES.includes('TimeEntry'));
  assert.equal(triggerNameFor('Activity'), 'omnisight_notify_activity');

  const first = await ensureNotifyTriggers(db);
  assert.equal(first.length, BROADCAST_TABLES.length, 'one trigger per broadcast table');
  const second = await ensureNotifyTriggers(db);
  assert.equal(second.length, BROADCAST_TABLES.length, 're-running converges on the same DDL');
});

// ─── J-01: JobRun lease lifecycle ───────────────────────────────────────────

test('J-01: job leases are atomic, exclusive, and lapsed leases are reclaimable', async () => {
  const job = 'sc_test_lease';

  assert.equal(await claimJob(job), true, 'first claim wins');
  const row = await db.jobRun.findUniqueOrThrow({ where: { job } });
  assert.equal(row.status, 'running');
  assert.ok(row.leaseExpiresAt && row.leaseExpiresAt.getTime() > Date.now(), 'lease is in the future');
  assert.equal(row.lastError, null);

  assert.equal(await claimJob(job), false, 'a running lease excludes concurrent workers');

  await finishJob(job, undefined, { batches: 3 });
  const done = await db.jobRun.findUniqueOrThrow({ where: { job } });
  assert.equal(done.status, 'completed');
  assert.equal(done.lastError, null);
  assert.equal(JSON.parse(done.lastResult ?? '{}').batches, 3);

  assert.equal(await claimJob(job), true, 'a completed job is claimable again');

  // Crash simulation: leave the row 'running' but expire the lease.
  await db.jobRun.update({ where: { job }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
  assert.equal(await claimJob(job), true, 'a lapsed lease is reclaimable');

  await finishJob(job, 'boom');
  const failed = await db.jobRun.findUniqueOrThrow({ where: { job } });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.lastError, 'boom');
});

// ─── J-02: consent expiration processor ─────────────────────────────────────

test('J-02: expireConsents flips only lapsed granted rows and writes the audit trail', async () => {
  const orgId = await seedOrg('p7-consents');
  const emp = await seedEmployee(orgId, 'c1');

  const expired = await db.consent.create({
    data: { employeeId: emp.id, consentType: 'location', status: 'granted', grantedAt: new Date('2026-09-01T00:00:00.000Z'), expiresAt: new Date('2026-09-05T00:00:00.000Z'), organizationId: orgId },
  });
  const future = await db.consent.create({
    data: { employeeId: emp.id, consentType: 'monitoring', status: 'granted', grantedAt: new Date('2026-09-01T00:00:00.000Z'), expiresAt: new Date('2999-01-01T00:00:00.000Z'), organizationId: orgId },
  });
  const never = await db.consent.create({
    data: { employeeId: emp.id, consentType: 'activity_tracking', status: 'granted', grantedAt: new Date('2026-09-01T00:00:00.000Z'), organizationId: orgId },
  });
  const alreadyDenied = await db.consent.create({
    data: { employeeId: emp.id, consentType: 'keystroke', status: 'denied', expiresAt: new Date('2026-09-05T00:00:00.000Z'), organizationId: orgId },
  });

  const count = await expireConsents();
  assert.equal(count, 1, 'only the granted + past-expiry row matches');

  const after = await db.consent.findUniqueOrThrow({ where: { id: expired.id } });
  assert.equal(after.status, 'expired');
  assert.ok(after.expiredAt, 'expiredAt stamped by the processor');

  assert.equal((await db.consent.findUniqueOrThrow({ where: { id: future.id } })).status, 'granted');
  assert.equal((await db.consent.findUniqueOrThrow({ where: { id: never.id } })).status, 'granted');
  assert.equal((await db.consent.findUniqueOrThrow({ where: { id: alreadyDenied.id } })).status, 'denied');

  const logs = await db.consentLog.findMany({ where: { consentId: expired.id } });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, 'expired');

  assert.equal(await expireConsents(), 0, 'idempotent — nothing left to expire');
});

// ─── J-03: expired agent credential sweep ───────────────────────────────────

test('J-03: sweepExpiredAgentCredentials deletes only expired rows', async () => {
  const orgId = await seedOrg('p7-tokens');
  const emp = await seedEmployee(orgId, 't1');
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + 3_600_000);

  await db.agentToken.create({ data: { token: `tok-expired-${++seq}`, employeeId: emp.id, organizationId: orgId, expiresAt: past } });
  await db.agentToken.create({ data: { token: `tok-valid-${++seq}`, employeeId: emp.id, organizationId: orgId, expiresAt: future } });
  await db.agentSession.create({ data: { token: `sess-expired-${++seq}`, employeeId: emp.id, organizationId: orgId, expiresAt: past } });
  await db.agentSession.create({ data: { token: `sess-valid-${++seq}`, employeeId: emp.id, organizationId: orgId, expiresAt: future } });

  const result = await sweepExpiredAgentCredentials();
  assert.equal(result.expiredAgentTokens, 1);
  assert.equal(result.expiredAgentSessions, 1);

  assert.equal(await db.agentToken.count({ where: { organizationId: orgId } }), 1, 'valid token survives');
  assert.equal(await db.agentSession.count({ where: { organizationId: orgId } }), 1, 'valid session survives');
});

// ─── J-04: lease-guarded project-time sync job ─────────────────────────────-

test('J-04: runProjectTimeSyncJob respects the shared JobRun lease', async () => {
  const held = await claimJob('project_time_sync');
  assert.equal(held, true);
  const noop = await runProjectTimeSyncJob();
  assert.equal((noop as { batches: number }).batches, 0, 'lease held elsewhere -> no-op round');
  assert.equal((noop as { initialized: boolean }).initialized, false);
  assert.equal((await db.jobRun.findUnique({ where: { job: 'project_time_sync' } }))?.status, 'running', 'held lease is not finished');

  await finishJob('project_time_sync');
  const run = await runProjectTimeSyncJob();
  assert.equal((run as { initialized: boolean }).initialized, true, 'free lease -> sync runs (cursor init on a fresh DB)');
  const row = await db.jobRun.findUniqueOrThrow({ where: { job: 'project_time_sync' } });
  assert.equal(row.status, 'completed');
  assert.equal(row.lastError, null);
  const parsed = JSON.parse(row.lastResult ?? '{}') as { initialized: boolean };
  assert.equal(parsed.initialized, true, 'lastResult carries the sync summary');
});
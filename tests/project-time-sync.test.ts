/**
 * Project Time Sync — automatic Activity → TimeEntry integration tests.
 *
 * Covers the full contract of the sync engine (src/lib/project-time/sync.ts):
 * attribution rules (single active membership only), consent gating, org
 * isolation, archived projects, idle exclusion, gap/duration semantics,
 * idempotency (cursor + unique keys), concurrent workers, manual-entry
 * preservation, and API-level manual/auto totals.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_project_time).
 * Run: npx tsx --test tests/project-time-sync.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation (must be set BEFORE any app module import) ──────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_project_time';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-project-time-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

before(() => {
  if (process.env.PROJECT_TIME_TEST_MIGRATED_DB !== '1') {
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

type SyncModule = typeof import('../src/lib/project-time/sync');
let runProjectTimeSync: SyncModule['runProjectTimeSync'];
type JobsModule = typeof import('../src/lib/jobs/run');
let runProjectTimeSyncJob: JobsModule['runProjectTimeSyncJob'];
type TimeEntriesApi = typeof import('../src/app/api/projects/[id]/time-entries/route');
type ProjectIdApi = typeof import('../src/app/api/projects/[id]/route');
let timeEntriesApi: TimeEntriesApi;
let projectIdApi: ProjectIdApi;

const OLD = new Date('2026-01-01T00:00:00.000Z'); // cursor start for every test

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  const [syncMod, jobsMod, pteApi, pIdApi] = await Promise.all([
    import('../src/lib/project-time/sync'),
    import('../src/lib/jobs/run'),
    import('../src/app/api/projects/[id]/time-entries/route'),
    import('../src/app/api/projects/[id]/route'),
  ]);
  runProjectTimeSync = syncMod.runProjectTimeSync;
  runProjectTimeSyncJob = jobsMod.runProjectTimeSyncJob;
  timeEntriesApi = pteApi;
  projectIdApi = pIdApi;
});

after(async () => {
  await db.$disconnect();
  if (process.env.PROJECT_TIME_TEST_MIGRATED_DB !== '1') {
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

function tokenFor(orgId: string, role = 'admin', userId = 'u-pts') {
  return signJWT({ userId, email: `${role}@${orgId.slice(-6)}.local`, role, organizationId: orgId });
}

/** Reset the global cursor so each test starts from a clean point. */
async function resetCursor(at = OLD) {
  await db.projectTimeSyncCursor.upsert({
    where: { id: 'global' },
    create: { id: 'global', lastProcessedAt: at },
    update: { lastProcessedAt: at },
  });
}

/** Full per-test isolation: clear rows the sync could pick up from earlier
 *  tests (activities, sync buckets, time entries, cursor), then reset. */
async function cleanSlate() {
  await db.activity.deleteMany({});
  await db.projectTimeSync.deleteMany({});
  await db.timeEntry.deleteMany({});
  await db.projectTimeSyncCursor.deleteMany({ where: { id: 'global' } });
  await resetCursor();
}

/** Grant activity_tracking consent tied to a published policy (required by
 *  hasActiveConsent/getConsentState — otherwise the sync fails closed). */
let policySeq = 1;
async function grantActivityConsent(orgId: string, employeeId: string) {
  const version = `v${policySeq}`;
  const policy = await db.consentPolicy.create({
    data: {
      organizationId: orgId,
      consentType: 'activity_tracking',
      title: `Activity Tracking Policy ${version}`,
      content: 'test',
      version,
      status: 'published',
      // effectiveAt makes the newest published policy deterministic
      // (getConsentState orders by effectiveAt desc).
      effectiveAt: new Date(Date.now() + policySeq * 1000),
    },
  });
  policySeq += 1;
  await db.consent.create({
    data: {
      employeeId,
      consentType: 'activity_tracking',
      status: 'granted',
      consentVersion: version,
      policyId: policy.id,
      organizationId: orgId,
    },
  });
  return policy;
}

async function seedOrg(slug: string) {
  return db.organization.create({ data: { name: slug, slug, timezone: 'UTC' } });
}

async function seedEmployee(orgId: string, code: string) {
  return db.employee.create({
    data: {
      employeeId: code,
      firstName: code.split('-')[0],
      lastName: 'Test',
      email: `${code.toLowerCase()}@test.local`,
      organizationId: orgId,
      status: 'active',
    },
  });
}

async function seedProject(orgId: string, name: string, extra: Record<string, unknown> = {}) {
  return db.project.create({ data: { name, organizationId: orgId, ...extra } });
}

/** One real application-activity row with agent-reported duration (seconds). */
async function seedActivity(employeeId: string, duration: number, createdAt: Date, type = 'application') {
  return db.activity.create({
    data: {
      type,
      duration,
      employeeId,
      timestamp: createdAt,
      createdAt,
      category: type === 'idle' ? 'idle' : 'neutral',
      applicationName: type === 'application' ? 'chrome.exe' : null,
    },
  });
}

async function autoEntriesFor(employeeId: string) {
  return db.timeEntry.findMany({
    where: { employeeId, source: 'ACTIVITY_AUTO' },
    orderBy: { createdAt: 'asc' },
  });
}

function hoursOf(seconds: number): number {
  return Math.round(seconds / 36) / 100;
}

// ─── 1. Single assignment → automatic project time ──────────────────────────

test('PTS-1: employee with one active membership — real activity produces project time', async () => {
  const org = await seedOrg('pts1-a');
  const emp = await seedEmployee(org.id, 'PTS-1');
  const proj = await seedProject(org.id, 'P1', { estimatedHours: 100 });
  await grantActivityConsent(org.id, emp.id);
  await db.projectMember.create({ data: { projectId: proj.id, employeeId: emp.id, organizationId: org.id } });
  await cleanSlate();

  const t0 = new Date('2026-02-01T10:00:00.000Z');
  await seedActivity(emp.id, 300, t0);
  await seedActivity(emp.id, 300, new Date(t0.getTime() + 60_000));
  await seedActivity(emp.id, 600, new Date(t0.getTime() + 120_000));

  const result = await runProjectTimeSync();
  assert.equal(result.initialized, false);
  assert.equal(result.activitiesAttributed, 3);
  assert.equal(result.skippedNoMembership, 0);
  assert.equal(result.secondsAttributed, 1200);

  const entries = await autoEntriesFor(emp.id);
  assert.equal(entries.length, 1, 'one aggregated auto entry per employee/project/day');
  assert.equal(entries[0].projectId, proj.id);
  assert.equal(entries[0].organizationId, org.id);
  assert.equal(entries[0].hours, hoursOf(1200), 'hours = sum of real durations');

  const syncRows = await db.projectTimeSync.findMany({ where: { employeeId: emp.id } });
  assert.equal(syncRows.length, 1);
  assert.equal(syncRows[0].seconds, 1200);
  assert.equal(syncRows[0].lastActivityAt?.getTime(), t0.getTime() + 120_000, 'lastActivityAt metadata preserved');
});

// ─── 2. Not assigned → no project time ──────────────────────────────────────

test('PTS-2: employee without any project membership gets NO project time', async () => {
  const org = await seedOrg('pts2-a');
  const emp = await seedEmployee(org.id, 'PTS-2');
  await grantActivityConsent(org.id, emp.id);
  await cleanSlate();
  await seedActivity(emp.id, 900, new Date('2026-02-02T10:00:00.000Z'));

  const result = await runProjectTimeSync();
  assert.equal(result.skippedNoMembership, 1);
  assert.equal(result.activitiesAttributed, 0);
  assert.equal((await autoEntriesFor(emp.id)).length, 0);
});

// ─── 3. Removed member (leftAt set) → future activity does not count ────────

test('PTS-3: membership ended (leftAt) — activity after removal is not counted', async () => {
  const org = await seedOrg('pts3-a');
  const emp = await seedEmployee(org.id, 'PTS-3');
  const proj = await seedProject(org.id, 'P3');
  await grantActivityConsent(org.id, emp.id);
  await resetCursor();
  // Membership ended yesterday.
  await db.projectMember.create({
    data: {
      projectId: proj.id,
      employeeId: emp.id,
      organizationId: org.id,
      leftAt: new Date('2026-02-01T00:00:00.000Z'),
    },
  });
  await cleanSlate();
  await seedActivity(emp.id, 7200, new Date('2026-02-02T10:00:00.000Z'));

  const result = await runProjectTimeSync();
  assert.equal(result.skippedNoMembership, 1, 'leftAt membership is not an active membership');
  assert.equal((await autoEntriesFor(emp.id)).length, 0);
});

// ─── 4. Multiple active memberships → NO ambiguous attribution ──────────────

test('PTS-4: two active memberships — activity is NEVER split or guessed', async () => {
  const org = await seedOrg('pts4-a');
  const emp = await seedEmployee(org.id, 'PTS-4');
  const projA = await seedProject(org.id, 'P4A');
  const projB = await seedProject(org.id, 'P4B');
  await grantActivityConsent(org.id, emp.id);
  await db.projectMember.create({ data: { projectId: projA.id, employeeId: emp.id, organizationId: org.id } });
  await db.projectMember.create({ data: { projectId: projB.id, employeeId: emp.id, organizationId: org.id } });
  await cleanSlate();
  await seedActivity(emp.id, 600, new Date('2026-02-03T10:00:00.000Z'));

  const result = await runProjectTimeSync();
  assert.equal(result.skippedAmbiguousMembership, 1);
  assert.equal(result.activitiesAttributed, 0);
  assert.equal((await autoEntriesFor(emp.id)).length, 0, 'no fabricated/split time');
  assert.equal(await db.timeEntry.count({ where: { employeeId: emp.id } }), 0);
});

// ─── 5 + 6. Duplicate activity / re-running sync → idempotent ───────────────

test('PTS-5: re-running the sync never double-counts (idempotent cursor)', async () => {
  const org = await seedOrg('pts5-a');
  const emp = await seedEmployee(org.id, 'PTS-5');
  const proj = await seedProject(org.id, 'P5');
  await grantActivityConsent(org.id, emp.id);
  await db.projectMember.create({ data: { projectId: proj.id, employeeId: emp.id, organizationId: org.id } });
  await cleanSlate();
  await seedActivity(emp.id, 300, new Date('2026-02-04T10:00:00.000Z'));

  const first = await runProjectTimeSync();
  assert.equal(first.activitiesAttributed, 1);
  assert.equal(first.secondsAttributed, 300);

  // Second + third runs: the same rows must not be re-absorbed.
  const second = await runProjectTimeSync();
  assert.equal(second.activitiesScanned, 0, 'no rows left after cursor advance');
  const third = await runProjectTimeSync();
  assert.equal(third.activitiesScanned, 0);

  const entries = await autoEntriesFor(emp.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].hours, hoursOf(300));
  const syncRow = await db.projectTimeSync.findFirst({ where: { employeeId: emp.id } });
  assert.equal(syncRow!.seconds, 300, 'seconds never double-accumulated');
});

// ─── 7 + 8. Manual entries preserved; manual + auto totals exact ────────────

test('PTS-6: manual TimeEntry untouched; project totals = manual + auto; API split correct', async () => {
  const org = await seedOrg('pts6-a');
  const emp = await seedEmployee(org.id, 'PTS-6');
  const proj = await seedProject(org.id, 'P6', { estimatedHours: 40 });
  await grantActivityConsent(org.id, emp.id);
  await db.projectMember.create({ data: { projectId: proj.id, employeeId: emp.id, organizationId: org.id } });
  await resetCursor();

  await cleanSlate();

  // Manual entry (admin route) FIRST — must survive the sync unchanged.
  const token = await tokenFor(org.id);
  const manual = await timeEntriesApi.POST(
    req(token, { method: 'POST', body: { employeeId: emp.id, date: '2026-02-05', hours: 5, category: 'development' } }),
    { params: Promise.resolve({ id: proj.id }) }
  );
  assert.equal(manual.status, 201);

  // Auto activity now.
  await seedActivity(emp.id, 1800, new Date('2026-02-05T10:00:00.000Z')); // 0.5h
  const sync = await runProjectTimeSync();
  assert.equal(sync.activitiesAttributed, 1);

  const manualRow = await db.timeEntry.findUnique({ where: { id: (await manual.json()).data.id } });
  assert.equal(manualRow!.source, 'MANUAL', 'manual source preserved');
  assert.equal(manualRow!.hours, 5, 'manual hours untouched');

  // API detail: totalHours = 5 + 0.5, manualHours = 5, autoHours = 0.5.
  const detail = await projectIdApi.GET(req(token), { params: Promise.resolve({ id: proj.id }) });
  const body = (await detail.json()).data;
  assert.equal(body.totalHours, 5.5);
  assert.equal(body.manualHours, 5);
  assert.equal(body.autoHours, 0.5);
  assert.equal(body.progress, Math.round((5.5 / 40) * 100), 'progress reflects auto hours too');

  // Time-entries aggregates expose the same split.
  const list = await timeEntriesApi.GET(req(token, { url: 'http://localhost:3000/api/projects/p6/time-entries?pageSize=50' }), {
    params: Promise.resolve({ id: proj.id }),
  });
  const agg = (await list.json()).aggregates;
  assert.equal(agg.totalHours, 5.5);
  assert.equal(agg.manualHours, 5);
  assert.equal(agg.autoHours, 0.5);
});

// ─── 9 + 10. Consent revoked → no time; restored → resumes ──────────────────

test('PTS-7: consent revoked blocks auto time; re-granted resumes (no backfill of denied period)', async () => {
  const org = await seedOrg('pts7-a');
  const emp = await seedEmployee(org.id, 'PTS-7');
  const proj = await seedProject(org.id, 'P7');
  await grantActivityConsent(org.id, emp.id);
  await db.projectMember.create({ data: { projectId: proj.id, employeeId: emp.id, organizationId: org.id } });

  // Revoke consent BEFORE the activity window.
  await db.consent.updateMany({
    where: { employeeId: emp.id, consentType: 'activity_tracking' },
    data: { status: 'revoked', revokedAt: new Date() },
  });
  await cleanSlate();
  await seedActivity(emp.id, 3600, new Date('2026-02-06T10:00:00.000Z'));

  const denied = await runProjectTimeSync();
  assert.equal(denied.skippedNoConsent, 1);
  assert.equal(denied.activitiesAttributed, 0);
  assert.equal((await autoEntriesFor(emp.id)).length, 0, 'no time while consent revoked');

  // Re-grant consent (Consent has a unique employee+type key — update the row).
  // The previously-denied activity is still past the cursor (skipped rows
  // advance the cursor), so it must NOT be backfilled.
  const newVersion = `v${policySeq}`;
  const newPolicy = await db.consentPolicy.create({
    data: {
      organizationId: org.id,
      consentType: 'activity_tracking',
      title: 'Activity Tracking Policy re-grant',
      content: 'test',
      version: newVersion,
      status: 'published',
      effectiveAt: new Date(Date.now() + policySeq * 1000),
    },
  });
  policySeq += 1;
  await db.consent.updateMany({
    where: { employeeId: emp.id, consentType: 'activity_tracking' },
    data: { status: 'granted', grantedAt: new Date(), revokedAt: null, expiresAt: null, policyId: newPolicy.id, consentVersion: newVersion },
  });
  const resume = await runProjectTimeSync();
  assert.equal(resume.activitiesScanned, 0, 'denied-period activity not backfilled after re-grant');
  assert.equal((await autoEntriesFor(emp.id)).length, 0);

  // NEW activity after re-grant IS tracked.
  await seedActivity(emp.id, 600, new Date('2026-02-07T10:00:00.000Z'));
  const after = await runProjectTimeSync();
  assert.equal(after.activitiesAttributed, 1);
  const entries = await autoEntriesFor(emp.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].hours, hoursOf(600));
});

// ─── 11. Cross-org blocked ──────────────────────────────────────────────────

test('PTS-8: activity from one org can never create time in another org project', async () => {
  const orgA = await seedOrg('pts8-a');
  const orgB = await seedOrg('pts8-b');
  const emp = await seedEmployee(orgA.id, 'PTS-8');
  const projB = await seedProject(orgB.id, 'P8B');
  await grantActivityConsent(orgA.id, emp.id);
  await resetCursor();
  // Simulate a corrupted/foreign membership: org A employee on org B project.
  await db.projectMember.create({ data: { projectId: projB.id, employeeId: emp.id, organizationId: orgB.id } });
  await cleanSlate();
  await seedActivity(emp.id, 3600, new Date('2026-02-08T10:00:00.000Z'));

  const result = await runProjectTimeSync();
  assert.equal(result.skippedOrgMismatch, 1, 'org mismatch must block attribution');
  assert.equal((await autoEntriesFor(emp.id)).length, 0);
  assert.equal(await db.timeEntry.count({ where: { projectId: projB.id } }), 0, 'Org B project received nothing');
});

// ─── 12. Archived project → no new automatic time ───────────────────────────

test('PTS-9: cancelled (archived) project receives no automatic time', async () => {
  const org = await seedOrg('pts9-a');
  const emp = await seedEmployee(org.id, 'PTS-9');
  const proj = await seedProject(org.id, 'P9', { status: 'cancelled' });
  await grantActivityConsent(org.id, emp.id);
  await db.projectMember.create({ data: { projectId: proj.id, employeeId: emp.id, organizationId: org.id } });
  await cleanSlate();
  await seedActivity(emp.id, 1800, new Date('2026-02-09T10:00:00.000Z'));

  const result = await runProjectTimeSync();
  assert.equal(result.skippedArchivedProject, 1);
  assert.equal((await autoEntriesFor(emp.id)).length, 0);
});

// ─── 13 + 14 + 15. Idle excluded; gaps/disconnect never inflate time ────────

test('PTS-10: idle rows excluded; large timestamp gaps never inflate working time', async () => {
  const org = await seedOrg('pts10-a');
  const emp = await seedEmployee(org.id, 'PTS-10');
  const proj = await seedProject(org.id, 'P10');
  await grantActivityConsent(org.id, emp.id);
  await db.projectMember.create({ data: { projectId: proj.id, employeeId: emp.id, organizationId: org.id } });
  await resetCursor();

  await cleanSlate();
  const t = new Date('2026-02-10T09:00:00.000Z');
  await seedActivity(emp.id, 60, t); // 1 minute
  await seedActivity(emp.id, 120, new Date(t.getTime() + 3 * 3600_000)); // 3h gap (disconnect)
  await seedActivity(emp.id, 60, new Date(t.getTime() + 8 * 3600_000)); // overnight gap
  await seedActivity(emp.id, 3600, new Date('2026-02-10T10:00:00.000Z'), 'idle'); // idle must not count

  const result = await runProjectTimeSync();
  assert.equal(result.activitiesAttributed, 3, 'only application/website rows');
  assert.equal(result.secondsAttributed, 60 + 120 + 60, 'duration sum only — gaps NOT counted');
  const entries = await autoEntriesFor(emp.id);
  assert.equal(entries[0].hours, hoursOf(240));
});

// ─── 16. Concurrent workers → no duplicate time ─────────────────────────────

test('PTS-11: concurrent sync workers produce exactly one entry (lease + idempotency)', async () => {
  const org = await seedOrg('pts11-a');
  const emp = await seedEmployee(org.id, 'PTS-11');
  const proj = await seedProject(org.id, 'P11');
  await grantActivityConsent(org.id, emp.id);
  await db.projectMember.create({ data: { projectId: proj.id, employeeId: emp.id, organizationId: org.id } });
  await cleanSlate();
  await seedActivity(emp.id, 240, new Date('2026-02-11T10:00:00.000Z'));

  const [a, b] = await Promise.all([
    runProjectTimeSyncJob(),
    runProjectTimeSyncJob(),
  ]);
  const attributed = (a.activitiesAttributed || 0) + (b.activitiesAttributed || 0);
  assert.equal(attributed, 1, 'exactly one worker processed the batch (lease)');

  const entries = await autoEntriesFor(emp.id);
  assert.equal(entries.length, 1, 'no duplicate entries');
  assert.equal(entries[0].hours, hoursOf(240), 'no double-counted time');
});

// ─── Backfill default: first-ever run initializes, converts nothing ─────────

test('PTS-12: first ever run initializes the cursor and performs NO backfill', async () => {
  const org = await seedOrg('pts12-a');
  const emp = await seedEmployee(org.id, 'PTS-12');
  const proj = await seedProject(org.id, 'P12');
  await grantActivityConsent(org.id, emp.id);
  await db.projectMember.create({ data: { projectId: proj.id, employeeId: emp.id, organizationId: org.id } });
  await cleanSlate();
  // NO cursor row — fresh install.
  await db.projectTimeSyncCursor.deleteMany({ where: { id: 'global' } });
  await seedActivity(emp.id, 7200, new Date('2026-02-12T10:00:00.000Z'));

  const result = await runProjectTimeSync();
  assert.equal(result.initialized, true, 'first run only initializes');
  assert.equal(result.activitiesAttributed, 0);
  assert.equal((await autoEntriesFor(emp.id)).length, 0, 'historical activity never backfilled');
  const cursor = await db.projectTimeSyncCursor.findUnique({ where: { id: 'global' } });
  assert.ok(cursor && cursor.lastProcessedAt.getTime() > Date.now() - 60_000, 'cursor initialized to now');
});

// ─── Invalid duration defensive guard ───────────────────────────────────────

test('PTS-13: impossible duration (0 / negative / >24h) is skipped, never invented', async () => {
  const org = await seedOrg('pts13-a');
  const emp = await seedEmployee(org.id, 'PTS-13');
  const proj = await seedProject(org.id, 'P13');
  await grantActivityConsent(org.id, emp.id);
  await db.projectMember.create({ data: { projectId: proj.id, employeeId: emp.id, organizationId: org.id } });
  await cleanSlate();
  await seedActivity(emp.id, 0, new Date('2026-02-13T10:00:00.000Z'));
  await seedActivity(emp.id, 90_000, new Date('2026-02-13T10:01:00.000Z')); // > 24h

  const result = await runProjectTimeSync();
  assert.equal(result.skippedInvalidDuration, 2);
  assert.equal(result.activitiesAttributed, 0);
  assert.equal((await autoEntriesFor(emp.id)).length, 0);
});

/**
 * Smart Testing Checklist — PHASE 6: Projects, Teams & Automatic Project Time.
 *
 * In-process server tests for the projects API (admin create/list, members
 * with active-tracking enrichment) and the Activity → TimeEntry auto-sync
 * engine (src/lib/project-time/sync.ts):
 *   P-01  projects: admin create, list stats, duplicate-name 409, validation
 *   P-02  members: add, duplicate 409, cross-org 422, active-tracking enrich
 *   S-01  sync: first run only initializes cursor (no backfill), then real
 *         activity is attributed to (employee, project, org-local day),
 *         idempotent re-runs, per-day buckets
 *   S-02  sync: no-guessing attribution — explicit active project wins,
 *         ambiguous membership skipped, no consent skipped, inactive employee
 *         skipped, cancelled project skipped, stale selection skipped
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_checklist_phase6).
 * Run: npx tsx --test tests/checklist-phase-6-projects-autosync.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_checklist_phase6';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-checklist-p6-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

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
let signJWT: (p: Record<string, unknown>) => Promise<string>;
let runProjectTimeSync: any;
let secondsToHours: (s: number) => number;
let projectsApi: typeof import('../src/app/api/projects/route');
let membersApi: typeof import('../src/app/api/projects/[id]/members/route');

/** Monotonic ingestion clock — createdAt must be STRICTLY increasing across
 *  the whole suite so the cursor `gt` comparisons are deterministic. */
const INIT_NOW = new Date('2026-09-01T00:00:00.000Z');
let ingestSeq = 0;
function ingestAt(): Date {
  return new Date(INIT_NOW.getTime() + ++ingestSeq * 1000);
}

before(async () => {
  db = (await import('../src/lib/db')).db;
  const auth = await import('../src/lib/auth');
  signJWT = (p) => auth.signJWT(p as any);
  const sync = await import('../src/lib/project-time/sync');
  runProjectTimeSync = sync.runProjectTimeSync;
  secondsToHours = sync.secondsToHours;
  projectsApi = await import('../src/app/api/projects/route');
  membersApi = await import('../src/app/api/projects/[id]/members/route');
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

async function seedOrg(slug: string, opts: { timezone?: string } = {}): Promise<string> {
  const org = await db.organization.create({
    data: {
      name: slug,
      slug,
      ...(opts.timezone ? { timezone: opts.timezone } : {}),
    },
  });
  return org.id;
}

/** Org-bound admin: AppUser + ACTIVE membership + bare (sessionless) JWT. */
async function seedAdmin(orgId: string, slug: string) {
  const email = `admin-${slug.toLowerCase()}@test.local`;
  const user = await db.appUser.create({
    data: { email, name: `Admin ${slug}`, password: 'n/a', role: 'admin', organizationId: orgId },
  });
  await db.organizationMembership.create({
    data: { userId: user.id, organizationId: orgId, role: 'admin', status: 'ACTIVE' },
  });
  const token = await signJWT({ userId: user.id, email, role: 'admin', organizationId: orgId });
  return { user, token };
}

async function seedEmployee(orgId: string, slug: string, idx: number, opts: { status?: string; activeTrackingProjectId?: string | null } = {}) {
  return db.employee.create({
    data: {
      employeeId: `${slug}-EMP-${String(idx).padStart(3, '0')}`,
      firstName: slug,
      lastName: String(idx),
      email: `${slug.toLowerCase()}-emp${idx}@test.local`,
      organizationId: orgId,
      status: opts.status ?? 'active',
      agentApproved: true,
      activeTrackingProjectId: opts.activeTrackingProjectId ?? null,
    },
  });
}

/** Publish an activity_tracking policy and grant it for an employee. */
async function grantActivityTracking(employeeId: string, organizationId: string) {
  const policy = await db.consentPolicy.upsert({
    where: { organizationId_consentType_version: { organizationId, consentType: 'activity_tracking', version: 'v1' } },
    create: {
      organizationId, consentType: 'activity_tracking', title: 'activity v1',
      content: 'consent', status: 'published', version: 'v1', effectiveAt: new Date(),
    },
    update: {},
  });
  await db.consent.upsert({
    where: { employeeId_consentType: { employeeId, consentType: 'activity_tracking' } },
    create: {
      employeeId, consentType: 'activity_tracking', status: 'granted', grantedAt: new Date(),
      consentVersion: 'v1', policyId: policy.id, organizationId,
    },
    update: { status: 'granted', grantedAt: new Date(), consentVersion: 'v1', policyId: policy.id },
  });
}

function memberUrl(projectId: string): string {
  return `http://localhost/api/projects/${projectId}/members`;
}

// ─── P-01: projects admin API ───────────────────────────────────────────────

test('P-01: projects — admin create, duplicate rejection, validation, list stats', async () => {
  const orgId = await seedOrg('p6-projects');
  const { token } = await seedAdmin(orgId, 'p6-projects');

  const listUrl = (q = '') => `http://localhost/api/projects${q}`;
  const empty = await projectsApi.GET(new NextRequest(listUrl(), {
    headers: { authorization: `Bearer ${token}` },
  }));
  const emptyBody = (await empty.json()) as { data: unknown[]; total: number; stats: { totalHours: number; totalProjects: number } };
  assert.equal(empty.status, 200);
  assert.equal(emptyBody.total, 0);
  assert.equal(emptyBody.stats.totalHours, 0);
  assert.equal(emptyBody.stats.totalProjects, 0);

  const created = await projectsApi.POST(new NextRequest('http://localhost/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: '  Alpha Website  ', description: 'v1', priority: 'high',
      startDate: '2026-09-01', deadline: '2026-12-31',
      estimatedHours: 40, budgetType: 'hourly', hourlyRate: 25,
    }),
  }));
  const createdBody = (await created.json()) as { data: { id: string; name: string; status: string; priority: string; budgetType: string | null } };
  assert.equal(created.status, 201, JSON.stringify(createdBody));
  assert.equal(createdBody.data.name, 'Alpha Website', 'name must be trimmed');
  assert.equal(createdBody.data.status, 'active');
  assert.equal(createdBody.data.priority, 'high');
  assert.equal(createdBody.data.budgetType, 'hourly');

  const dup = await projectsApi.POST(new NextRequest('http://localhost/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'alpha website' }),
  }));
  assert.equal(dup.status, 409);
  assert.match((await dup.json()).error ?? '', /already exists/);

  const badPriority = await projectsApi.POST(new NextRequest('http://localhost/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'X', priority: 'urgent' }),
  }));
  assert.equal(badPriority.status, 422);
  assert.match((await badPriority.json()).error ?? '', /Invalid priority/);

  const invertedDates = await projectsApi.POST(new NextRequest('http://localhost/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'Y', startDate: '2026-12-31', deadline: '2026-09-01' }),
  }));
  assert.equal(invertedDates.status, 422);
  assert.match((await invertedDates.json()).error ?? '', /Start date must be on or before/);

  const badPaging = await projectsApi.GET(new NextRequest(listUrl('?pageSize=0'), {
    headers: { authorization: `Bearer ${token}` },
  }));
  assert.equal(badPaging.status, 422);
  assert.match((await badPaging.json()).error ?? '', /pageSize must be a positive integer/);

  const list = await projectsApi.GET(new NextRequest(listUrl(), {
    headers: { authorization: `Bearer ${token}` },
  }));
  const listBody = (await list.json()) as { total: number; stats: { totalProjects: number; activeProjects: number; byStatus: Record<string, number> } };
  assert.equal(list.status, 200);
  assert.equal(listBody.total, 1);
  assert.equal(listBody.stats.totalProjects, 1);
  assert.equal(listBody.stats.activeProjects, 1);
  assert.equal(listBody.stats.byStatus.active, 1);
});

// ─── P-02: project members ──────────────────────────────────────────────────

test('P-02: members — add, conflict, cross-org rejection, active-tracking enrichment', async () => {
  const orgId = await seedOrg('p6-members');
  const { token } = await seedAdmin(orgId, 'p6-members');
  const emp = await seedEmployee(orgId, 'p6-m', 1);
  const otherOrgId = await seedOrg('p6-foreign');
  const foreignEmp = await seedEmployee(otherOrgId, 'p6-f', 1);

  const project = await db.project.create({ data: { name: 'Site Relaunch', organizationId: orgId } });

  const empty = await membersApi.GET(new NextRequest(memberUrl(project.id), {
    headers: { authorization: `Bearer ${token}` },
  }), { params: { id: project.id } });
  assert.equal(empty.status, 200);
  assert.equal(((await empty.json()) as { total: number }).total, 0);

  const added = await membersApi.POST(new NextRequest(memberUrl(project.id), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ employeeId: emp.id, role: 'lead', hoursPerWeek: 20 }),
  }), { params: { id: project.id } });
  const addedBody = (await added.json()) as { data: { role: string; hoursPerWeek: number } };
  assert.equal(added.status, 201, JSON.stringify(addedBody));
  assert.equal(addedBody.data.role, 'lead');
  assert.equal(addedBody.data.hoursPerWeek, 20);

  const conflict = await membersApi.POST(new NextRequest(memberUrl(project.id), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ employeeId: emp.id }),
  }), { params: { id: project.id } });
  assert.equal(conflict.status, 409);
  assert.match((await conflict.json()).error ?? '', /already a member/);

  const crossOrg = await membersApi.POST(new NextRequest(memberUrl(project.id), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ employeeId: foreignEmp.id }),
  }), { params: { id: project.id } });
  assert.equal(crossOrg.status, 422);
  assert.match((await crossOrg.json()).error ?? '', /Employee not found/);

  const listed = await membersApi.GET(new NextRequest(memberUrl(project.id), {
    headers: { authorization: `Bearer ${token}` },
  }), { params: { id: project.id } });
  const listedBody = (await listed.json()) as {
    data: Array<{ role: string; activeTrackingProjectId: string | null; isActiveTracking: boolean }>;
  };
  assert.equal(listedBody.data.length, 1);
  assert.equal(listedBody.data[0].role, 'lead');
  assert.equal(listedBody.data[0].activeTrackingProjectId, null, 'no active tracking selection yet');
  assert.equal(listedBody.data[0].isActiveTracking, false);

  await db.employee.update({ where: { id: emp.id }, data: { activeTrackingProjectId: project.id } });
  const enriched = await membersApi.GET(new NextRequest(memberUrl(project.id), {
    headers: { authorization: `Bearer ${token}` },
  }), { params: { id: project.id } });
  const enrichedBody = (await enriched.json()) as {
    data: Array<{ activeTrackingProjectId: string | null; isActiveTracking: boolean }>;
  };
  assert.equal(enrichedBody.data[0].activeTrackingProjectId, project.id);
  assert.equal(enrichedBody.data[0].isActiveTracking, true, 'member GET reflects the admin selection');

  const notFound = await membersApi.POST(new NextRequest(memberUrl('cafe-babe-0000'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ employeeId: emp.id }),
  }), { params: { id: 'cafe-babe-0000' } });
  assert.equal(notFound.status, 404);
  assert.match((await notFound.json()).error ?? '', /Project not found/);
});

// ─── S-01: activity → time sync engine ─────────────────────────────────────

test('S-01: auto project time — no backfill, attribution, per-day bucket, idempotent', async () => {
  const orgId = await seedOrg('p6-sync', { timezone: 'UTC' });
  const emp = await seedEmployee(orgId, 'p6-sy', 1);
  const project = await db.project.create({ data: { name: 'Core App', organizationId: orgId } });
  await db.projectMember.create({
    data: { projectId: project.id, employeeId: emp.id, organizationId: orgId, role: 'member' },
  });
  await grantActivityTracking(emp.id, orgId);

  // Activity ingested BEFORE the cursor never gets backfilled: createdAt is
  // pinned strictly before INIT_NOW (the cursor the first run initializes to).
  await db.activity.create({
    data: {
      employeeId: emp.id, organizationId: orgId, type: 'application', title: 'Legacy',
      applicationName: 'Old IDE', duration: 9000, timestamp: new Date('2026-08-01T09:00:00.000Z'),
      createdAt: new Date(INIT_NOW.getTime() - 1000),
    },
  });

  const first = await runProjectTimeSync({ now: INIT_NOW });
  assert.equal(first.initialized, true, 'first-ever run only initializes the cursor');
  assert.equal(first.timeEntriesCreated, 0);
  assert.equal(first.activitiesAttributed, 0);

  // Real work TODAY (two events, same org-local day → ONE bucket).
  await db.activity.create({
    data: {
      employeeId: emp.id, organizationId: orgId, type: 'application', title: 'Coding',
      applicationName: 'VS Code', duration: 3600, timestamp: new Date('2026-09-10T10:00:00.000Z'),
      createdAt: ingestAt(),
    },
  });
  await db.activity.create({
    data: {
      employeeId: emp.id, organizationId: orgId, type: 'website', title: 'Docs', url: 'https://docs.example',
      duration: 1800, timestamp: new Date('2026-09-10T14:30:00.000Z'), createdAt: ingestAt(),
    },
  });

  const run = await runProjectTimeSync({ now: new Date(INIT_NOW.getTime() + 60_000) });
  assert.equal(run.initialized, false);
  assert.equal(run.batches, 1);
  assert.equal(run.activitiesScanned, 2);
  assert.equal(run.activitiesAttributed, 2);
  assert.equal(run.secondsAttributed, 5400);
  assert.equal(run.buckets, 1, 'two events on the same org-local day collapse into one bucket');
  assert.equal(run.timeEntriesCreated, 1);
  assert.equal(run.auditWritten, true);

  assert.equal(await db.activity.count({ where: { organizationId: orgId } }), 3, 'legacy + 2 new rows');

  const bucket = await db.projectTimeSync.findFirstOrThrow({ where: { organizationId: orgId } });
  assert.equal(bucket.seconds, 5400);
  assert.equal(bucket.projectId, project.id);
  assert.equal(bucket.employeeId, emp.id);
  assert.equal(bucket.date.toISOString(), '2026-09-10T00:00:00.000Z');

  const entry = await db.timeEntry.findFirstOrThrow({ where: { organizationId: orgId } });
  assert.equal(entry.source, 'ACTIVITY_AUTO');
  assert.equal(entry.projectId, project.id);
  assert.equal(entry.employeeId, emp.id);
  assert.equal(entry.hours, secondsToHours(5400));
  assert.equal(entry.billable, true);
  assert.equal(entry.category, null);
  assert.match(entry.description ?? '', /Automatically tracked/);

  // Idempotent re-run: nothing new, nothing rewritten.
  const rerun = await runProjectTimeSync({ now: new Date(INIT_NOW.getTime() + 120_000) });
  assert.equal(rerun.activitiesScanned, 0);
  assert.equal(rerun.timeEntriesCreated, 0);
  assert.equal(rerun.timeEntriesUpdated, 0);
  assert.equal(await db.timeEntry.count({ where: { organizationId: orgId } }), 1);

  // A NEW day creates a second bucket + auto entry.
  await db.activity.create({
    data: {
      employeeId: emp.id, organizationId: orgId, type: 'application', title: 'More coding',
      applicationName: 'VS Code', duration: 1200, timestamp: new Date('2026-09-11T11:00:00.000Z'),
      createdAt: ingestAt(),
    },
  });
  const day2 = await runProjectTimeSync({ now: new Date(INIT_NOW.getTime() + 180_000) });
  assert.equal(day2.buckets, 1);
  assert.equal(day2.timeEntriesCreated, 1);
  assert.equal(await db.timeEntry.count({ where: { organizationId: orgId } }), 2);
  assert.equal(await db.projectTimeSync.count({ where: { organizationId: orgId } }), 2);
});

// ─── S-02: attribution never guesses ────────────────────────────────────────

test('S-02: auto project time — no-guessing attribution rules', async () => {
  const orgId = await seedOrg('p6-rules', { timezone: 'UTC' });
  const p1 = await db.project.create({ data: { name: 'Digital', organizationId: orgId } });
  const p2 = await db.project.create({ data: { name: 'Analytics', organizationId: orgId } });
  const pX = await db.project.create({ data: { name: 'Archived', organizationId: orgId, status: 'cancelled' } });

  const empPrecedence = await seedEmployee(orgId, 'p6-r', 1, { activeTrackingProjectId: p2.id });
  const empAmbiguous = await seedEmployee(orgId, 'p6-r', 2);
  const empNoConsent = await seedEmployee(orgId, 'p6-r', 3);
  const empInactive = await seedEmployee(orgId, 'p6-r', 4, { status: 'inactive' });
  const empStale = await seedEmployee(orgId, 'p6-r', 5, { activeTrackingProjectId: p2.id });
  const empArchived = await seedEmployee(orgId, 'p6-r', 6, { activeTrackingProjectId: pX.id });

  const memberships: Array<[string, string]> = [
    [empPrecedence.id, p1.id], [empPrecedence.id, p2.id],
    [empAmbiguous.id, p1.id], [empAmbiguous.id, p2.id],
    [empNoConsent.id, p1.id],
    [empInactive.id, p1.id],
    [empStale.id, p1.id],           // explicit selection p2 but NOT a member of it
    [empArchived.id, pX.id],        // explicit selection on a CANCELLED project
  ];
  for (const [employeeId, projectId] of memberships) {
    await db.projectMember.create({ data: { projectId, employeeId, organizationId: orgId, role: 'member' } });
  }

  for (const emp of [empPrecedence, empAmbiguous, empInactive, empStale, empArchived]) {
    await grantActivityTracking(emp.id, orgId);
  }

  const activityFor = (empId: string) =>
    db.activity.create({
      data: {
        employeeId: empId, organizationId: orgId, type: 'application', title: 'Work',
        applicationName: 'App', duration: 120, timestamp: new Date('2026-09-10T09:00:00.000Z'),
        createdAt: ingestAt(),
      },
    });
  await activityFor(empPrecedence.id);
  await activityFor(empAmbiguous.id);
  await activityFor(empNoConsent.id);
  await activityFor(empInactive.id);
  await activityFor(empStale.id);
  await activityFor(empArchived.id);

  const run = await runProjectTimeSync({ now: new Date(INIT_NOW.getTime() + 240_000) });
  assert.equal(run.activitiesScanned, 6);
  assert.equal(run.activitiesAttributed, 1, 'only the explicit selection may attribute');
  assert.equal(run.skippedAmbiguousMembership, 1, 'two active memberships, no selection → skip');
  assert.equal(run.skippedNoConsent, 1);
  assert.equal(run.skippedEmployeeInactive, 1);
  assert.equal(run.skippedStaleActiveProject, 1, 'explicit selection not in active memberships → NEVER falls back');
  assert.equal(run.skippedArchivedProject, 1);
  assert.equal(run.buckets, 1);
  assert.equal(run.timeEntriesCreated, 1);

  const entries = await db.timeEntry.findMany({ where: { organizationId: orgId } });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].projectId, p2.id, 'explicit active project wins over multi-membership');

  const synced = await db.projectTimeSync.findMany({ where: { organizationId: orgId } });
  assert.equal(synced.length, 1);
  assert.equal(synced[0].projectId, p2.id);
});
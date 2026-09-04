/**
 * Admin-Controlled Active Tracking Project — integration tests.
 *
 * Covers the full contract of the feature:
 *  - PUT /api/employees/[id]/active-project (set / clear / switch, RBAC,
 *    org scoping, membership + leftAt + cancelled checks, audit logging).
 *  - Sync attribution precedence (explicit active project beats ambiguous
 *    multi-membership; stale/invalid explicit selection NEVER guesses).
 *  - Stale handling: member removal and project archive clear the field.
 *  - Consent + employee-status guards at sync time; manual entries untouched.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_active_project).
 * Run: npx tsx --test tests/active-project.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { req } from './helpers/request';

// ─── Test DB isolation (must be set BEFORE any app module import) ──────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_active_project';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-active-project-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

before(() => {
  if (process.env.ACTIVE_PROJECT_TEST_MIGRATED_DB !== '1') {
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
type ActiveProjectApi = typeof import('../src/app/api/employees/[id]/active-project/route');
type MemberIdApi = typeof import('../src/app/api/projects/[id]/members/[memberId]/route');
type MembersApi = typeof import('../src/app/api/projects/[id]/members/route');
type EmployeeProjectsApi = typeof import('../src/app/api/employees/[id]/projects/route');
type ProjectIdApi = typeof import('../src/app/api/projects/[id]/route');
let activeProjectApi: ActiveProjectApi;
let memberIdApi: MemberIdApi;
let membersApi: MembersApi;
let employeeProjectsApi: EmployeeProjectsApi;
let projectIdApi: ProjectIdApi;

const OLD = new Date('2026-01-01T00:00:00.000Z'); // cursor start for every test

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  const [syncMod, apApi, miApi, msApi, epApi, pApi] = await Promise.all([
    import('../src/lib/project-time/sync'),
    import('../src/app/api/employees/[id]/active-project/route'),
    import('../src/app/api/projects/[id]/members/[memberId]/route'),
    import('../src/app/api/projects/[id]/members/route'),
    import('../src/app/api/employees/[id]/projects/route'),
    import('../src/app/api/projects/[id]/route'),
  ]);
  runProjectTimeSync = syncMod.runProjectTimeSync;
  activeProjectApi = apApi;
  memberIdApi = miApi;
  membersApi = msApi;
  employeeProjectsApi = epApi;
  projectIdApi = pApi;
});

after(async () => {
  await db.$disconnect();
  if (process.env.ACTIVE_PROJECT_TEST_MIGRATED_DB !== '1') {
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


function tokenFor(orgId: string, role = 'admin', userId = 'u-ap') {
  return signJWT({ userId, email: `${role}@${orgId.slice(-6)}.local`, role, organizationId: orgId });
}

async function resetCursor(at = OLD) {
  await db.projectTimeSyncCursor.upsert({
    where: { id: 'global' },
    create: { id: 'global', lastProcessedAt: at },
    update: { lastProcessedAt: at },
  });
}

async function cleanSlate() {
  await db.activity.deleteMany({});
  await db.projectTimeSync.deleteMany({});
  await db.timeEntry.deleteMany({});
  await db.projectTimeSyncCursor.deleteMany({ where: { id: 'global' } });
  await resetCursor();
}

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

async function seedEmployee(orgId: string, code: string, extra: Record<string, unknown> = {}) {
  return db.employee.create({
    data: {
      employeeId: code,
      firstName: code.split('-')[0],
      lastName: 'Test',
      email: `${code.toLowerCase()}@test.local`,
      organizationId: orgId,
      status: 'active',
      ...extra,
    },
  });
}

async function seedProject(orgId: string, name: string, extra: Record<string, unknown> = {}) {
  return db.project.create({ data: { name, organizationId: orgId, ...extra } });
}

async function seedActivity(employeeId: string, duration: number, createdAt: Date, type = 'application') {
  // Phase 1: Activity requires direct organizationId — resolve from the employee (same rule as the DB backfill).
  const emp = await db.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { organizationId: true } });
  return db.activity.create({
    data: {
      type,
      duration,
      employeeId,
      organizationId: emp.organizationId,
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

/** PUT /api/employees/[id]/active-project helper. */
async function setActive(token: string, employeeId: string, projectId: string | null, method = 'PUT') {
  return activeProjectApi.PUT(
    req(token, { method, body: { projectId } }),
    { params: Promise.resolve({ id: employeeId }) }
  );
}

/** Read an employee's current active tracking project id directly from DB. */
async function activeProjectIdOf(employeeId: string): Promise<string | null> {
  const e = await db.employee.findUnique({ where: { id: employeeId }, select: { activeTrackingProjectId: true } });
  return e?.activeTrackingProjectId ?? null;
}

// ────────────────────────────────────────────────────────────────────────────
// API — set / clear / switch / RBAC / org / membership validation
// ────────────────────────────────────────────────────────────────────────────

test('AP-1: admin sets active project — 200, persisted, audited SET', async () => {
  const org = await seedOrg('ap1-a');
  const emp = await seedEmployee(org.id, 'AP-1');
  const proj = await seedProject(org.id, 'AP1-P');
  await db.projectMember.create({ data: { projectId: proj.id, employeeId: emp.id, organizationId: org.id } });

  const res = await setActive(await tokenFor(org.id), emp.id, proj.id);
  assert.equal(res.status, 200);
  const body = (await res.json()).data;
  assert.equal(body.employeeId, emp.id);
  assert.equal(body.activeProject.id, proj.id);
  assert.equal(body.activeProject.name, proj.name);

  assert.equal(await activeProjectIdOf(emp.id), proj.id, 'persisted in DB');

  const audit = await db.auditLog.findFirst({
    where: { resource: 'employee_active_project', resourceId: emp.id },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(audit, 'audit row written');
  assert.equal(audit!.action, 'ACTIVE_TRACKING_PROJECT_SET');
  assert.equal(audit!.organizationId, org.id);
  const meta = JSON.parse(audit!.metadata || '{}');
  assert.equal(meta.employeeId, emp.id);
  assert.equal(meta.projectId, proj.id);
  assert.equal(meta.previousProjectId, null);
  assert.ok(meta.actorId, 'actor recorded');
});

test('AP-2: admin clears active project — 200, null, audited CLEARED', async () => {
  const org = await seedOrg('ap2-a');
  const emp = await seedEmployee(org.id, 'AP-2');
  const proj = await seedProject(org.id, 'AP2-P');
  await db.projectMember.create({ data: { projectId: proj.id, employeeId: emp.id, organizationId: org.id } });
  await setActive(await tokenFor(org.id), emp.id, proj.id);

  const res = await setActive(await tokenFor(org.id), emp.id, null);
  assert.equal(res.status, 200);
  const body = (await res.json()).data;
  assert.equal(body.activeProject, null);
  assert.equal(await activeProjectIdOf(emp.id), null, 'cleared in DB');

  const audit = await db.auditLog.findFirst({
    where: { resource: 'employee_active_project', resourceId: emp.id, action: 'ACTIVE_TRACKING_PROJECT_CLEARED' },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(audit, 'CLEARED audit row written');
  const meta = JSON.parse(audit!.metadata || '{}');
  assert.equal(meta.projectId, null);
  assert.equal(meta.previousProjectId, proj.id, 'previous value recorded');
});

test('AP-3: admin switches active project — CHANGED audit, only one active', async () => {
  const org = await seedOrg('ap3-a');
  const emp = await seedEmployee(org.id, 'AP-3');
  const projA = await seedProject(org.id, 'AP3-A');
  const projB = await seedProject(org.id, 'AP3-B');
  await db.projectMember.create({ data: { projectId: projA.id, employeeId: emp.id, organizationId: org.id } });
  await db.projectMember.create({ data: { projectId: projB.id, employeeId: emp.id, organizationId: org.id } });
  await setActive(await tokenFor(org.id), emp.id, projA.id);

  const res = await setActive(await tokenFor(org.id), emp.id, projB.id);
  assert.equal(res.status, 200);
  assert.equal(await activeProjectIdOf(emp.id), projB.id, 'switched');
  assert.equal(
    await db.employee.count({ where: { id: emp.id, activeTrackingProjectId: projA.id } }),
    0,
    'old project no longer active'
  );

  const audit = await db.auditLog.findFirst({
    where: { resource: 'employee_active_project', resourceId: emp.id, action: 'ACTIVE_TRACKING_PROJECT_CHANGED' },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(audit, 'CHANGED audit row written');
  const meta = JSON.parse(audit!.metadata || '{}');
  assert.equal(meta.projectId, projB.id);
  assert.equal(meta.previousProjectId, projA.id);
});

test('AP-4: non-admin cannot change the active project (403)', async () => {
  const org = await seedOrg('ap4-a');
  const emp = await seedEmployee(org.id, 'AP-4');
  const proj = await seedProject(org.id, 'AP4-P');
  await db.projectMember.create({ data: { projectId: proj.id, employeeId: emp.id, organizationId: org.id } });

  for (const role of ['manager', 'viewer']) {
    const res = await setActive(await tokenFor(org.id, role), emp.id, proj.id);
    assert.equal(res.status, 403, `${role} must be rejected`);
  }
  assert.equal(await activeProjectIdOf(emp.id), null, 'nothing persisted');
});

test('AP-5: cross-org project is rejected (404, never leaks)', async () => {
  const orgA = await seedOrg('ap5-a');
  const orgB = await seedOrg('ap5-b');
  const emp = await seedEmployee(orgA.id, 'AP-5');
  const projB = await seedProject(orgB.id, 'AP5-B');
  // Even a cross-org membership must not help.
  await db.projectMember.create({ data: { projectId: projB.id, employeeId: emp.id, organizationId: orgB.id } });

  const res = await setActive(await tokenFor(orgA.id), emp.id, projB.id);
  assert.equal(res.status, 404, 'cross-org project is concealed as not-found');
  assert.equal(await activeProjectIdOf(emp.id), null);
});

test('AP-6: employee not a member → 409; unknown employee → 404', async () => {
  const org = await seedOrg('ap6-a');
  const emp = await seedEmployee(org.id, 'AP-6');
  const proj = await seedProject(org.id, 'AP6-P');

  const notMember = await setActive(await tokenFor(org.id), emp.id, proj.id);
  assert.equal(notMember.status, 409, 'non-member rejected');
  assert.equal(await activeProjectIdOf(emp.id), null);

  const missing = await setActive(await tokenFor(org.id), 'does-not-exist', proj.id);
  assert.equal(missing.status, 404);
});

test('AP-7: soft-removed member (leftAt) → 409', async () => {
  const org = await seedOrg('ap7-a');
  const emp = await seedEmployee(org.id, 'AP-7');
  const proj = await seedProject(org.id, 'AP7-P');
  await db.projectMember.create({
    data: { projectId: proj.id, employeeId: emp.id, organizationId: org.id, leftAt: new Date() },
  });

  const res = await setActive(await tokenFor(org.id), emp.id, proj.id);
  assert.equal(res.status, 409);
  assert.equal(await activeProjectIdOf(emp.id), null);
});

test('AP-8: cancelled (archived) project → 409', async () => {
  const org = await seedOrg('ap8-a');
  const emp = await seedEmployee(org.id, 'AP-8');
  const proj = await seedProject(org.id, 'AP8-P', { status: 'cancelled' });
  await db.projectMember.create({ data: { projectId: proj.id, employeeId: emp.id, organizationId: org.id } });

  const res = await setActive(await tokenFor(org.id), emp.id, proj.id);
  assert.equal(res.status, 409);
  assert.equal(await activeProjectIdOf(emp.id), null);
});

test('AP-9: invalid payloads → 400', async () => {
  const org = await seedOrg('ap9-a');
  const emp = await seedEmployee(org.id, 'AP-9');
  const proj = await seedProject(org.id, 'AP9-P');
  await db.projectMember.create({ data: { projectId: proj.id, employeeId: emp.id, organizationId: org.id } });
  const token = await tokenFor(org.id);

  const invalidBodies: Array<{ body?: unknown }> = [
    { body: undefined }, // missing/malformed body
    { body: {} }, // missing projectId
    { body: { projectId: 42 } },
    { body: { projectId: '' } },
    { body: { projectId: '   ' } },
  ];
  for (const c of invalidBodies) {
    const res = await activeProjectApi.PUT(
      req(token, { method: 'PUT', body: c.body }),
      { params: Promise.resolve({ id: emp.id }) }
    );
    assert.equal(res.status, 400, `payload ${JSON.stringify(c.body)} rejected`);
  }
  assert.equal(await activeProjectIdOf(emp.id), null);
});

test('AP-10: idempotent re-set is a 200 no-op (no extra audit row)', async () => {
  const org = await seedOrg('ap10-a');
  const emp = await seedEmployee(org.id, 'AP-10');
  const proj = await seedProject(org.id, 'AP10-P');
  await db.projectMember.create({ data: { projectId: proj.id, employeeId: emp.id, organizationId: org.id } });
  const token = await tokenFor(org.id);
  await setActive(token, emp.id, proj.id);

  const res = await setActive(token, emp.id, proj.id);
  assert.equal(res.status, 200);
  const body = (await res.json()).data;
  assert.equal(body.activeProject.id, proj.id);

  const auditCount = await db.auditLog.count({
    where: { resource: 'employee_active_project', resourceId: emp.id, action: 'ACTIVE_TRACKING_PROJECT_SET' },
  });
  assert.equal(auditCount, 1, 'no duplicate audit for a no-op re-set');
});

// ────────────────────────────────────────────────────────────────────────────
// Members API exposes the active tracking state
// ────────────────────────────────────────────────────────────────────────────

test('AP-11: members GET exposes isActiveTracking per member', async () => {
  const org = await seedOrg('ap11-a');
  const emp = await seedEmployee(org.id, 'AP-11');
  const projA = await seedProject(org.id, 'AP11-A');
  const projB = await seedProject(org.id, 'AP11-B');
  await db.projectMember.create({ data: { projectId: projA.id, employeeId: emp.id, organizationId: org.id } });
  await db.projectMember.create({ data: { projectId: projB.id, employeeId: emp.id, organizationId: org.id } });
  await setActive(await tokenFor(org.id), emp.id, projA.id);

  const res = await membersApi.GET(req(await tokenFor(org.id), { url: `http://localhost:3000/api/projects/${projA.id}/members` }), {
    params: Promise.resolve({ id: projA.id }),
  });
  assert.equal(res.status, 200);
  const members = (await res.json()).data;
  const member = members.find((m: { employeeId: string }) => m.employeeId === emp.id);
  assert.ok(member, 'member present');
  assert.equal(member.isActiveTracking, true, 'projA is the active tracking project');
  assert.equal(member.activeTrackingProjectId, projA.id);

  const resB = await membersApi.GET(req(await tokenFor(org.id), { url: `http://localhost:3000/api/projects/${projB.id}/members` }), {
    params: Promise.resolve({ id: projB.id }),
  });
  const memberB = (await resB.json()).data.find((m: { employeeId: string }) => m.employeeId === emp.id);
  assert.equal(memberB.isActiveTracking, false, 'projB is assigned, not active');
});

// ────────────────────────────────────────────────────────────────────────────
// Stale handling — removal / archive clear the field
// ────────────────────────────────────────────────────────────────────────────

test('AP-12: removing the active ProjectMember clears the field (transaction)', async () => {
  const org = await seedOrg('ap12-a');
  const emp = await seedEmployee(org.id, 'AP-12');
  const proj = await seedProject(org.id, 'AP12-P');
  const member = await db.projectMember.create({ data: { projectId: proj.id, employeeId: emp.id, organizationId: org.id } });
  await setActive(await tokenFor(org.id), emp.id, proj.id);
  assert.equal(await activeProjectIdOf(emp.id), proj.id);

  const res = await memberIdApi.DELETE(req(await tokenFor(org.id), { method: 'DELETE' }), {
    params: Promise.resolve({ id: proj.id, memberId: member.id }),
  });
  assert.equal(res.status, 200);

  const empAfter = await db.employee.findUnique({ where: { id: emp.id }, select: { activeTrackingProjectId: true } });
  assert.equal(empAfter!.activeTrackingProjectId, null, 'active project cleared on removal');
  const memberAfter = await db.projectMember.findUnique({ where: { id: member.id } });
  assert.ok(memberAfter!.leftAt, 'membership soft-removed (leftAt set)');
});

test('AP-13: archiving the active project clears it for every employee', async () => {
  const org = await seedOrg('ap13-a');
  const emp1 = await seedEmployee(org.id, 'AP-13A');
  const emp2 = await seedEmployee(org.id, 'AP-13B');
  const proj = await seedProject(org.id, 'AP13-P');
  await db.projectMember.create({ data: { projectId: proj.id, employeeId: emp1.id, organizationId: org.id } });
  await db.projectMember.create({ data: { projectId: proj.id, employeeId: emp2.id, organizationId: org.id } });
  const token = await tokenFor(org.id);
  await setActive(token, emp1.id, proj.id);
  await setActive(token, emp2.id, proj.id);
  assert.equal(await activeProjectIdOf(emp1.id), proj.id);
  assert.equal(await activeProjectIdOf(emp2.id), proj.id);

  const res = await projectIdApi.DELETE(req(token, { method: 'DELETE' }), { params: Promise.resolve({ id: proj.id }) });
  assert.equal(res.status, 200);

  assert.equal(await activeProjectIdOf(emp1.id), null, 'emp1 cleared on archive');
  assert.equal(await activeProjectIdOf(emp2.id), null, 'emp2 cleared on archive');
  const project = await db.project.findUnique({ where: { id: proj.id } });
  assert.equal(project!.status, 'cancelled');
});

test('AP-14: employee assignment replacement removes membership AND clears active project', async () => {
  const org = await seedOrg('ap14-a');
  const emp = await seedEmployee(org.id, 'AP-14');
  const projA = await seedProject(org.id, 'AP14-A');
  const projB = await seedProject(org.id, 'AP14-B');
  await db.projectMember.create({ data: { projectId: projA.id, employeeId: emp.id, organizationId: org.id } });
  const token = await tokenFor(org.id);
  await setActive(token, emp.id, projA.id);
  assert.equal(await activeProjectIdOf(emp.id), projA.id);

  // Replace assignments: drop A, add B.
  const res = await employeeProjectsApi.PUT(
    req(token, { method: 'PUT', body: { projectIds: [projB.id] } }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  assert.equal(res.status, 200);

  assert.equal(await activeProjectIdOf(emp.id), null, 'removed membership cleared the active project');
  const memberA = await db.projectMember.findFirst({ where: { projectId: projA.id, employeeId: emp.id } });
  assert.ok(memberA!.leftAt, 'A soft-removed');
  const memberB = await db.projectMember.findFirst({ where: { projectId: projB.id, employeeId: emp.id } });
  assert.equal(memberB!.leftAt, null, 'B active');
});

// ────────────────────────────────────────────────────────────────────────────
// Sync attribution — explicit active project precedence
// ────────────────────────────────────────────────────────────────────────────

test('AP-15: one membership + no explicit selection → existing fallback still works', async () => {
  const org = await seedOrg('ap15-a');
  const emp = await seedEmployee(org.id, 'AP-15');
  const proj = await seedProject(org.id, 'AP15-P');
  await grantActivityConsent(org.id, emp.id);
  await db.projectMember.create({ data: { projectId: proj.id, employeeId: emp.id, organizationId: org.id } });
  await cleanSlate();
  await seedActivity(emp.id, 600, new Date('2026-03-01T10:00:00.000Z'));

  const result = await runProjectTimeSync();
  assert.equal(result.activitiesAttributed, 1);
  const entries = await autoEntriesFor(emp.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].projectId, proj.id);
  assert.equal(entries[0].hours, hoursOf(600));
});

test('AP-16: multiple memberships + NO explicit selection → no automatic time', async () => {
  const org = await seedOrg('ap16-a');
  const emp = await seedEmployee(org.id, 'AP-16');
  const projA = await seedProject(org.id, 'AP16-A');
  const projB = await seedProject(org.id, 'AP16-B');
  await grantActivityConsent(org.id, emp.id);
  await db.projectMember.create({ data: { projectId: projA.id, employeeId: emp.id, organizationId: org.id } });
  await db.projectMember.create({ data: { projectId: projB.id, employeeId: emp.id, organizationId: org.id } });
  await cleanSlate();
  await seedActivity(emp.id, 600, new Date('2026-03-02T10:00:00.000Z'));

  const result = await runProjectTimeSync();
  assert.equal(result.skippedAmbiguousMembership, 1);
  assert.equal(result.activitiesAttributed, 0);
  assert.equal((await autoEntriesFor(emp.id)).length, 0);
});

test('AP-17: multiple memberships + explicit selection → activity goes ONLY to the selected project', async () => {
  const org = await seedOrg('ap17-a');
  const emp = await seedEmployee(org.id, 'AP-17');
  const projA = await seedProject(org.id, 'AP17-A');
  const projB = await seedProject(org.id, 'AP17-B');
  await grantActivityConsent(org.id, emp.id);
  await db.projectMember.create({ data: { projectId: projA.id, employeeId: emp.id, organizationId: org.id } });
  await db.projectMember.create({ data: { projectId: projB.id, employeeId: emp.id, organizationId: org.id } });
  await setActive(await tokenFor(org.id), emp.id, projA.id);
  await cleanSlate();
  await seedActivity(emp.id, 1200, new Date('2026-03-03T10:00:00.000Z'));

  const result = await runProjectTimeSync();
  assert.equal(result.activitiesAttributed, 1, 'explicit selection resolves ambiguity');
  assert.equal(result.skippedAmbiguousMembership, 0);
  const entries = await autoEntriesFor(emp.id);
  assert.equal(entries.length, 1, 'one aggregated entry, never split/duplicated');
  assert.equal(entries[0].projectId, projA.id, 'only the selected project');
  assert.equal(entries[0].hours, hoursOf(1200));
  assert.equal(await db.timeEntry.count({ where: { employeeId: emp.id, projectId: projB.id } }), 0, 'B received nothing');
});

test('AP-18: switching project → new activity goes to new project; history untouched', async () => {
  const org = await seedOrg('ap18-a');
  const emp = await seedEmployee(org.id, 'AP-18');
  const projA = await seedProject(org.id, 'AP18-A');
  const projB = await seedProject(org.id, 'AP18-B');
  await grantActivityConsent(org.id, emp.id);
  await db.projectMember.create({ data: { projectId: projA.id, employeeId: emp.id, organizationId: org.id } });
  await db.projectMember.create({ data: { projectId: projB.id, employeeId: emp.id, organizationId: org.id } });
  const token = await tokenFor(org.id);

  await setActive(token, emp.id, projA.id);
  await cleanSlate();
  await seedActivity(emp.id, 600, new Date('2026-03-04T10:00:00.000Z')); // day 1 → A
  await runProjectTimeSync();

  await setActive(token, emp.id, projB.id); // switch
  await seedActivity(emp.id, 900, new Date('2026-03-05T10:00:00.000Z')); // day 2 → B
  await runProjectTimeSync();

  const entries = await autoEntriesFor(emp.id);
  assert.equal(entries.length, 2, 'one entry per project/day');
  const entryA = entries.find((e) => e.projectId === projA.id)!;
  const entryB = entries.find((e) => e.projectId === projB.id)!;
  assert.equal(entryA.hours, hoursOf(600), 'historical entry for A unchanged');
  assert.equal(entryB.hours, hoursOf(900), 'new entry for B');
  assert.equal(await db.timeEntry.count({ where: { employeeId: emp.id, projectId: projA.id } }), 1, 'no extra A entry');
});

test('AP-19: stale explicit selection (membership removed, field not cleared) → no time, never guesses', async () => {
  const org = await seedOrg('ap19-a');
  const emp = await seedEmployee(org.id, 'AP-19');
  const projA = await seedProject(org.id, 'AP19-A');
  const projB = await seedProject(org.id, 'AP19-B');
  await grantActivityConsent(org.id, emp.id);
  await db.projectMember.create({ data: { projectId: projA.id, employeeId: emp.id, organizationId: org.id } });
  await db.projectMember.create({ data: { projectId: projB.id, employeeId: emp.id, organizationId: org.id } });
  await setActive(await tokenFor(org.id), emp.id, projA.id);
  await cleanSlate();

  // Simulate a stale reference that was NOT auto-cleared (defense in depth):
  // soft-remove A's membership directly, keep the field pointing at A.
  await db.projectMember.updateMany({ where: { projectId: projA.id, employeeId: emp.id }, data: { leftAt: new Date() } });
  await seedActivity(emp.id, 600, new Date('2026-03-06T10:00:00.000Z'));

  const result = await runProjectTimeSync();
  assert.equal(result.skippedStaleActiveProject, 1, 'stale explicit selection blocked');
  assert.equal(result.activitiesAttributed, 0);
  assert.equal((await autoEntriesFor(emp.id)).length, 0, 'no fallback guess to B');
});

test('AP-20: explicit selection on a cancelled project → no automatic time', async () => {
  const org = await seedOrg('ap20-a');
  const emp = await seedEmployee(org.id, 'AP-20');
  const projA = await seedProject(org.id, 'AP20-A');
  const projB = await seedProject(org.id, 'AP20-B');
  await grantActivityConsent(org.id, emp.id);
  await db.projectMember.create({ data: { projectId: projA.id, employeeId: emp.id, organizationId: org.id } });
  await db.projectMember.create({ data: { projectId: projB.id, employeeId: emp.id, organizationId: org.id } });
  await setActive(await tokenFor(org.id), emp.id, projA.id);
  await cleanSlate();

  await db.project.update({ where: { id: projA.id }, data: { status: 'cancelled' } });
  await seedActivity(emp.id, 600, new Date('2026-03-07T10:00:00.000Z'));

  const result = await runProjectTimeSync();
  assert.equal(result.skippedArchivedProject, 1, 'cancelled explicit selection blocked');
  assert.equal(result.activitiesAttributed, 0);
  assert.equal((await autoEntriesFor(emp.id)).length, 0, 'no guess to B');
});

test('AP-21: consent revoked blocks auto time even with an explicit active project; restore resumes', async () => {
  const org = await seedOrg('ap21-a');
  const emp = await seedEmployee(org.id, 'AP-21');
  const projA = await seedProject(org.id, 'AP21-A');
  const projB = await seedProject(org.id, 'AP21-B');
  await grantActivityConsent(org.id, emp.id);
  await db.projectMember.create({ data: { projectId: projA.id, employeeId: emp.id, organizationId: org.id } });
  await db.projectMember.create({ data: { projectId: projB.id, employeeId: emp.id, organizationId: org.id } });
  await setActive(await tokenFor(org.id), emp.id, projA.id);

  // Revoke BEFORE the activity window — explicit selection must NOT bypass consent.
  await db.consent.updateMany({
    where: { employeeId: emp.id, consentType: 'activity_tracking' },
    data: { status: 'revoked', revokedAt: new Date() },
  });
  await cleanSlate();
  await seedActivity(emp.id, 600, new Date('2026-03-08T10:00:00.000Z'));
  const denied = await runProjectTimeSync();
  assert.equal(denied.skippedNoConsent, 1);
  assert.equal((await autoEntriesFor(emp.id)).length, 0, 'no time while consent revoked');

  // Restore consent → new activity resumes, attributed to the explicit project.
  const newVersion = `v${policySeq}`;
  const newPolicy = await db.consentPolicy.create({
    data: {
      organizationId: org.id,
      consentType: 'activity_tracking',
      title: 'Activity Tracking Policy restore',
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
  await seedActivity(emp.id, 300, new Date('2026-03-09T10:00:00.000Z'));
  const after = await runProjectTimeSync();
  assert.equal(after.activitiesAttributed, 1);
  const entries = await autoEntriesFor(emp.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].projectId, projA.id);
  assert.equal(entries[0].hours, hoursOf(300), 'denied period not backfilled');
});

test('AP-22: deactivated employee → no new automatic project time', async () => {
  const org = await seedOrg('ap22-a');
  const emp = await seedEmployee(org.id, 'AP-22', { status: 'inactive' });
  const proj = await seedProject(org.id, 'AP22-P');
  await grantActivityConsent(org.id, emp.id);
  await db.projectMember.create({ data: { projectId: proj.id, employeeId: emp.id, organizationId: org.id } });
  await cleanSlate();
  await seedActivity(emp.id, 600, new Date('2026-03-10T10:00:00.000Z'));

  const result = await runProjectTimeSync();
  assert.equal(result.skippedEmployeeInactive, 1);
  assert.equal(result.activitiesAttributed, 0);
  assert.equal((await autoEntriesFor(emp.id)).length, 0);
});

test('AP-23: manual TimeEntry unchanged while explicit active project syncs', async () => {
  const org = await seedOrg('ap23-a');
  const emp = await seedEmployee(org.id, 'AP-23');
  const projA = await seedProject(org.id, 'AP23-A');
  const projB = await seedProject(org.id, 'AP23-B');
  await grantActivityConsent(org.id, emp.id);
  await db.projectMember.create({ data: { projectId: projA.id, employeeId: emp.id, organizationId: org.id } });
  await db.projectMember.create({ data: { projectId: projB.id, employeeId: emp.id, organizationId: org.id } });
  await setActive(await tokenFor(org.id), emp.id, projA.id);
  await cleanSlate();

  const manual = await db.timeEntry.create({
    data: {
      projectId: projB.id,
      employeeId: emp.id,
      date: new Date('2026-03-11T00:00:00.000Z'),
      hours: 2.5,
      source: 'MANUAL',
      billable: true,
      organizationId: org.id,
    },
  });
  await seedActivity(emp.id, 1800, new Date('2026-03-11T10:00:00.000Z')); // 0.5h auto → A
  await runProjectTimeSync();

  const manualAfter = await db.timeEntry.findUnique({ where: { id: manual.id } });
  assert.equal(manualAfter!.source, 'MANUAL', 'manual source preserved');
  assert.equal(manualAfter!.hours, 2.5, 'manual hours untouched');

  const entries = await autoEntriesFor(emp.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].projectId, projA.id);
  assert.equal(entries[0].hours, hoursOf(1800));
});

test('AP-24: sync is idempotent — re-running never double-counts the explicit project', async () => {
  const org = await seedOrg('ap24-a');
  const emp = await seedEmployee(org.id, 'AP-24');
  const projA = await seedProject(org.id, 'AP24-A');
  const projB = await seedProject(org.id, 'AP24-B');
  await grantActivityConsent(org.id, emp.id);
  await db.projectMember.create({ data: { projectId: projA.id, employeeId: emp.id, organizationId: org.id } });
  await db.projectMember.create({ data: { projectId: projB.id, employeeId: emp.id, organizationId: org.id } });
  await setActive(await tokenFor(org.id), emp.id, projA.id);
  await cleanSlate();
  await seedActivity(emp.id, 300, new Date('2026-03-12T10:00:00.000Z'));

  const first = await runProjectTimeSync();
  assert.equal(first.activitiesAttributed, 1);
  const second = await runProjectTimeSync();
  assert.equal(second.activitiesScanned, 0, 'cursor advanced — nothing re-read');
  const third = await runProjectTimeSync();
  assert.equal(third.activitiesScanned, 0);

  const entries = await autoEntriesFor(emp.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].hours, hoursOf(300), 'seconds never double-accumulated');
  const syncRow = await db.projectTimeSync.findFirst({ where: { employeeId: emp.id } });
  assert.equal(syncRow!.seconds, 300);
});

test('AP-25: cross-org isolation at sync time — explicit selection cannot leak across orgs', async () => {
  const orgA = await seedOrg('ap25-a');
  const orgB = await seedOrg('ap25-b');
  const emp = await seedEmployee(orgA.id, 'AP-25');
  const projB = await seedProject(orgB.id, 'AP25-B');
  await grantActivityConsent(orgA.id, emp.id);
  await cleanSlate();

  // Corrupted state: an explicit selection pointing at a CROSS-ORG project
  // (the API forbids this, but defense in depth must hold at sync time).
  await db.employee.update({ where: { id: emp.id }, data: { activeTrackingProjectId: projB.id } });
  await seedActivity(emp.id, 600, new Date('2026-03-13T10:00:00.000Z'));

  const result = await runProjectTimeSync();
  assert.equal(result.skippedStaleActiveProject, 1, 'cross-org explicit selection blocked');
  assert.equal((await autoEntriesFor(emp.id)).length, 0);
  assert.equal(await db.timeEntry.count({ where: { projectId: projB.id } }), 0, 'Org B project received nothing');
});

/**
 * Project Module — end-to-end route-level audit tests.
 *
 * Covers: list (org scoping + pagination + stats), server-side search,
 * combined filters, server-side sorting, create/update/archive validation,
 * member assignment (duplicate prevention, soft-removal, reactivation),
 * time-entry validation, cross-organization isolation, employee↔project
 * consistency, and report/export tenant isolation.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_projects).
 * Run: npx tsx --test tests/projects.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { req } from './helpers/request';

// ─── Test DB isolation (must be set BEFORE any app module import) ──────────
// Each suite owns a dedicated throwaway PostgreSQL database; the schema is
// pushed with `prisma db push` (test-only convenience — production deploys
// with `prisma migrate deploy`). PG_TEST_BASE_URL overrides the default
// local instance (e.g. for CI).
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_projects';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-projects-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

before(() => {
  if (process.env.PROJECTS_TEST_MIGRATED_DB !== '1') {
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

type ProjectsApi = typeof import('../src/app/api/projects/route');
type ProjectIdApi = typeof import('../src/app/api/projects/[id]/route');
type ProjectMembersApi = typeof import('../src/app/api/projects/[id]/members/route');
type ProjectMemberIdApi = typeof import('../src/app/api/projects/[id]/members/[memberId]/route');
type ProjectTimeEntriesApi = typeof import('../src/app/api/projects/[id]/time-entries/route');
type EmployeeProjectsApi = typeof import('../src/app/api/employees/[id]/projects/route');
type ProjectPdfApi = typeof import('../src/app/api/reports/pdf/project/route');
type ExportApi = typeof import('../src/app/api/export/[type]/route');

let projectsApi: ProjectsApi;
let projectIdApi: ProjectIdApi;
let projectMembersApi: ProjectMembersApi;
let projectMemberIdApi: ProjectMemberIdApi;
let projectTimeEntriesApi: ProjectTimeEntriesApi;
let employeeProjectsApi: EmployeeProjectsApi;
let projectPdfApi: ProjectPdfApi;
let exportApi: ExportApi;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  const [pApi, pIdApi, pmApi, pmiApi, pteApi, epApi, pdfApi, expApi] = await Promise.all([
    import('../src/app/api/projects/route'),
    import('../src/app/api/projects/[id]/route'),
    import('../src/app/api/projects/[id]/members/route'),
    import('../src/app/api/projects/[id]/members/[memberId]/route'),
    import('../src/app/api/projects/[id]/time-entries/route'),
    import('../src/app/api/employees/[id]/projects/route'),
    import('../src/app/api/reports/pdf/project/route'),
    import('../src/app/api/export/[type]/route'),
  ]);
  projectsApi = pApi;
  projectIdApi = pIdApi;
  projectMembersApi = pmApi;
  projectMemberIdApi = pmiApi;
  projectTimeEntriesApi = pteApi;
  employeeProjectsApi = epApi;
  projectPdfApi = pdfApi;
  exportApi = expApi;
});

after(async () => {
  await db.$disconnect();
  if (process.env.PROJECTS_TEST_MIGRATED_DB !== '1') {
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


function tokenFor(orgId: string, role = 'admin', userId = 'u-test') {
  return signJWT({ userId, email: `${role}@${orgId.slice(-6)}.local`, role, organizationId: orgId });
}

async function seedOrg(slug: string) {
  return db.organization.create({ data: { name: slug, slug } });
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

// ─── List: auth, scoping, pagination, stats ─────────────────────────────────

test('PRJ-1: unauthenticated GET /api/projects -> 401', async () => {
  const res = await projectsApi.GET(req(null));
  assert.equal(res.status, 401);
});

test('PRJ-2: Org A sees only Org A projects; pagination + stats are real', async () => {
  const orgA = await seedOrg('prj-a');
  const orgB = await seedOrg('prj-b');
  for (let i = 1; i <= 5; i++) await seedProject(orgA.id, `A-Proj-${i}`, { status: i % 2 === 0 ? 'active' : 'on_hold' });
  await seedProject(orgB.id, 'B-Proj-1');

  const token = await tokenFor(orgA.id);
  const page1 = await projectsApi.GET(req(token, { url: 'http://localhost:3000/api/projects?page=1&pageSize=3' }));
  assert.equal(page1.status, 200);
  const body1 = await page1.json();
  assert.equal(body1.total, 5);
  assert.equal(body1.pageSize, 3);
  assert.equal(body1.totalPages, 2);
  assert.equal(body1.data.length, 3);
  assert.ok(body1.data.every((p: { organizationId: string }) => p.organizationId === orgA.id));
  assert.equal(body1.stats.totalProjects, 5);
  assert.equal(body1.stats.activeProjects, 2);
  assert.equal(typeof body1.stats.uniqueMembers, 'number');
  assert.equal(typeof body1.stats.overdueCount, 'number');
  assert.equal(typeof body1.stats.dailyAverageHours, 'number');

  const page2 = await projectsApi.GET(req(token, { url: 'http://localhost:3000/api/projects?page=2&pageSize=3' }));
  const body2 = await page2.json();
  assert.equal(body2.data.length, 2);
  const ids1 = new Set(body1.data.map((p: { id: string }) => p.id));
  assert.ok(body2.data.every((p: { id: string }) => !ids1.has(p.id)), 'page 2 must not repeat page 1');

  // Filtered list: `total` reflects the filtered set, but KPI stats stay
  // org-wide (searching must not change the header cards' numbers).
  const filtered = await projectsApi.GET(req(token, { url: 'http://localhost:3000/api/projects?status=active&pageSize=50' }));
  const fbody = await filtered.json();
  assert.equal(fbody.total, 2, 'filtered total reflects the filter');
  assert.equal(fbody.stats.totalProjects, 5, 'KPI card stays org-wide while filtered');
  assert.equal(fbody.stats.activeProjects, 2, 'org-wide active count');
});

test('PRJ-3: search is case-insensitive, partial and server-side', async () => {
  const orgA = await seedOrg('prjs-a');
  await seedProject(orgA.id, 'Website Redesign');
  await seedProject(orgA.id, 'Mobile App');
  await seedProject(orgA.id, 'website-ops');

  const token = await tokenFor(orgA.id);
  const res = await projectsApi.GET(req(token, { url: `http://localhost:3000/api/projects?search=${encodeURIComponent('WEBSITE')}&pageSize=50` }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.total, 2);
  const names = body.data.map((p: { name: string }) => p.name).sort();
  assert.deepEqual(names, ['Website Redesign', 'website-ops']);
});

test('PRJ-4: combined filters (status + priority + search) all apply', async () => {
  const orgA = await seedOrg('prjf-a');
  await seedProject(orgA.id, 'Alpha Website', { status: 'active', priority: 'high' });
  await seedProject(orgA.id, 'Beta Website', { status: 'active', priority: 'low' });
  await seedProject(orgA.id, 'Gamma App', { status: 'completed', priority: 'high' });

  const token = await tokenFor(orgA.id);
  const res = await projectsApi.GET(req(token, { url: `http://localhost:3000/api/projects?status=active&priority=high&search=website&pageSize=50` }));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.total, 1);
  assert.equal(body.data[0].name, 'Alpha Website');
});

test('PRJ-5: server-side sorting by name and hours', async () => {
  const orgA = await seedOrg('prjo-a');
  const p1 = await seedProject(orgA.id, 'Zulu');
  await seedProject(orgA.id, 'Alpha');
  const p3 = await seedProject(orgA.id, 'Mike');
  const emp = await seedEmployee(orgA.id, 'SORT-1');
  await db.projectMember.create({ data: { projectId: p3.id, employeeId: emp.id, organizationId: orgA.id } });
  // Mike gets 10h, Zulu 5h, Alpha 0h
  await db.timeEntry.create({ data: { projectId: p3.id, employeeId: emp.id, date: new Date(), hours: 10, organizationId: orgA.id } });
  await db.timeEntry.create({ data: { projectId: p1.id, employeeId: emp.id, date: new Date(), hours: 5, organizationId: orgA.id } });

  const token = await tokenFor(orgA.id);
  const byName = await projectsApi.GET(req(token, { url: 'http://localhost:3000/api/projects?sortBy=name&pageSize=50' }));
  const names = (await byName.json()).data.map((p: { name: string }) => p.name);
  assert.deepEqual(names, ['Alpha', 'Mike', 'Zulu']);

  const byHours = await projectsApi.GET(req(token, { url: 'http://localhost:3000/api/projects?sortBy=hours_most&pageSize=50' }));
  const hoursOrder = (await byHours.json()).data.map((p: { name: string }) => p.name);
  assert.deepEqual(hoursOrder, ['Mike', 'Zulu', 'Alpha']);
});

// ─── Create ─────────────────────────────────────────────────────────────────

test('PRJ-6: admin creates project -> 201, persisted, appears in list', async () => {
  const orgA = await seedOrg('prjc-a');
  const token = await tokenFor(orgA.id);

  const res = await projectsApi.POST(req(token, { method: 'POST', body: { name: 'New Project', status: 'active', priority: 'high' } }));
  assert.equal(res.status, 201);
  const { data } = await res.json();
  assert.equal(data.name, 'New Project');
  assert.equal(data.organizationId, orgA.id);

  const inDb = await db.project.findUnique({ where: { id: data.id } });
  assert.ok(inDb, 'record must exist in the database');
  assert.equal(inDb!.status, 'active');
  assert.equal(inDb!.priority, 'high');

  const audit = await db.auditLog.findFirst({ where: { resource: 'project', resourceId: data.id } });
  assert.ok(audit, 'creation must be audited');
});

test('PRJ-7: create validation — empty name 400, duplicate 409, bad enum 422, bad dates 422', async () => {
  const orgA = await seedOrg('prjv-a');
  await seedProject(orgA.id, 'Dupe');
  const token = await tokenFor(orgA.id);

  assert.equal((await projectsApi.POST(req(token, { method: 'POST', body: { name: '  ' } }))).status, 400);
  assert.equal((await projectsApi.POST(req(token, { method: 'POST', body: { name: 'Dupe' } }))).status, 409);
  assert.equal((await projectsApi.POST(req(token, { method: 'POST', body: { name: 'X', status: 'archived' } }))).status, 422);
  assert.equal((await projectsApi.POST(req(token, { method: 'POST', body: { name: 'X', priority: 'urgent' } }))).status, 422);
  assert.equal((await projectsApi.POST(req(token, { method: 'POST', body: { name: 'X', budgetType: 'nope' } }))).status, 422);
  assert.equal((await projectsApi.POST(req(token, { method: 'POST', body: { name: 'X', estimatedHours: -5 } }))).status, 422);
  // startDate after deadline
  assert.equal((await projectsApi.POST(req(token, { method: 'POST', body: { name: 'X', startDate: '2026-05-01', deadline: '2026-01-01' } }))).status, 422);
  assert.equal((await projectsApi.POST(req(token, { method: 'POST', body: { name: 'X', deadline: 'not-a-date' } }))).status, 422);

  const viewer = await tokenFor(orgA.id, 'viewer', 'u-prjv-viewer');
  assert.equal((await projectsApi.POST(req(viewer, { method: 'POST', body: { name: 'Nope' } }))).status, 403);
});

// ─── Update / Archive ───────────────────────────────────────────────────────

test('PRJ-8: update persists; duplicate name 409; invalid enum/date 422', async () => {
  const orgA = await seedOrg('pru-a');
  const p = await seedProject(orgA.id, 'Original');
  await seedProject(orgA.id, 'Taken');
  const token = await tokenFor(orgA.id);

  const put = await projectIdApi.PUT(req(token, { method: 'PUT', body: { name: 'Renamed', status: 'completed', priority: 'critical' } }), { params: Promise.resolve({ id: p.id }) });
  assert.equal(put.status, 200);
  const updated = (await put.json()).data;
  assert.equal(updated.name, 'Renamed');
  assert.equal(updated.status, 'completed');

  const inDb = await db.project.findUnique({ where: { id: p.id } });
  assert.equal(inDb!.name, 'Renamed');
  assert.equal(inDb!.status, 'completed');

  assert.equal((await projectIdApi.PUT(req(token, { method: 'PUT', body: { name: 'Taken' } }), { params: Promise.resolve({ id: p.id }) })).status, 409);
  assert.equal((await projectIdApi.PUT(req(token, { method: 'PUT', body: { status: 'deleted' } }), { params: Promise.resolve({ id: p.id }) })).status, 422);
  assert.equal((await projectIdApi.PUT(req(token, { method: 'PUT', body: { name: '' } }), { params: Promise.resolve({ id: p.id }) })).status, 400);
  assert.equal((await projectIdApi.PUT(req(token, { method: 'PUT', body: { startDate: '2026-09-01', deadline: '2026-01-01' } }), { params: Promise.resolve({ id: p.id }) })).status, 422);
});

test('PRJ-9: archive (DELETE) sets status to cancelled and preserves history', async () => {
  const orgA = await seedOrg('prd-a');
  const p = await seedProject(orgA.id, 'ArchiveMe', { status: 'active' });
  const emp = await seedEmployee(orgA.id, 'ARC-1');
  await db.projectMember.create({ data: { projectId: p.id, employeeId: emp.id, organizationId: orgA.id } });
  await db.timeEntry.create({ data: { projectId: p.id, employeeId: emp.id, date: new Date(), hours: 4, organizationId: orgA.id } });
  const token = await tokenFor(orgA.id);

  const res = await projectIdApi.DELETE(req(token, { method: 'DELETE' }), { params: Promise.resolve({ id: p.id }) });
  assert.equal(res.status, 200);

  const inDb = await db.project.findUnique({ where: { id: p.id } });
  assert.equal(inDb!.status, 'cancelled');
  assert.equal(await db.projectMember.count({ where: { projectId: p.id } }), 1, 'membership preserved');
  assert.equal(await db.timeEntry.count({ where: { projectId: p.id } }), 1, 'time entries preserved');
});

// ─── Members ────────────────────────────────────────────────────────────────

test('PRJ-10: member lifecycle — add, duplicate 409, invalid role 422, soft-remove, reactivate', async () => {
  const orgA = await seedOrg('prm-a');
  const p = await seedProject(orgA.id, 'Members');
  const emp = await seedEmployee(orgA.id, 'MEM-1');
  const token = await tokenFor(orgA.id);

  const add = await projectMembersApi.POST(req(token, { method: 'POST', body: { employeeId: emp.id, role: 'lead' } }), { params: Promise.resolve({ id: p.id }) });
  assert.equal(add.status, 201);
  const member = (await add.json()).data;
  assert.equal(member.role, 'lead');

  const dup = await projectMembersApi.POST(req(token, { method: 'POST', body: { employeeId: emp.id } }), { params: Promise.resolve({ id: p.id }) });
  assert.equal(dup.status, 409);

  const badRole = await projectMembersApi.POST(req(token, { method: 'POST', body: { employeeId: emp.id, role: 'boss' } }), { params: Promise.resolve({ id: p.id }) });
  assert.equal(badRole.status, 422);

  const badHours = await projectMembersApi.POST(req(token, { method: 'POST', body: { employeeId: emp.id, hoursPerWeek: 999 } }), { params: Promise.resolve({ id: p.id }) });
  assert.equal(badHours.status, 422);

  // Soft remove: row kept, leftAt set, membership hidden from active list.
  const del = await projectMemberIdApi.DELETE(req(token, { method: 'DELETE' }), { params: Promise.resolve({ id: p.id, memberId: member.id }) });
  assert.equal(del.status, 200);
  const afterRemove = await db.projectMember.findUnique({ where: { id: member.id } });
  assert.ok(afterRemove!.leftAt, 'soft removal must set leftAt');
  const listRes = await projectMembersApi.GET(req(token), { params: Promise.resolve({ id: p.id }) });
  assert.equal((await listRes.json()).data.length, 0, 'removed member not in active list');

  // Re-add reactivates the SAME row (unique constraint) instead of failing.
  const readd = await projectMembersApi.POST(req(token, { method: 'POST', body: { employeeId: emp.id, role: 'reviewer' } }), { params: Promise.resolve({ id: p.id }) });
  assert.equal(readd.status, 201);
  const readded = (await readd.json()).data;
  assert.equal(readded.id, member.id, 'reactivation must reuse the membership row');
  const row = await db.projectMember.findUnique({ where: { id: member.id } });
  assert.equal(row!.leftAt, null);
  assert.equal(row!.role, 'reviewer');
  assert.equal(await db.projectMember.count({ where: { projectId: p.id } }), 1, 'no duplicate rows');
});

test('PRJ-11: member role update validates and persists', async () => {
  const orgA = await seedOrg('prmr-a');
  const p = await seedProject(orgA.id, 'RoleChange');
  const emp = await seedEmployee(orgA.id, 'RLC-1');
  const member = await db.projectMember.create({ data: { projectId: p.id, employeeId: emp.id, organizationId: orgA.id, role: 'member' } });
  const token = await tokenFor(orgA.id);

  const put = await projectMemberIdApi.PUT(req(token, { method: 'PUT', body: { role: 'stakeholder' } }), { params: Promise.resolve({ id: p.id, memberId: member.id }) });
  assert.equal(put.status, 200);
  assert.equal((await db.projectMember.findUnique({ where: { id: member.id } }))!.role, 'stakeholder');

  const bad = await projectMemberIdApi.PUT(req(token, { method: 'PUT', body: { role: 'admin' } }), { params: Promise.resolve({ id: p.id, memberId: member.id }) });
  assert.equal(bad.status, 422);
});

test('PRJ-12: cross-org member assignment rejected (422 / 404)', async () => {
  const orgA = await seedOrg('prx-a');
  const orgB = await seedOrg('prx-b');
  const projA = await seedProject(orgA.id, 'X-A');
  const projB = await seedProject(orgB.id, 'X-B');
  const empB = await seedEmployee(orgB.id, 'X-EMP-B');
  const adminA = await tokenFor(orgA.id);

  // Org B employee on Org A project -> 422.
  assert.equal((await projectMembersApi.POST(req(adminA, { method: 'POST', body: { employeeId: empB.id } }), { params: Promise.resolve({ id: projA.id }) })).status, 422);
  // Org A admin acting on Org B project -> 404.
  assert.equal((await projectMembersApi.POST(req(adminA, { method: 'POST', body: { employeeId: empB.id } }), { params: Promise.resolve({ id: projB.id }) })).status, 404);
  assert.equal((await projectIdApi.GET(req(adminA), { params: Promise.resolve({ id: projB.id }) })).status, 404);
  assert.equal((await projectIdApi.PUT(req(adminA, { method: 'PUT', body: { name: 'Hijack' } }), { params: Promise.resolve({ id: projB.id }) })).status, 404);
});

// ─── Time entries ───────────────────────────────────────────────────────────

test('PRJ-13: time entries — non-member 403, invalid hours 422, valid 201', async () => {
  const orgA = await seedOrg('prt-a');
  const p = await seedProject(orgA.id, 'Time');
  const member = await seedEmployee(orgA.id, 'TM-1');
  const outsider = await seedEmployee(orgA.id, 'TM-2');
  await db.projectMember.create({ data: { projectId: p.id, employeeId: member.id, organizationId: orgA.id } });
  const token = await tokenFor(orgA.id);

  const outsiderRes = await projectTimeEntriesApi.POST(req(token, { method: 'POST', body: { employeeId: outsider.id, date: '2026-01-05', hours: 2 } }), { params: Promise.resolve({ id: p.id }) });
  assert.equal(outsiderRes.status, 403);

  const zeroHours = await projectTimeEntriesApi.POST(req(token, { method: 'POST', body: { employeeId: member.id, date: '2026-01-05', hours: 0 } }), { params: Promise.resolve({ id: p.id }) });
  assert.equal(zeroHours.status, 422);

  const tooMany = await projectTimeEntriesApi.POST(req(token, { method: 'POST', body: { employeeId: member.id, date: '2026-01-05', hours: 25 } }), { params: Promise.resolve({ id: p.id }) });
  assert.equal(tooMany.status, 422);

  const badCat = await projectTimeEntriesApi.POST(req(token, { method: 'POST', body: { employeeId: member.id, date: '2026-01-05', hours: 2, category: 'napping' } }), { params: Promise.resolve({ id: p.id }) });
  assert.equal(badCat.status, 422);

  const ok = await projectTimeEntriesApi.POST(req(token, { method: 'POST', body: { employeeId: member.id, date: '2026-01-05', hours: 7.5, category: 'development', billable: true } }), { params: Promise.resolve({ id: p.id }) });
  assert.equal(ok.status, 201);

  const list = await projectTimeEntriesApi.GET(req(token, { url: 'http://localhost:3000/api/projects/t/time-entries' }), { params: Promise.resolve({ id: p.id }) });
  const body = await list.json();
  assert.equal(body.total, 1);
  assert.equal(body.aggregates.totalHours, 7.5);
  assert.equal(body.aggregates.billableHours, 7.5);
});

// ─── Employee ↔ Project consistency ─────────────────────────────────────────

test('PRJ-14: employee project assignments — multi-assign, soft-remove, reactivate, both sides consistent', async () => {
  const orgA = await seedOrg('pre-a');
  const emp = await seedEmployee(orgA.id, 'EMP-PROJ-1');
  const projA = await seedProject(orgA.id, 'PA');
  const projB = await seedProject(orgA.id, 'PB');
  const projC = await seedProject(orgA.id, 'PC');
  const token = await tokenFor(orgA.id);

  // Assign A + B.
  const put1 = await employeeProjectsApi.PUT(req(token, { method: 'PUT', body: { projectIds: [projA.id, projB.id] } }), { params: Promise.resolve({ id: emp.id }) });
  assert.equal(put1.status, 200);

  const get1 = await employeeProjectsApi.GET(req(token), { params: Promise.resolve({ id: emp.id }) });
  const active1 = (await get1.json()).data.filter((m: { leftAt: string | null }) => !m.leftAt);
  assert.deepEqual(active1.map((m: { projectId: string }) => m.projectId).sort(), [projA.id, projB.id].sort());

  // Project side reflects the assignment.
  const projBMembers = await projectMembersApi.GET(req(token), { params: Promise.resolve({ id: projB.id }) });
  assert.equal((await projBMembers.json()).data.length, 1);

  // Swap: drop A, add C. A becomes leftAt (soft), C created.
  const put2 = await employeeProjectsApi.PUT(req(token, { method: 'PUT', body: { projectIds: [projB.id, projC.id] } }), { params: Promise.resolve({ id: emp.id }) });
  assert.equal(put2.status, 200);

  const get2 = await employeeProjectsApi.GET(req(token), { params: Promise.resolve({ id: emp.id }) });
  const active2 = (await get2.json()).data.filter((m: { leftAt: string | null }) => !m.leftAt);
  assert.deepEqual(active2.map((m: { projectId: string }) => m.projectId).sort(), [projB.id, projC.id].sort());

  // Re-add A (previously left) — must reactivate, not crash on the unique key.
  const put3 = await employeeProjectsApi.PUT(req(token, { method: 'PUT', body: { projectIds: [projA.id, projB.id, projC.id] } }), { params: Promise.resolve({ id: emp.id }) });
  assert.equal(put3.status, 200);
  const get3 = await employeeProjectsApi.GET(req(token), { params: Promise.resolve({ id: emp.id }) });
  const active3 = (await get3.json()).data.filter((m: { leftAt: string | null }) => !m.leftAt);
  assert.equal(active3.length, 3);
  assert.equal(await db.projectMember.count({ where: { employeeId: emp.id } }), 3, 'still exactly 3 rows — no duplicates');

  // Cross-org project in the assignment list -> 422.
  const orgB = await seedOrg('pre-b');
  const projB2 = await seedProject(orgB.id, 'PB-OTHER');
  const putBad = await employeeProjectsApi.PUT(req(token, { method: 'PUT', body: { projectIds: [projA.id, projB2.id] } }), { params: Promise.resolve({ id: emp.id }) });
  assert.equal(putBad.status, 422);
});

// ─── Reports / export tenant isolation ──────────────────────────────────────

test('PRJ-15: project PDF is org-scoped — cross-org request -> 404', async () => {
  const orgA = await seedOrg('pdf-a');
  const orgB = await seedOrg('pdf-b');
  const projB = await seedProject(orgB.id, 'Secret B');
  const adminA = await tokenFor(orgA.id);

  const res = await projectPdfApi.POST(req(adminA, { method: 'POST', body: { projectId: projB.id } }));
  assert.equal(res.status, 404, 'cross-org project must not be downloadable');

  const noAuth = await projectPdfApi.POST(req(null, { method: 'POST', body: { projectId: projB.id } }));
  assert.equal(noAuth.status, 401);
});

test('PRJ-16: project export is org-scoped', async () => {
  const orgA = await seedOrg('exp-a');
  const orgB = await seedOrg('exp-b');
  await seedProject(orgA.id, 'Exportable A');
  await seedProject(orgB.id, 'Secret B Proj');
  const adminA = await tokenFor(orgA.id);

  const res = await exportApi.GET(req(adminA, { url: 'http://localhost:3000/api/export/projects' }), { params: Promise.resolve({ type: 'projects' }) });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('Exportable A'), 'own-org project included');
  assert.ok(!text.includes('Secret B Proj'), 'other-org project must never leak');
});

test('PRJ-17: viewer cannot create time entries or members (403)', async () => {
  const orgA = await seedOrg('prz-a');
  const p = await seedProject(orgA.id, 'Perms');
  const emp = await seedEmployee(orgA.id, 'PRM-1');
  const viewer = await tokenFor(orgA.id, 'viewer', 'u-prz-viewer');

  assert.equal((await projectMembersApi.POST(req(viewer, { method: 'POST', body: { employeeId: emp.id } }), { params: Promise.resolve({ id: p.id }) })).status, 403);
  assert.equal((await projectTimeEntriesApi.POST(req(viewer, { method: 'POST', body: { employeeId: emp.id, date: '2026-01-01', hours: 1 } }), { params: Promise.resolve({ id: p.id }) })).status, 403);
  assert.equal((await projectsApi.POST(req(viewer, { method: 'POST', body: { name: 'Nope' } }))).status, 403);
});

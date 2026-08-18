/**
 * Project Tracking P2 — route-level audit tests for the new functionality.
 *
 * Covers:
 *  - TimeEntry edit (PUT /api/projects/[id]/time-entries/[entryId])
 *  - TimeEntry delete (DELETE /api/projects/[id]/time-entries/[entryId])
 *  - edit/delete validation + security (401/403/404/422, cross-org, closed schema)
 *  - archive filtering (includeArchived, default hide cancelled, pagination)
 *  - restore archived project (POST /api/projects/[id]/restore)
 *  - data integrity: aggregates recalculate from real rows (no stored aggregates)
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_projects_tracking).
 * Run: npx tsx --test tests/projects-tracking.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation (must be set BEFORE any app module import) ──────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_projects_tracking';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-projects-tracking-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

before(() => {
  if (process.env.PROJECTS_TRACKING_TEST_MIGRATED_DB !== '1') {
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
type ProjectRestoreApi = typeof import('../src/app/api/projects/[id]/restore/route');
type ProjectSearchApi = typeof import('../src/app/api/projects/search/route');
type ProjectTimeEntriesApi = typeof import('../src/app/api/projects/[id]/time-entries/route');
type ProjectTimeEntryIdApi = typeof import('../src/app/api/projects/[id]/time-entries/[entryId]/route');

let projectsApi: ProjectsApi;
let projectIdApi: ProjectIdApi;
let projectRestoreApi: ProjectRestoreApi;
let projectSearchApi: ProjectSearchApi;
let projectTimeEntriesApi: ProjectTimeEntriesApi;
let projectTimeEntryIdApi: ProjectTimeEntryIdApi;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  const [pApi, pIdApi, prApi, psApi, pteApi, pteIdApi] = await Promise.all([
    import('../src/app/api/projects/route'),
    import('../src/app/api/projects/[id]/route'),
    import('../src/app/api/projects/[id]/restore/route'),
    import('../src/app/api/projects/search/route'),
    import('../src/app/api/projects/[id]/time-entries/route'),
    import('../src/app/api/projects/[id]/time-entries/[entryId]/route'),
  ]);
  projectsApi = pApi;
  projectIdApi = pIdApi;
  projectRestoreApi = prApi;
  projectSearchApi = psApi;
  projectTimeEntriesApi = pteApi;
  projectTimeEntryIdApi = pteIdApi;
});

after(async () => {
  await db.$disconnect();
  if (process.env.PROJECTS_TRACKING_TEST_MIGRATED_DB !== '1') {
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

function tokenFor(orgId: string, role = 'admin', userId = 'u-tracking-test') {
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

/** Create an org, an employee who is an active member, and a time entry. */
async function seedEntry(
  orgId: string,
  projectId: string,
  hours = 4,
  extra: Record<string, unknown> = {}
) {
  const emp = await seedEmployee(orgId, `TE-${hours}-${Math.random().toString(36).slice(2, 7)}`);
  await db.projectMember.create({ data: { projectId, employeeId: emp.id, organizationId: orgId } });
  const entry = await db.timeEntry.create({
    data: {
      projectId,
      employeeId: emp.id,
      organizationId: orgId,
      date: new Date('2026-06-01'),
      hours,
      category: 'development',
      billable: true,
      ...extra,
    },
  });
  return { emp, entry };
}

// ─── TimeEntry Edit ─────────────────────────────────────────────────────────

test('PTR-1: edit entry — hours/category/date/billable persist; aggregates recalc', async () => {
  const orgA = await seedOrg('ptr1-a');
  const p = await seedProject(orgA.id, 'EditMe', { hourlyRate: 100 });
  const { entry } = await seedEntry(orgA.id, p.id, 4);
  const token = await tokenFor(orgA.id);

  // 4h × $100 = $400 actual cost before.
  const before = await projectIdApi.GET(req(token), { params: Promise.resolve({ id: p.id }) });
  const beforeBody = await before.json();
  assert.equal(beforeBody.data.totalHours, 4);

  const res = await projectTimeEntryIdApi.PUT(
    req(token, { method: 'PUT', body: { hours: 6, category: 'testing', billable: false, date: '2026-06-02' } }),
    { params: Promise.resolve({ id: p.id, entryId: entry.id }) }
  );
  assert.equal(res.status, 200);
  const updated = (await res.json()).data;
  assert.equal(updated.hours, 6);
  assert.equal(updated.category, 'testing');
  assert.equal(updated.billable, false);
  assert.equal(new Date(updated.date).toISOString().slice(0, 10), '2026-06-02');

  // Persisted in DB.
  const inDb = await db.timeEntry.findUnique({ where: { id: entry.id } });
  assert.equal(inDb!.hours, 6);
  assert.equal(inDb!.category, 'testing');
  assert.equal(inDb!.billable, false);

  // Aggregates recalculate from the real rows (6h now, not the old 4h).
  const after = await projectIdApi.GET(req(token), { params: Promise.resolve({ id: p.id }) });
  const afterBody = await after.json();
  assert.equal(afterBody.data.totalHours, 6, 'progress recalculates from 6h');

  const list = await projectTimeEntriesApi.GET(req(token), { params: Promise.resolve({ id: p.id }) });
  const listBody = await list.json();
  assert.equal(listBody.aggregates.totalHours, 6, 'time-entry aggregates recalc');
  assert.equal(listBody.aggregates.billableHours, 0, 'billable recalc after billable=false');

  // Audit trail exists.
  const audit = await db.auditLog.findFirst({ where: { resource: 'time_entry', resourceId: entry.id, action: 'update' } });
  assert.ok(audit, 'edit must be audited');
});

test('PTR-2: edit employee requires active membership in the same org', async () => {
  const orgA = await seedOrg('ptr2-a');
  const p = await seedProject(orgA.id, 'MemberSwitch');
  const { entry } = await seedEntry(orgA.id, p.id, 3);
  const outsider = await seedEmployee(orgA.id, 'OUTSIDER-1');
  const token = await tokenFor(orgA.id);

  // Non-member employee -> 403.
  const bad = await projectTimeEntryIdApi.PUT(
    req(token, { method: 'PUT', body: { employeeId: outsider.id } }),
    { params: Promise.resolve({ id: p.id, entryId: entry.id }) }
  );
  assert.equal(bad.status, 403);

  // Cross-org employee -> 403 (not an active member of THIS org's project).
  const orgB = await seedOrg('ptr2-b');
  const empB = await seedEmployee(orgB.id, 'CROSS-B');
  const cross = await projectTimeEntryIdApi.PUT(
    req(token, { method: 'PUT', body: { employeeId: empB.id } }),
    { params: Promise.resolve({ id: p.id, entryId: entry.id }) }
  );
  assert.equal(cross.status, 403);
});

test('PTR-3: edit validation — unknown fields 422, bad hours 422, bad category 422, bad date 422, bad billable 422', async () => {
  const orgA = await seedOrg('ptr3-a');
  const p = await seedProject(orgA.id, 'ValidateEdit');
  const { entry } = await seedEntry(orgA.id, p.id, 2);
  const token = await tokenFor(orgA.id);
  const params = () => Promise.resolve({ id: p.id, entryId: entry.id });

  // Closed schema — arbitrary fields are rejected, never silently accepted.
  assert.equal(
    (await projectTimeEntryIdApi.PUT(req(token, { method: 'PUT', body: { hours: 3, projectId: 'hijack' } }), { params: params() })).status,
    422
  );
  assert.equal(
    (await projectTimeEntryIdApi.PUT(req(token, { method: 'PUT', body: { organizationId: 'hijack' } }), { params: params() })).status,
    422
  );
  assert.equal(
    (await projectTimeEntryIdApi.PUT(req(token, { method: 'PUT', body: { hours: 0 } }), { params: params() })).status,
    422
  );
  assert.equal(
    (await projectTimeEntryIdApi.PUT(req(token, { method: 'PUT', body: { hours: 25 } }), { params: params() })).status,
    422
  );
  assert.equal(
    (await projectTimeEntryIdApi.PUT(req(token, { method: 'PUT', body: { hours: 'abc' } }), { params: params() })).status,
    422
  );
  assert.equal(
    (await projectTimeEntryIdApi.PUT(req(token, { method: 'PUT', body: { category: 'napping' } }), { params: params() })).status,
    422
  );
  assert.equal(
    (await projectTimeEntryIdApi.PUT(req(token, { method: 'PUT', body: { date: 'not-a-date' } }), { params: params() })).status,
    422
  );
  assert.equal(
    (await projectTimeEntryIdApi.PUT(req(token, { method: 'PUT', body: { billable: 'yes' } }), { params: params() })).status,
    422
  );
});

test('PTR-4: edit security — unauthenticated 401, non-admin 403, cross-org project 404, entry of another project 404', async () => {
  const orgA = await seedOrg('ptr4-a');
  const orgB = await seedOrg('ptr4-b');
  const pA = await seedProject(orgA.id, 'EditAuthA');
  const pB = await seedProject(orgB.id, 'EditAuthB');
  const { entry } = await seedEntry(orgA.id, pA.id, 2);
  const adminB = await tokenFor(orgB.id);

  assert.equal(
    (await projectTimeEntryIdApi.PUT(req(null, { method: 'PUT', body: { hours: 5 } }), { params: Promise.resolve({ id: pA.id, entryId: entry.id }) })).status,
    401
  );
  assert.equal(
    (await projectTimeEntryIdApi.PUT(req(await tokenFor(orgA.id, 'viewer', 'u-ptr4-viewer'), { method: 'PUT', body: { hours: 5 } }), { params: Promise.resolve({ id: pA.id, entryId: entry.id }) })).status,
    403
  );
  // Org B admin on Org A project -> 404.
  assert.equal(
    (await projectTimeEntryIdApi.PUT(req(adminB, { method: 'PUT', body: { hours: 5 } }), { params: Promise.resolve({ id: pA.id, entryId: entry.id }) })).status,
    404
  );
  // Entry belongs to project A but request targets project B -> 404.
  assert.equal(
    (await projectTimeEntryIdApi.PUT(req(await tokenFor(orgA.id), { method: 'PUT', body: { hours: 5 } }), { params: Promise.resolve({ id: pB.id, entryId: entry.id }) })).status,
    404
  );
  // Nonexistent entry -> 404.
  assert.equal(
    (await projectTimeEntryIdApi.PUT(req(await tokenFor(orgA.id), { method: 'PUT', body: { hours: 5 } }), { params: Promise.resolve({ id: pA.id, entryId: 'no-such-entry' }) })).status,
    404
  );
});

// ─── TimeEntry Delete ───────────────────────────────────────────────────────

test('PTR-5: delete entry — row removed, only that entry, aggregates recalc', async () => {
  const orgA = await seedOrg('ptr5-a');
  const p = await seedProject(orgA.id, 'DeleteMe', { hourlyRate: 100 });
  const { entry } = await seedEntry(orgA.id, p.id, 4);
  const keep = await seedEntry(orgA.id, p.id, 2);
  const token = await tokenFor(orgA.id);

  const res = await projectTimeEntryIdApi.DELETE(
    req(token, { method: 'DELETE' }),
    { params: Promise.resolve({ id: p.id, entryId: entry.id }) }
  );
  assert.equal(res.status, 200);

  const gone = await db.timeEntry.findUnique({ where: { id: entry.id } });
  assert.equal(gone, null, 'deleted entry is gone');
  const kept = await db.timeEntry.findUnique({ where: { id: keep.entry.id } });
  assert.ok(kept, 'unrelated entry untouched');
  assert.equal(await db.timeEntry.count({ where: { projectId: p.id } }), 1, 'only the requested entry deleted');

  // Project/employee rows survive.
  assert.ok(await db.project.findUnique({ where: { id: p.id } }), 'project not deleted');
  assert.equal(await db.projectMember.count({ where: { projectId: p.id } }), 2, 'membership not deleted');

  // Aggregates recalc (only 2h remains).
  const detail = await projectIdApi.GET(req(token), { params: Promise.resolve({ id: p.id }) });
  const body = await detail.json();
  assert.equal(body.data.totalHours, 2, 'actual hours decrease after delete');

  const list = await projectTimeEntriesApi.GET(req(token), { params: Promise.resolve({ id: p.id }) });
  const listBody = await list.json();
  assert.equal(listBody.aggregates.totalHours, 2);

  // Audit trail exists.
  const audit = await db.auditLog.findFirst({ where: { resource: 'time_entry', resourceId: entry.id, action: 'delete' } });
  assert.ok(audit, 'delete must be audited');
});

test('PTR-6: delete security — 401/403/404/cross-org/wrong-project', async () => {
  const orgA = await seedOrg('ptr6-a');
  const orgB = await seedOrg('ptr6-b');
  const pA = await seedProject(orgA.id, 'DelAuthA');
  const pB = await seedProject(orgB.id, 'DelAuthB');
  const { entry } = await seedEntry(orgA.id, pA.id, 2);

  assert.equal(
    (await projectTimeEntryIdApi.DELETE(req(null, { method: 'DELETE' }), { params: Promise.resolve({ id: pA.id, entryId: entry.id }) })).status,
    401
  );
  assert.equal(
    (await projectTimeEntryIdApi.DELETE(req(await tokenFor(orgA.id, 'viewer', 'u-ptr6-v'), { method: 'DELETE' }), { params: Promise.resolve({ id: pA.id, entryId: entry.id }) })).status,
    403
  );
  assert.equal(
    (await projectTimeEntryIdApi.DELETE(req(await tokenFor(orgB.id), { method: 'DELETE' }), { params: Promise.resolve({ id: pA.id, entryId: entry.id }) })).status,
    404
  );
  assert.equal(
    (await projectTimeEntryIdApi.DELETE(req(await tokenFor(orgA.id), { method: 'DELETE' }), { params: Promise.resolve({ id: pB.id, entryId: entry.id }) })).status,
    404
  );
  assert.equal(
    (await projectTimeEntryIdApi.DELETE(req(await tokenFor(orgA.id), { method: 'DELETE' }), { params: Promise.resolve({ id: pA.id, entryId: 'missing' }) })).status,
    404
  );
  // Entry still exists — nothing was deleted by the failed attempts.
  assert.ok(await db.timeEntry.findUnique({ where: { id: entry.id } }));
});

// ─── Archive filtering ──────────────────────────────────────────────────────

test('PTR-7: default list hides cancelled; includeArchived=true shows them; explicit status wins', async () => {
  const orgA = await seedOrg('ptr7-a');
  await seedProject(orgA.id, 'ActiveOne', { status: 'active' });
  await seedProject(orgA.id, 'HoldOne', { status: 'on_hold' });
  await seedProject(orgA.id, 'DoneOne', { status: 'completed' });
  await seedProject(orgA.id, 'DeadOne', { status: 'cancelled' });
  const token = await tokenFor(orgA.id);

  const def = await projectsApi.GET(req(token, { url: 'http://localhost:3000/api/projects?pageSize=50' }));
  const defBody = await def.json();
  assert.equal(defBody.total, 3, 'cancelled hidden by default');
  assert.ok(defBody.data.every((p: { status: string }) => p.status !== 'cancelled'));

  const incl = await projectsApi.GET(req(token, { url: 'http://localhost:3000/api/projects?pageSize=50&includeArchived=true' }));
  const inclBody = await incl.json();
  assert.equal(inclBody.total, 4, 'includeArchived brings cancelled back');

  // Explicit status=cancelled still works regardless of the archive default.
  const cancelled = await projectsApi.GET(req(token, { url: 'http://localhost:3000/api/projects?status=cancelled&pageSize=50' }));
  const cancelledBody = await cancelled.json();
  assert.equal(cancelledBody.total, 1, 'explicit status filter wins');

  // Search route mirrors the same default (selectors don't offer archived).
  const searchDef = await projectSearchApi.GET(req(token, { url: 'http://localhost:3000/api/projects/search?q=One&limit=50' }));
  assert.equal((await searchDef.json()).total, 3);
  const searchArch = await projectSearchApi.GET(req(token, { url: 'http://localhost:3000/api/projects/search?q=One&limit=50&includeArchived=true' }));
  assert.equal((await searchArch.json()).total, 4);
});

test('PTR-8: archive filter + search + priority + pagination stay consistent', async () => {
  const orgA = await seedOrg('ptr8-a');
  for (let i = 1; i <= 5; i++) {
    await seedProject(orgA.id, `ArchSearch-${i}`, { status: i % 2 === 0 ? 'active' : 'cancelled', priority: 'high' });
  }
  await seedProject(orgA.id, 'ArchSearch-other', { status: 'active', priority: 'low' });
  const token = await tokenFor(orgA.id);

  // Search narrows within the archive default: ArchSearch-N with even N are
  // active (high) — N=2, N=4 → 2 active; N=1,3,5 are cancelled (high).
  const res = await projectsApi.GET(req(token, {
    url: `http://localhost:3000/api/projects?search=${encodeURIComponent('ArchSearch')}&priority=high&pageSize=2&page=1`,
  }));
  const body = await res.json();
  assert.equal(body.total, 2, 'search+priority filter inside archive default');
  assert.equal(body.data.length, 2);
  assert.equal(body.totalPages, 1);
  assert.ok(body.data.every((p: { status: string }) => p.status !== 'cancelled'));

  // With archived included, the same search returns all 5 high-priority.
  const incl = await projectsApi.GET(req(token, {
    url: `http://localhost:3000/api/projects?search=${encodeURIComponent('ArchSearch')}&priority=high&pageSize=50&includeArchived=true`,
  }));
  const inclBody = await incl.json();
  assert.equal(inclBody.total, 5);
  assert.equal(inclBody.data.filter((p: { status: string }) => p.status === 'cancelled').length, 3, 'cancelled present when included');

  // Sorting still works under the archive default.
  const byName = await projectsApi.GET(req(token, { url: 'http://localhost:3000/api/projects?sortBy=name&pageSize=50' }));
  const names = (await byName.json()).data.map((p: { name: string }) => p.name);
  assert.deepEqual(names, [...names].sort(), 'server-side sort intact');
});

// ─── Restore ────────────────────────────────────────────────────────────────

test('PTR-9: restore — cancelled -> active, history preserved, audited; non-cancelled 409', async () => {
  const orgA = await seedOrg('ptr9-a');
  const p = await seedProject(orgA.id, 'RestoreMe', { status: 'cancelled' });
  const { entry } = await seedEntry(orgA.id, p.id, 3);
  const token = await tokenFor(orgA.id);

  const res = await projectRestoreApi.POST(req(token, { method: 'POST' }), { params: Promise.resolve({ id: p.id }) });
  assert.equal(res.status, 200);
  const restored = (await res.json()).data;
  assert.equal(restored.status, 'active', 'uses existing status enum');

  const inDb = await db.project.findUnique({ where: { id: p.id } });
  assert.equal(inDb!.status, 'active');
  assert.equal(await db.projectMember.count({ where: { projectId: p.id } }), 1, 'members preserved');
  assert.equal(await db.timeEntry.count({ where: { projectId: p.id } }), 1, 'time entries preserved');
  assert.equal((await db.timeEntry.findUnique({ where: { id: entry.id } }))!.hours, 3, 'data preserved');

  const audit = await db.auditLog.findFirst({ where: { resource: 'project', resourceId: p.id, description: { contains: 'Restored' } } });
  assert.ok(audit, 'restore must be audited');

  // Restoring a non-cancelled project -> 409.
  const active = await seedProject(orgA.id, 'AlreadyActive', { status: 'active' });
  assert.equal(
    (await projectRestoreApi.POST(req(token, { method: 'POST' }), { params: Promise.resolve({ id: active.id }) })).status,
    409
  );

  // Restored project appears in the default list again.
  const list = await projectsApi.GET(req(token, { url: 'http://localhost:3000/api/projects?pageSize=50' }));
  const names = (await list.json()).data.map((x: { name: string }) => x.name);
  assert.ok(names.includes('RestoreMe'), 'restored project visible in default active list');
});

test('PTR-10: restore security — 401/403/404/cross-org', async () => {
  const orgA = await seedOrg('ptr10-a');
  const orgB = await seedOrg('ptr10-b');
  const pA = await seedProject(orgA.id, 'RestoreAuthA', { status: 'cancelled' });
  const pB = await seedProject(orgB.id, 'RestoreAuthB', { status: 'cancelled' });

  assert.equal((await projectRestoreApi.POST(req(null, { method: 'POST' }), { params: Promise.resolve({ id: pA.id }) })).status, 401);
  assert.equal((await projectRestoreApi.POST(req(await tokenFor(orgA.id, 'viewer', 'u-ptr10-v'), { method: 'POST' }), { params: Promise.resolve({ id: pA.id }) })).status, 403);
  assert.equal((await projectRestoreApi.POST(req(await tokenFor(orgB.id), { method: 'POST' }), { params: Promise.resolve({ id: pA.id }) })).status, 404);
  assert.equal((await projectRestoreApi.POST(req(await tokenFor(orgA.id), { method: 'POST' }), { params: Promise.resolve({ id: pB.id }) })).status, 404);
  assert.equal((await projectRestoreApi.POST(req(await tokenFor(orgA.id), { method: 'POST' }), { params: Promise.resolve({ id: 'missing' }) })).status, 404);

  // Org A project still cancelled (nothing restored by failed attempts).
  assert.equal((await db.project.findUnique({ where: { id: pA.id } }))!.status, 'cancelled');
});

// ─── Data integrity ─────────────────────────────────────────────────────────

test('PTR-11: full cycle — create → edit 4h→6h → delete; cost/progress derive from rows only', async () => {
  const orgA = await seedOrg('ptr11-a');
  const p = await seedProject(orgA.id, 'Integrity', { estimatedHours: 20, hourlyRate: 100 });
  const { entry } = await seedEntry(orgA.id, p.id, 4);
  const token = await tokenFor(orgA.id);

  // Before: 4h → $400 actual, 20% progress.
  const before = await projectIdApi.GET(req(token), { params: Promise.resolve({ id: p.id }) });
  const beforeBody = await before.json();
  assert.equal(beforeBody.data.totalHours, 4);
  assert.equal(beforeBody.data.progress, 20);

  // Edit 4h → 6h: $600 actual, 30% progress.
  await projectTimeEntryIdApi.PUT(
    req(token, { method: 'PUT', body: { hours: 6 } }),
    { params: Promise.resolve({ id: p.id, entryId: entry.id }) }
  );
  const mid = await projectIdApi.GET(req(token), { params: Promise.resolve({ id: p.id }) });
  const midBody = await mid.json();
  assert.equal(midBody.data.totalHours, 6);
  assert.equal(midBody.data.progress, 30);
  assert.equal(midBody.data.totalHours * midBody.data.hourlyRate, 600, 'actual cost derives from rows');

  // Delete: back to 0h, 0%.
  await projectTimeEntryIdApi.DELETE(req(token, { method: 'DELETE' }), { params: Promise.resolve({ id: p.id, entryId: entry.id }) });
  const after = await projectIdApi.GET(req(token), { params: Promise.resolve({ id: p.id }) });
  const afterBody = await after.json();
  assert.equal(afterBody.data.totalHours, 0);
  assert.equal(afterBody.data.progress, 0);

  // No orphan rows.
  assert.equal(await db.timeEntry.count({ where: { projectId: p.id } }), 0);
});

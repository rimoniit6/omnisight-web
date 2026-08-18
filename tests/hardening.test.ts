/**
 * Production Hardening — regression tests for P1/P2/P3 findings (session audit).
 *
 * Covers the fixes applied in the security-hardening pass:
 *   - null/malformed member role + hoursPerWeek -> 422 (was Prisma 500)
 *   - validatePagination strictness (NaN, negative, oversized pageSize) -> 422
 *   - time-entries: invalid dateFrom/dateTo -> 422 (was Prisma 500)
 *   - time-entries total is filter-aware (was unfiltered count)
 *   - self/consents GET is READ-ONLY (no rows/logs written from a GET)
 *   - self/consents requiresReconsent binds policy id AND version
 *   - consent POST: 201 fresh / 200 transition; notes cap -> 400; no published
 *     policy -> 409; performedBy always the authenticated admin
 *   - consent PUT: client-supplied performedBy is ignored
 *   - consent bulk: unknown consentTypes rejected before any write
 *   - auditLog.userId is always populated on project/member/time-entry writes
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_hardening).
 * Run: npx tsx --test tests/hardening.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation (must be set BEFORE any app module import) ──────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_hardening';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-hardening-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

before(() => {
  if (process.env.HARDENING_TEST_MIGRATED_DB !== '1') {
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
let CONSENT_TYPES: readonly string[];
let MAX_CONSENT_NOTES_LENGTH: number;

type ProjectsApi = typeof import('../src/app/api/projects/route');
type ProjectMembersApi = typeof import('../src/app/api/projects/[id]/members/route');
type ProjectMemberIdApi = typeof import('../src/app/api/projects/[id]/members/[memberId]/route');
type ProjectTimeEntriesApi = typeof import('../src/app/api/projects/[id]/time-entries/route');
type ConsentApi = typeof import('../src/app/api/consent/route');
type ConsentIdApi = typeof import('../src/app/api/consent/[id]/route');
type ConsentBulkApi = typeof import('../src/app/api/consent/bulk/route');
type SelfConsentsApi = typeof import('../src/app/api/self/consents/route');
type SelfConsentIdApi = typeof import('../src/app/api/self/consents/[id]/route');
type SelfTelemetrySummaryApi = typeof import('../src/app/api/self/telemetry-summary/route');

let projectsApi: ProjectsApi;
let projectMembersApi: ProjectMembersApi;
let projectMemberIdApi: ProjectMemberIdApi;
let projectTimeEntriesApi: ProjectTimeEntriesApi;
let consentApi: ConsentApi;
let consentIdApi: ConsentIdApi;
let consentBulkApi: ConsentBulkApi;
let selfConsentsApi: SelfConsentsApi;
let selfConsentIdApi: SelfConsentIdApi;
let selfTelemetrySummaryApi: SelfTelemetrySummaryApi;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  ({ CONSENT_TYPES, MAX_CONSENT_NOTES_LENGTH } = await import('../src/lib/consent'));

  const [pApi, pmApi, pmiApi, pteApi, cApi, cIdApi, cBulkApi, scApi, scIdApi, stApi] = await Promise.all([
    import('../src/app/api/projects/route'),
    import('../src/app/api/projects/[id]/members/route'),
    import('../src/app/api/projects/[id]/members/[memberId]/route'),
    import('../src/app/api/projects/[id]/time-entries/route'),
    import('../src/app/api/consent/route'),
    import('../src/app/api/consent/[id]/route'),
    import('../src/app/api/consent/bulk/route'),
    import('../src/app/api/self/consents/route'),
    import('../src/app/api/self/consents/[id]/route'),
    import('../src/app/api/self/telemetry-summary/route'),
  ]);
  projectsApi = pApi;
  projectMembersApi = pmApi;
  projectMemberIdApi = pmiApi;
  projectTimeEntriesApi = pteApi;
  consentApi = cApi;
  consentIdApi = cIdApi;
  consentBulkApi = cBulkApi;
  selfConsentsApi = scApi;
  selfConsentIdApi = scIdApi;
  selfTelemetrySummaryApi = stApi;
});

after(async () => {
  await db.$disconnect();
  if (process.env.HARDENING_TEST_MIGRATED_DB !== '1') {
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

function tokenFor(orgId: string, role = 'admin', userId = 'u-hardening') {
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

async function seedMember(projectId: string, employeeId: string, orgId: string) {
  return db.projectMember.create({ data: { projectId, employeeId, organizationId: orgId } });
}

async function publishPolicy(orgId: string, consentType: string) {
  await db.consentPolicy.updateMany({
    where: { organizationId: orgId, consentType, status: 'published' },
    data: { status: 'archived' },
  });
  const existing = await db.consentPolicy.findMany({
    where: { organizationId: orgId, consentType },
    select: { version: true },
  });
  const { nextPolicyVersion } = await import('../src/lib/consent');
  const version = nextPolicyVersion(existing.map((p) => p.version));
  return db.consentPolicy.create({
    data: {
      organizationId: orgId,
      consentType,
      title: `${consentType} Policy`,
      content: 'Test policy content.',
      status: 'published',
      version,
    },
  });
}

// ─── P1-1: null / malformed member fields ───────────────────────────────────

test('H-01: member POST rejects role:null with 422 (no 500)', async () => {
  const orgA = await seedOrg('hard-01-a');
  const emp = await seedEmployee(orgA.id, 'H01-E1');
  const project = await seedProject(orgA.id, 'H01-Proj');
  const token = await tokenFor(orgA.id);

  const res = await projectMembersApi.POST(
    req(token, { method: 'POST', url: `http://localhost:3000/api/projects/${project.id}/members`, body: { employeeId: emp.id, role: null } }),
    { params: Promise.resolve({ id: project.id }) }
  );
  assert.equal(res.status, 422);
  const inDb = await db.projectMember.count({ where: { projectId: project.id } });
  assert.equal(inDb, 0, 'no member row may be created for an invalid role');
});

test('H-02: member POST rejects hoursPerWeek:null with 422 (no 500)', async () => {
  const orgA = await seedOrg('hard-02-a');
  const emp = await seedEmployee(orgA.id, 'H02-E1');
  const project = await seedProject(orgA.id, 'H02-Proj');
  const token = await tokenFor(orgA.id);

  const res = await projectMembersApi.POST(
    req(token, { method: 'POST', url: `http://localhost:3000/api/projects/${project.id}/members`, body: { employeeId: emp.id, role: 'member', hoursPerWeek: null } }),
    { params: Promise.resolve({ id: project.id }) }
  );
  assert.equal(res.status, 422);
});

test('H-03: member POST rejects NaN / out-of-range hoursPerWeek with 422', async () => {
  const orgA = await seedOrg('hard-03-a');
  const emp = await seedEmployee(orgA.id, 'H03-E1');
  const project = await seedProject(orgA.id, 'H03-Proj');
  const token = await tokenFor(orgA.id);

  for (const hoursPerWeek of ['abc', -1, 169, Infinity]) {
    const res = await projectMembersApi.POST(
      req(token, { method: 'POST', url: `http://localhost:3000/api/projects/${project.id}/members`, body: { employeeId: emp.id, role: 'member', hoursPerWeek } }),
      { params: Promise.resolve({ id: project.id }) }
    );
    assert.equal(res.status, 422, `hoursPerWeek=${JSON.stringify(hoursPerWeek)} must be 422`);
  }
});

test('H-04: member PUT rejects role:null and hoursPerWeek:null with 422, row untouched', async () => {
  const orgA = await seedOrg('hard-04-a');
  const emp = await seedEmployee(orgA.id, 'H04-E1');
  const project = await seedProject(orgA.id, 'H04-Proj');
  const member = await seedMember(project.id, emp.id, orgA.id);
  await db.projectMember.update({ where: { id: member.id }, data: { role: 'lead', hoursPerWeek: 30 } });
  const token = await tokenFor(orgA.id);

  const url = `http://localhost:3000/api/projects/${project.id}/members/${member.id}`;
  for (const body of [{ role: null }, { hoursPerWeek: null }, { role: 42 }, { hoursPerWeek: -5 }]) {
    const res = await projectMemberIdApi.PUT(req(token, { method: 'PUT', url, body }), { params: Promise.resolve({ id: project.id, memberId: member.id }) });
    assert.equal(res.status, 422, `body=${JSON.stringify(body)} must be 422`);
  }

  const after = await db.projectMember.findUnique({ where: { id: member.id } });
  assert.equal(after!.role, 'lead', 'row must remain untouched');
  assert.equal(after!.hoursPerWeek, 30, 'row must remain untouched');
  const logs = await db.auditLog.count({ where: { resourceId: member.id } });
  assert.equal(logs, 0, 'rejected updates must not write audit logs');
});

// ─── P1-2/P1-6: validatePagination strictness ───────────────────────────────

test('H-05: projects GET rejects NaN / negative / oversized pagination with 422', async () => {
  const orgA = await seedOrg('hard-05-a');
  await seedProject(orgA.id, 'H05-Proj');
  const token = await tokenFor(orgA.id);

  for (const qs of ['page=abc', 'page=-1', 'pageSize=0', 'pageSize=abc', 'pageSize=1000', 'page=1.5']) {
    const res = await projectsApi.GET(req(token, { url: `http://localhost:3000/api/projects?${qs}` }));
    assert.equal(res.status, 422, `query "${qs}" must be 422`);
  }
});

test('H-06: time-entries GET rejects invalid pagination AND invalid dates with 422', async () => {
  const orgA = await seedOrg('hard-06-a');
  const emp = await seedEmployee(orgA.id, 'H06-E1');
  const project = await seedProject(orgA.id, 'H06-Proj');
  await seedMember(project.id, emp.id, orgA.id);
  const token = await tokenFor(orgA.id);
  const url = (qs: string) => `http://localhost:3000/api/projects/${project.id}/time-entries?${qs}`;

  for (const qs of ['page=abc', 'pageSize=5000', 'dateFrom=not-a-date', 'dateTo=xyz', 'dateFrom=2024-13-01']) {
    const res = await projectTimeEntriesApi.GET(req(token, { url: url(qs) }), { params: Promise.resolve({ id: project.id }) });
    assert.equal(res.status, 422, `query "${qs}" must be 422`);
  }
});

// ─── P2-2: filter-aware total ───────────────────────────────────────────────

test('H-07: time-entries total reflects date filters (was unfiltered count)', async () => {
  const orgA = await seedOrg('hard-07-a');
  const emp = await seedEmployee(orgA.id, 'H07-E1');
  const project = await seedProject(orgA.id, 'H07-Proj');
  await seedMember(project.id, emp.id, orgA.id);
  const token = await tokenFor(orgA.id);

  await db.timeEntry.create({ data: { projectId: project.id, employeeId: emp.id, date: new Date('2026-01-05'), hours: 1, organizationId: orgA.id } });
  await db.timeEntry.create({ data: { projectId: project.id, employeeId: emp.id, date: new Date('2026-03-10'), hours: 2, organizationId: orgA.id } });

  const url = `http://localhost:3000/api/projects/${project.id}/time-entries?dateFrom=2026-03-01&dateTo=2026-03-31`;
  const res = await projectTimeEntriesApi.GET(req(token, { url }), { params: Promise.resolve({ id: project.id }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.total, 1, 'total must reflect the date-filtered set');
  assert.equal(body.data.length, 1);
});

// ─── P1-4: self/consents GET is read-only ──────────────────────────────────

test('H-08: self/consents GET never writes Consent or ConsentLog rows', async () => {
  const orgA = await seedOrg('hard-08-a');
  const emp = await seedEmployee(orgA.id, 'H08-E1');
  const token = await tokenFor(orgA.id, 'manager');
  await publishPolicy(orgA.id, CONSENT_TYPES[0]);

  const consentCountBefore = await db.consent.count({ where: { employeeId: emp.id } });
  const logCountBefore = await db.consentLog.count({ where: { consent: { employeeId: emp.id } } });

  const res = await selfConsentsApi.GET(req(token, { url: `http://localhost:3000/api/self/consents?employeeId=${emp.id}` }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.length, CONSENT_TYPES.length, 'all supported types rendered');

  const consentCountAfter = await db.consent.count({ where: { employeeId: emp.id } });
  const logCountAfter = await db.consentLog.count({ where: { consent: { employeeId: emp.id } } });
  assert.equal(consentCountAfter, consentCountBefore, 'no consent rows may be created by GET');
  assert.equal(logCountAfter, logCountBefore, 'no consent log rows may be created by GET');

  // Synthetic rows expose a pending marker id, never a real persisted record.
  const synthetic = body.data.find((c: { id: string }) => String(c.id).startsWith('pending:'));
  assert.ok(synthetic, 'missing types are synthesized as pending');
  assert.equal(synthetic.status, 'pending');
});

test('H-09: self/consents requiresReconsent binds policy id AND version', async () => {
  const orgA = await seedOrg('hard-09-a');
  const emp = await seedEmployee(orgA.id, 'H09-E1');
  const token = await tokenFor(orgA.id, 'manager');

  const policyV1 = await publishPolicy(orgA.id, 'activity_tracking');
  await db.consent.create({
    data: {
      employeeId: emp.id,
      consentType: 'activity_tracking',
      status: 'granted',
      consentVersion: policyV1.version,
      policyId: policyV1.id,
      organizationId: orgA.id,
    },
  });

  const fresh = await selfConsentsApi.GET(req(token, { url: `http://localhost:3000/api/self/consents?employeeId=${emp.id}` }));
  const freshBody = await fresh.json();
  const freshRow = freshBody.data.find((c: { consentType: string }) => c.consentType === 'activity_tracking');
  assert.equal(freshRow.requiresReconsent, false, 'grant bound to current policy+version');

  // Version bump without republish
  await db.consentPolicy.update({ where: { id: policyV1.id }, data: { version: 'v2' } });
  const bumped = await selfConsentsApi.GET(req(token, { url: `http://localhost:3000/api/self/consents?employeeId=${emp.id}` }));
  const bumpedBody = await bumped.json();
  const bumpedRow = bumpedBody.data.find((c: { consentType: string }) => c.consentType === 'activity_tracking');
  assert.equal(bumpedRow.requiresReconsent, true, 'version bump must set requiresReconsent');

  // Republish (new policy id, same version)
  await db.consentPolicy.update({ where: { id: policyV1.id }, data: { version: 'v1', status: 'archived' } });
  const policyV2 = await publishPolicy(orgA.id, 'activity_tracking');
  const republished = await selfConsentsApi.GET(req(token, { url: `http://localhost:3000/api/self/consents?employeeId=${emp.id}` }));
  const republishedBody = await republished.json();
  const republishedRow = republishedBody.data.find((c: { consentType: string }) => c.consentType === 'activity_tracking');
  assert.equal(republishedRow.requiresReconsent, true, 'new policy id must set requiresReconsent');
  assert.ok(policyV2.id !== policyV1.id);
});

// ─── P3-6 / P3-10 / P1-5: consent POST semantics ───────────────────────────

test('H-10: consent POST returns 201 on fresh create, 200 on transition', async () => {
  const orgA = await seedOrg('hard-10-a');
  const emp = await seedEmployee(orgA.id, 'H10-E1');
  const token = await tokenFor(orgA.id);
  await publishPolicy(orgA.id, 'activity_tracking');

  const url = 'http://localhost:3000/api/consent';
  const first = await consentApi.POST(req(token, { method: 'POST', url, body: { employeeId: emp.id, consentType: 'activity_tracking' } }));
  assert.equal(first.status, 201, 'fresh record must be 201');

  // Revoke via PUT, then re-grant through POST — this TRANSITIONS an existing
  // record, so it must return 200 (not 201).
  const consent = await db.consent.findFirst({ where: { employeeId: emp.id, consentType: 'activity_tracking' } });
  const put = await consentIdApi.PUT(req(token, { method: 'PUT', url: `${url}/${consent!.id}`, body: { status: 'revoked' } }), { params: Promise.resolve({ id: consent!.id }) });
  assert.equal(put.status, 200);

  const second = await consentApi.POST(req(token, { method: 'POST', url, body: { employeeId: emp.id, consentType: 'activity_tracking' } }));
  assert.equal(second.status, 200, 'transitioning an existing record must be 200');
  assert.equal(await db.consent.count({ where: { employeeId: emp.id, consentType: 'activity_tracking' } }), 1, 'still one row');

  // Re-granting an already-granted consent is a duplicate -> 409.
  const third = await consentApi.POST(req(token, { method: 'POST', url, body: { employeeId: emp.id, consentType: 'activity_tracking' } }));
  assert.equal(third.status, 409, 'already-granted must be 409');
});

test('H-11: consent POST rejects notes over 500 chars with 400', async () => {
  const orgA = await seedOrg('hard-11-a');
  const emp = await seedEmployee(orgA.id, 'H11-E1');
  const token = await tokenFor(orgA.id);
  await publishPolicy(orgA.id, 'screenshot');

  const notes = 'x'.repeat(MAX_CONSENT_NOTES_LENGTH + 1);
  const res = await consentApi.POST(req(token, { method: 'POST', url: 'http://localhost:3000/api/consent', body: { employeeId: emp.id, consentType: 'screenshot', notes } }));
  assert.equal(res.status, 400);
  assert.equal(await db.consent.count({ where: { employeeId: emp.id, consentType: 'screenshot' } }), 0, 'no row for over-length notes');
});

test('H-12: consent POST without published policy -> 409, nothing written', async () => {
  const orgA = await seedOrg('hard-12-a');
  const emp = await seedEmployee(orgA.id, 'H12-E1');
  const token = await tokenFor(orgA.id);

  const res = await consentApi.POST(req(token, { method: 'POST', url: 'http://localhost:3000/api/consent', body: { employeeId: emp.id, consentType: 'activity_tracking' } }));
  assert.equal(res.status, 409);
  assert.equal(await db.consent.count({ where: { employeeId: emp.id } }), 0);
  assert.equal(await db.auditLog.count({ where: { organizationId: orgA.id } }), 0, 'no audit noise for a failed consent');
});

test('H-13: consent POST performedBy always equals the authenticated admin', async () => {
  const orgA = await seedOrg('hard-13-a');
  const emp = await seedEmployee(orgA.id, 'H13-E1');
  const token = await tokenFor(orgA.id, 'admin', 'admin-user-13');
  await publishPolicy(orgA.id, 'activity_tracking');

  const res = await consentApi.POST(req(token, { method: 'POST', url: 'http://localhost:3000/api/consent', body: { employeeId: emp.id, consentType: 'activity_tracking' } }));
  assert.equal(res.status, 201);
  const log = await db.consentLog.findFirst({ where: { consent: { employeeId: emp.id, consentType: 'activity_tracking' } } });
  assert.ok(log, 'consent log written');
  assert.equal(log!.performedBy, `admin@${orgA.id.slice(-6)}.local`, 'performedBy must come from the token, not the body');
});

// ─── P3-8: consent PUT ignores client-supplied performedBy ──────────────────

test('H-14: consent PUT ignores client-supplied performedBy (uses auth email)', async () => {
  const orgA = await seedOrg('hard-14-a');
  const emp = await seedEmployee(orgA.id, 'H14-E1');
  const token = await tokenFor(orgA.id, 'admin', 'admin-user-14');
  const policy = await publishPolicy(orgA.id, 'screenshot');

  const consent = await db.consent.create({
    data: { employeeId: emp.id, consentType: 'screenshot', status: 'granted', consentVersion: policy.version, policyId: policy.id, organizationId: orgA.id },
  });

  const url = `http://localhost:3000/api/consent/${consent.id}`;
  const res = await consentIdApi.PUT(
    req(token, { method: 'PUT', url, body: { status: 'revoked', performedBy: 'attacker@evil.local' } }),
    { params: Promise.resolve({ id: consent.id }) }
  );
  assert.equal(res.status, 200);
  const log = await db.consentLog.findFirst({ where: { consentId: consent.id }, orderBy: { createdAt: 'desc' } });
  assert.equal(log!.performedBy, `admin@${orgA.id.slice(-6)}.local`, 'performedBy must be the authenticated admin, never the body');
  assert.equal(log!.action, 'admin_revoked', 'revocation maps to admin_revoked, not a client-chosen action');
});

test('H-15: consent PUT without published policy -> 409', async () => {
  const orgA = await seedOrg('hard-15-a');
  const emp = await seedEmployee(orgA.id, 'H15-E1');
  const token = await tokenFor(orgA.id);

  const consent = await db.consent.create({
    data: { employeeId: emp.id, consentType: 'activity_tracking', status: 'granted', organizationId: orgA.id },
  });

  const url = `http://localhost:3000/api/consent/${consent.id}`;
  const res = await consentIdApi.PUT(req(token, { method: 'PUT', url, body: { status: 'granted' } }), { params: Promise.resolve({ id: consent.id }) });
  assert.equal(res.status, 409);
});

// ─── P2-2: bulk whitelist ───────────────────────────────────────────────────

test('H-16: consent bulk rejects unknown consentTypes before any write', async () => {
  const orgA = await seedOrg('hard-16-a');
  const emp = await seedEmployee(orgA.id, 'H16-E1');
  const token = await tokenFor(orgA.id);

  const countBefore = await db.consent.count({ where: { employeeId: emp.id } });
  const res = await consentBulkApi.POST(req(token, { method: 'POST', url: 'http://localhost:3000/api/consent/bulk', body: { employeeId: emp.id, action: 'grant_types', consentTypes: ['activity_tracking', 'totally_fake_type'] } }));
  assert.equal(res.status, 400);
  assert.equal(await db.consent.count({ where: { employeeId: emp.id } }), countBefore, 'no partial writes allowed');

  const notArray = await consentBulkApi.POST(req(token, { method: 'POST', url: 'http://localhost:3000/api/consent/bulk', body: { employeeId: emp.id, action: 'grant_types', consentTypes: 'activity_tracking' } }));
  assert.equal(notArray.status, 400, 'consentTypes must be an array');
  assert.equal(await db.consent.count({ where: { employeeId: emp.id } }), countBefore);
});

// ─── P2-3: auditLog.userId always populated ─────────────────────────────────

test('H-17: project/member/time-entry writes always populate auditLog.userId', async () => {
  const orgA = await seedOrg('hard-17-a');
  const emp = await seedEmployee(orgA.id, 'H17-E1');
  const token = await tokenFor(orgA.id, 'admin', 'admin-user-17');

  const create = await projectsApi.POST(req(token, { method: 'POST', url: 'http://localhost:3000/api/projects', body: { name: 'H17-Proj' } }));
  const { data: project } = await create.json();

  await projectMembersApi.POST(req(token, { method: 'POST', url: `http://localhost:3000/api/projects/${project.id}/members`, body: { employeeId: emp.id, role: 'member' } }), { params: Promise.resolve({ id: project.id }) });

  const member = await db.projectMember.findFirst({ where: { projectId: project.id, employeeId: emp.id } });
  await projectMemberIdApi.PUT(req(token, { method: 'PUT', url: `http://localhost:3000/api/projects/${project.id}/members/${member!.id}`, body: { role: 'lead' } }), { params: Promise.resolve({ id: project.id, memberId: member!.id }) });

  await projectTimeEntriesApi.POST(req(token, { method: 'POST', url: `http://localhost:3000/api/projects/${project.id}/time-entries`, body: { employeeId: emp.id, date: '2026-01-15', hours: 4 } }), { params: Promise.resolve({ id: project.id }) });

  const logs = await db.auditLog.findMany({ where: { organizationId: orgA.id } });
  assert.ok(logs.length >= 3, 'expected audit logs for create/member/time-entry');
  for (const l of logs) {
    assert.ok(l.userId, `auditLog.userId must be set for ${l.resource} (found ${JSON.stringify(l.userId)})`);
    assert.equal(l.userId, 'admin-user-17', 'auditLog.userId must be the authenticated actor');
  }
});

// ─── H-20: self-portal consent create-on-grant (P1 portal fix) ─────────────

test('H-20: self/consents PUT grants a pending (synthetic) type by creating the record', async () => {
  const org = await seedOrg('hard-20-a');
  const emp = await seedEmployee(org.id, 'H20-EMP');
  await publishPolicy(org.id, 'keystroke');
  const token = await tokenFor(org.id, 'manager', 'mgr-h20');

  // No keystroke row exists yet → GET synthesizes `pending:keystroke`.
  const getRes = await selfConsentsApi.GET(req(token, { url: `http://localhost:3000/api/self/consents?employeeId=${emp.id}` }));
  assert.equal(getRes.status, 200);
  const getBody = (await getRes.json()) as { data: Array<{ id: string; consentType: string; status: string }> };
  const pendingKeystroke = getBody.data.find((c) => c.consentType === 'keystroke');
  assert.ok(pendingKeystroke, 'keystroke consent must be synthesized as pending');
  assert.ok(pendingKeystroke.id.startsWith('pending:'), 'synthetic id must carry the pending: prefix');

  // Grant on the synthetic id → 201 + a real row materialized.
  const putRes = await selfConsentIdApi.PUT(
    req(token, {
      method: 'PUT',
      url: `http://localhost:3000/api/self/consents/${pendingKeystroke.id}`,
      body: { employeeId: emp.id, status: 'granted', consentType: 'keystroke' },
    }),
    { params: Promise.resolve({ id: pendingKeystroke.id }) }
  );
  assert.equal(putRes.status, 201, `grant on pending type must create the record (got ${putRes.status})`);

  const row = await db.consent.findFirst({ where: { employeeId: emp.id, consentType: 'keystroke' } });
  assert.ok(row, 'keystroke consent row must now exist');
  assert.equal(row.status, 'granted', 'created row must be granted (policy bound via the state machine)');
  assert.ok(row.policyId, 'grant binds the published policy');
  assert.equal(row.consentVersion, (await db.consentPolicy.findFirst({ where: { id: row.policyId! } }))?.version);

  // Re-grant (idempotent, same policy) → 200, no duplicate audit log row.
  const putAgain = await selfConsentIdApi.PUT(
    req(token, {
      method: 'PUT',
      url: `http://localhost:3000/api/self/consents/${row.id}`,
      body: { employeeId: emp.id, status: 'granted', consentType: 'keystroke' },
    }),
    { params: Promise.resolve({ id: row.id }) }
  );
  assert.equal(putAgain.status, 200);
  const logs = await db.consentLog.count({ where: { consentId: row.id } });
  assert.equal(logs, 1, 'idempotent re-grant must not create a second audit event');
});

test('H-21: self/consents PUT cannot grant a pending type for a foreign employee (404)', async () => {
  const orgA = await seedOrg('hard-21-a');
  const orgB = await seedOrg('hard-21-b');
  const empB = await seedEmployee(orgB.id, 'H21-EMP');
  await publishPolicy(orgB.id, 'location');
  const tokenA = await tokenFor(orgA.id, 'admin', 'admin-h21');

  const putRes = await selfConsentIdApi.PUT(
    req(tokenA, {
      method: 'PUT',
      url: `http://localhost:3000/api/self/consents/pending:location`,
      body: { employeeId: empB.id, status: 'granted', consentType: 'location' },
    }),
    { params: Promise.resolve({ id: 'pending:location' }) }
  );
  assert.equal(putRes.status, 404, 'foreign employee must be concealed (404), not granted');
  const row = await db.consent.count({ where: { employeeId: empB.id, consentType: 'location' } });
  assert.equal(row, 0, 'no consent row may be created for the foreign employee');
});

// ─── H-22: self telemetry summary (consent + config gated) ─────────────────

test('H-22: self/telemetry-summary returns real aggregates when consent+config enabled', async () => {
  const org = await seedOrg('hard-22-a');
  const emp = await seedEmployee(org.id, 'H22-EMP');
  const token = await tokenFor(org.id, 'manager', 'mgr-h22');

  // Enable keystroke + location config; grant keystroke consent only.
  await db.organizationSetting.createMany({
    data: [
      { organizationId: org.id, key: 'keystroke_logging_enabled', value: 'true', category: 'monitoring' },
      { organizationId: org.id, key: 'location_tracking', value: 'true', category: 'monitoring' },
      { organizationId: org.id, key: 'website_tracking', value: 'true', category: 'monitoring' },
      { organizationId: org.id, key: 'webcam_capture_enabled', value: 'true', category: 'monitoring' },
    ],
  });
  // Grant must be bound to a published policy (hasActiveConsent fails closed
  // without one) — same binding the state machine writes on a real grant.
  const keystrokePolicy = await publishPolicy(org.id, 'keystroke');
  await db.consent.create({
    data: { employeeId: emp.id, organizationId: org.id, consentType: 'keystroke', status: 'granted', policyId: keystrokePolicy.id, consentVersion: keystrokePolicy.version },
  });

  // Seed real telemetry (aggregate-only).
  const now = new Date();
  await db.keyboardActivity.create({
    data: { employeeId: emp.id, organizationId: org.id, intervalStart: new Date(now.getTime() - 3600_000), intervalEnd: now, keystrokeCount: 210, activeTypingSeconds: 90, application: 'code.exe' },
  });
  await db.activity.create({
    data: { employeeId: emp.id, type: 'website', url: 'github.com', title: 'GitHub', category: 'productive', duration: 600, timestamp: now },
  });
  await db.locationEvent.create({
    data: { employeeId: emp.id, organizationId: org.id, latitude: 23.8103, longitude: 90.4125, accuracy: 25, recordedAt: now },
  });

  const res = await selfTelemetrySummaryApi.GET(req(token, { url: `http://localhost:3000/api/self/telemetry-summary?employeeId=${emp.id}` }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    data: {
      websites: { available: boolean; topDomains: Array<{ domain: string; visits: number }> };
      keyboard: { available: boolean; totalKeystrokes: number; totalActiveTypingSeconds: number; intervals: number };
      location: { available: boolean; latest: { latitude: number; longitude: number } | null };
      webcam: { available: boolean; session: unknown };
    };
  };

  // Keystroke: consent granted + config enabled → real aggregates.
  assert.equal(body.data.keyboard.available, true);
  assert.equal(body.data.keyboard.totalKeystrokes, 210);
  assert.equal(body.data.keyboard.totalActiveTypingSeconds, 90);
  assert.equal(body.data.keyboard.intervals, 1);

  // Website: activity_tracking consent MISSING → not available, nothing leaked.
  assert.equal(body.data.websites.available, false);
  assert.equal(body.data.websites.topDomains.length, 0, 'no domains may leak without activity_tracking consent');

  // Location: config enabled but location consent MISSING → unavailable.
  assert.equal(body.data.location.available, false);
  assert.equal(body.data.location.latest, null);

  // Webcam: config enabled but webcam_access consent MISSING → unavailable.
  assert.equal(body.data.webcam.available, false);
  assert.equal(body.data.webcam.session, null);
});

test('H-23: self/telemetry-summary conceals telemetry when config disabled (fail closed)', async () => {
  const org = await seedOrg('hard-23-a');
  const emp = await seedEmployee(org.id, 'H23-EMP');
  const token = await tokenFor(org.id, 'manager', 'mgr-h23');

  // Consent granted but config DISABLED (no org settings rows → defaults false).
  // (No published policy → hasActiveConsent false, which is ALSO fine for this
  // test: the config gate alone must conceal the data.)
  await db.consent.create({ data: { employeeId: emp.id, organizationId: org.id, consentType: 'keystroke', status: 'granted' } });
  const now = new Date();
  await db.keyboardActivity.create({
    data: { employeeId: emp.id, organizationId: org.id, intervalStart: new Date(now.getTime() - 3600_000), intervalEnd: now, keystrokeCount: 999, activeTypingSeconds: 60 },
  });

  const res = await selfTelemetrySummaryApi.GET(req(token, { url: `http://localhost:3000/api/self/telemetry-summary?employeeId=${emp.id}` }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: { keyboard: { available: boolean; configEnabled: boolean; totalKeystrokes: number } } };
  assert.equal(body.data.keyboard.configEnabled, false, 'keystroke_logging_enabled must default to false');
  assert.equal(body.data.keyboard.available, false);
  assert.equal(body.data.keyboard.totalKeystrokes, 0, 'no keystrokes may be reported while the config is disabled');
});

test('H-24: self/telemetry-summary is org-scoped (foreign employee → 404)', async () => {
  const orgA = await seedOrg('hard-24-a');
  const orgB = await seedOrg('hard-24-b');
  const empB = await seedEmployee(orgB.id, 'H24-EMP');
  await db.consent.create({ data: { employeeId: empB.id, organizationId: orgB.id, consentType: 'keystroke', status: 'granted' } });
  const tokenA = await tokenFor(orgA.id, 'manager', 'mgr-h24');

  const res = await selfTelemetrySummaryApi.GET(req(tokenA, { url: `http://localhost:3000/api/self/telemetry-summary?employeeId=${empB.id}` }));
  assert.equal(res.status, 404, 'foreign employee must be concealed (404)');
});

// ─── H-25/H-26: Employee Portal dashboard envelope (P1 — Overview rendered 0s) ─

test('H-25: unwrapDashboard returns the flat contract from the { data } envelope', async () => {
  const { unwrapDashboard } = await import('../src/lib/self-dashboard');
  const payload = {
    todayHours: 11298,
    productiveToday: 2551,
    unproductiveToday: 0,
    weeklyProductivity: 23,
    productivityChange: 0,
    deviceOnline: 1,
    deviceTotal: 1,
    deviceNames: ['Rimon'],
    consentGranted: 8,
    consentTotal: 8,
    consentPending: 0,
    timeBreakdown: { productive: 0.71, neutral: 2.43, unproductive: 0 },
  };
  const flat = unwrapDashboard({ data: payload });
  assert.equal(flat.todayHours, 11298, 'todayHours must come from inside the envelope');
  assert.equal(flat.deviceTotal, 1);
  assert.equal(flat.consentGranted, 8);
  assert.equal(flat.timeBreakdown.productive, 0.71);
});

test('H-26: unwrapDashboard throws on a missing/malformed envelope (error body or 0s guard)', async () => {
  const { unwrapDashboard } = await import('../src/lib/self-dashboard');
  // An API error body ({ error }) must never be coerced to zeroes.
  assert.throws(() => unwrapDashboard({ error: 'Failed to fetch self dashboard' }));
  // A bare flat object (no envelope) must also fail loudly, not render zeros.
  assert.throws(() => unwrapDashboard({ todayHours: 11298 }));
  assert.throws(() => unwrapDashboard(null));
  assert.throws(() => unwrapDashboard(undefined));
});

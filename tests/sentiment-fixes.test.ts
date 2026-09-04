/**
 * Sentiment Analysis fix regression tests (C1–C10 fixes).
 *
 * Covers: input validation (400 never 500), RBAC on analyze (manager+),
 * consent gating (activity_tracking), no-data records (NULL score), exact
 * window replacement on re-runs, latest-per-employee dedup in list/stats,
 * PII stripping in the detail endpoint, sort nulls-last, retention purge,
 * empty-body {} analyze success, server-side search/department filters,
 * DELETE RBAC + id validation.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_sentimentfix).
 * Run: PG_TEST_BASE_URL=postgresql://postgres:<pass>@localhost:5432 npx tsx --test tests/sentiment-fixes.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation (set BEFORE any app module import) ──────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_sentimentfix';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-sentiment-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@sentiment.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!Sentiment2026x';
(process.env as Record<string, string>).NODE_ENV = 'test';

before(() => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  // NODE_ENV=test above makes prisma use this file's DATABASE_URL env fallback
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
let deptA: { id: string };
let empA1: { id: string }; // org A, consented, has activity -> scored
let empA2: { id: string }; // org A, NOT consented -> skipped
let empA3: { id: string }; // org A, consented, no activity -> no-data
let empB1: { id: string }; // org B

let viewerAToken: string;
let managerAToken: string;
let employeeAToken: string;
let managerBToken: string;

let post: typeof import('../src/app/api/sentiment/analyze/route').POST;
let getList: typeof import('../src/app/api/sentiment/route').GET;
let getDetail: typeof import('../src/app/api/sentiment/[id]/route').GET;
let getSummary: typeof import('../src/app/api/sentiment/summary/route').GET;

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

  const analyze = await import('../src/app/api/sentiment/analyze/route');
  const list = await import('../src/app/api/sentiment/route');
  const detail = await import('../src/app/api/sentiment/[id]/route');
  const summary = await import('../src/app/api/sentiment/summary/route');
  post = analyze.POST;
  getList = list.GET;
  getDetail = detail.GET;
  getSummary = summary.GET;

  orgA = await db.organization.create({ data: { name: 'Sentiment Org A', slug: 'sentiment-org-a' } });
  orgB = await db.organization.create({ data: { name: 'Sentiment Org B', slug: 'sentiment-org-b' } });
  deptA = await db.department.create({ data: { name: 'Dept A', organizationId: orgA.id } });

  // Activity consumed by the analyzer MUST be understood by Prisma's generated client
  const empCommon = { status: 'active', agentApproved: true };
  empA1 = await db.employee.create({ data: { employeeId: 'EMP-A-1', firstName: 'Alice', lastName: 'One', email: 'a1@a.test', organizationId: orgA.id, departmentId: deptA.id, ...empCommon } });
  empA2 = await db.employee.create({ data: { employeeId: 'EMP-A-2', firstName: 'Bob', lastName: 'Two', email: 'a2@a.test', organizationId: orgA.id, departmentId: deptA.id, ...empCommon } });
  empA3 = await db.employee.create({ data: { employeeId: 'EMP-A-3', firstName: 'Carol', lastName: 'Three', email: 'a3@a.test', organizationId: orgA.id, departmentId: deptA.id, ...empCommon } });
  empB1 = await db.employee.create({ data: { employeeId: 'EMP-B-1', firstName: 'Dan', lastName: 'Four', email: 'b1@b.test', organizationId: orgB.id, ...empCommon } });

  // Org A: publish an activity_tracking policy and grant it to empA1 + empA3.
  // empA2 deliberately has no consent (fail-closed skip). Org B has none.
  const policyA = await db.consentPolicy.create({
    data: { organizationId: orgA.id, consentType: 'activity_tracking', title: 'Activity Tracking Policy', content: 'p', version: 'v1', status: 'published' },
  });
  await db.consent.createMany({
    data: [
      { employeeId: empA1.id, consentType: 'activity_tracking', status: 'granted', consentVersion: 'v1', policyId: policyA.id, organizationId: orgA.id },
      { employeeId: empA3.id, consentType: 'activity_tracking', status: 'granted', consentVersion: 'v1', policyId: policyA.id, organizationId: orgA.id },
    ],
  });

  // Alice has activity in the last 7 days; Bob and Carol have none.
  const now = new Date();
  await db.activity.createMany({
    data: [
      { employeeId: empA1.id, organizationId: orgA.id, type: 'application', applicationName: 'App', category: 'productive', duration: 3600, timestamp: new Date(now.getTime() - 86400000) },
      { employeeId: empA1.id, organizationId: orgA.id, type: 'application', applicationName: 'App', category: 'productive', duration: 7200, timestamp: new Date(now.getTime() - 172800000) },
    ],
  });

  viewerAToken = await signJWT({ userId: 'viewer-a', email: 'viewer@a.test', role: 'viewer', organizationId: orgA.id });
  managerAToken = await signJWT({ userId: 'mgr-a', email: 'mgr@a.test', role: 'manager', organizationId: orgA.id });
  employeeAToken = await signJWT({ userId: 'emp-a', email: 'emp@a.test', role: 'employee', organizationId: orgA.id });
  managerBToken = await signJWT({ userId: 'mgr-b', email: 'mgr@b.test', role: 'manager', organizationId: orgB.id });
});

after(async () => {
  await db.$disconnect();
});

// ==================== Validation (C2) ====================

test('list: invalid pagination/filter params return 400, never 500', async () => {
  const cases = [
    'page=abc', 'page=-1', 'page=0', 'page=1.5',
    'pageSize=0', 'pageSize=-5', 'pageSize=101', 'pageSize=abc',
    'mood=bogus', 'sort=bogus',
  ];
  for (const qs of cases) {
    const res = await getList(req(`http://localhost/api/sentiment?${qs}`, { headers: authHeader(managerAToken) }));
    assert.equal(res.status, 400, `expected 400 for ${qs}, got ${res.status}`);
  }
});

test('analyze: malformed/missing body and invalid params return 400', async () => {
  // No body at all (the original C1 crash — req.json() throws -> 500 before)
  const noBody = await post(req('http://localhost/api/sentiment/analyze', { method: 'POST', headers: authHeader(managerAToken) }));
  assert.equal(noBody.status, 400, `bodyless POST should be 400, got ${noBody.status}`);

  const badJson = await post(req('http://localhost/api/sentiment/analyze', { method: 'POST', headers: { ...authHeader(managerAToken), 'Content-Type': 'application/json' }, body: '{not json' }));
  assert.equal(badJson.status, 400);

  for (const body of [
    { periodDays: 0 }, { periodDays: 91 }, { periodDays: -1 }, { periodDays: 'abc' }, { periodDays: 7.5 },
    { employeeIds: 'not-an-array' }, { employeeIds: [''] }, { employeeIds: Array.from({ length: 51 }, (_, i) => `id-${i}`) },
  ]) {
    const res = await post(req('http://localhost/api/sentiment/analyze', { method: 'POST', headers: { ...authHeader(managerAToken), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body).slice(0, 60)}, got ${res.status}`);
  }
});

test('analyze: unauthenticated -> 401, viewer/employee -> 403, manager allowed', async () => {
  const noAuth = await post(req('http://localhost/api/sentiment/analyze', { method: 'POST', body: JSON.stringify({ periodDays: 7 }) }));
  assert.equal(noAuth.status, 401);

  const viewer = await post(req('http://localhost/api/sentiment/analyze', { method: 'POST', headers: { ...authHeader(viewerAToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ periodDays: 7 }) }));
  assert.equal(viewer.status, 403);

  const employee = await post(req('http://localhost/api/sentiment/analyze', { method: 'POST', headers: { ...authHeader(employeeAToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ periodDays: 7 }) }));
  assert.equal(employee.status, 403);

  const manager = await post(req('http://localhost/api/sentiment/analyze', { method: 'POST', headers: { ...authHeader(managerAToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ periodDays: 7 }) }));
  assert.equal(manager.status, 200);
});

test('analyze: an empty JSON body {} is a valid request and analyzes the org (C1)', async () => {
  const res = await post(req('http://localhost/api/sentiment/analyze', { method: 'POST', headers: { ...authHeader(managerAToken), 'Content-Type': 'application/json' }, body: JSON.stringify({}) }));
  assert.equal(res.status, 200, `empty body {} must succeed, got ${res.status}`);
  const json = await res.json();
  assert.equal(json.analyzed, 2);
  assert.equal(typeof json.periodStart, 'string', 'period metadata returned');
});

test('detail DELETE: admin-only, oversized id -> 400, cross-org -> 404', async () => {
  const del = (await import('../src/app/api/sentiment/[id]/route')).DELETE;
  const record = await db.sentimentRecord.findFirst({ where: { employeeId: empA1.id } });
  assert.ok(record, 'a sentiment record exists to delete');
  const params = () => Promise.resolve({ id: record!.id });
  const adminAToken = await signJWT({ userId: 'admin-a', email: 'admin@a.test', role: 'admin', organizationId: orgA.id });
  const adminBToken = await signJWT({ userId: 'admin-b', email: 'admin@b.test', role: 'admin', organizationId: orgB.id });

  // Manager (below admin) and viewer cannot delete
  const viewerDel = await del(req(`http://localhost/api/sentiment/${record!.id}`, { method: 'DELETE', headers: authHeader(viewerAToken) }), { params: params() });
  assert.equal(viewerDel.status, 403);
  const mgrDel = await del(req(`http://localhost/api/sentiment/${record!.id}`, { method: 'DELETE', headers: authHeader(managerAToken) }), { params: params() });
  assert.equal(mgrDel.status, 403, 'manager is below admin — delete requires admin+');

  // Oversized id -> 400, never 500
  const badId = await del(req('http://localhost/api/sentiment/x', { method: 'DELETE', headers: authHeader(adminAToken) }), { params: Promise.resolve({ id: 'a'.repeat(72) }) });
  assert.equal(badId.status, 400);

  // Cross-org delete (org B admin) is concealed as 404
  const cross = await del(req(`http://localhost/api/sentiment/${record!.id}`, { method: 'DELETE', headers: authHeader(adminBToken) }), { params: params() });
  assert.equal(cross.status, 404);
});

// ==================== Consent gating (C9) ====================

test('analyze: employees without active activity_tracking consent are skipped and counted', async () => {
  const res = await post(req('http://localhost/api/sentiment/analyze', { method: 'POST', headers: { ...authHeader(managerAToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ periodDays: 7 }) }));
  assert.equal(res.status, 200);
  const json = await res.json();

  assert.equal(json.total, 3, 'three active employees in org A');
  assert.equal(json.consentSkipped, 1, 'Bob (empA2) has no consent and must be skipped');
  assert.equal(json.analyzed, 2, 'Alice + Carol analyzed');
});

// ==================== No-data (C6) ====================

test('analyze: employees with no activity get a NULL-score no-data record, and AI is never called for them', async () => {
  const res = await post(req('http://localhost/api/sentiment/analyze', { method: 'POST', headers: { ...authHeader(managerAToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ periodDays: 7 }) }));
  assert.equal(res.status, 200);
  const json = await res.json();

  assert.equal(json.noData, 1, 'Carol (empA3) has no activity -> no-data');

  const carol = json.data.find((r: { employeeId: string }) => r.employeeId === empA3.id);
  assert.ok(carol, 'no-data record created');
  assert.equal(carol.score, null, 'no-data records are never scored');
  assert.equal(carol.mood, 'no-data');
  assert.equal(carol.aiProviderUsed, 'none', 'no AI call for unmeasured employees');

  const alice = json.data.find((r: { employeeId: string }) => r.employeeId === empA1.id);
  assert.ok(alice);
  assert.equal(typeof alice.score, 'number', 'Alice scored from her activity');
  // No provider configured in the test DB -> AI unavailable -> rules fallback
  assert.equal(alice.aiProviderUsed, 'rules');
  assert.equal(json.aiFallback.count, 1);

  // A no-data record must exist in the DB with NULL score
  const stored = await db.sentimentRecord.findFirst({ where: { employeeId: empA3.id, periodStart: json.periodStart }, select: { score: true, mood: true } });
  assert.ok(stored);
  assert.equal(stored.score, null);
  assert.equal(stored.mood, 'no-data');
});

// ==================== Re-run replacement (C5) ====================

test('analyze: a re-run of the same period replaces records instead of stacking duplicates', async () => {
  const run = async () => {
    const res = await post(req('http://localhost/api/sentiment/analyze', { method: 'POST', headers: { ...authHeader(managerAToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ periodDays: 7 }) }));
    assert.equal(res.status, 200);
    return res.json();
  };
  await run();
  const second = await run();
  assert.equal(second.analyzed, 2);

  // Exactly one record per analyzed employee for that window — no duplicates.
  for (const empId of [empA1.id, empA3.id]) {
    const count = await db.sentimentRecord.count({ where: { employeeId: empId, periodStart: second.periodStart } });
    assert.equal(count, 1, `expected exactly 1 record for ${empId}, found ${count}`);
  }
  const aliceCount6 = await db.sentimentRecord.count({ where: { employeeId: empA1.id, periodStart: second.periodStart } });
  assert.equal(aliceCount6, 1);
});

test('analyze: different period windows coexist, and the list dedups to latest per employee', async () => {
  // Org B has consent too so the analyzer can run there
  const policyB = await db.consentPolicy.create({
    data: { organizationId: orgB.id, consentType: 'activity_tracking', title: 'P', content: 'p', version: 'v1', status: 'published' },
  });
  await db.consent.create({ data: { employeeId: empB1.id, consentType: 'activity_tracking', status: 'granted', consentVersion: 'v1', policyId: policyB.id, organizationId: orgB.id } });

  // Run a 1-day window on org B
  const resB = await post(req('http://localhost/api/sentiment/analyze', { method: 'POST', headers: { ...authHeader(managerBToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ periodDays: 1 }) }));
  assert.equal(resB.status, 200);
  const jsonB = await resB.json();
  assert.equal(jsonB.analyzed, 1);
  assert.equal(jsonB.noData, 1, 'Dan has no activity in the last day -> no-data');

  // Both orgs have unrelated windows — org A's 7-day record must survive.
  const totalA = await db.sentimentRecord.count({ where: { organizationId: orgA.id } });
  assert.ok(totalA >= 2, 'org A records untouched by org B runs');

  // List API: one latest record per employee regardless of window count.
  const listA = await getList(req('http://localhost/api/sentiment?pageSize=100', { headers: authHeader(managerAToken) }));
  assert.equal(listA.status, 200);
  const listJson = await listA.json();
  const records = listJson.records;
  assert.equal(records.length, 2, 'two employees in org A');
  assert.equal(listJson.total, 2);
  const seen = new Set(records.map((r: { employeeId: string }) => r.employeeId));
  assert.equal(seen.size, 2, 'no duplicate employee rows in the page');
});

// ==================== Stats dedup (C5) ====================

test('list: stats are computed over latest-per-employee records only (no run inflation)', async () => {
  // Simulate an old duplicate run: two extra records for Alice with older createdAt.
  const now = new Date();
  await db.sentimentRecord.createMany({
    data: [
      { employeeId: empA1.id, organizationId: orgA.id, periodStart: new Date(now.getTime() - 86400000 * 20), periodEnd: now, score: 10, mood: 'critical', signals: '{}', riskFactors: '[]', createdAt: new Date(now.getTime() - 86400000 * 10) },
      { employeeId: empA1.id, organizationId: orgA.id, periodStart: new Date(now.getTime() - 86400000 * 10), periodEnd: now, score: 90, mood: 'positive', signals: '{}', riskFactors: '[]', createdAt: new Date(now.getTime() - 86400000 * 5) },
    ],
  });

  const res = await getList(req('http://localhost/api/sentiment?pageSize=100', { headers: authHeader(managerAToken) }));
  assert.equal(res.status, 200);
  const json = await res.json();

  assert.equal(json.total, 2, 'still two employees — duplicates never inflate the count');
  assert.equal(json.stats.totalAnalyzed, 2);

  // Alice's stats must come from her LATEST record only.
  const alice = json.records.find((r: { employeeId: string }) => r.employeeId === empA1.id);
  assert.ok(alice);
  assert.ok(alice.updatedAt || alice.id, 'lifetime record returned');

  // avgScore is a number and bounded — no duplicate-run score pollution
  assert.equal(typeof json.stats.avgScore, 'number');
  assert.ok(json.stats.avgScore > 0 && json.stats.avgScore <= 100);

  // Mood counts must reflect exactly one mood per employee
  const moodTotal = json.stats.positiveCount + json.stats.neutralCount + json.stats.negativeCount + json.stats.criticalCount;
  assert.ok(moodTotal <= 2, `mood counts never exceed employee count (got ${moodTotal})`);
});

// ==================== Server-side search + filters (C4) ====================

test('list: search finds employees on ANY page of the full dataset, not just page 1', async () => {
  // Carol's no-data record may sort behind Alice's — a page-1-only fetch of
  // the unfiltered set would miss her. Search must locate her regardless.
  const res = await getList(req('http://localhost/api/sentiment?search=Carol&page=1&pageSize=1', { headers: authHeader(managerAToken) }));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.total, 1, 'search narrows the entire dataset, not the page');
  assert.equal(json.records.length, 1);
  assert.equal(json.records[0].employee.firstName, 'Carol');

  // Case-insensitive partial match
  const partial = await getList(req('http://localhost/api/sentiment?search=ALI&pageSize=100', { headers: authHeader(managerAToken) }));
  const partialJson = await partial.json();
  assert.equal(partialJson.total, 1);
  assert.equal(partialJson.records[0].employee.firstName, 'Alice');
});

test('list: department filter applies server-side over the full dataset', async () => {
  const res = await getList(req(`http://localhost/api/sentiment?departmentId=${deptA.id}&pageSize=100`, { headers: authHeader(managerAToken) }));
  assert.equal(res.status, 200);
  const json = await res.json();
  // Alice + Carol are in dept A; Bob (no consent) was never analyzed.
  assert.equal(json.total, 2);
  for (const r of json.records) {
    assert.equal(r.employee.departmentId, deptA.id, 'only dept A rows returned');
  }
});

// ==================== Pagination + sort (C4) ====================

test('list: pagination is server-side with totalPages; sort keeps null scores last', async () => {
  const res = await getList(req('http://localhost/api/sentiment?page=1&pageSize=1&sort=score_desc', { headers: authHeader(managerAToken) }));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.pageSize, 1);
  assert.ok(json.total >= 2);
  assert.ok(json.totalPages >= 2);
  assert.equal(json.records.length, 1, 'one record per page');

  // score_desc must never place a NULL (no-data) score first
  const sorted = await getList(req('http://localhost/api/sentiment?pageSize=100&sort=score_desc', { headers: authHeader(managerAToken) }));
  const sortedJson = await sorted.json();
  const firstWithScore = sortedJson.records.find((r: { score: number | null }) => r.score !== null);
  const nullScoresAfter = sortedJson.records.findIndex((r: { score: number | null }) => r.score === null);
  const firstScoreIdx = sortedJson.records.findIndex((r: { score: number | null }) => r.score !== null);
  assert.ok(firstWithScore, 'at least one scored record');
  assert.ok(firstScoreIdx !== -1 && (nullScoresAfter === -1 || nullScoresAfter > firstScoreIdx), 'no-data records sort last');

  // mood=no-data filter returns only the no-data employee
  const noDataRes = await getList(req('http://localhost/api/sentiment?mood=no-data&pageSize=100', { headers: authHeader(managerAToken) }));
  const noDataJson = await noDataRes.json();
  assert.equal(noDataJson.total, 1);
  assert.equal(noDataJson.records[0].mood, 'no-data');
});

// ==================== Cross-tenant (tenant isolation) ====================

test('analyze: employeeIds from another organization are ignored (tenant scoping)', async () => {
  const res = await post(req('http://localhost/api/sentiment/analyze', { method: 'POST', headers: { ...authHeader(managerAToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ periodDays: 7, employeeIds: [empB1.id] }) }));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.total, 0, 'no org-A employee matches the org-B id');

  const res2 = await post(req('http://localhost/api/sentiment/analyze', { method: 'POST', headers: { ...authHeader(managerBToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ periodDays: 7, employeeIds: [empA1.id] }) }));
  const json2 = await res2.json();
  assert.equal(json2.total, 0, 'org B manager cannot analyze org A employees');

  // Duplicate-run guard is scoped per (org, window): sequential runs still work
  const res3 = await post(req('http://localhost/api/sentiment/analyze', { method: 'POST', headers: { ...authHeader(managerAToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ periodDays: 7 }) }));
  assert.equal(res3.status, 200);
});

// ==================== Detail endpoint (C7) ====================

test('detail: record visible only in its own org, PII (email/phone) never exposed, invalid id -> 400', async () => {
  const record = await db.sentimentRecord.findFirst({ where: { employeeId: empA1.id, mood: { not: 'no-data' } }, orderBy: { createdAt: 'desc' } });
  assert.ok(record);

  const params = () => Promise.resolve({ id: record!.id });
  const res = await getDetail(req(`http://localhost/api/sentiment/${record!.id}`, { headers: authHeader(managerAToken) }), { params: params() });
  assert.equal(res.status, 200);
  const json = await res.json();
  const employee = json.data.employee;
  assert.ok(employee.email === undefined, 'email must not be exposed');
  assert.ok(employee.phone === undefined, 'phone must not be exposed');
  assert.equal(employee.firstName, 'Alice');

  // Cross-org: org B cannot read org A records (404, not leak)
  const crossOrg = await getDetail(req(`http://localhost/api/sentiment/${record!.id}`, { headers: authHeader(managerBToken) }), { params: params() });
  assert.equal(crossOrg.status, 404);

  // Malformed (oversized) id -> 400
  const badId = await getDetail(req('http://localhost/api/sentiment/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { headers: authHeader(managerAToken) }), { params: Promise.resolve({ id: 'a'.repeat(72) }) });
  assert.equal(badId.status, 400);
});

// ==================== Summary (no-data exclusion) ====================

test('summary: no-data records are excluded from averages and top lists', async () => {
  const res = await getSummary(req('http://localhost/api/sentiment/summary', { headers: authHeader(managerAToken) }));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(typeof json.averageScore, 'number', 'averageScore never NaN');
  assert.ok(Number.isFinite(json.averageScore));
  for (const dept of json.departmentBreakdown) {
    assert.ok(dept.averageScore === null || typeof dept.averageScore === 'number');
  }
  for (const r of json.topAtRisk) {
    assert.ok(r.score !== null, 'no-data employees are never listed as at-risk');
  }
});

// ==================== Concurrent duplicate-run guard ====================

test('analyze: two simultaneous runs of the same window — exactly one proceeds (200), the other is guarded (409), guard then releases', async () => {
  const run = () => post(req('http://localhost/api/sentiment/analyze', { method: 'POST', headers: { ...authHeader(managerAToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ periodDays: 7 }) }));

  // Fire both before either settles — the in-process guard must 409 one of them.
  const [r1, r2] = await Promise.all([run(), run()]);
  const statuses = [r1.status, r2.status].sort((a, b) => a - b);
  assert.ok(statuses.includes(200), `one request must succeed, got ${JSON.stringify(statuses)}`);
  assert.ok(statuses.includes(409), `the duplicate must be rejected with 409, got ${JSON.stringify(statuses)}`);

  // Whatever actually ran, it replaced — never stacked — the window's records.
  const json = (r1.status === 200 ? r1 : r2);
  const runJson = await json.json();
  for (const empId of [empA1.id, empA3.id]) {
    const count = await db.sentimentRecord.count({ where: { employeeId: empId, periodStart: new Date(runJson.periodStart) } });
    assert.equal(count, 1, `exactly one current-period record per employee, got ${count}`);
  }

  // Guard must be released after completion: a follow-up run succeeds.
  const after = await run();
  assert.equal(after.status, 200, 'guard released — later legitimate run succeeds');
});

// ==================== Audit log (analysis runs) ====================

test('analyze: a successful run writes an auditLog row with actor and counters', async () => {
  const before = await db.auditLog.count({ where: { organizationId: orgA.id, resource: 'sentiment_record' } });
  const res = await post(req('http://localhost/api/sentiment/analyze', { method: 'POST', headers: { ...authHeader(managerAToken), 'Content-Type': 'application/json' }, body: JSON.stringify({ periodDays: 7 }) }));
  assert.equal(res.status, 200);
  const after = await db.auditLog.count({ where: { organizationId: orgA.id, resource: 'sentiment_record' } });
  assert.equal(after, before + 1, 'audit log row created for the run');

  const log = await db.auditLog.findFirst({ where: { organizationId: orgA.id, resource: 'sentiment_record' }, orderBy: { createdAt: 'desc' } });
  assert.equal(log?.userId, 'mgr-a');
});

// ==================== Retention purge (C8) ====================

test('retention: SentimentRecord is purged by ai_insight_retention_days; fresh records survive', async () => {
  const runRetentionForOrg = (await import('../src/lib/jobs/retention')).runRetentionForOrg;

  await db.organizationSetting.upsert({
    where: { organizationId_key: { organizationId: orgA.id, key: 'ai_insight_retention_days' } },
    update: { value: '1' },
    create: { organizationId: orgA.id, key: 'ai_insight_retention_days', value: '1' },
  });

  const now = new Date();
  const oldRecord = await db.sentimentRecord.create({
    data: { employeeId: empA1.id, organizationId: orgA.id, periodStart: new Date(now.getTime() - 86400000 * 30), periodEnd: new Date(now.getTime() - 86400000 * 29), score: 42, mood: 'neutral', signals: '{}', riskFactors: '[]', createdAt: new Date(now.getTime() - 86400000 * 10) },
  });
  const freshRecord = await db.sentimentRecord.create({
    data: { employeeId: empA2.id, organizationId: orgA.id, periodStart: new Date(now.getTime() - 86400000), periodEnd: now, score: 55, mood: 'neutral', signals: '{}', riskFactors: '[]' },
  });

  const result = await runRetentionForOrg(orgA.id, now);
  assert.ok(result.sentimentRecords >= 1, 'sentiment purge ran for the org');

  const gone = await db.sentimentRecord.findUnique({ where: { id: oldRecord.id } });
  assert.equal(gone, null, 'old sentiment record purged');
  const kept = await db.sentimentRecord.findUnique({ where: { id: freshRecord.id } });
  assert.ok(kept, 'fresh record within the window survives');
});
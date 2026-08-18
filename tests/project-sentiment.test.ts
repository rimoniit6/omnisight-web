/**
 * WorkLensAI — Project-Scoped Sentiment tests (71→100 certification suite).
 *
 * Covers: RBAC on analyze (manager+), tenant isolation (cross-org 404),
 * project membership validation, activity_tracking consent gating, project
 * data-scoping (TimeEntry from OTHER projects never contributes), no-data
 * records (NULL score), exact window replacement on re-runs, projectId
 * persistence, GET scoping, cross-project isolation, AI config validation
 * (google + gpt-4o rejected), and provider/model/baseUrl compatibility.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_projectsentiment).
 * Run: PG_TEST_BASE_URL=postgresql://postgres:<pass>@localhost:5432 npx tsx --test tests/project-sentiment.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation (set BEFORE any app module import) ──────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_projectsentiment';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-projectsentiment-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@projectsentiment.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!ProjectSentiment2026x';
(process.env as Record<string, string>).NODE_ENV = 'test';

before(() => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
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
let empA1: { id: string }; // org A, consented, project member, has time entries -> scored
let empA2: { id: string }; // org A, member, NOT consented -> skipped
let empA3: { id: string }; // org A, member, consented, no time entries -> no-data
let empA4: { id: string }; // org A, NOT a project member
let empB1: { id: string }; // org B
let projectA: { id: string; name: string };
let projectB: { id: string; name: string };

let viewerAToken: string;
let managerAToken: string;
let employeeAToken: string;
let adminAToken: string;
let managerBToken: string;
let superAdminToken: string;

let postAnalyze: typeof import('../src/app/api/projects/[id]/sentiment/analyze/route').POST;
let getSentiment: typeof import('../src/app/api/projects/[id]/sentiment/route').GET;

function req(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  return new NextRequest(url, init);
}

function authHeader(token: string, ip?: string) {
  return {
    Authorization: `Bearer ${token}`,
    ...(ip ? { 'x-real-ip': ip } : {}),
  };
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  const analyze = await import('../src/app/api/projects/[id]/sentiment/analyze/route');
  const sentiment = await import('../src/app/api/projects/[id]/sentiment/route');
  postAnalyze = analyze.POST;
  getSentiment = sentiment.GET;

  orgA = await db.organization.create({ data: { name: 'Project Sentiment Org A', slug: 'project-sentiment-org-a' } });
  orgB = await db.organization.create({ data: { name: 'Project Sentiment Org B', slug: 'project-sentiment-org-b' } });
  deptA = await db.department.create({ data: { name: 'Eng', organizationId: orgA.id } });

  const empCommon = { status: 'active', agentApproved: true };
  empA1 = await db.employee.create({ data: { employeeId: 'PS-EMP-A-1', firstName: 'Alice', lastName: 'One', email: 'psa1@a.test', organizationId: orgA.id, departmentId: deptA.id, ...empCommon } });
  empA2 = await db.employee.create({ data: { employeeId: 'PS-EMP-A-2', firstName: 'Bob', lastName: 'Two', email: 'psa2@a.test', organizationId: orgA.id, departmentId: deptA.id, ...empCommon } });
  empA3 = await db.employee.create({ data: { employeeId: 'PS-EMP-A-3', firstName: 'Carol', lastName: 'Three', email: 'psa3@a.test', organizationId: orgA.id, departmentId: deptA.id, ...empCommon } });
  empA4 = await db.employee.create({ data: { employeeId: 'PS-EMP-A-4', firstName: 'Dave', lastName: 'Four', email: 'psa4@a.test', organizationId: orgA.id, departmentId: deptA.id, ...empCommon } });
  empB1 = await db.employee.create({ data: { employeeId: 'PS-EMP-B-1', firstName: 'Eve', lastName: 'Five', email: 'psb1@b.test', organizationId: orgB.id, ...empCommon } });

  projectA = await db.project.create({ data: { name: 'Website Redesign', status: 'active', organizationId: orgA.id } });
  projectB = await db.project.create({ data: { name: 'Mobile App', status: 'active', organizationId: orgA.id } });
  await db.project.create({ data: { name: 'Org B Project', status: 'active', organizationId: orgB.id } });

  // Memberships: A1 (lead), A2 (member), A3 (member). A4 is NOT a member.
  await db.projectMember.createMany({
    data: [
      { projectId: projectA.id, employeeId: empA1.id, role: 'lead', organizationId: orgA.id },
      { projectId: projectA.id, employeeId: empA2.id, role: 'member', organizationId: orgA.id },
      { projectId: projectA.id, employeeId: empA3.id, role: 'member', organizationId: orgA.id },
      // A1 also belongs to project B (used for cross-project isolation).
      { projectId: projectB.id, employeeId: empA1.id, role: 'member', organizationId: orgA.id },
    ],
  });

  // Org A: publish an activity_tracking policy and grant it to A1 + A3.
  // A2 has NO consent (fail-closed skip).
  const policyA = await db.consentPolicy.create({
    data: { organizationId: orgA.id, consentType: 'activity_tracking', title: 'Activity Tracking', content: 'p', version: 'v1', status: 'published' },
  });
  await db.consent.createMany({
    data: [
      { employeeId: empA1.id, consentType: 'activity_tracking', status: 'granted', consentVersion: 'v1', policyId: policyA.id, organizationId: orgA.id },
      { employeeId: empA3.id, consentType: 'activity_tracking', status: 'granted', consentVersion: 'v1', policyId: policyA.id, organizationId: orgA.id },
    ],
  });

  // TimeEntry data: A1 has project-A hours this week AND project-B hours (the
  // project-B rows must NEVER contribute to project-A sentiment). A3 has no
  // time entries (no-data). Previous window rows drive the trend.
  const now = new Date();
  const day = 86400000;
  await db.timeEntry.createMany({
    data: [
      { projectId: projectA.id, employeeId: empA1.id, date: new Date(now.getTime() - day), hours: 6, category: 'development', billable: true, organizationId: orgA.id },
      { projectId: projectA.id, employeeId: empA1.id, date: new Date(now.getTime() - 2 * day), hours: 4, category: 'design', billable: true, organizationId: orgA.id },
      { projectId: projectA.id, employeeId: empA1.id, date: new Date(now.getTime() - 9 * day), hours: 8, category: 'development', billable: true, organizationId: orgA.id },
      // Cross-project pollution guard: these project-B hours must NOT count.
      { projectId: projectB.id, employeeId: empA1.id, date: new Date(now.getTime() - day), hours: 99, category: 'development', billable: true, organizationId: orgA.id },
    ],
  });

  viewerAToken = await signJWT({ userId: 'viewer-a', email: 'v@a.test', role: 'viewer', organizationId: orgA.id });
  managerAToken = await signJWT({ userId: 'mgr-a', email: 'm@a.test', role: 'manager', organizationId: orgA.id });
  employeeAToken = await signJWT({ userId: 'emp-a', email: 'e@a.test', role: 'employee', organizationId: orgA.id });
  adminAToken = await signJWT({ userId: 'adm-a', email: 'ad@a.test', role: 'admin', organizationId: orgA.id });
  managerBToken = await signJWT({ userId: 'mgr-b', email: 'm@b.test', role: 'manager', organizationId: orgB.id });
  superAdminToken = await signJWT({ userId: 'super-g', email: 'sg@global.test', role: 'super_admin' });
});

after(async () => {
  await db.$disconnect();
});

// ==================== RBAC ====================

test('PS-1: analyze requires manager+ (401 unauthenticated, 403 viewer/employee, 200 manager/admin)', async () => {
  const body = JSON.stringify({ periodDays: 7 });
  const base = `http://localhost/api/projects/${projectA.id}/sentiment/analyze`;

  const unauth = await postAnalyze(req(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), params(projectA.id));
  assert.equal(unauth.status, 401, `expected 401 unauthenticated, got ${unauth.status}`);

  const viewer = await postAnalyze(req(base, { method: 'POST', headers: { ...authHeader(viewerAToken, '10.0.0.1'), 'Content-Type': 'application/json' }, body }), params(projectA.id));
  assert.equal(viewer.status, 403, `expected 403 viewer, got ${viewer.status}`);

  const employee = await postAnalyze(req(base, { method: 'POST', headers: { ...authHeader(employeeAToken, '10.0.0.2'), 'Content-Type': 'application/json' }, body }), params(projectA.id));
  assert.equal(employee.status, 403, `expected 403 employee role, got ${employee.status}`);

  const manager = await postAnalyze(req(base, { method: 'POST', headers: { ...authHeader(managerAToken, '10.0.0.3'), 'Content-Type': 'application/json' }, body }), params(projectA.id));
  assert.equal(manager.status, 200, `expected 200 manager, got ${manager.status}`);

  const admin = await postAnalyze(req(base, { method: 'POST', headers: { ...authHeader(adminAToken, '10.0.0.4'), 'Content-Type': 'application/json' }, body }), params(projectA.id));
  assert.equal(admin.status, 200, `expected 200 admin, got ${admin.status}`);
});

// ==================== Tenant isolation ====================

test('PS-2: cross-org project -> 404 (concealment), invalid id -> 400', async () => {
  const orgBProject = await db.project.findFirstOrThrow({ where: { organizationId: orgB.id } });
  const body = JSON.stringify({ periodDays: 7 });

  const cross = await postAnalyze(req(`http://localhost/api/projects/${orgBProject.id}/sentiment/analyze`, { method: 'POST', headers: { ...authHeader(managerAToken, '10.0.0.5'), 'Content-Type': 'application/json' }, body }), params(orgBProject.id));
  assert.equal(cross.status, 404, `expected 404 cross-org project, got ${cross.status}`);

  const garbage = await postAnalyze(req('http://localhost/api/projects/x'.repeat(9) + '/sentiment/analyze', { method: 'POST', headers: { ...authHeader(managerAToken, '10.0.0.6'), 'Content-Type': 'application/json' }, body }), params('x'.repeat(72)));
  assert.equal(garbage.status, 400, `expected 400 oversized id, got ${garbage.status}`);
});

// ==================== Membership validation ====================

test('PS-3: non-member employeeId is rejected with 403', async () => {
  const body = JSON.stringify({ periodDays: 7, employeeIds: [empA4.id] });
  const res = await postAnalyze(req(`http://localhost/api/projects/${projectA.id}/sentiment/analyze`, { method: 'POST', headers: { ...authHeader(managerAToken, '10.0.0.7'), 'Content-Type': 'application/json' }, body }), params(projectA.id));
  assert.equal(res.status, 403, `expected 403 non-member, got ${res.status}`);
});

// ==================== Consent gating ====================

test('PS-4: employees without activity_tracking consent are skipped (fail closed)', async () => {
  const body = JSON.stringify({ periodDays: 7, employeeIds: [empA1.id, empA2.id] });
  const res = await postAnalyze(req(`http://localhost/api/projects/${projectA.id}/sentiment/analyze`, { method: 'POST', headers: { ...authHeader(managerAToken, '10.0.0.8'), 'Content-Type': 'application/json' }, body }), params(projectA.id));
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.consentSkipped, 1, `expected 1 consent skip, got ${json.consentSkipped}`);
  assert.equal(json.analyzed, 1, `expected 1 analyzed, got ${json.analyzed}`);
  // Only empA1 row created (project-scoped).
  const rows = await db.sentimentRecord.findMany({ where: { projectId: projectA.id } });
  assert.ok(rows.every((r) => r.projectId === projectA.id), 'all rows must carry the project id');
});

// ==================== Project data scoping + signals ====================

test('PS-5: project sentiment uses ONLY this project\'s time entries; other-project hours never contribute', async () => {
  // Clean previous runs for a deterministic check.
  await db.sentimentRecord.deleteMany({ where: { projectId: projectA.id } });

  const body = JSON.stringify({ periodDays: 7 });
  const res = await postAnalyze(req(`http://localhost/api/projects/${projectA.id}/sentiment/analyze`, { method: 'POST', headers: { ...authHeader(managerAToken, '10.0.0.9'), 'Content-Type': 'application/json' }, body }), params(projectA.id));
  const json = await res.json();
  assert.equal(res.status, 200);

  const alice = json.data.find((d: { employeeId: string }) => d.employeeId === empA1.id);
  assert.ok(alice, 'Alice must be analyzed');
  assert.equal(alice.projectId, projectA.id, 'projectId must be persisted');
  assert.equal(alice.aiProviderUsed, 'rules', 'no live AI key in test -> honest rules fallback');

  const signals = JSON.parse(alice.signals);
  // 6h + 4h = 10h in-window; the 99h on project B must NOT appear.
  assert.equal(signals.hoursThisPeriod, 10, `expected 10h project-scoped, got ${signals.hoursThisPeriod}`);
  assert.equal(signals.productiveRatio, 100, 'all project-A hours are productive categories');
  assert.equal(signals.entryCount, 2, 'only 2 project-A entries in window');

  const carol = json.data.find((d: { employeeId: string }) => d.employeeId === empA3.id);
  assert.ok(carol, 'Carol must be analyzed');
  assert.equal(carol.mood, 'no-data', 'no time entries -> no-data');
  assert.equal(carol.score, null, 'no-data score must be NULL (never fabricated)');
});

// ==================== Dedup / replace semantics ====================

test('PS-6: re-running the same period replaces rows (no duplicates accumulate)', async () => {
  const before = await db.sentimentRecord.count({ where: { projectId: projectA.id, periodStart: { gte: new Date(Date.now() - 8 * 86400000) } } });

  const body = JSON.stringify({ periodDays: 7, employeeIds: [empA1.id] });
  const res = await postAnalyze(req(`http://localhost/api/projects/${projectA.id}/sentiment/analyze`, { method: 'POST', headers: { ...authHeader(managerAToken, '10.0.0.10'), 'Content-Type': 'application/json' }, body }), params(projectA.id));
  assert.equal(res.status, 200);

  const after = await db.sentimentRecord.count({ where: { projectId: projectA.id, employeeId: empA1.id } });
  assert.equal(after, 1, `expected exactly 1 project-sentiment row for Alice, got ${after}`);
  assert.ok(before >= 1, 'previous run existed before rerun');
});

// ==================== Cross-project isolation ====================

test('PS-7: GET /api/projects/[id]/sentiment is project-scoped (project B rows never leak into A)', async () => {
  const resA = await getSentiment(req(`http://localhost/api/projects/${projectA.id}/sentiment`, { headers: authHeader(managerAToken) }), params(projectA.id));
  const jsonA = await resA.json();
  assert.equal(resA.status, 200);
  assert.equal(jsonA.project.id, projectA.id);
  assert.ok(jsonA.records.every((r: { projectId: string }) => r.projectId === projectA.id), 'all records belong to project A');

  // Analyze project B for Alice, then verify it does not appear in A.
  const body = JSON.stringify({ periodDays: 7 });
  await postAnalyze(req(`http://localhost/api/projects/${projectB.id}/sentiment/analyze`, { method: 'POST', headers: { ...authHeader(managerAToken, '10.0.0.11'), 'Content-Type': 'application/json' }, body }), params(projectB.id));

  const resB = await getSentiment(req(`http://localhost/api/projects/${projectB.id}/sentiment`, { headers: authHeader(managerAToken) }), params(projectB.id));
  const jsonB = await resB.json();
  const bSignals = JSON.parse(jsonB.records[0].signals);
  assert.equal(bSignals.hoursThisPeriod, 99, 'project B rows only for project B (99h)');

  // A is unchanged — no cross-contamination.
  const resA2 = await getSentiment(req(`http://localhost/api/projects/${projectA.id}/sentiment`, { headers: authHeader(managerAToken) }), params(projectA.id));
  const jsonA2 = await resA2.json();
  const aSignals = JSON.parse(jsonA2.records.find((r: { employeeId: string }) => r.employeeId === empA1.id).signals);
  assert.equal(aSignals.hoursThisPeriod, 10, 'project A hours must not include project B hours');
});

// ==================== GET RBAC + tenant isolation ====================

test('PS-8: GET sentiment enforces auth and cross-org concealment', async () => {
  const unauth = await getSentiment(req(`http://localhost/api/projects/${projectA.id}/sentiment`), params(projectA.id));
  assert.equal(unauth.status, 401);

  const orgBProject = await db.project.findFirstOrThrow({ where: { organizationId: orgB.id } });
  const cross = await getSentiment(req(`http://localhost/api/projects/${orgBProject.id}/sentiment`, { headers: authHeader(managerAToken) }), params(orgBProject.id));
  assert.equal(cross.status, 404, `cross-org project sentiment must be concealed, got ${cross.status}`);
});

// ==================== Input validation ====================

test('PS-9: invalid periodDays/employeeIds -> 400, never 500', async () => {
  const base = `http://localhost/api/projects/${projectA.id}/sentiment/analyze`;

  const badDays = await postAnalyze(req(base, { method: 'POST', headers: { ...authHeader(managerAToken, '10.0.0.12'), 'Content-Type': 'application/json' }, body: JSON.stringify({ periodDays: 0 }) }), params(projectA.id));
  assert.equal(badDays.status, 400);

  const badDays2 = await postAnalyze(req(base, { method: 'POST', headers: { ...authHeader(managerAToken, '10.0.0.13'), 'Content-Type': 'application/json' }, body: JSON.stringify({ periodDays: 91 }) }), params(projectA.id));
  assert.equal(badDays2.status, 400);

  const badIds = await postAnalyze(req(base, { method: 'POST', headers: { ...authHeader(managerAToken, '10.0.0.14'), 'Content-Type': 'application/json' }, body: JSON.stringify({ employeeIds: 'nope' }) }), params(projectA.id));
  assert.equal(badIds.status, 400);

  const noBody = await postAnalyze(req(base, { method: 'POST', headers: authHeader(managerAToken, '10.0.0.15') }), params(projectA.id));
  assert.equal(noBody.status, 400, 'bodyless request must be a client error');
});

// ==================== AI configuration validation ====================

test('PS-10: settings PUT (super_admin) rejects incompatible AI provider/model/baseUrl combinations', async () => {
  const putSettings = (await import('../src/app/api/settings/route')).PUT;
  const put = (key: string, value: string) => putSettings(req('http://localhost/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${superAdminToken}` },
    body: JSON.stringify({ key, value }),
  }));

  // P1-7: an org-bound admin can no longer write global AI config at all.
  const adminDenied = await putSettings(req('http://localhost/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${adminAToken}` },
    body: JSON.stringify({ key: 'ai_model', value: 'gemini-2.5-flash' }),
  }));
  assert.equal(adminDenied.status, 403, 'org admin global AI write must be 403');

  // Seed a google provider with an OpenAI-style model — must be rejected.
  await db.systemSetting.upsert({ where: { key: 'ai_provider' }, update: { value: 'google' }, create: { key: 'ai_provider', value: 'google', category: 'ai' } });

  const badModel = await put('ai_model', 'gpt-4o');
  assert.equal(badModel.status, 400, `google + gpt-4o must be rejected, got ${badModel.status}`);

  const goodModel = await put('ai_model', 'gemini-2.5-flash');
  assert.equal(goodModel.status, 200, `google + gemini model must be accepted, got ${goodModel.status}`);

  const badBase = await put('ai_base_url', 'https://api.openai.com');
  assert.equal(badBase.status, 400, `google + OpenAI gateway base URL must be rejected, got ${badBase.status}`);

  const goodBase = await put('ai_base_url', 'https://generativelanguage.googleapis.com');
  assert.equal(goodBase.status, 200, `google + google base URL must be accepted, got ${goodBase.status}`);

  // Cleanup so other tests are unaffected.
  await db.systemSetting.deleteMany({ where: { key: { in: ['ai_provider', 'ai_model', 'ai_base_url'] } } });
});

test('PS-11: validateProviderConfig unit checks', async () => {
  const { validateProviderConfig } = await import('../src/lib/ai-provider-helper');

  assert.ok(validateProviderConfig({ provider: 'google', model: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com' }) === null);
  assert.match(validateProviderConfig({ provider: 'google', model: 'gpt-4o' }) || '', /Gemini/i);
  assert.match(validateProviderConfig({ provider: 'google', baseUrl: 'https://api.openai.com' }) || '', /Custom provider/i);
  assert.ok(validateProviderConfig({ provider: 'anthropic', model: 'claude-3-5-sonnet' }) === null);
  assert.match(validateProviderConfig({ provider: 'anthropic', model: 'gpt-4o' }) || '', /Claude/i);
  assert.ok(validateProviderConfig({ provider: 'openai', model: 'gpt-4o', baseUrl: 'https://api.openai.com' }) === null);
  assert.ok(validateProviderConfig({ provider: 'custom', model: 'x', baseUrl: 'https://gateway.example.com' }) === null);
  assert.ok(validateProviderConfig({ provider: 'custom', model: 'x' }) !== null, 'custom without baseUrl is invalid');
});

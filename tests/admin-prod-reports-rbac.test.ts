/**
 * S-3 / S-4 — reports generation/export RBAC (manager+) + list hardening.
 *
 * viewer → 403 on generation/export/PDF/CSV; manager/admin → allowed;
 * cross-org report access stays concealed (404); the report LIST never
 * exposes filePath or raw payload data — only hasData.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_reportrbac).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_reportrbac';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-reportrbac-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@reportrbac.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!ReportRbac2026x';
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
let reportAWithData: { id: string };
let reportAEmpty: { id: string };
let reportB: { id: string };
let viewerAToken: string;
let managerAToken: string;
let adminAToken: string;
let managerBToken: string;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  orgA = await db.organization.create({ data: { name: 'Org A', slug: 'org-a-rpt' } });
  orgB = await db.organization.create({ data: { name: 'Org B', slug: 'org-b-rpt' } });

  reportAWithData = await db.report.create({
    data: {
      title: 'Org A Productivity',
      type: 'productivity',
      format: 'csv',
      status: 'generated',
      organizationId: orgA.id,
      data: JSON.stringify({ summary: { totalHours: 12 } }),
      filePath: '/uploads/reports/org-a-secret.pdf',
    },
  });
  reportAEmpty = await db.report.create({
    data: { title: 'Org A Empty', type: 'activity', format: 'pdf', status: 'completed', organizationId: orgA.id },
  });
  reportB = await db.report.create({
    data: {
      title: 'Org B Secret Report',
      type: 'productivity',
      format: 'csv',
      status: 'generated',
      organizationId: orgB.id,
      data: JSON.stringify({ summary: { totalHours: 999 } }),
      filePath: '/uploads/reports/org-b-secret.pdf',
    },
  });

  viewerAToken = await signJWT({ userId: 'viewer-a', email: 'viewer@a.test', role: 'viewer', organizationId: orgA.id });
  managerAToken = await signJWT({ userId: 'manager-a', email: 'manager@a.test', role: 'manager', organizationId: orgA.id });
  adminAToken = await signJWT({ userId: 'admin-a', email: 'admin@a.test', role: 'admin', organizationId: orgA.id });
  managerBToken = await signJWT({ userId: 'manager-b', email: 'manager@b.test', role: 'manager', organizationId: orgB.id });
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

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

test('RBAC-1: unauthenticated report generation → 401', async () => {
  const api = await import('../src/app/api/reports/generate/route');
  const res = await api.POST(req(null, { method: 'POST', body: { type: 'productivity' } }));
  assert.equal(res.status, 401);
});

test('RBAC-2: viewer cannot generate or export reports (403)', async () => {
  const generate = await import('../src/app/api/reports/generate/route');
  assert.equal(
    (await generate.POST(req(viewerAToken, { method: 'POST', body: { type: 'productivity' } }))).status,
    403
  );

  const create = await import('../src/app/api/reports/route');
  assert.equal(
    (await create.POST(req(viewerAToken, { method: 'POST', body: { title: 'X', type: 'productivity' } }))).status,
    403
  );

  const exportApi = await import('../src/app/api/reports/[id]/export/route');
  assert.equal((await exportApi.GET(req(viewerAToken, { url: `http://localhost:3000/api/reports/${reportAWithData.id}/export` }), params(reportAWithData.id))).status, 403);

  const pdfApi = await import('../src/app/api/reports/[id]/pdf/route');
  assert.equal((await pdfApi.GET(req(viewerAToken, { url: `http://localhost:3000/api/reports/${reportAWithData.id}/pdf` }), params(reportAWithData.id))).status, 403);

  const csvApi = await import('../src/app/api/reports/[id]/csv/route');
  assert.equal((await csvApi.GET(req(viewerAToken, { url: `http://localhost:3000/api/reports/${reportAWithData.id}/csv` }), params(reportAWithData.id))).status, 403);
});

test('RBAC-3: viewer cannot use pdf/* generation endpoints (403)', async () => {
  const activity = await import('../src/app/api/reports/pdf/activity/route');
  assert.equal((await activity.POST(req(viewerAToken, { method: 'POST', body: {} }))).status, 403);

  const audit = await import('../src/app/api/reports/pdf/audit/route');
  assert.equal((await audit.POST(req(viewerAToken, { method: 'POST', body: {} }))).status, 403);
});

test('RBAC-4: manager is allowed to generate reports (201)', async () => {
  const api = await import('../src/app/api/reports/generate/route');
  const res = await api.POST(req(managerAToken, { method: 'POST', body: { type: 'productivity' } }));
  assert.equal(res.status, 201);
});

test('RBAC-5: admin is allowed (201) and manager can export own-org report (200)', async () => {
  const create = await import('../src/app/api/reports/route');
  const created = await create.POST(req(adminAToken, { method: 'POST', body: { title: 'Admin Report', type: 'productivity', format: 'pdf' } }));
  assert.equal(created.status, 201);

  const exportApi = await import('../src/app/api/reports/[id]/export/route');
  const res = await exportApi.GET(req(managerAToken, { url: `http://localhost:3000/api/reports/${reportAWithData.id}/export` }), params(reportAWithData.id));
  assert.equal(res.status, 200);
});

test('RBAC-6: cross-org report access remains concealed (404)', async () => {
  const exportApi = await import('../src/app/api/reports/[id]/export/route');
  assert.equal(
    (await exportApi.GET(req(managerAToken, { url: `http://localhost:3000/api/reports/${reportB.id}/export` }), params(reportB.id))).status,
    404,
    'org A manager must NOT see org B report'
  );

  const csvApi = await import('../src/app/api/reports/[id]/csv/route');
  assert.equal(
    (await csvApi.GET(req(managerAToken, { url: `http://localhost:3000/api/reports/${reportB.id}/csv` }), params(reportB.id))).status,
    404
  );

  // Org B manager still sees own report.
  const bRes = await exportApi.GET(req(managerBToken, { url: `http://localhost:3000/api/reports/${reportB.id}/export` }), params(reportB.id));
  assert.equal(bRes.status, 200, 'org B manager sees own-org report');
});

test('RBAC-7: report list does NOT expose filePath or data; hasData works', async () => {
  const api = await import('../src/app/api/reports/route');
  const res = await api.GET(req(managerAToken, { url: 'http://localhost:3000/api/reports' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  const list = body.data as Array<Record<string, unknown>>;

  assert.ok(list.length >= 4, 'fixture + generated reports listed');
  for (const r of list) {
    assert.equal('data' in r, false, 'raw report payload must never be exposed');
    assert.equal('filePath' in r, false, 'filesystem path must never be exposed');
  }

  const byId = new Map(list.map((r) => [r.id, r]));
  assert.equal(byId.get(reportAWithData.id)?.hasData, true, 'report with data → hasData true');
  assert.equal(byId.get(reportAEmpty.id)?.hasData, false, 'report without data → hasData false');
  assert.equal(byId.get(reportB.id), undefined, 'org B report must NOT appear in org A list');
});

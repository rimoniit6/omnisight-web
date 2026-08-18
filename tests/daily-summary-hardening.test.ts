/**
 * WorkLensAI — Daily Summary Report hardening tests (DAILY-SUMMARY audit fixes).
 *
 * Covers:
 *  - DS-P1-1: validateProviderConfig rejects google + OpenAI-compatible base
 *    URL paths (the /v1beta/openai gateway) while accepting native roots;
 *    settings PUT (super_admin) can CLEAR ai_base_url with '' (the UI's
 *    reset path that previously left a stale gateway URL in place).
 *  - DS-P1-2: /api/reports/daily/ai-summary derives its data from body.date
 *    (client contract) — the response date is the ORG-LOCAL day of the
 *    requested date.
 *  - DS-P2-1: TZ-safe date label — requesting 2026-07-01 from an
 *    Asia/Dhaka org labels 2026-07-01 (previously 2026-06-30).
 *  - DS-P3-4: per-code fallback wording (AI_KEY_MISSING etc.).
 *  - RBAC preserved: anon 401, viewer 403, manager 200.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_dailyreport).
 * Run: PG_TEST_BASE_URL=postgresql://postgres:<pass>@localhost:5432 npx tsx --test tests/daily-summary-hardening.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation (set BEFORE any app module import) ──────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_dailyreport';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-dailyreport-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@dailyreport.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!DailyReport2026x';
(process.env as Record<string, string>).NODE_ENV = 'test';
// Retention purges physical screenshot files through the storage driver;
// this suite asserts against the local filesystem, so pin the local driver
// regardless of any developer's .env.
process.env.STORAGE_DRIVER = 'local';

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

let orgA: { id: string; timezone: string };
let managerAToken: string;
let viewerAToken: string;
let superAdminToken: string;

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

  orgA = await db.organization.create({ data: { name: 'Daily Report Org', slug: 'daily-report-org', timezone: 'Asia/Dhaka' } });

  managerAToken = await signJWT({ userId: 'mgr-ds', email: 'm@ds.test', role: 'manager', organizationId: orgA.id });
  viewerAToken = await signJWT({ userId: 'vw-ds', email: 'v@ds.test', role: 'viewer', organizationId: orgA.id });
  superAdminToken = await signJWT({ userId: 'super-ds', email: 's@global.test', role: 'super_admin' });
});

after(async () => {
  await db.$disconnect();
});

// ==================== DS-P1-1: google base-URL path validation ====================

test('DS-1: validateProviderConfig rejects google + OpenAI-compatible gateway base URL (native roots only)', async () => {
  const { validateProviderConfig } = await import('../src/lib/ai-provider-helper');

  // Native roots are valid (bare host, /v1, /v1beta).
  assert.equal(validateProviderConfig({ provider: 'google', model: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com' }), null);
  assert.equal(validateProviderConfig({ provider: 'google', model: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1' }), null);
  assert.equal(validateProviderConfig({ provider: 'google', model: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }), null);

  // The OpenAI-compatible gateway path (/v1beta/openai) is a DIFFERENT protocol
  // (chat/completions + Bearer) — never valid for the native google branch.
  const gateway = validateProviderConfig({ provider: 'google', model: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' });
  assert.ok(gateway !== null, 'google + /v1beta/openai must be rejected');
  assert.match(gateway || '', /OpenAI-compatible|Custom provider|native/i);

  // A foreign host remains rejected (existing behavior).
  assert.ok(validateProviderConfig({ provider: 'google', baseUrl: 'https://api.openai.com' }) !== null);
});

// ==================== DS-P1-1: settings PUT can clear ai_base_url ====================

test('DS-2: settings PUT (super_admin) clears a non-secret setting with empty string (UI reset path)', async () => {
  const putSettings = (await import('../src/app/api/settings/route')).PUT;

  // Seed a stale gateway base URL exactly like the audit found it.
  await db.systemSetting.upsert({
    where: { key: 'ai_base_url' },
    update: { value: 'https://generativelanguage.googleapis.com/v1beta/openai' },
    create: { key: 'ai_base_url', value: 'https://generativelanguage.googleapis.com/v1beta/openai', category: 'ai' },
  });
  await db.systemSetting.upsert({
    where: { key: 'ai_provider' },
    update: { value: 'google' },
    create: { key: 'ai_provider', value: 'google', category: 'ai' },
  });

  // Clearing with '' must succeed and remove the row (previously 400 →
  // the stale URL survived the Settings UI's switch-provider reset).
  const res = await putSettings(req('http://localhost/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeader(superAdminToken) },
    body: JSON.stringify({ key: 'ai_base_url', value: '' }),
  }));
  assert.equal(res.status, 200, `clearing ai_base_url must be 200, got ${res.status}`);

  const row = await db.systemSetting.findUnique({ where: { key: 'ai_base_url' } });
  assert.equal(row, null, 'ai_base_url row must be deleted (native default used)');

  // The provider row stays intact.
  const providerRow = await db.systemSetting.findUnique({ where: { key: 'ai_provider' } });
  assert.equal(providerRow?.value, 'google');

  // An org-bound admin can never write global AI config (P1-7 preserved).
  const adminDenied = await putSettings(req('http://localhost/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeader(viewerAToken) },
    body: JSON.stringify({ key: 'ai_base_url', value: '' }),
  }));
  assert.equal(adminDenied.status, 403);

  await db.systemSetting.deleteMany({ where: { key: { in: ['ai_provider', 'ai_base_url', 'ai_api_key', 'ai_model'] } } });
});

// ==================== DS-P1-2 / DS-P2-1: ai-summary date contract + TZ label ====================

test('DS-3: ai-summary honors body.date and labels the ORG-LOCAL day (no UTC off-by-one)', async () => {
  const postAiSummary = (await import('../src/app/api/reports/daily/ai-summary/route')).POST;

  // No provider configured in the fresh test DB → honest fallback (and no 500).
  const res = await postAiSummary(req('http://localhost/api/reports/daily/ai-summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(managerAToken) },
    body: JSON.stringify({ date: '2026-07-01' }),
  }));
  assert.equal(res.status, 200);
  const json = await res.json();

  // DS-P2-1: the label must be the requested ORG-LOCAL day, NOT the UTC-shifted
  // previous day (2026-06-30). Asia/Dhaka local midnight of 07-01 = 06-30T18:00Z.
  assert.equal(json.date, '2026-07-01', `date label must be org-local 2026-07-01, got ${json.date}`);

  // DS-P3-4: fallback wording must be truthful for the actual cause.
  assert.ok(json.aiError, 'no provider configured → an aiError code is present');
  assert.match(json.aiSummary.executiveSummary, /provider/i);
});

test('DS-4: ai-summary RBAC preserved — anon 401, viewer 403, manager 200', async () => {
  const postAiSummary = (await import('../src/app/api/reports/daily/ai-summary/route')).POST;
  const body = JSON.stringify({ date: '2026-08-13' });

  const anon = await postAiSummary(req('http://localhost/api/reports/daily/ai-summary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }));
  assert.equal(anon.status, 401);

  const viewer = await postAiSummary(req('http://localhost/api/reports/daily/ai-summary', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader(viewerAToken) }, body }));
  assert.equal(viewer.status, 403);

  const manager = await postAiSummary(req('http://localhost/api/reports/daily/ai-summary', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader(managerAToken) }, body }));
  assert.equal(manager.status, 200);
});

test('DS-5: daily report route date label is org-local (DS-P2-1) and data is real', async () => {
  const postDaily = (await import('../src/app/api/reports/daily/route')).POST;

  const res = await postDaily(req('http://localhost/api/reports/daily', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader(managerAToken) },
    body: JSON.stringify({ date: '2026-07-01' }),
  }));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.date, '2026-07-01', `daily report label must be org-local, got ${json.date}`);

  // The report row + audit are created (real persistence), then cleaned up.
  const rows = await db.report.findMany({ where: { organizationId: orgA.id } });
  assert.equal(rows.length, 1);
  const audits = await db.auditLog.count({ where: { resource: 'report', organizationId: orgA.id } });
  assert.equal(audits, 1, 'generation is audited');

  await db.auditLog.deleteMany({ where: { resource: 'report', organizationId: orgA.id } });
  await db.report.deleteMany({ where: { organizationId: orgA.id } });
});

// ==================== apiEndpoint normalization ====================

test('DS-6: apiEndpoint never duplicates the version segment for google (native root)', async () => {
  const { apiEndpoint } = await import('../src/lib/ai-provider-helper');

  assert.equal(
    apiEndpoint('https://generativelanguage.googleapis.com', '/v1/models/gemini-2.5-flash:generateContent'),
    'https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent',
  );
  assert.equal(
    apiEndpoint('https://generativelanguage.googleapis.com/v1', '/v1/models/gemini-2.5-flash:generateContent'),
    'https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent',
  );
});

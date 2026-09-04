/**
 * Phase 5 — AI USAGE METERING + READINESS tests.
 *
 * The metering surface is new in Phase 5 (per-call AiUsage rows). These tests
 * verify real behavior, not interfaces:
 *
 *   P5-AI-01  recordAiUsage writes one org-scoped row with safe fields only.
 *   P5-AI-02  meterAiCall records success rows incl. provider-reported tokens
 *             and latency; returns the provider result unchanged.
 *   P5-AI-03  meterAiCall records error rows with the safe error code.
 *   P5-AI-04  meterAiCall skips config-level misses (no provider attempted).
 *   P5-AI-05  recordAiUsage is best-effort — a write failure never throws.
 *   P5-AI-06  GET /api/ai-provider/metering is tenant-isolated: Org A admin
 *             sees only Org A rows; Org B admin can never see Org A's rows.
 *   P5-AI-07  Viewer role and org-less Super Admin cannot read metering.
 *   P5-AI-08  Metering API responses never contain keys/payloads/secrets.
 *   P5-AI-09  GET /api/health/ready returns 200 ready when DB+storage+config
 *             are present and 503 not_ready when runtime config is missing —
 *             and never leaks secret VALUES.
 *
 * Runs against a THROWAWAY PostgreSQL database.
 * Run: npx tsx --test tests/phase5-ai-metering.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_p5metering';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-p5-metering-0123456789abcdef';
process.env.ENCRYPTION_KEY = 'test-encryption-key-p5-metering-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@p5-metering.test';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.STORAGE_DRIVER = 'local';

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
let adminAToken: string;
let adminBToken: string;
let viewerAToken: string;
let saGlobalToken: string;

function bearerReq(token: string, url = 'http://localhost:3000/api/x'): NextRequest {
  return new NextRequest(url, { method: 'GET', headers: { authorization: `Bearer ${token}` } });
}

before(async () => {
  db = (await import('../src/lib/db')).db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  orgA = await db.organization.create({
    data: { name: 'Meter Tenant A', slug: 'p5m-orga', timezone: 'UTC' },
    select: { id: true },
  });
  orgB = await db.organization.create({
    data: { name: 'Meter Tenant B', slug: 'p5m-orgb', timezone: 'UTC' },
    select: { id: true },
  });

  adminAToken = await signJWT({ userId: 'admin-a', email: 'admin-a@p5m.test', role: 'admin', organizationId: orgA.id });
  adminBToken = await signJWT({ userId: 'admin-b', email: 'admin-b@p5m.test', role: 'admin', organizationId: orgB.id });
  viewerAToken = await signJWT({ userId: 'viewer-a', email: 'viewer-a@p5m.test', role: 'viewer', organizationId: orgA.id });
  saGlobalToken = await signJWT({ userId: 'sa-root', email: 'sa@p5m.test', role: 'super_admin' });
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
  } catch { /* best-effort */ }
});

// ─── P5-AI-01: recordAiUsage writes an org-scoped row with safe fields ─────

test('P5-AI-01: recordAiUsage persists one org-scoped row with safe fields only', async () => {
  const { recordAiUsage } = await import('../src/lib/ai-metering');
  await recordAiUsage({
    organizationId: orgA.id,
    provider: 'openai',
    model: 'gpt-4o-mini',
    operation: 'screenshot_analysis',
    status: 'success',
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
    latencyMs: 250,
  });

  const row = await db.aiUsage.findFirst({
    where: { organizationId: orgA.id, operation: 'screenshot_analysis' },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(row, 'usage row persisted');
  assert.equal(row!.organizationId, orgA.id);
  assert.equal(row!.provider, 'openai');
  assert.equal(row!.model, 'gpt-4o-mini');
  assert.equal(row!.operation, 'screenshot_analysis');
  assert.equal(row!.status, 'success');
  assert.equal(row!.inputTokens, 10);
  assert.equal(row!.outputTokens, 20);
  assert.equal(row!.totalTokens, 30);
  assert.ok(row!.latencyMs !== null && row!.latencyMs >= 0, 'latency recorded');

  // No secret/payload columns may exist on the row. (Provider token COUNTS
  // are legitimate metering columns — only credential/payload fields are
  // forbidden.)
  const keys = Object.keys(row!).map((k) => k.toLowerCase());
  for (const forbidden of ['apikey', 'apisecret', 'key', 'secret', 'prompt', 'response', 'payload', 'content']) {
    assert.ok(!keys.some((k) => k.includes(forbidden)), `row must not carry a ${forbidden} column`);
  }
});

// ─── P5-AI-02/03/04: meterAiCall semantics ──────────────────────────────

test('P5-AI-02: meterAiCall records a success row with tokens+latency and returns the result unchanged', async () => {
  const { meterAiCall } = await import('../src/lib/ai-metering');
  const stub = {
    text: 'ok',
    provider: 'anthropic',
    model: 'claude-3-5-haiku',
    usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
  };
  const returned = await meterAiCall({ organizationId: orgA.id, operation: 'ai_insight' }, async () => stub);
  assert.equal(returned, stub, 'result object returned unchanged');

  const row = await db.aiUsage.findFirst({
    where: { organizationId: orgA.id, operation: 'ai_insight', status: 'success' },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(row, 'success row recorded');
  assert.equal(row!.provider, 'anthropic');
  assert.equal(row!.model, 'claude-3-5-haiku');
  assert.equal(row!.inputTokens, 5);
  assert.equal(row!.outputTokens, 3);
  assert.equal(row!.totalTokens, 8);
  assert.ok(row!.latencyMs !== null && row!.latencyMs >= 0, 'wall latency measured');
});

test('P5-AI-03: meterAiCall records an error row with the safe error code', async () => {
  const { meterAiCall } = await import('../src/lib/ai-metering');
  const stub = { text: null as string | null, provider: 'google', model: 'gemini-3.5-flash', error: 'AI_HTTP_429' };
  await meterAiCall({ organizationId: orgB.id, operation: 'sentiment' }, async () => stub);

  const row = await db.aiUsage.findFirst({
    where: { organizationId: orgB.id, operation: 'sentiment', status: 'error' },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(row, 'error row recorded');
  assert.equal(row!.errorCode, 'AI_HTTP_429');
  assert.equal(row!.status, 'error');
});

test('P5-AI-04: meterAiCall skips config-level misses (no provider attempted)', async () => {
  const { meterAiCall } = await import('../src/lib/ai-metering');
  const stub = { text: null as string | null, provider: '', model: '', error: 'AI_PROVIDER_NOT_CONFIGURED' };
  const beforeCount = await db.aiUsage.count({ where: { organizationId: orgA.id } });
  const returned = await meterAiCall({ organizationId: orgA.id, operation: 'daily_summary' }, async () => stub);
  assert.equal(returned, stub);
  const afterCount = await db.aiUsage.count({ where: { organizationId: orgA.id } });
  assert.equal(afterCount, beforeCount, 'no row for a provider that was never attempted');
});

// ─── P5-AI-05: best-effort writes never throw ────────────────────────────

test('P5-AI-05: recordAiUsage never throws even when the write fails', async () => {
  const { recordAiUsage } = await import('../src/lib/ai-metering');
  // Bogus org → FK violation must be swallowed (metering must never break AI).
  await recordAiUsage({
    organizationId: 'org-does-not-exist',
    provider: 'openai',
    model: 'gpt-4o-mini',
    operation: 'ai_insight',
    status: 'success',
  });
  assert.ok(true, 'write failure was non-fatal');
});

// ─── P5-AI-06/07/08: tenant-isolated read API ────────────────────────────

test('P5-AI-06: metering API is tenant-isolated — Org B can never see Org A rows', async () => {
  const { GET } = await import('../src/app/api/ai-provider/metering/route');

  // Seed several Org A rows.
  const { recordAiUsage } = await import('../src/lib/ai-metering');
  for (let i = 0; i < 3; i++) {
    await recordAiUsage({
      organizationId: orgA.id,
      provider: 'openai',
      model: 'gpt-4o-mini',
      operation: 'daily_summary',
      status: 'success',
      latencyMs: 100 + i,
    });
  }

  const resA = await GET(bearerReq(adminAToken, 'http://localhost:3000/api/ai-provider/metering'));
  assert.equal(resA.status, 200);
  const bodyA = (await resA.json()) as { total: number; recent: Array<{ organizationId?: string }> };
  assert.ok(bodyA.total >= 4, 'Org A admin sees Org A rows');
  assert.ok(bodyA.recent.every((r) => !('organizationId' in r)), 'response rows carry no org field (never serialized)');

  // Org B's own row (P5-AI-03) is legitimately visible to Org B; what must
  // NEVER happen is Org A rows leaking into Org B's response.
  const resB = await GET(bearerReq(adminBToken, 'http://localhost:3000/api/ai-provider/metering'));
  assert.equal(resB.status, 200);
  const bodyB = (await resB.json()) as { total: number; recent: Array<{ id: string }> };
  const bCount = await db.aiUsage.count({ where: { organizationId: orgB.id } });
  assert.equal(bodyB.total, bCount, 'Org B admin sees exactly Org B rows');
  const aIds = new Set((await db.aiUsage.findMany({ where: { organizationId: orgA.id }, select: { id: true } })).map((r) => r.id));
  assert.ok(aIds.size >= 4, 'Org A rows exist in the DB');
  assert.ok(bodyB.recent.every((r) => !aIds.has(r.id)), 'no Org A row id appears in Org B response');

  // Ensure Org A rows actually exist so the assertion is meaningful.
  const aCount = await db.aiUsage.count({ where: { organizationId: orgA.id } });
  assert.ok(aCount >= 4, 'Org A rows exist in the DB');
});

test('P5-AI-07: viewer role and org-less Super Admin are denied metering reads', async () => {
  const { GET } = await import('../src/app/api/ai-provider/metering/route');

  const resViewer = await GET(bearerReq(viewerAToken, 'http://localhost:3000/api/ai-provider/metering'));
  assert.equal(resViewer.status, 403, 'viewer cannot read metering');

  const resSA = await GET(bearerReq(saGlobalToken, 'http://localhost:3000/api/ai-provider/metering'));
  assert.equal(resSA.status, 403, 'org-less super admin has no org scope to read metering from');
});

test('P5-AI-08: metering API responses never contain keys, payloads or secrets', async () => {
  const { GET } = await import('../src/app/api/ai-provider/metering/route');
  const res = await GET(bearerReq(adminAToken, 'http://localhost:3000/api/ai-provider/metering'));
  const text = await res.text();
  assert.ok(!text.includes('test-jwt-secret'), 'no session secret in the response');
  assert.ok(!text.includes('apiKey') && !text.includes('api_key'), 'no key fields serialized');
  assert.ok(!text.includes('prompt') && !text.includes('content'), 'no prompt/payload content serialized');
});

// ─── P5-AI-09: readiness probe ───────────────────────────────────────────

test('P5-AI-09: /api/health/ready gates on config presence and never leaks values', async () => {
  const { GET } = await import('../src/app/api/health/ready/route');

  // All required config present (set at module top) + DB reachable + local storage.
  const resReady = await GET();
  assert.equal(resReady.status, 200, 'ready when DB + storage + config are present');
  const bodyReady = (await resReady.json()) as { status: string; checks: { config: Array<{ key: string; present: boolean }> } };
  assert.equal(bodyReady.status, 'ready');
  assert.ok(bodyReady.checks.config.every((c) => c.present), 'all required config present');
  const readyText = JSON.stringify(bodyReady);
  assert.ok(!readyText.includes('test-jwt-secret') && !readyText.includes('test-encryption-key'), 'no secret VALUES in the body');

  // Remove a required secret → 503 not_ready with a boolean flag (no value).
  const priorJwt = process.env.JWT_SECRET;
  const priorEnc = process.env.ENCRYPTION_KEY;
  delete process.env.JWT_SECRET;
  delete process.env.ENCRYPTION_KEY;
  try {
    const resNotReady = await GET();
    assert.equal(resNotReady.status, 503, 'not ready when required config is missing');
    const bodyNot = (await resNotReady.json()) as { status: string; checks: { config: Array<{ key: string; present: boolean }> } };
    assert.equal(bodyNot.status, 'not_ready');
    assert.ok(bodyNot.checks.config.some((c) => !c.present), 'failing key flagged present:false');
    const notReadyText = JSON.stringify(bodyNot);
    assert.ok(!notReadyText.includes('test-jwt-secret') && !notReadyText.includes('test-encryption-key'), 'missing secret values never echoed');
  } finally {
    process.env.JWT_SECRET = priorJwt;
    process.env.ENCRYPTION_KEY = priorEnc;
  }
});

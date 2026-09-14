/**
 * Phase 1 — Per-Organization AI Runtime Resolution.
 *
 * Verifies that callAIProvider/callAIProviderVision resolve AI credentials per
 * organization: a fully-configured OrganizationSetting block (ai_provider,
 * ai_api_key, ai_base_url, ai_model) wins over the platform-wide SystemSetting
 * block; missing or incomplete org config falls back to the global block;
 * legacy plaintext org keys are upgraded to encrypted envelopes in place; and
 * an undecryptable org key fails closed instead of silently using the global key.
 *
 * Every "reachable" request targets http://127.0.0.1:1 — an SSRF-blocked
 * literal — so no real HTTP call is ever made. Reaching the request phase
 * proves settings were RESOLVED, as opposed to AI_PROVIDER_NOT_CONFIGURED
 * (no block) or AI_CONFIG_INCOMPATIBLE (wrong block selected).
 *
 * Run: npx tsx --test tests/ai-org-resolution.test.ts
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

// ─── Test DB isolation (set BEFORE any app module import) ──────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_orgai';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'org-ai-test-jwt-secret-0123456789abcdef';
(process.env as Record<string, string>).NODE_ENV = 'test';

const LOCAL_BLOCKED = 'http://127.0.0.1:1';
const IMAGE_INPUT = { type: 'base64' as const, base64: 'iVBORw0KGgo=', mimeType: 'image/png' };

type DbModule = typeof import('../src/lib/db');
type HelperModule = typeof import('../src/lib/ai-provider-helper');
let db: DbModule['db'];
let callAIProvider: HelperModule['callAIProvider'];
let callAIProviderVision: HelperModule['callAIProviderVision'];
let orgA: { id: string };
let orgB: { id: string };

async function seedOrgSettings(orgId: string, values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    await db.organizationSetting.create({ data: { organizationId: orgId, key, value, category: 'ai' } });
  }
}

async function seedSystemSettings(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    await db.systemSetting.create({ data: { key, value, category: 'ai' } });
  }
}

async function clearAllSettings() {
  await db.organizationSetting.deleteMany({});
  await db.systemSetting.deleteMany({});
}

before(async () => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: 'pipe',
  });

  db = (await import('../src/lib/db')).db;
  const helper = (await import('../src/lib/ai-provider-helper'));
  callAIProvider = helper.callAIProvider;
  callAIProviderVision = helper.callAIProviderVision;

  orgA = await db.organization.create({ data: { name: 'ORG AI A', slug: 'org-ai-a', status: 'active' } });
  orgB = await db.organization.create({ data: { name: 'ORG AI B', slug: 'org-ai-b', status: 'active' } });
});

test('OP-01: fully-configured org wins over an unconfigured global block', async () => {
  await clearAllSettings();
  await seedOrgSettings(orgA.id, {
    ai_provider: 'custom',
    ai_api_key: 'org-secret-key',
    ai_base_url: LOCAL_BLOCKED,
    ai_model: 'org-model',
  });

  const result = await callAIProvider('sys', 'user', { organizationId: orgA.id });
  assert.equal(result?.error, 'AI_REQUEST_FAILED', 'org config should be resolved, not AI_PROVIDER_NOT_CONFIGURED');
});

test('OP-02: legacy plaintext org key is upgraded to an encrypted envelope', async () => {
  await clearAllSettings();
  await seedOrgSettings(orgA.id, {
    ai_provider: 'custom',
    ai_api_key: 'org-secret-key',
    ai_base_url: LOCAL_BLOCKED,
    ai_model: 'org-model',
  });

  await callAIProvider('sys', 'user', { organizationId: orgA.id });

  const stored = await db.organizationSetting.findUnique({
    where: { organizationId_key: { organizationId: orgA.id, key: 'ai_api_key' } },
  });
  assert.ok(stored, 'org ai_api_key should still exist');
  assert.ok(stored.value.startsWith('v1:'), `org key should be encrypted after first use, got ${stored.value.slice(0, 8)}…`);
  assert.notEqual(stored.value, 'org-secret-key', 'stored value must not be the plaintext key');
});

test('OP-03: incomplete org config falls back to the global block', async () => {
  await clearAllSettings();
  await seedOrgSettings(orgA.id, { ai_provider: 'custom' });

  let result = await callAIProvider('sys', 'user', { organizationId: orgA.id });
  assert.equal(result?.error, 'AI_PROVIDER_NOT_CONFIGURED', 'org custom without baseUrl/model must fall back to global');

  await seedOrgSettings(orgB.id, {
    ai_provider: 'madeup-provider',
    ai_api_key: 'ignored-key',
    ai_base_url: LOCAL_BLOCKED,
    ai_model: 'ignored-model',
  });
  result = await callAIProvider('sys', 'user', { organizationId: orgB.id });
  assert.equal(result?.error, 'AI_PROVIDER_NOT_CONFIGURED', 'unknown org provider must fall back to global');
});

test('OP-04: unconfigured org uses a configured global block', async () => {
  await clearAllSettings();
  await seedSystemSettings({
    ai_provider: 'custom',
    ai_api_key: 'global-key',
    ai_base_url: LOCAL_BLOCKED,
    ai_model: 'global-model',
  });

  const withOrg = await callAIProvider('sys', 'user', { organizationId: orgB.id });
  assert.equal(withOrg?.error, 'AI_REQUEST_FAILED', 'org without AI settings must resolve the global block');

  const noOrg = await callAIProvider('sys', 'user');
  assert.equal(noOrg?.error, 'AI_REQUEST_FAILED', 'no orgId keeps existing global behavior');
});

test('OP-05: vision path resolves the same org block', async () => {
  await clearAllSettings();
  await seedOrgSettings(orgA.id, {
    ai_provider: 'custom',
    ai_api_key: 'org-secret-key',
    ai_base_url: LOCAL_BLOCKED,
    ai_model: 'org-model',
  });

  const withOrg = await callAIProviderVision('sys', 'user', IMAGE_INPUT, { organizationId: orgA.id });
  assert.equal(withOrg?.error, 'AI_REQUEST_FAILED', 'vision should use the org config');

  const noOrg = await callAIProviderVision('sys', 'user', IMAGE_INPUT, { organizationId: orgB.id });
  assert.equal(noOrg?.error, 'AI_PROVIDER_NOT_CONFIGURED', 'vision should fall back when org config is absent');
});

test('OP-06: org block short-circuits an incompatible global block', async () => {
  await clearAllSettings();
  await seedSystemSettings({
    ai_provider: 'google',
    ai_api_key: 'global-key',
    ai_model: 'gpt-4o',
  });
  await seedOrgSettings(orgA.id, {
    ai_provider: 'custom',
    ai_api_key: 'org-secret-key',
    ai_base_url: LOCAL_BLOCKED,
    ai_model: 'org-model',
  });

  const withOrg = await callAIProvider('sys', 'user', { organizationId: orgA.id });
  assert.equal(withOrg?.error, 'AI_REQUEST_FAILED', 'valid org config must win over the invalid global config');

  const noOrg = await callAIProvider('sys', 'user');
  assert.equal(noOrg?.error, 'AI_CONFIG_INCOMPATIBLE', 'control: global block alone is rejected as incompatible');
});

test('OP-07: undecryptable org key fails closed, not silent global fallback', async () => {
  await clearAllSettings();
  await seedSystemSettings({
    ai_provider: 'custom',
    ai_api_key: 'global-key',
    ai_base_url: LOCAL_BLOCKED,
    ai_model: 'global-model',
  });
  await seedOrgSettings(orgA.id, {
    ai_provider: 'custom',
    ai_api_key: 'v1:garbage:garbage:garbage',
    ai_base_url: LOCAL_BLOCKED,
    ai_model: 'org-model',
  });

  const result = await callAIProvider('sys', 'user', { organizationId: orgA.id });
  assert.equal(result?.error, 'AI_KEY_DECRYPT_FAILED', 'corrupt org key must error, never silently use the global key');
});
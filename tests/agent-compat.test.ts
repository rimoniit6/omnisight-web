/**
 * Agent compatibility fingerprint endpoint — tests.
 *
 * /api/agent/compat exists so the Local Agent Builder (omnisight-agent) can
 * positively identify an OmniSight server before baking its URL into a
 * packaged agent: /api/health is generic and could be any web server.
 *
 * The endpoint is pure and DB-free, so this test imports the route directly
 * (no throwaway database needed, unlike tests/health.test.ts).
 * Run: npx tsx --test tests/agent-compat.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

type CompatApi = typeof import('../src/app/api/agent/compat/route');

let compatApi: CompatApi;

test('before: load the compat route module', async () => {
  compatApi = await import('../src/app/api/agent/compat/route');
});

test('AC-1: /api/agent/compat returns 200 with the OmniSight product fingerprint', async () => {
  const res = await compatApi.GET();
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.product, 'omnisight');
  assert.equal(body.service, 'omnisight-web');
  assert.equal(typeof body.version, 'string');
  assert.equal(body.agentProtocol, 1);
});

test('AC-2: the fingerprint is stable and machine-checkable (exact shape)', async () => {
  // Phase 3 extended the compat fingerprint with the agent compatibility
  // floor (minAgentVersion), serverVersion, and supportedDeploymentModes.
  // All additions are additive and shape-pinned so the Builder can rely on
  // the exact machine contract.
  const res = await compatApi.GET();
  const body = (await res.json()) as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  assert.deepEqual(keys, [
    'agentProtocol',
    'minAgentVersion',
    'product',
    'serverVersion',
    'service',
    'supportedDeploymentModes',
    'version',
  ]);
  assert.match(body.product as string, /^[a-z0-9-]+$/);
  assert.equal(body.service, 'omnisight-web');
  assert.equal(body.agentProtocol, 1);
});

test('AC-5: compat exposes the agent-version floor and supported deployment modes', async () => {
  const res = await compatApi.GET();
  const body = (await res.json()) as Record<string, unknown>;
  assert.match(body.minAgentVersion as string, /^\d+\.\d+\.\d+$/, 'minAgentVersion must be numeric semver');
  assert.match(body.serverVersion as string, /^\d+\.\d+\.\d+$/, 'serverVersion must be numeric semver');
  assert.equal(body.serverVersion, body.version, 'serverVersion must equal the release version');
  const modes = body.supportedDeploymentModes as string[];
  assert.ok(Array.isArray(modes), 'supportedDeploymentModes must be an array');
  assert.deepEqual([...modes].sort(), ['CUSTOMER_DB', 'MANAGED', 'PRIVATE']);
  for (const m of modes) assert.match(m, /^(MANAGED|CUSTOMER_DB|PRIVATE)$/);
});

test('AC-6: compat remains public, DB-free and zero-state (no auth required, nothing persisted)', async () => {
  const res = await compatApi.GET();
  assert.equal(res.status, 200);
  const headers = Object.fromEntries(res.headers.entries());
  assert.ok(!('set-cookie' in headers), 'no session cookie may be issued');
  // The endpoint must not require or hint at authentication.
  const body = (await res.json()) as Record<string, unknown>;
  assert.ok(!('token' in body) && !('session' in body), 'no auth material in the fingerprint');
});

test('AC-3: the endpoint leaks NO secrets, internals, or environment', async () => {
  const res = await compatApi.GET();
  const text = JSON.stringify(await res.json()).toLowerCase();
  assert.ok(!text.includes('jwt'), 'no JWT material');
  assert.ok(!text.includes('password') && !text.includes('secret'), 'no credentials');
  assert.ok(!text.includes('database_url') && !text.includes('postgresql://'), 'no DB URL');
  assert.ok(!text.includes('token'), 'no tokens');
  assert.ok(!text.includes('api_key') && !text.includes('private_key'), 'no API/private keys');
  assert.ok(!text.includes('bearer'), 'no bearer material');
});

test('AC-4: /api/health and /api/agent/compat are distinct fingerprints', async () => {
  // A Builder validation that only checked "HTTP 200" would accept ANY server;
  // the whole point of compat is that it is OmniSight-specific. Assert the two
  // public endpoints do not answer the same question.
  const health = await (await import('../src/app/api/health/route')).GET();
  const compat = await compatApi.GET();
  const healthBody = (await health.json()) as Record<string, unknown>;
  const compatBody = (await compat.json()) as Record<string, unknown>;
  assert.ok(!('product' in healthBody), '/api/health must NOT carry the OmniSight fingerprint');
  assert.equal(compatBody.product, 'omnisight');
});
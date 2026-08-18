/**
 * OmniSight — Agent Software build API + env-aware server URL policy tests.
 *
 * Regression for the "Agent build exited with code 1" failure:
 *
 *   The org's saved server URL was `http://localhost:3000` (accepted by the
 *   settings validation in dev), but the build pipeline (omnisight-agent/
 *   scripts/build-prod.mjs) hard-required https://. The server passed the
 *   http URL straight to the child process, the child printed the real reason
 *   to STDERR and exited 1, and the server — which only captured stdout —
 *   stored the useless error "Agent build exited with code 1".
 *
 * These tests pin the fixed contract, driven by ONE canonical env-aware
 * validator (src/lib/agent-server-url.ts) shared by the Admin Settings API,
 * the Builder API, startAgentBuild, and the build script itself:
 *   - development/test: http://localhost / 127.0.0.1 (/ [::1]) is ALLOWED so
 *     local development builds work; https:// is always allowed.
 *   - production: https:// is MANDATORY — every http:// URL (loopback
 *     included) is rejected.
 *   - public (non-loopback) http:// is rejected in EVERY environment.
 *   - malformed URLs, non-HTTP(S) schemes, and embedded credentials are
 *     rejected everywhere.
 *   - A public http:// URL is rejected BEFORE any build is attempted, with a
 *     clear, actionable reason (both at the API boundary and inside
 *     startAgentBuild as defense-in-depth).
 *   - Captured child output (stdout AND stderr) is surfaced in the failure
 *     record, with the enrollment code redacted.
 *   - The build script's own behavior is reproduced exactly (exit 1 + stderr
 *     message) and confirmed to leave the source tree untouched.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_agent_software).
 * Run: npx tsx --test tests/agent-software-build.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import { NextRequest } from 'next/server';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

// ─── Test DB isolation (set BEFORE any app module import) ──────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_agent_software';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-agent-software-0123456789';
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
let agentSoftware: typeof import('../src/lib/agent-software');
let buildRoute: typeof import('../src/app/api/agent-software/build/route');
let settingsRoute: typeof import('../src/app/api/agent-software/route');
let agentServerUrl: typeof import('../src/lib/agent-server-url');
let validateServerUrl: typeof import('../src/lib/agent-server-url').validateServerUrl;
let SERVER_URL_MESSAGES: typeof import('../src/lib/agent-server-url').SERVER_URL_MESSAGES;

let orgA: { id: string };

before(async () => {
  db = (await import('../src/lib/db')).db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  agentSoftware = await import('../src/lib/agent-software');
  buildRoute = await import('../src/app/api/agent-software/build/route');
  settingsRoute = await import('../src/app/api/agent-software/route');
  agentServerUrl = await import('../src/lib/agent-server-url');
  validateServerUrl = agentServerUrl.validateServerUrl;
  SERVER_URL_MESSAGES = agentServerUrl.SERVER_URL_MESSAGES;

  orgA = await db.organization.create({ data: { name: 'Org A', slug: 'org-a-build' } });
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function req(token: string | null, opts: { method?: string; body?: unknown; url?: string; ip?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (opts.ip) headers['x-forwarded-for'] = opts.ip;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(opts.url || 'http://localhost:3000/api/agent-software/build', {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

function adminToken(orgId: string, role = 'admin'): Promise<string> {
  return signJWT({ userId: 'admin-build-test', email: 'admin@test.local', role, organizationId: orgId });
}

async function saveServerUrl(orgId: string, value: string) {
  await db.organizationSetting.upsert({
    where: { organizationId_key: { organizationId: orgId, key: 'agent_server_url' } },
    update: { value, category: 'agent' },
    create: { organizationId: orgId, key: 'agent_server_url', value, category: 'agent' },
  });
}

// ─── Unit: canonical validator — development/test policy ────────────────────

test('canonical validator — development/test: loopback http allowed, https allowed, public http rejected', () => {
  const dev = { env: 'development' };
  for (const url of ['http://localhost:3000', 'http://localhost:3001', 'http://127.0.0.1:3000', 'http://localhost', 'http://[::1]:3000']) {
    assert.deepEqual(validateServerUrl(url, dev), { ok: true, value: url }, `dev accepts ${url}`);
  }
  assert.deepEqual(
    validateServerUrl('https://agents.example.com/', dev),
    { ok: true, value: 'https://agents.example.com' },
    'trailing slash normalized; https allowed'
  );
  for (const url of ['http://example.com', 'http://agents.example.com:3000', 'http://10.0.0.1:3000']) {
    const r = validateServerUrl(url, dev);
    assert.equal(r.ok, false, `dev rejects public http: ${url}`);
    if (!r.ok) assert.equal(r.error, SERVER_URL_MESSAGES.publicHttp, `correct message for ${url}`);
  }
});

// ─── Unit: canonical validator — production policy ──────────────────────────

test('canonical validator — production: https only, all http rejected (loopback included)', () => {
  const prod = { env: 'production' };
  assert.deepEqual(validateServerUrl('https://example.com', prod), { ok: true, value: 'https://example.com' });
  for (const url of ['http://example.com', 'http://localhost:3000', 'http://127.0.0.1:3000', 'http://agents.example.com']) {
    const r = validateServerUrl(url, prod);
    assert.equal(r.ok, false, `production rejects ${url}`);
    if (!r.ok) assert.equal(r.error, SERVER_URL_MESSAGES.productionHttp, `production message for ${url}`);
  }
});

// ─── Unit: canonical validator — malformed, schemes, credentials ────────────

test('canonical validator — rejects malformed input, unsupported schemes, and credentials', () => {
  for (const bad of ['', '   ', 'not a url', 'example.com', undefined, null, 42]) {
    const r = validateServerUrl(bad, { env: 'development' });
    assert.equal(r.ok, false, `rejects invalid: ${String(bad)}`);
    if (!r.ok) assert.equal(r.error, SERVER_URL_MESSAGES.invalid, `invalid message for ${String(bad)}`);
  }
  const ftp = validateServerUrl('ftp://example.com', { env: 'development' });
  assert.equal(ftp.ok, false);
  if (!ftp.ok) assert.equal(ftp.error, SERVER_URL_MESSAGES.scheme);

  const creds = validateServerUrl('https://user:pass@agents.example.com', { env: 'development' });
  assert.equal(creds.ok, false);
  if (!creds.ok) assert.equal(creds.error, SERVER_URL_MESSAGES.credentials);
});

// ─── Unit: canonical validator — default env follows NODE_ENV (test) ────────

test('canonical validator — default env follows NODE_ENV (test = dev policy)', () => {
  assert.equal(validateServerUrl('http://localhost:3000').ok, true, 'test env accepts loopback http by default');
  assert.equal(validateServerUrl('http://agents.example.com').ok, false, 'test env still rejects public http');
  const r = validateServerUrl('http://agents.example.com');
  if (!r.ok) assert.equal(r.error, SERVER_URL_MESSAGES.publicHttp);
});

// ─── Unit: captured-output redaction ────────────────────────────────────────

test('redactBuildOutput strips the enrollment code before persistence', () => {
  const code = 'test-enroll-CODE-0123456789abcdef';
  const out = `[build-prod] baked enrollment code: ${code.slice(0, 4)}…\nfoo ${code} bar`;
  const redacted = agentSoftware.redactBuildOutput(out, [code]);
  assert.ok(!redacted.includes(code), 'plaintext enrollment code never persists');
  assert.ok(redacted.includes('[REDACTED]'));
});

// ─── Regression: startAgentBuild with a public http URL fails fast ──────────

test('startAgentBuild with a PUBLIC http URL fails the record fast with a clear reason (no child, no "exited with code 1")', async () => {
  const build = await db.agentBuild.create({
    data: {
      organizationId: orgA.id,
      serverUrl: 'http://agents.example.com',
      enrollmentCodeBaked: true,
      agentVersion: '1.1.0',
      status: 'pending',
      requestedBy: 'admin-build-test',
    },
  });

  const result = await agentSoftware.startAgentBuild(build, { enrollmentCode: 'some-code' });

  assert.equal(result.started, false);
  assert.equal(result.error, SERVER_URL_MESSAGES.publicHttp, 'a clear, actionable reason is returned');

  const row = await db.agentBuild.findUnique({ where: { id: build.id } });
  assert.equal(row!.status, 'failed');
  assert.equal(row!.startedAt, null, 'never reached "building" — no child spawned');
  assert.ok(row!.completedAt, 'record reaches a terminal state');
  assert.equal(row!.error, SERVER_URL_MESSAGES.publicHttp);
  assert.ok(!(row!.error ?? '').includes('Agent build exited with code 1'), 'no cryptic exit-code-only error');
});

// ─── API: public http override → immediate 422, no record ──────────────────

test('POST /build with a public http:// serverUrl override → 422 with the https reason, no record created', async () => {
  const org = await db.organization.create({ data: { name: 'Org Override', slug: 'org-build-override' } });
  const token = await adminToken(org.id);
  const res = await buildRoute.POST(req(token, { method: 'POST', body: { serverUrl: 'http://agents.example.com' }, ip: '203.0.113.1' }));
  assert.equal(res.status, 422);
  const body = await res.json() as { error: string };
  assert.equal(body.error, SERVER_URL_MESSAGES.publicHttp, 'the admin sees the actionable reason');

  const count = await db.agentBuild.count({ where: { organizationId: org.id } });
  assert.equal(count, 0, 'no doomed build record is created');
});

// ─── API: stored public http config → immediate 422, no record ─────────────

test('POST /build with the stored public http:// config → 422 with the https reason, no record created', async () => {
  const org = await db.organization.create({ data: { name: 'Org StoredHttp', slug: 'org-build-stored-http' } });
  await saveServerUrl(org.id, 'http://agents.example.com');
  const token = await adminToken(org.id);

  const res = await buildRoute.POST(req(token, { method: 'POST', body: {}, ip: '203.0.113.2' }));
  assert.equal(res.status, 422);
  const body = await res.json() as { error: string };
  assert.equal(body.error, SERVER_URL_MESSAGES.publicHttp);

  const count = await db.agentBuild.count({ where: { organizationId: org.id } });
  assert.equal(count, 0);
});

// ─── API: wrong enrollment code still rejected (behavior unchanged) ─────────

test('POST /build with an invalid enrollment code → 422 before any build', async () => {
  const org = await db.organization.create({ data: { name: 'Org WrongCode', slug: 'org-build-wrong-code' } });
  await saveServerUrl(org.id, 'https://agents.example.com');
  await db.organizationSetting.upsert({
    where: { organizationId_key: { organizationId: org.id, key: 'agent_enrollment_code' } },
    update: { value: agentSoftware.hashEnrollmentCode('real-code-abc123'), category: 'agent' },
    create: { organizationId: org.id, key: 'agent_enrollment_code', value: agentSoftware.hashEnrollmentCode('real-code-abc123'), category: 'agent' },
  });
  const token = await adminToken(org.id);

  const res = await buildRoute.POST(req(token, {
    method: 'POST',
    body: { enrollmentCode: 'not-the-code' },
    ip: '203.0.113.3',
  }));
  assert.equal(res.status, 422);
  const body = await res.json() as { error: string };
  assert.match(body.error, /Invalid enrollment code/);

  const count = await db.agentBuild.count({ where: { organizationId: org.id } });
  assert.equal(count, 0);
});

// ─── API: PUT — dev policy (test env) persists loopback http ────────────────

test('PUT /api/agent-software saves http://localhost:3000 in development', async () => {
  const org = await db.organization.create({ data: { name: 'Org Dev Save', slug: 'org-dev-save' } });
  const token = await adminToken(org.id);
  const res = await settingsRoute.PUT(req(token, {
    method: 'PUT',
    body: { serverUrl: 'http://localhost:3000' },
    url: 'http://localhost:3000/api/agent-software',
  }));
  assert.equal(res.status, 200);
  const saved = await db.organizationSetting.findFirst({ where: { organizationId: org.id, key: 'agent_server_url' } });
  assert.equal(saved?.value, 'http://localhost:3000');
});

test('PUT /api/agent-software rejects a public http URL even in development', async () => {
  const org = await db.organization.create({ data: { name: 'Org Dev Public', slug: 'org-dev-public' } });
  const token = await adminToken(org.id);
  const res = await settingsRoute.PUT(req(token, {
    method: 'PUT',
    body: { serverUrl: 'http://agents.example.com' },
    url: 'http://localhost:3000/api/agent-software',
  }));
  assert.equal(res.status, 422);
  const body = await res.json() as { error: string };
  assert.equal(body.error, SERVER_URL_MESSAGES.publicHttp);
});

// ─── API: PUT — production policy is https-only (env flip) ──────────────────

test('PUT /api/agent-software enforces HTTPS in production (http rejected even for localhost; https saved)', async () => {
  const org = await db.organization.create({ data: { name: 'Org Prod Save', slug: 'org-prod-save' } });
  const token = await adminToken(org.id);
  const url = 'http://localhost:3000/api/agent-software';
  const savedEnv = process.env.NODE_ENV;
  (process.env as Record<string, string>).NODE_ENV = 'production';
  try {
    const local = await settingsRoute.PUT(req(token, { method: 'PUT', body: { serverUrl: 'http://localhost:3000' }, url }));
    assert.equal(local.status, 422, 'production rejects loopback http too');
    assert.equal((await local.json()).error, SERVER_URL_MESSAGES.productionHttp);

    const publicHttp = await settingsRoute.PUT(req(token, { method: 'PUT', body: { serverUrl: 'http://agents.example.com' }, url }));
    assert.equal(publicHttp.status, 422);
    assert.equal((await publicHttp.json()).error, SERVER_URL_MESSAGES.productionHttp);

    const ok = await settingsRoute.PUT(req(token, { method: 'PUT', body: { serverUrl: 'https://agents.example.com' }, url }));
    assert.equal(ok.status, 200, 'production accepts https');
    const saved = await db.organizationSetting.findFirst({ where: { organizationId: org.id, key: 'agent_server_url' } });
    assert.equal(saved?.value, 'https://agents.example.com');
  } finally {
    (process.env as Record<string, string>).NODE_ENV = savedEnv ?? '';
  }
});

// ─── API: RBAC unchanged ────────────────────────────────────────────────────

test('POST /build as a viewer → 403 (admin-only)', async () => {
  const token = await adminToken(orgA.id, 'viewer');
  const res = await buildRoute.POST(req(token, { method: 'POST', body: {}, ip: '203.0.113.4' }));
  assert.equal(res.status, 403);
});

// ─── Script level: exact reproduction of the original exit-1 ────────────────

test('build-prod.mjs exits 1 for a PUBLIC http AGENT_SERVER_URL, prints the reason to stderr, and leaves the source tree untouched', async () => {
  const desktopAgentDir = join(process.cwd(), 'omnisight-agent');
  const serverUrlFile = join(desktopAgentDir, 'src', 'config', 'server-url.ts');
  const agentConfigFile = join(desktopAgentDir, 'src', 'config', 'agent-config.ts');
  const beforeServer = readFileSync(serverUrlFile, 'utf8');
  const beforeConfig = readFileSync(agentConfigFile, 'utf8');

  const child = spawn(process.execPath, ['scripts/build-prod.mjs'], {
    cwd: desktopAgentDir,
    env: { ...process.env, AGENT_SERVER_URL: 'http://agents.example.com' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));

  assert.equal(code, 1, 'a public http URL is unbuildable — the script exits 1');
  assert.match(stderr, /Public server URLs must use HTTPS/, 'the real reason goes to stderr');

  assert.equal(readFileSync(serverUrlFile, 'utf8'), beforeServer, 'server-url.ts untouched (validation fails before patching)');
  assert.equal(readFileSync(agentConfigFile, 'utf8'), beforeConfig, 'agent-config.ts untouched');
  assert.ok(!(stdout + stderr).includes('real-code-abc123'), 'no enrollment code appears in script output');
});

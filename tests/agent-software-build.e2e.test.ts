/**
 * OmniSight — Agent Software real Windows build E2E (OPT-IN).
 *
 * Runs the FULL Admin-UI build path end-to-end on a real Windows host:
 *   POST /api/agent-software/build → startAgentBuild → spawn
 *   node omnisight-agent/scripts/build-prod.mjs → npm run build →
 *   electron-builder --win nsis → stageArtifact → AgentBuild update.
 *
 * Covers BOTH sides of the canonical env-aware server URL policy
 * (src/lib/agent-server-url.ts), proven with real builds:
 *   - DEV build: stored http://localhost:3000 is accepted (test env = dev
 *     policy) and bakes a working installer.
 *   - PROD build: stored https://agents.example.com is accepted and bakes the
 *     production URL.
 *   - PUBLIC http is rejected at the API boundary BEFORE any build is
 *     attempted (422, no record, no child spawn).
 *
 * Then verifies every artifact-level guarantee (task-11 contract) for both
 * builds:
 *   - status becomes "completed" with fileName + sha256
 *   - the NSIS installer exists in omnisight-agent/out
 *   - the staged artifacts exist at uploads/agent-builds/<orgId>/<buildId>.exe
 *   - SHA-256 in the DB matches each actual artifact; the newest installer
 *     matches the last build's digest
 *   - the baked URLs are present in the main-process bundle (prod URL baked,
 *     dev default present)
 *   - the enrollment code is present ONLY in main-process config, never in
 *     the renderer bundle
 *   - the source config is restored to dev defaults after the build
 *   - no plaintext enrollment code is persisted in the database
 *   - the download endpoint serves the org's own artifact (200) and returns
 *     404 for a cross-org admin
 *
 * SKIPPED unless RUN_AGENT_BUILD_E2E=1 (it takes several minutes — two real
 * Windows builds — and requires the Windows toolchain):
 *   RUN_AGENT_BUILD_E2E=1 npx tsx --test tests/agent-software-build.e2e.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const RUN_E2E = process.env.RUN_AGENT_BUILD_E2E === '1';
const SKIP_REASON = 'set RUN_AGENT_BUILD_E2E=1 to run the real Windows build';

// ─── Test DB isolation (set BEFORE any app module import) ──────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_agent_software_e2e';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-agent-software-e2e-012345';
(process.env as Record<string, string>).NODE_ENV = 'test';

const ENROLLMENT_CODE = 'e2e-verify-code-0123456789abcdefghijklmn';
const DEV_URL = 'http://localhost:3000';
const PROD_URL = 'https://agents.example.com';
const DESKTOP_AGENT_DIR = join(process.cwd(), 'omnisight-agent');
const ARTIFACT_DIR = join(process.cwd(), 'uploads', 'agent-builds');

type DbModule = typeof import('../src/lib/db');
let db: DbModule['db'];
let signJWT: (payload: { userId: string; email: string; role: string; organizationId?: string }) => Promise<string>;
let agentSoftware: typeof import('../src/lib/agent-software');
let agentServerUrl: typeof import('../src/lib/agent-server-url');
let buildRoute: typeof import('../src/app/api/agent-software/build/route');
let downloadRoute: typeof import('../src/app/api/agent-software/builds/[id]/download/route');

let orgA: { id: string };
let orgB: { id: string };
let devBuildId = '';
let prodBuildId = '';

before(() => {
  if (!RUN_E2E) return;
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: 'pipe',
  });
});

before(async () => {
  if (!RUN_E2E) return;
  db = (await import('../src/lib/db')).db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  agentSoftware = await import('../src/lib/agent-software');
  agentServerUrl = await import('../src/lib/agent-server-url');
  buildRoute = await import('../src/app/api/agent-software/build/route');
  downloadRoute = await import('../src/app/api/agent-software/builds/[id]/download/route');

  orgA = await db.organization.create({ data: { name: 'E2E Org A', slug: 'e2e-org-a' } });
  orgB = await db.organization.create({ data: { name: 'E2E Org B', slug: 'e2e-org-b' } });

  // orgA = DEV build (loopback http), orgB = PROD build (https).
  await db.organizationSetting.upsert({
    where: { organizationId_key: { organizationId: orgA.id, key: 'agent_server_url' } },
    update: { value: DEV_URL, category: 'agent' },
    create: { organizationId: orgA.id, key: 'agent_server_url', value: DEV_URL, category: 'agent' },
  });
  await db.organizationSetting.upsert({
    where: { organizationId_key: { organizationId: orgB.id, key: 'agent_server_url' } },
    update: { value: PROD_URL, category: 'agent' },
    create: { organizationId: orgB.id, key: 'agent_server_url', value: PROD_URL, category: 'agent' },
  });
  for (const orgId of [orgA.id, orgB.id]) {
    await db.organizationSetting.upsert({
      where: { organizationId_key: { organizationId: orgId, key: 'agent_enrollment_code' } },
      update: { value: agentSoftware.hashEnrollmentCode(ENROLLMENT_CODE), category: 'agent' },
      create: { organizationId: orgId, key: 'agent_enrollment_code', value: agentSoftware.hashEnrollmentCode(ENROLLMENT_CODE), category: 'agent' },
    });
  }
});

after(async () => {
  if (!RUN_E2E) return;
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

function adminToken(orgId: string): Promise<string> {
  return signJWT({ userId: 'e2e-admin', email: 'e2e@test.local', role: 'admin', organizationId: orgId });
}

async function waitForTerminal(buildId: string): Promise<{ status: string; error: string | null }> {
  const deadline = Date.now() + 25 * 60 * 1000;
  while (Date.now() < deadline) {
    const row = await db.agentBuild.findUnique({ where: { id: buildId }, select: { status: true, error: true } });
    if (row && (row.status === 'completed' || row.status === 'failed')) return row;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('build did not reach a terminal state in time');
}

// ─── Fast gate: canonical policy + PUBLIC http rejected before any build ────

test('E2E: canonical policy allows loopback http in dev, and the build route rejects PUBLIC http before any build', { skip: !RUN_E2E && SKIP_REASON }, async () => {
  const dev = { env: 'development' };
  assert.equal(agentServerUrl.validateServerUrl(DEV_URL, dev).ok, true, 'loopback http accepted in development');
  const publicHttp = agentServerUrl.validateServerUrl('http://agents.example.com', dev);
  assert.equal(publicHttp.ok, false);
  if (!publicHttp.ok) assert.equal(publicHttp.error, agentServerUrl.SERVER_URL_MESSAGES.publicHttp);

  // Route-level: a PUBLIC http override must 422 with no record — the child
  // process is never spawned for an unbuildable URL.
  const orgC = await db.organization.create({ data: { name: 'E2E Org C', slug: 'e2e-org-c' } });
  const token = await adminToken(orgC.id);
  const res = await buildRoute.POST(req(token, { method: 'POST', body: { serverUrl: 'http://agents.example.com' }, ip: '203.0.113.102' }));
  assert.equal(res.status, 422);
  const body = await res.json() as { error: string };
  assert.equal(body.error, agentServerUrl.SERVER_URL_MESSAGES.publicHttp);
  const count = await db.agentBuild.count({ where: { organizationId: orgC.id } });
  assert.equal(count, 0, 'no doomed build record is created');
});

// ─── DEV build: stored http://localhost:3000 ────────────────────────────────

test('E2E: DEV build — stored http://localhost:3000 is accepted and completes', { skip: !RUN_E2E && SKIP_REASON }, async () => {
  const token = await adminToken(orgA.id);

  // The exact request the Admin UI sends (Settings → Agent Software → Build Agent).
  const res = await buildRoute.POST(req(token, {
    method: 'POST',
    body: { enrollmentCode: ENROLLMENT_CODE },
    ip: '203.0.113.99',
  }));
  assert.equal(res.status, 202, 'dev build accepted (loopback http allowed in test env)');
  const body = await res.json() as { buildId: string };
  devBuildId = body.buildId;
  assert.ok(devBuildId, 'build record id returned');

  const row = await waitForTerminal(devBuildId);
  assert.equal(row.status, 'completed', `dev build completed — recorded error: ${row.error ?? '(none)'}`);
});

// ─── PROD build: stored https://agents.example.com ──────────────────────────

test('E2E: PROD build — stored https://agents.example.com is accepted and completes', { skip: !RUN_E2E && SKIP_REASON }, async () => {
  const token = await adminToken(orgB.id);
  const res = await buildRoute.POST(req(token, {
    method: 'POST',
    body: { enrollmentCode: ENROLLMENT_CODE },
    ip: '203.0.113.103',
  }));
  assert.equal(res.status, 202, 'prod build accepted');
  const body = await res.json() as { buildId: string };
  prodBuildId = body.buildId;
  assert.ok(prodBuildId, 'build record id returned');

  const row = await waitForTerminal(prodBuildId);
  assert.equal(row.status, 'completed', `prod build completed — recorded error: ${row.error ?? '(none)'}`);
});

// ─── Artifact-level verification for BOTH builds ────────────────────────────

test('E2E: artifacts, SHA-256, baked URLs, code scoping, restore, DB hygiene, download', { skip: !RUN_E2E && SKIP_REASON }, async () => {
  const devRecord = await db.agentBuild.findUnique({ where: { id: devBuildId } });
  const prodRecord = await db.agentBuild.findUnique({ where: { id: prodBuildId } });
  assert.ok(devRecord && prodRecord, 'both build records exist');
  assert.ok(devRecord.sha256 && devRecord.fileName, 'dev build recorded sha256 + fileName');
  assert.ok(prodRecord.sha256 && prodRecord.fileName, 'prod build recorded sha256 + fileName');

  // Installers present in omnisight-agent/out (the newest = the LAST build = prod).
  const outDir = join(DESKTOP_AGENT_DIR, 'out');
  assert.ok(existsSync(outDir), 'out/ exists');
  const installers = readdirSync(outDir).filter((f) => /^OmniSight Agent Setup .+\.exe$/.test(f));
  assert.ok(installers.length > 0, 'NSIS installer produced');
  const newestInstaller = installers
    .map((f) => ({ f, t: statSync(join(outDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0];

  // Staged org-owned artifacts present.
  const devArtifact = join(ARTIFACT_DIR, orgA.id, devRecord.fileName);
  const prodArtifact = join(ARTIFACT_DIR, orgB.id, prodRecord.fileName);
  assert.ok(existsSync(devArtifact), `dev artifact staged at ${devArtifact}`);
  assert.ok(existsSync(prodArtifact), `prod artifact staged at ${prodArtifact}`);

  // SHA-256 in the DB matches each actual artifact; the newest installer
  // matches the last build's digest.
  assert.equal(createHash('sha256').update(readFileSync(devArtifact)).digest('hex'), devRecord.sha256, 'dev artifact digest === dev DB sha256');
  assert.equal(createHash('sha256').update(readFileSync(prodArtifact)).digest('hex'), prodRecord.sha256, 'prod artifact digest === prod DB sha256');
  assert.equal(
    createHash('sha256').update(readFileSync(join(outDir, newestInstaller.f))).digest('hex'),
    prodRecord.sha256,
    'newest installer === prod artifact digest'
  );

  // Baked URLs in the compiled main-process configuration
  // (dist/config/server-url.js — imported by the main process at startup).
  const mainConfigDir = join(DESKTOP_AGENT_DIR, 'dist', 'config');
  assert.ok(existsSync(mainConfigDir), 'dist/config exists');
  const serverUrlBundle = readFileSync(join(mainConfigDir, 'server-url.js'), 'utf8');
  const agentConfigBundle = readFileSync(join(mainConfigDir, 'agent-config.js'), 'utf8');
  assert.ok(serverUrlBundle.includes(PROD_URL), 'prod https URL is baked into the main-process config');
  assert.ok(serverUrlBundle.includes(DEV_URL), 'dev loopback URL present in the compiled config default');
  assert.ok(agentConfigBundle.includes(ENROLLMENT_CODE), 'enrollment code is baked into the main-process config');

  // Enrollment code: present in the main-process config ONLY.
  const rendererFiles: string[] = [];
  (function collect(dir: string) {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) collect(p);
      else rendererFiles.push(p);
    }
  })(join(DESKTOP_AGENT_DIR, 'dist', 'renderer'));
  const rendererBundle = rendererFiles.map((p) => readFileSync(p, 'utf8')).join('\n');
  assert.ok(!rendererBundle.includes(ENROLLMENT_CODE), 'renderer contains NO enrollment code');

  // Source config restored to dev defaults after BOTH builds.
  const serverUrlSrc = readFileSync(join(DESKTOP_AGENT_DIR, 'src', 'config', 'server-url.ts'), 'utf8');
  const agentConfigSrc = readFileSync(join(DESKTOP_AGENT_DIR, 'src', 'config', 'agent-config.ts'), 'utf8');
  assert.match(serverUrlSrc, /DEFAULT_SERVER_URL = 'http:\/\/localhost:3000';/, 'server-url.ts restored to the dev default');
  assert.ok(!serverUrlSrc.includes(PROD_URL), 'no prod baked URL remains in server-url.ts');
  assert.match(agentConfigSrc, /enrollmentCode: null/, 'agent-config.ts enrollment code cleared');
  assert.ok(!agentConfigSrc.includes(ENROLLMENT_CODE), 'no plaintext code remains in agent-config.ts');

  // No plaintext enrollment code anywhere in the database.
  assert.ok(!JSON.stringify(devRecord).includes(ENROLLMENT_CODE), 'no plaintext code in the dev AgentBuild record');
  assert.ok(!JSON.stringify(prodRecord).includes(ENROLLMENT_CODE), 'no plaintext code in the prod AgentBuild record');
  const allOrgASettings = JSON.stringify(await db.organizationSetting.findMany({ where: { organizationId: orgA.id } }));
  const allOrgBSettings = JSON.stringify(await db.organizationSetting.findMany({ where: { organizationId: orgB.id } }));
  assert.ok(!allOrgASettings.includes(ENROLLMENT_CODE), 'no plaintext code in org A settings');
  assert.ok(!allOrgBSettings.includes(ENROLLMENT_CODE), 'no plaintext code in org B settings');

  // Download endpoint: prod org owner gets the artifact; a cross-org admin gets 404.
  const owner = await adminToken(orgB.id);
  const dl = await downloadRoute.GET(req(owner, { ip: '203.0.113.104' }), { params: Promise.resolve({ id: prodBuildId }) });
  assert.equal(dl.status, 200, 'owner downloads the artifact');
  const bytes = Buffer.from(await dl.arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'), prodRecord.sha256, 'download bytes match the artifact');

  const intruder = await adminToken(orgA.id);
  const dlOther = await downloadRoute.GET(req(intruder, { ip: '203.0.113.105' }), { params: Promise.resolve({ id: prodBuildId }) });
  assert.equal(dlOther.status, 404, 'cross-org admin cannot download');
});

test('E2E: exact child command is fixed — no shell, fixed script path', { skip: !RUN_E2E && SKIP_REASON }, async () => {
  // Mirrors startAgentBuild: node <omnisight-agent>/scripts/build-prod.mjs, cwd
  // omnisight-agent, env-driven config. Proves the invocation used by the server.
  const src = readFileSync(join(process.cwd(), 'src', 'lib', 'agent-software.ts'), 'utf8');
  assert.ok(src.includes(`spawn(process.execPath, [BUILD_SCRIPT],`), 'child spawns the fixed build script');
  assert.ok(src.includes(`cwd: DESKTOP_AGENT_DIR`), 'child cwd is the omnisight-agent checkout');
  assert.ok(!/shell:\s*true/.test(src), 'no shell invocation (no arbitrary command execution)');
});

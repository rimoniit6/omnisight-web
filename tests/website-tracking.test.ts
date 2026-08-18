/**
 * Website Domain Tracking — server-side enforcement tests.
 *
 * Covers:
 *   WT-1  — full URLs are sanitized to domain-only at ingestion
 *   WT-2  — credentials/paths/queries/fragments never reach the database
 *   WT-3  — internal schemes and malformed hostnames are rejected (row dropped)
 *   WT-4  — authentication enforced (401 without a valid agent token)
 *   WT-5  — consent enforced (403 without activity_tracking consent)
 *   WT-6  — tenant isolation: cross-org token can never write another org's rows
 *   WT-7  — payload limits preserved (100 max activities)
 *   WT-8  — normal (non-website) activity rows are unaffected
 *   WT-9  — normalizeWebsiteDomain unit matrix
 *   WT-10 — admin aggregation surfaces domain-only values (no raw URLs)
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_website_tracking).
 * Run: npx tsx --test tests/website-tracking.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation (set BEFORE any app module import) ──────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_website_tracking';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-website-tracking-0123456789abcdef';
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
let activityRoute: typeof import('../src/app/api/agent/activity/route');
let generateToken: (length?: number) => string;
let nextPolicyVersion: (versions: string[]) => string;
let normalizeWebsiteDomain: (input: string | null | undefined) => string | null;
let sanitizeWebsiteTitle: (input: string | null | undefined) => string | null;

before(async () => {
  db = (await import('../src/lib/db')).db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  generateToken = (await import('../src/lib/agent/auth')).generateToken;
  nextPolicyVersion = (await import('../src/lib/consent')).nextPolicyVersion;
  normalizeWebsiteDomain = (await import('../src/lib/domain')).normalizeWebsiteDomain;
  sanitizeWebsiteTitle = (await import('../src/lib/domain')).sanitizeWebsiteTitle;

  activityRoute = (await import('../src/app/api/agent/activity/route'));
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

function agentReq(token: string, activities: unknown[]): NextRequest {
  return new NextRequest('http://localhost:3000/api/agent/activity', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ activities }),
  });
}

async function seedOrg(name: string) {
  return db.organization.create({ data: { name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') } });
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
      agentApproved: true,
    },
  });
}

async function publishPolicy(orgId: string, consentType: string) {
  const existing = await db.consentPolicy.findMany({
    where: { organizationId: orgId, consentType },
    select: { version: true },
  });
  const version = nextPolicyVersion(existing.map((e) => e.version));
  await db.consentPolicy.updateMany({
    where: { organizationId: orgId, consentType, status: 'published' },
    data: { status: 'archived' },
  });
  return db.consentPolicy.create({
    data: {
      organizationId: orgId,
      consentType,
      title: `${consentType} Policy`,
      content: 'Test policy content.',
      version,
      status: 'published',
      effectiveAt: new Date(),
      publishedAt: new Date(),
    },
  });
}

async function grantConsent(employeeId: string, orgId: string, consentType: string) {
  const policy = await publishPolicy(orgId, consentType);
  await db.consent.create({
    data: {
      employeeId,
      organizationId: orgId,
      consentType,
      status: 'granted',
      consentVersion: policy.version,
      policyId: policy.id,
      grantedAt: new Date(),
    },
  });
}

/** Issue a valid device-bound agent token for an employee. */
async function agentTokenFor(employeeId: string): Promise<string> {
  const token = generateToken(64);
  await db.agentToken.create({
    data: { token, employeeId, expiresAt: new Date(Date.now() + 3600_000) },
  });
  return token;
}

// ─── WT-9: normalizeWebsiteDomain unit matrix ──────────────────────────────

test('WT-9: normalizeWebsiteDomain unit matrix', () => {
  assert.equal(normalizeWebsiteDomain('https://www.github.com/a/b?x=1'), 'github.com');
  assert.equal(normalizeWebsiteDomain('https://github.com/a/b'), 'github.com');
  assert.equal(normalizeWebsiteDomain('HTTP://WWW.YOUTUBE.COM/watch?v=1'), 'youtube.com');
  assert.equal(normalizeWebsiteDomain('https://user:pass@example.com/a'), 'example.com');
  assert.equal(normalizeWebsiteDomain('github.com'), 'github.com');
  assert.equal(normalizeWebsiteDomain('https://mail.google.com/mail/u/0/'), 'mail.google.com');
  assert.equal(normalizeWebsiteDomain('https://example.com/path?token=SECRET123'), 'example.com');
  assert.equal(normalizeWebsiteDomain('https://example.com/document/private-id-123'), 'example.com');
  assert.equal(normalizeWebsiteDomain('chrome://settings'), null);
  assert.equal(normalizeWebsiteDomain('javascript:alert(1)'), null);
  assert.equal(normalizeWebsiteDomain('not a valid hostname'), null);
  assert.equal(normalizeWebsiteDomain('localhost:3000'), null);
  assert.equal(normalizeWebsiteDomain(''), null);
  assert.equal(normalizeWebsiteDomain(null), null);
});

test('WT-9b: sanitizeWebsiteTitle strips URL-like tokens', () => {
  assert.equal(sanitizeWebsiteTitle('GitHub'), 'GitHub');
  assert.equal(sanitizeWebsiteTitle('https://github.com/user/secret?token=abc'), null);
  assert.equal(sanitizeWebsiteTitle('Home — https://github.com/user/repo?x=1'), 'Home —');
  assert.equal(sanitizeWebsiteTitle('   '), null);
  assert.equal(sanitizeWebsiteTitle(null), null);
});

// ─── WT-1/WT-2/WT-3: sanitization at ingestion ──────────────────────────────

test('WT-1+2+3: website activity is domain-sanitized at ingestion; secrets never persisted', async () => {
  const org = await seedOrg('wt-1-org');
  const emp = await seedEmployee(org.id, 'WT-1');
  await grantConsent(emp.id, org.id, 'activity_tracking');
  const token = await agentTokenFor(emp.id);

  const res = await activityRoute.POST(agentReq(token, [
    { type: 'website', url: 'https://www.github.com/company/private-project?token=abc', title: 'https://github.com/user/secret?token=abc', duration: 600, timestamp: new Date().toISOString() },
    { type: 'website', url: 'https://example.com/login?email=user@example.com', duration: 300, timestamp: new Date().toISOString() },
    { type: 'website', url: 'https://user:pass@example.com/secret', duration: 120, timestamp: new Date().toISOString() },
    { type: 'website', url: 'chrome://settings', duration: 60, timestamp: new Date().toISOString() },
    { type: 'website', url: 'javascript:alert(1)', duration: 60, timestamp: new Date().toISOString() },
    { type: 'website', url: 'not a valid hostname', duration: 60, timestamp: new Date().toISOString() },
  ]));
  assert.equal(res.status, 200);

  const rows = await db.activity.findMany({ where: { employeeId: emp.id, type: 'website' } });
  assert.equal(rows.length, 3, '3 valid rows stored, 3 invalid dropped');
  const urls = rows.map((r) => r.url).sort();
  assert.deepEqual(urls, ['example.com', 'example.com', 'github.com']);
  // The URL-like title on the github row must have been sanitized away.
  for (const r of rows) {
    assert.ok(!(r.title ?? '').includes('https://'), 'no URL token survives in titles');
    assert.ok(!(r.title ?? '').includes('?token='), 'no secret token survives in titles');
  }
  // No path / query / fragment / credential may ever appear.
  for (const r of rows) {
    assert.ok(r.url, 'url must be non-null');
    assert.ok(!r.url!.includes('http'), 'no scheme in stored url');
    assert.ok(!r.url!.includes('?'), 'no query string in stored url');
    assert.ok(!r.url!.includes('#'), 'no fragment in stored url');
    assert.ok(!r.url!.includes('/'), 'no path in stored url');
    assert.ok(!r.url!.includes('@'), 'no credentials in stored url');
    assert.ok(!r.url!.includes('token'), 'no secret token in stored url');
    assert.ok(!r.url!.includes('email'), 'no PII in stored url');
    assert.ok(!r.url!.includes('secret'), 'no secret path in stored url');
  }
});

// ─── WT-4: authentication ──────────────────────────────────────────────────

test('WT-4: activity upload without a valid agent token returns 401', async () => {
  const res = await activityRoute.POST(agentReq('bogus-token', [
    { type: 'website', url: 'github.com', duration: 60 },
  ]));
  assert.equal(res.status, 401);
});

// ─── WT-5: consent ─────────────────────────────────────────────────────────

test('WT-5: website upload without activity consent returns 403', async () => {
  const org = await seedOrg('wt-5-org');
  const emp = await seedEmployee(org.id, 'WT-5');
  const token = await agentTokenFor(emp.id);

  const res = await activityRoute.POST(agentReq(token, [
    { type: 'website', url: 'github.com', duration: 60 },
  ]));
  assert.equal(res.status, 403, 'no consent → fail closed');
});

// ─── WT-6: tenant isolation ────────────────────────────────────────────────

test('WT-6: an agent token can only write rows for ITS OWN organization', async () => {
  const orgA = await seedOrg('wt-6-org-a');
  const orgB = await seedOrg('wt-6-org-b');
  const empB = await seedEmployee(orgB.id, 'WT-6');
  await grantConsent(empB.id, orgB.id, 'activity_tracking');
  const tokenB = await agentTokenFor(empB.id);

  // Attempt to smuggle another org's employeeId in the payload — the server
  // must derive identity ONLY from the token.
  const res = await activityRoute.POST(agentReq(tokenB, [
    {
      type: 'website',
      url: 'github.com',
      duration: 60,
      employeeId: 'org-a-employee-id-that-does-not-exist',
    },
  ]));
  assert.equal(res.status, 200);

  // The row is bound to the AUTHENTICATED employee (org B), never to any
  // client-supplied employeeId.
  const rows = await db.activity.findMany({
    where: { employeeId: empB.id, type: 'website' },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.employeeId, empB.id);

  // Nothing was created for org A (there is no org A employee at all).
  const orgACount = await db.activity.count({
    where: { employee: { organizationId: orgA.id } },
  });
  assert.equal(orgACount, 0, 'cross-org write impossible');
});

// ─── WT-7: payload limits ──────────────────────────────────────────────────

test('WT-7: batch payload limits preserved (max 100)', async () => {
  const org = await seedOrg('wt-7-org');
  const emp = await seedEmployee(org.id, 'WT-7');
  await grantConsent(emp.id, org.id, 'activity_tracking');
  const token = await agentTokenFor(emp.id);

  const activities = Array.from({ length: 101 }, (_, i) => ({
    type: 'website',
    url: `example${i}.com`,
    duration: 60,
  }));
  const res = await activityRoute.POST(agentReq(token, activities));
  assert.equal(res.status, 400, 'over-limit batch rejected');
});

// ─── WT-8: non-website rows unaffected ─────────────────────────────────────

test('WT-8: normal application activity rows are stored unchanged', async () => {
  const org = await seedOrg('wt-8-org');
  const emp = await seedEmployee(org.id, 'WT-8');
  await grantConsent(emp.id, org.id, 'activity_tracking');
  const token = await agentTokenFor(emp.id);

  const res = await activityRoute.POST(agentReq(token, [
    { type: 'application', applicationName: 'Code.exe', title: 'src/main.ts', duration: 900 },
    { type: 'idle', duration: 60 },
  ]));
  assert.equal(res.status, 200);

  const apps = await db.activity.findMany({ where: { employeeId: emp.id, type: 'application' } });
  assert.equal(apps.length, 1);
  assert.equal(apps[0]!.applicationName, 'Code.exe');
  assert.equal(apps[0]!.url, null, 'application rows have no url');
});

// ─── WT-10: admin aggregation surfaces domain-only values ───────────────────

test('WT-10: employee detail aggregates websites as domains (no raw URLs)', async () => {
  const org = await seedOrg('wt-10-org');
  const emp = await seedEmployee(org.id, 'WT-10');
  await grantConsent(emp.id, org.id, 'activity_tracking');
  const token = await agentTokenFor(emp.id);

  const now = new Date().toISOString();
  const res = await activityRoute.POST(agentReq(token, [
    { type: 'website', url: 'https://www.github.com/company/private?token=abc', duration: 600, timestamp: now },
    { type: 'website', url: 'https://www.github.com/other/repo', duration: 300, timestamp: now },
    { type: 'website', url: 'https://youtube.com/watch?v=xyz', duration: 900, timestamp: now },
  ]));
  assert.equal(res.status, 200);

  const detailRoute = (await import('../src/app/api/employees/[id]/detail/route'));
  const adminToken = await signJWT({ userId: 'admin-wt10', email: 'admin@test.local', role: 'admin', organizationId: org.id });
  const detail = await detailRoute.GET(
    new NextRequest(`http://localhost:3000/api/employees/${emp.id}/detail`, {
      headers: { authorization: `Bearer ${adminToken}` },
    }),
    { params: Promise.resolve({ id: emp.id }) }
  );
  assert.equal(detail.status, 200);
  const body = await detail.json() as { topWebsites: Array<{ name: string; duration: number }> };

  // github.com aggregated across both visits → 15 min; youtube 15 min.
  const github = body.topWebsites.find((w) => w.name === 'github.com');
  const youtube = body.topWebsites.find((w) => w.name === 'youtube.com');
  assert.ok(github, 'github.com present in top websites');
  assert.equal(github!.duration, 15, 'durations aggregate across visits');
  assert.ok(youtube, 'youtube.com present in top websites');
  // No raw URL ever surfaces.
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('company/private'), 'no raw path in admin response');
  assert.ok(!raw.includes('token=abc'), 'no query token in admin response');
  assert.ok(!raw.includes('watch?v=xyz'), 'no raw query in admin response');
});

// ─── WT-P2-1: server-side website_tracking enforcement ────────────────────
//
// The org setting must gate website ingestion server-side, independently of
// the agent/extension. Resolved from the AUTHENTICATED token's organization
// via resolveOrgMonitoring (the same canonical resolver the agent config
// endpoint uses). A website row in a mixed batch rejects the WHOLE batch.

async function setWebsiteTracking(orgId: string, value: boolean) {
  await db.organizationSetting.upsert({
    where: { organizationId_key: { organizationId: orgId, key: 'website_tracking' } },
    update: { value: String(value), category: 'monitoring' },
    create: { organizationId: orgId, key: 'website_tracking', value: String(value), category: 'monitoring' },
  });
}

async function countWebsite(employeeId: string): Promise<number> {
  return db.activity.count({ where: { employeeId, type: 'website' } });
}

function websiteAct(url = 'github.com'): Record<string, unknown> {
  return { type: 'website', url, duration: 60, timestamp: new Date().toISOString() };
}

test('WT-P2-1-01: website_tracking=true → website activity accepted', async () => {
  const org = await seedOrg('wt-p2-1-01-org');
  const emp = await seedEmployee(org.id, 'WT-P2-1-01');
  await grantConsent(emp.id, org.id, 'activity_tracking');
  await setWebsiteTracking(org.id, true);
  const token = await agentTokenFor(emp.id);

  const res = await activityRoute.POST(agentReq(token, [websiteAct()]));
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  assert.equal(await countWebsite(emp.id), 1);
});

test('WT-P2-1-02: website_tracking=false → website activity rejected', async () => {
  const org = await seedOrg('wt-p2-1-02-org');
  const emp = await seedEmployee(org.id, 'WT-P2-1-02');
  await grantConsent(emp.id, org.id, 'activity_tracking');
  await setWebsiteTracking(org.id, false);
  const token = await agentTokenFor(emp.id);

  const res = await activityRoute.POST(agentReq(token, [websiteAct()]));
  assert.equal(res.status, 403, `expected 403, got ${res.status}`);
  const body = await res.json() as { error?: string };
  assert.equal(body.error, 'WEBSITE_TRACKING_DISABLED', 'stable machine-readable error code');
});

test('WT-P2-1-03: website_tracking=false → zero DB writes', async () => {
  const org = await seedOrg('wt-p2-1-03-org');
  const emp = await seedEmployee(org.id, 'WT-P2-1-03');
  await grantConsent(emp.id, org.id, 'activity_tracking');
  await setWebsiteTracking(org.id, false);
  const token = await agentTokenFor(emp.id);

  const before = await db.activity.count({ where: { employeeId: emp.id } });
  const res = await activityRoute.POST(agentReq(token, [websiteAct()]));
  assert.equal(res.status, 403);
  const after = await db.activity.count({ where: { employeeId: emp.id } });
  assert.equal(after, before, 'zero rows written while tracking disabled');
});

test('WT-P2-1-04: website_tracking=false + valid consent → still rejected', async () => {
  const org = await seedOrg('wt-p2-1-04-org');
  const emp = await seedEmployee(org.id, 'WT-P2-1-04');
  await grantConsent(emp.id, org.id, 'activity_tracking'); // valid, active consent
  await setWebsiteTracking(org.id, false);
  const token = await agentTokenFor(emp.id);

  const res = await activityRoute.POST(agentReq(token, [websiteAct()]));
  assert.equal(res.status, 403, 'consent alone does not enable website tracking');
  const body = await res.json() as { error?: string };
  assert.equal(body.error, 'WEBSITE_TRACKING_DISABLED');
});

test('WT-P2-1-05: website_tracking=false + forged organizationId → ignored', async () => {
  const org = await seedOrg('wt-p2-1-05-org');
  const emp = await seedEmployee(org.id, 'WT-P2-1-05');
  await grantConsent(emp.id, org.id, 'activity_tracking');
  await setWebsiteTracking(org.id, false);
  const token = await agentTokenFor(emp.id);

  // Forged org in the payload must not bypass the token-derived org's setting.
  const res = await activityRoute.POST(agentReq(token, [
    { ...websiteAct(), organizationId: 'some-other-org-with-tracking-on' },
  ]));
  assert.equal(res.status, 403, 'server uses the token org setting, not the payload');
  const body = await res.json() as { error?: string };
  assert.equal(body.error, 'WEBSITE_TRACKING_DISABLED');
});

test('WT-P2-1-06: website_tracking=true + forged organizationId → attribution stays token-derived', async () => {
  const org = await seedOrg('wt-p2-1-06-org');
  const emp = await seedEmployee(org.id, 'WT-P2-1-06');
  await grantConsent(emp.id, org.id, 'activity_tracking');
  await setWebsiteTracking(org.id, true);
  const token = await agentTokenFor(emp.id);

  const res = await activityRoute.POST(agentReq(token, [
    { ...websiteAct(), employeeId: 'bogus-employee', organizationId: 'bogus-org', deviceId: 'bogus-device' },
  ]));
  assert.equal(res.status, 200);
  const rows = await db.activity.findMany({ where: { employeeId: emp.id, type: 'website' } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.employeeId, emp.id, 'employee from token');
  assert.equal(rows[0]!.deviceId, null, 'no device from payload');
  const orgCount = await db.activity.count({ where: { employee: { organizationId: org.id } } });
  assert.equal(orgCount, 1);
});

test('WT-P2-1-07: mixed batch with website while disabled → whole batch rejected, zero writes', async () => {
  const org = await seedOrg('wt-p2-1-07-org');
  const emp = await seedEmployee(org.id, 'WT-P2-1-07');
  await grantConsent(emp.id, org.id, 'activity_tracking');
  await setWebsiteTracking(org.id, false);
  const token = await agentTokenFor(emp.id);

  const res = await activityRoute.POST(agentReq(token, [
    { type: 'application', applicationName: 'Code.exe', duration: 900 },
    websiteAct(),
    { type: 'idle', duration: 60 },
  ]));
  assert.equal(res.status, 403, 'atomic batch rejection');
  const body = await res.json() as { error?: string };
  assert.equal(body.error, 'WEBSITE_TRACKING_DISABLED');
  assert.equal(await db.activity.count({ where: { employeeId: emp.id } }), 0, 'zero rows — no partial write');
});

test('WT-P2-1-08: re-enable website_tracking → website ingestion resumes', async () => {
  const org = await seedOrg('wt-p2-1-08-org');
  const emp = await seedEmployee(org.id, 'WT-P2-1-08');
  await grantConsent(emp.id, org.id, 'activity_tracking');
  await setWebsiteTracking(org.id, false);
  const token = await agentTokenFor(emp.id);

  assert.equal((await activityRoute.POST(agentReq(token, [websiteAct()]))).status, 403);
  await setWebsiteTracking(org.id, true);
  const res = await activityRoute.POST(agentReq(token, [websiteAct()]));
  assert.equal(res.status, 200, 'ingestion resumes after re-enable');
  assert.equal(await countWebsite(emp.id), 1);
});

test('WT-P2-1-09: existing application/activity ingestion unaffected', async () => {
  const org = await seedOrg('wt-p2-1-09-org');
  const emp = await seedEmployee(org.id, 'WT-P2-1-09');
  await grantConsent(emp.id, org.id, 'activity_tracking');
  // Setting irrelevant to non-website rows.
  await setWebsiteTracking(org.id, false);
  const token = await agentTokenFor(emp.id);

  const res = await activityRoute.POST(agentReq(token, [
    { type: 'application', applicationName: 'Code.exe', duration: 900 },
    { type: 'idle', duration: 60 },
    { type: 'work_session', duration: 60 },
    { type: 'screenshot', duration: 60 },
  ]));
  assert.equal(res.status, 200, 'non-website rows unaffected by website_tracking=false');
  assert.equal(await db.activity.count({ where: { employeeId: emp.id, type: 'application' } }), 1);
  assert.equal(await db.activity.count({ where: { employeeId: emp.id, type: 'idle' } }), 1);
  assert.equal(await db.activity.count({ where: { employeeId: emp.id, type: 'work_session' } }), 1);
  assert.equal(await db.activity.count({ where: { employeeId: emp.id, type: 'screenshot' } }), 1);
});

test('WT-P2-1-10: tenant isolation intact — org A disabled does not affect org B', async () => {
  const orgA = await seedOrg('wt-p2-1-10-org-a');
  const orgB = await seedOrg('wt-p2-1-10-org-b');
  const empA = await seedEmployee(orgA.id, 'WT-P2-1-10-A');
  const empB = await seedEmployee(orgB.id, 'WT-P2-1-10-B');
  await grantConsent(empA.id, orgA.id, 'activity_tracking');
  await grantConsent(empB.id, orgB.id, 'activity_tracking');
  await setWebsiteTracking(orgA.id, false);
  await setWebsiteTracking(orgB.id, true);
  const tokenA = await agentTokenFor(empA.id);
  const tokenB = await agentTokenFor(empB.id);

  const resA = await activityRoute.POST(agentReq(tokenA, [websiteAct()]));
  assert.equal(resA.status, 403, 'org A (disabled) rejects');
  const resB = await activityRoute.POST(agentReq(tokenB, [websiteAct()]));
  assert.equal(resB.status, 200, 'org B (enabled) accepts');
  assert.equal(await countWebsite(empA.id), 0);
  assert.equal(await countWebsite(empB.id), 1, 'org B row written');
  // Cross-org: org A's rows are invisible to org B (and vice versa) —
  // org A has zero rows; nothing leaked into org B.
  const orgACount = await db.activity.count({ where: { employee: { organizationId: orgA.id } } });
  const orgBCount = await db.activity.count({ where: { employee: { organizationId: orgB.id } } });
  assert.equal(orgACount, 0);
  assert.equal(orgBCount, 1, 'only org B has rows, none cross-org');
});

// ─── WT-AGG: Website Usage aggregation (duration / visits / first+last) ──────
//
// These tests drive the REAL admin endpoints (/api/employees/[id]/websites and
// /api/employees/[id]/detail) against rows persisted through the REAL
// ingestion route, verifying the DB → API duration semantics the Admin
// Website Usage panel renders:
//   - durations SUM per domain across non-contiguous intervals (never a row
//     count, never double-counting)
//   - visit count = number of stored slices
//   - firstSeen / lastSeen from min/max timestamps
//   - org-timezone day boundaries (Asia/Dhaka day ≠ UTC day)
//   - server-side aggregation over the FULL range (not the first activity page)
//   - pagination, empty state, privacy (domain-only) and RBAC

interface WebsitesRow {
  domain: string;
  visits: number;
  totalSeconds: number;
  firstSeen: string;
  lastSeen: string;
}

interface WebsitesBody {
  data: WebsitesRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  summary: { totalSeconds: number; totalVisits: number; domains: number };
}

async function websitesFor(
  adminToken: string,
  employeeId: string,
  params: Record<string, string> = {}
): Promise<{ status: number; body: WebsitesBody }> {
  const route = await import('../src/app/api/employees/[id]/websites/route');
  const qs = new URLSearchParams(params).toString();
  const res = await route.GET(
    new NextRequest(`http://localhost:3000/api/employees/${employeeId}/websites${qs ? `?${qs}` : ''}`, {
      headers: { authorization: `Bearer ${adminToken}` },
    }),
    { params: Promise.resolve({ id: employeeId }) }
  );
  return { status: res.status, body: (await res.json()) as WebsitesBody };
}

interface TopWebsite {
  name: string;
  duration: number;
  percentage: number;
}

async function detailFor(
  adminToken: string,
  employeeId: string,
  params: Record<string, string> = {}
): Promise<{ status: number; body: { topWebsites?: TopWebsite[] } }> {
  const route = await import('../src/app/api/employees/[id]/detail/route');
  const qs = new URLSearchParams(params).toString();
  const res = await route.GET(
    new NextRequest(`http://localhost:3000/api/employees/${employeeId}/detail${qs ? `?${qs}` : ''}`, {
      headers: { authorization: `Bearer ${adminToken}` },
    }),
    { params: Promise.resolve({ id: employeeId }) }
  );
  return { status: res.status, body: (await res.json()) as { topWebsites?: TopWebsite[] } };
}

async function seedOrgWithTz(name: string, timezone: string) {
  return db.organization.create({
    data: { name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${timezone.toLowerCase().replace(/[^a-z0-9]+/g, '')}`, timezone },
  });
}

async function adminTokenFor(orgId: string, code: string): Promise<string> {
  return signJWT({ userId: `admin-${code}`, email: `admin-${code}@test.local`, role: 'admin', organizationId: orgId });
}

async function uploadWebsite(token: string, url: string, duration: number, timestamp: string) {
  const res = await activityRoute.POST(agentReq(token, [
    { type: 'website', url, duration, timestamp },
  ]));
  assert.equal(res.status, 200, `upload ${url} failed: ${await res.text()}`);
}

test('WT-AGG-01: website duration aggregates per domain (seconds, not row count)', async () => {
  const org = await seedOrgWithTz('wt-agg-01-org', 'UTC');
  const emp = await seedEmployee(org.id, 'WT-AGG-01');
  await grantConsent(emp.id, org.id, 'activity_tracking');
  await setWebsiteTracking(org.id, true);
  const token = await agentTokenFor(emp.id);

  await uploadWebsite(token, 'lwn.net', 300, '2026-08-14T10:00:00.000Z');
  await uploadWebsite(token, 'en.wikipedia.org', 180, '2026-08-14T10:05:00.000Z');
  await uploadWebsite(token, 'github.com', 120, '2026-08-14T10:10:00.000Z');

  const admin = await adminTokenFor(org.id, 'wt-agg-01');
  const { status, body } = await websitesFor(admin, emp.id, { from: '2026-08-14', to: '2026-08-14' });
  assert.equal(status, 200);
  assert.equal(body.total, 3);
  const lwn = body.data.find((r) => r.domain === 'lwn.net');
  const wiki = body.data.find((r) => r.domain === 'en.wikipedia.org');
  const gh = body.data.find((r) => r.domain === 'github.com');
  assert.ok(lwn && wiki && gh, 'all three domains present');
  assert.equal(lwn.totalSeconds, 300);
  assert.equal(lwn.visits, 1);
  assert.equal(wiki.totalSeconds, 180);
  assert.equal(gh.totalSeconds, 120);
  assert.equal(body.summary.totalSeconds, 600, 'summary sums all domains');
  assert.equal(body.summary.totalVisits, 3);
  assert.equal(body.summary.domains, 3);
});

test('WT-AGG-02: multiple intervals for the same domain SUM (no double counting, no row-count)', async () => {
  const org = await seedOrgWithTz('wt-agg-02-org', 'UTC');
  const emp = await seedEmployee(org.id, 'WT-AGG-02');
  await grantConsent(emp.id, org.id, 'activity_tracking');
  await setWebsiteTracking(org.id, true);
  const token = await agentTokenFor(emp.id);

  // lwn.net 10:00–10:05 → github 10:05–10:10 → lwn.net 10:10–10:15
  await uploadWebsite(token, 'lwn.net', 300, '2026-08-14T10:00:00.000Z');
  await uploadWebsite(token, 'github.com', 300, '2026-08-14T10:05:00.000Z');
  await uploadWebsite(token, 'lwn.net', 300, '2026-08-14T10:10:00.000Z');

  const admin = await adminTokenFor(org.id, 'wt-agg-02');
  const { body } = await websitesFor(admin, emp.id, { from: '2026-08-14', to: '2026-08-14' });
  const lwn = body.data.find((r) => r.domain === 'lwn.net');
  const gh = body.data.find((r) => r.domain === 'github.com');
  assert.ok(lwn && gh, 'both domains present');
  // lwn.net = first interval + second interval (600s), NOT 300 (row count)
  assert.equal(lwn.totalSeconds, 600, 'non-contiguous visits sum');
  assert.equal(lwn.visits, 2, 'visit count = number of slices');
  assert.equal(gh.totalSeconds, 300);
  assert.equal(body.summary.totalSeconds, 900);
});

test('WT-AGG-03: firstSeen / lastSeen reflect min/max timestamps', async () => {
  const org = await seedOrgWithTz('wt-agg-03-org', 'UTC');
  const emp = await seedEmployee(org.id, 'WT-AGG-03');
  await grantConsent(emp.id, org.id, 'activity_tracking');
  await setWebsiteTracking(org.id, true);
  const token = await agentTokenFor(emp.id);

  await uploadWebsite(token, 'lwn.net', 300, '2026-08-14T10:00:00.000Z');
  await uploadWebsite(token, 'github.com', 300, '2026-08-14T11:00:00.000Z');
  await uploadWebsite(token, 'lwn.net', 120, '2026-08-14T10:10:00.000Z');

  const admin = await adminTokenFor(org.id, 'wt-agg-03');
  const { body } = await websitesFor(admin, emp.id, { from: '2026-08-14', to: '2026-08-14' });
  const lwn = body.data.find((r) => r.domain === 'lwn.net');
  const gh = body.data.find((r) => r.domain === 'github.com');
  assert.ok(lwn && gh, 'both domains present');
  assert.equal(lwn.firstSeen, '2026-08-14T10:00:00.000Z');
  assert.equal(lwn.lastSeen, '2026-08-14T10:10:00.000Z');
  assert.equal(gh.firstSeen, '2026-08-14T11:00:00.000Z');
  assert.equal(gh.lastSeen, '2026-08-14T11:00:00.000Z');
});

test('WT-AGG-04: date range filters to the selected days (UTC org)', async () => {
  const org = await seedOrgWithTz('wt-agg-04-org', 'UTC');
  const emp = await seedEmployee(org.id, 'WT-AGG-04');
  await grantConsent(emp.id, org.id, 'activity_tracking');
  await setWebsiteTracking(org.id, true);
  const token = await agentTokenFor(emp.id);

  await uploadWebsite(token, 'lwn.net', 300, '2026-08-13T10:00:00.000Z');
  await uploadWebsite(token, 'github.com', 300, '2026-08-14T10:00:00.000Z');

  const admin = await adminTokenFor(org.id, 'wt-agg-04');
  const { body } = await websitesFor(admin, emp.id, { from: '2026-08-14', to: '2026-08-14' });
  assert.equal(body.total, 1, 'only the selected day is returned');
  assert.equal(body.data[0].domain, 'github.com');
  assert.equal(body.data[0].totalSeconds, 300);

  const { body: both } = await websitesFor(admin, emp.id, { from: '2026-08-13', to: '2026-08-14' });
  assert.equal(both.total, 2, 'multi-day range includes both days');
});

test('WT-AGG-05: timezone boundary — org-local day (Asia/Dhaka) vs UTC day', async () => {
  const org = await seedOrgWithTz('wt-agg-05-org', 'Asia/Dhaka');
  const emp = await seedEmployee(org.id, 'WT-AGG-05');
  await grantConsent(emp.id, org.id, 'activity_tracking');
  await setWebsiteTracking(org.id, true);
  const token = await agentTokenFor(emp.id);

  // Asia/Dhaka is UTC+6. The org-local day 2026-08-01 runs 18:00Z (Jul 31) →
  // 17:59:59Z (Aug 1). A UTC-boundary implementation would wrongly include
  // C (Aug 1 18:10Z) and exclude A (Jul 31 18:30Z).
  await uploadWebsite(token, 'lwn.net', 300, '2026-07-31T18:30:00.000Z');  // Aug 1 00:30 Dhaka
  await uploadWebsite(token, 'github.com', 300, '2026-08-01T17:30:00.000Z'); // Aug 1 23:30 Dhaka
  await uploadWebsite(token, 'youtube.com', 300, '2026-08-01T18:10:00.000Z'); // Aug 2 00:10 Dhaka

  const admin = await adminTokenFor(org.id, 'wt-agg-05');
  const { body } = await websitesFor(admin, emp.id, { from: '2026-08-01', to: '2026-08-01' });
  const domains = body.data.map((r) => r.domain).sort();
  assert.deepEqual(domains, ['github.com', 'lwn.net'], 'only the org-local day 2026-08-01 (Dhaka) is returned');
  assert.equal(body.summary.totalSeconds, 600, 'youtube.com (Aug 2 in Dhaka) excluded');

  // Same assertion for the employee detail route (same boundary convention).
  const { body: detail } = await detailFor(admin, emp.id, { from: '2026-08-01', to: '2026-08-01' });
  const detailDomains = (detail.topWebsites || []).map((w) => w.name).sort();
  assert.deepEqual(detailDomains, ['github.com', 'lwn.net']);
});

test('WT-AGG-06: empty state — no rows in range returns zeros, not errors', async () => {
  const org = await seedOrgWithTz('wt-agg-06-org', 'UTC');
  const emp = await seedEmployee(org.id, 'WT-AGG-06');
  await grantConsent(emp.id, org.id, 'activity_tracking');
  await setWebsiteTracking(org.id, true);

  const admin = await adminTokenFor(org.id, 'wt-agg-06');
  const { status, body } = await websitesFor(admin, emp.id, { from: '2026-01-01', to: '2026-01-02' });
  assert.equal(status, 200);
  assert.deepEqual(body.data, []);
  assert.equal(body.total, 0);
  assert.equal(body.totalPages, 0);
  assert.equal(body.summary.totalSeconds, 0);
  assert.equal(body.summary.totalVisits, 0);
  assert.equal(body.summary.domains, 0);
});

test('WT-AGG-07: pagination bounds the response (server-side aggregation)', async () => {
  const org = await seedOrgWithTz('wt-agg-07-org', 'UTC');
  const emp = await seedEmployee(org.id, 'WT-AGG-07');
  await grantConsent(emp.id, org.id, 'activity_tracking');
  await setWebsiteTracking(org.id, true);
  const token = await agentTokenFor(emp.id);

  for (let i = 1; i <= 5; i++) {
    await uploadWebsite(token, `site${i}.com`, 100 * i, `2026-08-14T10:0${i}:00.000Z`);
  }

  const admin = await adminTokenFor(org.id, 'wt-agg-07');
  const p1 = await websitesFor(admin, emp.id, { from: '2026-08-14', to: '2026-08-14', page: '1', pageSize: '2' });
  assert.equal(p1.body.data.length, 2);
  assert.equal(p1.body.total, 5);
  assert.equal(p1.body.totalPages, 3);
  assert.equal(p1.body.page, 1);
  const p3 = await websitesFor(admin, emp.id, { from: '2026-08-14', to: '2026-08-14', page: '3', pageSize: '2' });
  assert.equal(p3.body.data.length, 1);
  assert.equal(p3.body.summary.totalSeconds, 1500, 'summary covers the FULL dataset across pages');

  // Strict bounds: pageSize > 100 rejected, page < 1 rejected.
  const bad = await websitesFor(admin, emp.id, { page: '1', pageSize: '101' });
  assert.equal(bad.status, 422);
  const badPage = await websitesFor(admin, emp.id, { page: '0' });
  assert.equal(badPage.status, 422);
});

test('WT-AGG-08: detail topWebsites aggregates the FULL range, not the first activity page', async () => {
  const org = await seedOrgWithTz('wt-agg-08-org', 'UTC');
  const emp = await seedEmployee(org.id, 'WT-AGG-08');
  await grantConsent(emp.id, org.id, 'activity_tracking');
  await setWebsiteTracking(org.id, true);
  const token = await agentTokenFor(emp.id);

  // One website slice EARLIER than 55 application slices: the first activity
  // page (50 rows, newest first) contains only application rows, so a
  // page-based aggregation would report zero websites. The Website Usage
  // panel must aggregate over the FULL range.
  await uploadWebsite(token, 'lwn.net', 600, '2026-08-14T10:00:00.000Z');
  const appBatch = Array.from({ length: 55 }, (_, i) => ({
    type: 'application',
    applicationName: `App${i}.exe`,
    duration: 60,
    timestamp: new Date(Date.UTC(2026, 7, 14, 11, i)).toISOString(), // 11:00–11:54 UTC
  }));
  const res = await activityRoute.POST(agentReq(token, appBatch));
  assert.equal(res.status, 200);

  const admin = await adminTokenFor(org.id, 'wt-agg-08');
  const { body } = await detailFor(admin, emp.id, { from: '2026-08-14', to: '2026-08-14' });
  const lwn = (body.topWebsites || []).find((w) => w.name === 'lwn.net');
  assert.ok(lwn, 'website domain present in topWebsites even though it is older than the first activity page');
  assert.equal(lwn.duration, 10, '600s = 10 minutes in the chart unit');

  // DB → API cross-check: the dedicated /websites endpoint reports the same
  // duration for the same range.
  const { body: websites } = await websitesFor(admin, emp.id, { from: '2026-08-14', to: '2026-08-14' });
  const lwnFull = websites.data.find((r) => r.domain === 'lwn.net');
  assert.ok(lwnFull, 'lwn.net present in /websites');
  assert.equal(lwnFull.totalSeconds, 600);
  assert.equal(Math.round(lwnFull.totalSeconds / 60), lwn.duration, 'detail chart minutes == websites endpoint minutes');
});

test('WT-AGG-09: /websites response exposes DOMAIN only — no URLs, paths or secrets', async () => {
  const org = await seedOrgWithTz('wt-agg-09-org', 'UTC');
  const emp = await seedEmployee(org.id, 'WT-AGG-09');
  await grantConsent(emp.id, org.id, 'activity_tracking');
  await setWebsiteTracking(org.id, true);
  const token = await agentTokenFor(emp.id);

  await uploadWebsite(token, 'https://www.github.com/company/private-repo?token=abc123', 300, '2026-08-14T10:00:00.000Z');
  await uploadWebsite(token, 'https://user:pass@example.com/secret/page', 300, '2026-08-14T10:05:00.000Z');

  const admin = await adminTokenFor(org.id, 'wt-agg-09');
  const { body } = await websitesFor(admin, emp.id, { from: '2026-08-14', to: '2026-08-14' });
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('company/private'), 'no private path');
  assert.ok(!raw.includes('token=abc123'), 'no query token');
  assert.ok(!raw.includes('secret/page'), 'no path');
  assert.ok(!raw.includes('user:pass'), 'no credentials');
  assert.ok(!raw.includes('https://'), 'no scheme anywhere');
  const domains = body.data.map((r) => r.domain).sort();
  assert.deepEqual(domains, ['example.com', 'github.com'], 'bare lowercase domains only');
});

test('WT-AGG-10: /websites RBAC — no session 401, cross-org admin 404', async () => {
  const orgA = await seedOrgWithTz('wt-agg-10-org-a', 'UTC');
  const orgB = await seedOrgWithTz('wt-agg-10-org-b', 'UTC');
  const empA = await seedEmployee(orgA.id, 'WT-AGG-10-A');
  await grantConsent(empA.id, orgA.id, 'activity_tracking');
  await setWebsiteTracking(orgA.id, true);

  // No session → 401.
  const route = await import('../src/app/api/employees/[id]/websites/route');
  const anon = await route.GET(
    new NextRequest(`http://localhost:3000/api/employees/${empA.id}/websites`),
    { params: Promise.resolve({ id: empA.id }) }
  );
  assert.equal(anon.status, 401);

  // Admin of org B cannot see org A's employee (concealed as 404).
  const adminB = await adminTokenFor(orgB.id, 'wt-agg-10');
  const { status } = await websitesFor(adminB, empA.id);
  assert.equal(status, 404, 'foreign employee id is concealed as 404');
});

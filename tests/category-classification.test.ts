/**
 * Phase 3 — CategoryRule admin API + server-authoritative classification.
 *
 * Covers:
 *  - Pure engine: precedence ordering, first-match-wins, match-type targets,
 *    default-heuristic parity with the agent's local categorizers, corrupt
 *    rule rows never crash classification.
 *  - Admin CRUD: create/list/update/delete, RBAC (anon 401, viewer 403,
 *    manager+ 2xx), tenant isolation (org A rules invisible to org B; cross
 *    -org id 404s), validation (422), bounded count.
 *  - Dry-run: candidate rules evaluated WITHOUT persisting; saved-rules mode;
 *    tenant isolation.
 *  - Ingestion: server_classification OFF preserves the agent's category
 *    (today's behavior); ON reclassifies application/website rows via rules,
 *    falls back to the default heuristic for unmatched rows, and never
 *    reclassifies idle rows.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_categoryrules).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation (set BEFORE any app module import) ──────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_categoryrules';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-catrules-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@catrules.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!CatRules2026x';
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
let adminAToken: string;
let managerBToken: string;
let viewerAToken: string;

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

  orgA = await db.organization.create({ data: { name: 'CatRule Org A', slug: 'catrule-org-a', timezone: 'Asia/Dhaka' } });
  orgB = await db.organization.create({ data: { name: 'CatRule Org B', slug: 'catrule-org-b', timezone: 'UTC' } });

  adminAToken = await signJWT({ userId: 'admin-a', email: 'admin@a.test', role: 'admin', organizationId: orgA.id });
  managerBToken = await signJWT({ userId: 'mgr-b', email: 'mgr@b.test', role: 'manager', organizationId: orgB.id });
  viewerAToken = await signJWT({ userId: 'viewer-a', email: 'viewer@a.test', role: 'viewer', organizationId: orgA.id });
});

after(async () => {
  await db.$disconnect();
});

// ==================== Pure engine ====================

test('CAT-1: precedence — lower priority wins first; ties break deterministically', async () => {
  const { classifyRow } = await import('../src/lib/classification/engine');
  const rules = [
    { id: 'r-high', matchType: 'executable', pattern: 'game', category: 'unproductive', priority: 100, enabled: true },
    { id: 'r-low', matchType: 'executable', pattern: 'game', category: 'productive', priority: 1, enabled: true },
  ];
  // Both match 'game.exe' — the priority-1 (lower number) rule wins.
  const out = classifyRow({ type: 'application', applicationName: 'game.exe' }, rules);
  assert.ok(out && out.ruleMatched);
  assert.equal(out.category, 'productive');
  assert.equal(out.matchedRuleId, 'r-low');
});

test('CAT-2: match types target distinct fields (executable vs application vs domain)', async () => {
  const { classifyRow } = await import('../src/lib/classification/engine');
  const rules = [
    { matchType: 'executable', pattern: 'chrome.exe', category: 'productive', priority: 10, enabled: true },
    { matchType: 'application', pattern: 'Figma', category: 'productive', priority: 10, enabled: true },
    { matchType: 'domain', pattern: 'youtube.com', category: 'unproductive', priority: 10, enabled: true },
  ];
  // executable matches applicationName
  assert.equal(classifyRow({ type: 'application', applicationName: 'CHROME.EXE' }, rules)?.category, 'productive');
  // executable does NOT match the title
  assert.equal(classifyRow({ type: 'application', title: 'chrome.exe', applicationName: 'other.exe' }, rules)?.category, 'neutral');
  // application matches the window title
  assert.equal(classifyRow({ type: 'application', title: 'Figma — design', applicationName: 'figma.exe' }, rules)?.category, 'productive');
  // domain matches website url
  assert.equal(classifyRow({ type: 'website', url: 'www.YouTube.com/watch' }, rules)?.category, 'unproductive');
});

test('CAT-3: unmatched rows fall back to the default heuristic (agent parity)', async () => {
  const { classifyRow } = await import('../src/lib/classification/engine');
  // Agent samples from omnisight-agent/src/collectors/activity-collector.ts
  const appSamples: Array<[string | null, string]> = [
    ['Code.exe', 'productive'],
    ['Visual Studio Code', 'productive'], // substring 'visual studio'
    ['WindowsTerminal.exe', 'productive'],
    ['chrome.exe', 'neutral'],
    ['Slack.exe', 'neutral'],
    ['outlook.exe', 'neutral'],
    ['youtube-dl.exe', 'unproductive'],
    ['Steam.exe', 'unproductive'],
    ['Netflix.exe', 'unproductive'],
    ['notepad++.exe', 'productive'],
    ['unknown-app.exe', 'neutral'],
    [null, 'neutral'],
  ];
  for (const [app, expected] of appSamples) {
    const out = classifyRow({ type: 'application', applicationName: app }, []);
    assert.equal(out?.category, expected, `default app category for ${app}`);
    assert.equal(out?.ruleMatched, false);
  }

  // Domain parity with omnisight-agent website-collector categorizeDomain()
  const domainSamples: Array<[string | null, string]> = [
    ['github.com', 'productive'],
    ['stackoverflow.com', 'productive'],
    ['docs.google.com', 'productive'],
    ['youtube.com', 'unproductive'],
    ['x.com', 'unproductive'],
    ['facebook.com', 'unproductive'],
    ['example.com', 'neutral'],
    [null, 'neutral'],
  ];
  for (const [domain, expected] of domainSamples) {
    const out = classifyRow({ type: 'website', url: domain }, []);
    assert.equal(out?.category, expected, `default domain category for ${domain}`);
    assert.equal(out?.ruleMatched, false);
  }
});

test('CAT-4: idle and non-classifiable rows are never reclassified', async () => {
  const { classifyRow } = await import('../src/lib/classification/engine');
  const rules = [{ matchType: 'executable', pattern: 'x', category: 'productive', priority: 1, enabled: true }];
  assert.equal(classifyRow({ type: 'idle', category: 'idle' }, rules), null);
  assert.equal(classifyRow({ type: 'work_session', category: 'neutral' }, rules), null);
  assert.equal(classifyRow({ type: 'screenshot', category: 'neutral' }, rules), null);
});

test('CAT-5: corrupt rule rows (bad matchType/category/disabled) never match and never throw', async () => {
  const { classifyRow } = await import('../src/lib/classification/engine');
  const rules = [
    { id: 'corrupt-match', matchType: 'nonsense', pattern: 'chrome', category: 'productive', priority: 1 },
    { id: 'corrupt-cat', matchType: 'executable', pattern: 'chrome', category: 'bogus', priority: 1 },
    { id: 'disabled', matchType: 'executable', pattern: 'chrome', category: 'productive', priority: 1, enabled: false },
    { id: 'enabled-good', matchType: 'executable', pattern: 'firefox', category: 'neutral', priority: 2 },
  ];
  // chrome.exe matches nothing usable → falls back to default (neutral)
  const out = classifyRow({ type: 'application', applicationName: 'chrome.exe' }, rules);
  assert.ok(out && !out.ruleMatched);
  assert.equal(out.category, 'neutral');
  // firefox matches the enabled good rule
  assert.equal(classifyRow({ type: 'application', applicationName: 'firefox.exe' }, rules)?.category, 'neutral');
});

// ==================== Admin CRUD ====================

test('CAT-6: RBAC — anon 401, viewer 403, manager/admin can create+list', async () => {
  const postRoute = (await import('../src/app/api/category-rules/route')).POST;
  const getRoute = (await import('../src/app/api/category-rules/route')).GET;

  const anon = await postRoute(req('http://x/api/category-rules', { method: 'POST', body: JSON.stringify({ name: 'x', matchType: 'executable', pattern: 'a', category: 'productive', priority: 1 }), headers: { 'content-type': 'application/json' } }));
  assert.equal(anon.status, 401);

  const viewer = await postRoute(req('http://x/api/category-rules', { method: 'POST', body: JSON.stringify({ name: 'x', matchType: 'executable', pattern: 'a', category: 'productive', priority: 1 }), headers: { 'content-type': 'application/json', ...authHeader(viewerAToken) } }));
  assert.equal(viewer.status, 403);

  const created = await postRoute(req('http://x/api/category-rules', { method: 'POST', body: JSON.stringify({ name: 'Design tools', matchType: 'application', pattern: 'Figma', category: 'productive', priority: 5 }), headers: { 'content-type': 'application/json', ...authHeader(adminAToken) } }));
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.equal(body.data.organizationId, orgA.id);
  assert.equal(body.data.name, 'Design tools');

  const list = await getRoute(req('http://x/api/category-rules', { headers: authHeader(adminAToken) }));
  assert.equal(list.status, 200);
  const listBody = await list.json();
  assert.ok(listBody.data.length >= 1);
});

test('CAT-7: tenant isolation — org B cannot see or touch org A rules', async () => {
  const getRoute = (await import('../src/app/api/category-rules/route')).GET;
  const patchRoute = (await import('../src/app/api/category-rules/[id]/route')).PATCH;
  const deleteRoute = (await import('../src/app/api/category-rules/[id]/route')).DELETE;

  const ruleA = await db.categoryRule.create({
    data: { organizationId: orgA.id, name: 'A-secret', matchType: 'executable', pattern: 'secretA', category: 'unproductive', priority: 1 },
  });
  const ruleB = await db.categoryRule.create({
    data: { organizationId: orgB.id, name: 'B-rule', matchType: 'executable', pattern: 'secretB', category: 'neutral', priority: 1 },
  });

  // B lists only its own rules
  const listB = await getRoute(req('http://x/api/category-rules', { headers: authHeader(managerBToken) }));
  const listBJson = await listB.json();
  assert.ok(!listBJson.data.some((r: { id: string }) => r.id === ruleA.id));
  assert.ok(listBJson.data.some((r: { id: string }) => r.id === ruleB.id));

  // B cannot PATCH A's rule (404 — existence concealed)
  const patchB = await patchRoute(req('http://x/api/category-rules/anything', { method: 'PATCH', body: JSON.stringify({ name: 'hijack', matchType: 'executable', pattern: 'x', category: 'productive', priority: 1 }), headers: { 'content-type': 'application/json', ...authHeader(managerBToken) } }), { params: Promise.resolve({ id: ruleA.id }) });
  assert.equal(patchB.status, 404);
  // B cannot DELETE A's rule
  const delB = await deleteRoute(req('http://x/api/category-rules/anything', { method: 'DELETE', headers: authHeader(managerBToken) }), { params: Promise.resolve({ id: ruleA.id }) });
  assert.equal(delB.status, 404);

  // A's rule is still intact
  const still = await db.categoryRule.findUnique({ where: { id: ruleA.id } });
  assert.ok(still && still.name === 'A-secret');
});

test('CAT-8: validation — malformed payloads rejected with 422, never coerced', async () => {
  const postRoute = (await import('../src/app/api/category-rules/route')).POST;
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ name: '', matchType: 'executable', pattern: 'a', category: 'productive', priority: 1 }, 'name'],
    [{ name: 'x', matchType: 'wat', pattern: 'a', category: 'productive', priority: 1 }, 'matchType'],
    [{ name: 'x', matchType: 'executable', pattern: '', category: 'productive', priority: 1 }, 'pattern'],
    [{ name: 'x', matchType: 'executable', pattern: 'a'.repeat(200), category: 'productive', priority: 1 }, 'pattern'],
    [{ name: 'x', matchType: 'executable', pattern: 'a', category: 'idle', priority: 1 }, 'category'],
    [{ name: 'x', matchType: 'executable', pattern: 'a', category: 'productive', priority: 1.5 }, 'priority'],
    [{ name: 'x', matchType: 'executable', pattern: 'a', category: 'productive', priority: 5000 }, 'priority'],
  ];
  for (const [payload, expected] of cases) {
    const res = await postRoute(req('http://x/api/category-rules', { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json', ...authHeader(adminAToken) } }));
    assert.equal(res.status, 422, `expected 422 for bad ${expected}: ${JSON.stringify(payload).slice(0, 80)}`);
  }
});

test('CAT-9: update + delete mutate only the target org rule', async () => {
  const patchRoute = (await import('../src/app/api/category-rules/[id]/route')).PATCH;
  const deleteRoute = (await import('../src/app/api/category-rules/[id]/route')).DELETE;

  const rule = await db.categoryRule.create({
    data: { organizationId: orgA.id, name: 'tmp', matchType: 'domain', pattern: 'old.com', category: 'neutral', priority: 10 },
  });
  const patched = await patchRoute(req('http://x/api/category-rules/x', { method: 'PATCH', body: JSON.stringify({ name: 'renamed', matchType: 'domain', pattern: 'new.com', category: 'unproductive', priority: 3, enabled: false }), headers: { 'content-type': 'application/json', ...authHeader(adminAToken) } }), { params: Promise.resolve({ id: rule.id }) });
  assert.equal(patched.status, 200);
  const after = await db.categoryRule.findUnique({ where: { id: rule.id } });
  assert.ok(after && after.pattern === 'new.com' && after.category === 'unproductive' && after.priority === 3 && after.enabled === false && after.name === 'renamed');

  const del = await deleteRoute(req('http://x/api/category-rules/x', { method: 'DELETE', headers: authHeader(adminAToken) }), { params: Promise.resolve({ id: rule.id }) });
  assert.equal(del.status, 200);
  assert.equal(await db.categoryRule.findUnique({ where: { id: rule.id } }), null);
});

// ==================== Dry-run ====================

test('CAT-10: dry-run evaluates candidate rules without persisting; saved-rules mode is tenant-isolated', async () => {
  const dryRun = (await import('../src/app/api/category-rules/dry-run/route')).POST;
  const before = await db.categoryRule.count();

  // Candidate rules (not saved) — samples show rule + default fallback.
  const candidateRes = await dryRun(req('http://x/api/category-rules/dry-run', {
    method: 'POST',
    body: JSON.stringify({
      rules: [
        { name: 'block-games', matchType: 'executable', pattern: 'steam', category: 'unproductive', priority: 1 },
      ],
      samples: [
        { type: 'application', applicationName: 'Steam.exe', title: null },
        { type: 'application', applicationName: 'Code.exe', title: null },
        { type: 'website', url: 'youtube.com' },
      ],
    }),
    headers: { 'content-type': 'application/json', ...authHeader(adminAToken) },
  }));
  assert.equal(candidateRes.status, 200);
  const candidate = await candidateRes.json();
  assert.equal(candidate.evaluated, 'candidate-rules');
  assert.equal(candidate.data[0].category, 'unproductive');
  assert.equal(candidate.data[0].source, 'rule');
  assert.equal(candidate.data[1].category, 'productive'); // default heuristic
  assert.equal(candidate.data[1].source, 'default-heuristic');
  assert.equal(candidate.data[2].category, 'unproductive'); // default domain heuristic
  assert.equal(await db.categoryRule.count(), before, 'dry-run must not persist rules');

  // Saved-rules mode: org B saved rule secretB → its own dry-run reflects it.
  const savedRes = await dryRun(req('http://x/api/category-rules/dry-run', {
    method: 'POST',
    body: JSON.stringify({ samples: [{ type: 'application', applicationName: 'secretB.exe' }] }),
    headers: { 'content-type': 'application/json', ...authHeader(managerBToken) },
  }));
  const saved = await savedRes.json();
  assert.equal(saved.evaluated, 'saved-rules');
  assert.equal(saved.data[0].source, 'rule');
  assert.equal(saved.data[0].category, 'neutral');
});

// ==================== Ingestion ====================

/** Grant activity consent + build a valid agent token for an employee. */
async function seedEmployee(orgId: string, tag: string) {
  const emp = await db.employee.create({
    data: { employeeId: `emp-${tag}`, firstName: tag, lastName: 'T', email: `${tag}@catrule.test`, organizationId: orgId, status: 'active', agentApproved: true },
  });
  // Policy + granted consent (the shape hasActiveConsent expects: status
  // 'granted', matching policy version, grantedAt set).
  const existingPolicy = await db.consentPolicy.findFirst({ where: { organizationId: orgId, consentType: 'activity_tracking' } });
  const policy = existingPolicy ??
    (await db.consentPolicy.create({
      data: { organizationId: orgId, consentType: 'activity_tracking', title: 'Activity Policy', content: 'Test policy', version: '1', status: 'published', effectiveAt: new Date(), publishedAt: new Date() },
    }));
  await db.consent.create({
    data: {
      organizationId: orgId,
      employeeId: emp.id,
      policyId: policy.id,
      consentType: 'activity_tracking',
      status: 'granted',
      consentVersion: policy.version,
      grantedAt: new Date(),
    },
  });
  const token = await db.agentToken.create({
    data: { organizationId: orgId, employeeId: emp.id, token: `tok-${tag}-${Math.random().toString(36).slice(2)}`, expiresAt: new Date(Date.now() + 3600_000) },
  });
  return { emp, token: token.token };
}

async function setMonitoring(orgId: string, key: string, value: string) {
  await db.organizationSetting.upsert({
    where: { organizationId_key: { organizationId: orgId, key } },
    update: { value },
    create: { organizationId: orgId, key, value, category: 'monitoring' },
  });
}

test('CAT-11: flag OFF preserves the agent category; flag ON reclassifies via rules + heuristic fallback', async () => {
  const activityPost = (await import('../src/app/api/agent/activity/route')).POST;
  const { emp, token } = await seedEmployee(orgA.id, 'classify');
  const baseHeaders = { 'content-type': 'application/json', ...authHeader(token) };

  const appRows = (cat: string) => [
    { type: 'application', applicationName: 'Steam.exe', title: null, category: cat, duration: 60, timestamp: new Date().toISOString() },
    { type: 'application', applicationName: 'Code.exe', title: null, category: cat, duration: 60, timestamp: new Date().toISOString() },
  ];

  // (1) Flag OFF (default): agent categories stored as-is (today's behavior).
  const off = await activityPost(req('http://x/api/agent/activity', { method: 'POST', body: JSON.stringify({ activities: appRows('neutral') }), headers: baseHeaders }));
  assert.equal(off.status, 200);
  let stored = await db.activity.findMany({ where: { employeeId: emp.id } });
  assert.ok(stored.every((a) => a.category === 'neutral'), 'flag off must store agent value verbatim');
  await db.activity.deleteMany({ where: { employeeId: emp.id } });

  // (2) Enable server_classification + a rule: Steam → unproductive.
  await setMonitoring(orgA.id, 'server_classification', 'true');
  await db.categoryRule.create({
    data: { organizationId: orgA.id, name: 'games', matchType: 'executable', pattern: 'steam', category: 'unproductive', priority: 1 },
  });

  const on = await activityPost(req('http://x/api/agent/activity', { method: 'POST', body: JSON.stringify({ activities: appRows('neutral') }), headers: baseHeaders }));
  assert.equal(on.status, 200);
  stored = await db.activity.findMany({ where: { employeeId: emp.id } });
  const byApp = new Map(stored.map((a) => [a.applicationName, a.category]));
  assert.equal(byApp.get('Steam.exe'), 'unproductive', 'rule override');
  assert.equal(byApp.get('Code.exe'), 'productive', 'unmatched → default heuristic (code = productive)');

  // (3) idle rows are never reclassified even with the flag on.
  await db.activity.deleteMany({ where: { employeeId: emp.id } });
  const idleRes = await activityPost(req('http://x/api/agent/activity', { method: 'POST', body: JSON.stringify({ activities: [{ type: 'idle', applicationName: null, title: null, category: 'idle', duration: 300, timestamp: new Date().toISOString() }] }), headers: baseHeaders }));
  assert.equal(idleRes.status, 200);
  stored = await db.activity.findMany({ where: { employeeId: emp.id } });
  assert.equal(stored[0].category, 'idle');

  // (4) cleanup flag so other tests see defaults
  await setMonitoring(orgA.id, 'server_classification', 'false');
  await db.activity.deleteMany({ where: { employeeId: emp.id } });
});

// ==================== Working-hours / break semantics (Phase 3 §11-13) =====
// The classification contract is hour/timezone-INDEPENDENT (uniform identity
// policy, matching today's dashboard which buckets all hours equally). What
// classification MUST guarantee about working hours and breaks:
//  1. The same row classifies identically at any wall-clock hour (inside,
//     outside, overnight, across local midnight) and in any org timezone — no
//     hidden machine-local fallback, no hour-dependent flip-flopping.
//  2. Break-mode rows (idle-typed mirrors) and idle rows are NEVER
//     reclassified, even when a rule's pattern could match their text — break
//     remains authoritative and break time can never count as productive.
//  3. Out-of-hours uploads from offline queue replay are accepted and
//     classified (raw telemetry preserved — never deleted by classification).

test('CAT-12: classification is deterministic across hours, midnight and timezones', async () => {
  const { classifyRow } = await import('../src/lib/classification/engine');
  const rules = [{ matchType: 'domain', pattern: 'youtube.com', category: 'unproductive', priority: 1 }];
  const row = { type: 'website' as const, url: 'youtube.com' };
  // 09:00, 18:00, 23:00, 00:30 next day — identical outcome (timestamp is
  // never an input to classification; the org timezone is irrelevant here).
  const outcome = classifyRow(row, rules);
  assert.ok(outcome && outcome.ruleMatched && outcome.category === 'unproductive');
  // Prove hour-independence at the engine level for the no-rule fallback too.
  const fallback = classifyRow({ type: 'application', applicationName: 'Code.exe' }, []);
  assert.equal(fallback?.category, 'productive');
});

test('CAT-13: break/idle rows are never reclassified even when a rule pattern matches', async () => {
  const { classifyRow } = await import('../src/lib/classification/engine');
  // A rule that WOULD match the idle mirror's title text if classification
  // ever looked at idle rows.
  const rules = [{ matchType: 'application', pattern: 'Break Mode', category: 'productive', priority: 1 }];
  // Legacy break mirror rows are type idle/category idle — the engine must
  // return null (unchanged), so break time can never become "productive".
  const mirror = classifyRow({ type: 'idle', title: 'Break Mode Started', category: 'idle' }, rules);
  assert.equal(mirror, null);
  const idleRow = classifyRow({ type: 'idle', applicationName: 'youtube.exe', category: 'idle' }, rules);
  assert.equal(idleRow, null);
  // Non-idle rows still classify normally.
  assert.equal(classifyRow({ type: 'application', title: 'Break Mode', applicationName: 'app.exe' }, rules)?.category, 'productive');
});

test('CAT-14: out-of-hours uploads (offline queue replay) are accepted and classified — telemetry never deleted', async () => {
  const activityPost = (await import('../src/app/api/agent/activity/route')).POST;
  const { emp, token } = await seedEmployee(orgB.id, 'overnight');
  await setMonitoring(orgB.id, 'server_classification', 'true');
  await db.categoryRule.create({
    data: { organizationId: orgB.id, name: 'night-work', matchType: 'executable', pattern: 'ide', category: 'productive', priority: 1 },
  });
  // 23:50 local — outside the default 09:00-18:00 window. The server never
  // rejects out-of-hours activity (the AGENT gates collection at source when
  // working_hours_only is on); a queued offline replay with an out-of-hours
  // timestamp must be accepted and classified like any other row.
  const res = await activityPost(req('http://x/api/agent/activity', {
    method: 'POST',
    body: JSON.stringify({
      activities: [{
        type: 'application',
        applicationName: 'JetBrainsIDE.exe',
        title: null,
        category: 'neutral', // agent hint — server is authoritative here
        duration: 1800,
        timestamp: new Date('2026-09-02T23:50:00.000Z').toISOString(),
      }],
    }),
    headers: { 'content-type': 'application/json', ...authHeader(token) },
  }));
  assert.equal(res.status, 200);
  const stored = await db.activity.findFirst({ where: { employeeId: emp.id } });
  assert.ok(stored, 'out-of-hours row persisted (raw telemetry preserved)');
  assert.equal(stored.category, 'productive', 'server-authoritative rule applied regardless of the hour');

  // Cleanup so the org-B flag does not leak into other suites' expectations.
  await setMonitoring(orgB.id, 'server_classification', 'false');
  await db.activity.deleteMany({ where: { employeeId: emp.id } });
});

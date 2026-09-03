/**
 * Phase 1 — activity batch receipt dedupe (server-side integration).
 *
 * Proves, against a THROWAWAY PostgreSQL database (workai_test_activity_dedupe):
 *   - basic: batch with batchId accepted, receipt created, exact row count
 *   - duplicate: same (org, employee, batchId) twice → zero duplicate rows,
 *     second response succeeds and reports the deduplicated count
 *   - concurrent: two identical uploads at once → no duplicate rows, no race
 *     failure exposed to the client
 *   - retry: committed-then-retried batch → no duplicate rows
 *   - old agent: no batchId → accepted, legacy response shape (no
 *     deduplicated key), rows inserted
 *   - tenant isolation: same batchId in different orgs does NOT dedupe
 *   - employee isolation: same batchId for different employees does NOT dedupe
 *   - flag semantics: activity_dedupe OFF → batchId ignored (legacy duplicate
 *     uploads still insert — safe-rollout default)
 *   - validation: malformed batchId/batchSeq → 422
 *   - retention: stale receipts purged by the org retention sweep using the
 *     activity window; fresh receipts retained
 *   - cross-repo contract: the agent tree (when present) sends batchId +
 *     batchSeq and derives a stable batch id (static contract check)
 *
 * Run: npx tsx --test tests/activity-dedupe.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { req } from './helpers/request';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_activity_dedupe';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;

// ─── DB isolation (must run BEFORE any app module import) ─────────────────
before(() => {
  if (process.env.ACTIVITY_DEDUPE_TEST_MIGRATED_DB !== '1') {
    execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
    execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
      env: { ...process.env, DATABASE_URL: TEST_DB_URL },
      stdio: 'pipe',
    });
  }
});

type Db = typeof import('../src/lib/db')['db'];
let db: Db;
let route: typeof import('../src/app/api/agent/activity/route');
let runRetentionForOrg: typeof import('../src/lib/jobs/retention')['runRetentionForOrg'];

const ORG_SLUG = 'dedupe-test';

async function seedOrg(name: string) {
  return db.organization.create({ data: { name, slug: `${ORG_SLUG}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}-${randomBytes(3).toString('hex')}` } });
}

async function seedEmployee(orgId: string, code: string) {
  return db.employee.create({
    data: {
      employeeId: code,
      firstName: code.split('-')[0],
      lastName: 'Test',
      email: `${code.toLowerCase()}-${randomBytes(3).toString('hex')}@test.local`,
      organizationId: orgId,
      status: 'active',
      agentApproved: true,
    },
  });
}

async function publishPolicy(orgId: string, consentType: string) {
  const existing = await db.consentPolicy.findFirst({ where: { organizationId: orgId, consentType } });
  if (existing) return existing;
  return db.consentPolicy.create({
    data: {
      organizationId: orgId,
      consentType,
      title: `${consentType} Policy`,
      content: 'Test policy',
      version: '1',
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
  const token = randomBytes(48).toString('hex');
  const employee = await db.employee.findUnique({ where: { id: employeeId } });
  if (!employee) throw new Error(`Employee not found: ${employeeId}`);
  await db.agentToken.create({
    data: {
      token,
      employee: { connect: { id: employeeId } },
      organization: { connect: { id: employee.organizationId } },
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return token;
}

/** Enable/disable the org-scoped activity_dedupe flag. */
async function setActivityDedupe(orgId: string, enabled: boolean) {
  const existing = await db.organizationSetting.findUnique({
    where: { organizationId_key: { organizationId: orgId, key: 'activity_dedupe' } },
  });
  if (existing) {
    await db.organizationSetting.update({ where: { id: existing.id }, data: { value: String(enabled) } });
  } else {
    await db.organizationSetting.create({ data: { organizationId: orgId, key: 'activity_dedupe', value: String(enabled), category: 'monitoring' } });
  }
}

function activityBatch(count: number, titlePrefix = 'app') {
  return Array.from({ length: count }, (_, i) => ({
    type: 'application',
    applicationName: 'Code.exe',
    title: `${titlePrefix}-${i}`,
    category: 'productive',
    duration: 60,
    timestamp: new Date(Date.now() - 1000 * 60).toISOString(),
  }));
}

const ACTIVITY_URL = 'http://localhost:3000/api/agent/activity';

let orgA: { id: string };
let orgB: { id: string };
let empA1: { id: string };
let empA2: { id: string };
let empB1: { id: string };
let tokenA1: string;
let tokenA2: string;
let tokenB1: string;
// Fixed, route-valid RFC-4122 v4-shaped ids (distinct per scenario).
const BATCH_1 = '11111111-1111-4111-a111-111111111111';
const BATCH_2 = '22222222-2222-4222-a222-222222222222';
const BATCH_X = '33333333-3333-4333-a333-333333333333';
const BATCH_RACE = '99999999-9999-4999-a999-999999999999';
const BATCH_FLAG_OFF = '44444444-4444-4444-a444-444444444444';

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  route = await import('../src/app/api/agent/activity/route');
  runRetentionForOrg = (await import('../src/lib/jobs/retention')).runRetentionForOrg;

  orgA = await seedOrg('org-a');
  orgB = await seedOrg('org-b');
  empA1 = await seedEmployee(orgA.id, 'AD-EMP-A1');
  empA2 = await seedEmployee(orgA.id, 'AD-EMP-A2');
  empB1 = await seedEmployee(orgB.id, 'AD-EMP-B1');
  await Promise.all([
    grantConsent(empA1.id, orgA.id, 'activity_tracking'),
    grantConsent(empA2.id, orgA.id, 'activity_tracking'),
    grantConsent(empB1.id, orgB.id, 'activity_tracking'),
  ]);
  tokenA1 = await agentTokenFor(empA1.id);
  tokenA2 = await agentTokenFor(empA2.id);
  tokenB1 = await agentTokenFor(empB1.id);
});

after(async () => {
  await db.$disconnect();
  if (process.env.ACTIVITY_DEDUPE_TEST_MIGRATED_DB !== '1') {
    try {
      execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
        env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
        stdio: 'pipe',
      });
    } catch {
      /* best-effort cleanup */
    }
  }
});

async function countActivities(employeeId: string): Promise<number> {
  return db.activity.count({ where: { employeeId } });
}

async function countReceipts(orgId: string, employeeId: string, batchId: string): Promise<number> {
  return db.activityBatchReceipt.count({ where: { organizationId: orgId, employeeId, batchId } });
}

// ─── P1-1 Basic ────────────────────────────────────────────────────────────

test('P1-1: batch with batchId is accepted, receipt created, exact row count', async () => {
  await setActivityDedupe(orgA.id, true);
  const res = await route.POST(
    req(tokenA1, { method: 'POST', url: ACTIVITY_URL, body: { activities: activityBatch(3), batchId: BATCH_1, batchSeq: 1 } })
  );
  const body = (await res.json().catch(() => null)) as { success: boolean; count: number; deduplicated: number } | null;
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.ok(body, 'response body present');
  assert.equal(body.success, true);
  assert.equal(body.count, 3, 'three rows inserted');
  assert.equal(body.deduplicated, 0, 'fresh batch — nothing deduplicated');
  assert.equal(await countActivities(empA1.id), 3);
  const receipt = await db.activityBatchReceipt.findUnique({
    where: {
      organizationId_employeeId_batchId: { organizationId: orgA.id, employeeId: empA1.id, batchId: BATCH_1 },
    },
  });
  assert.ok(receipt, 'receipt row created');
  assert.equal(receipt!.rowCount, 3, 'receipt records the accepted row count');
});

// ─── P1-2 Duplicate ────────────────────────────────────────────────────────

test('P1-2: same org+employee+batchId twice → zero duplicates, success + deduplicated count', async () => {
  const res = await route.POST(
    req(tokenA1, { method: 'POST', url: ACTIVITY_URL, body: { activities: activityBatch(3), batchId: BATCH_1, batchSeq: 2 } })
  );
  assert.equal(res.status, 200, 'duplicate is a success, not an error');
  const body = (await res.json()) as { success: boolean; count: number; deduplicated: number };
  assert.equal(body.success, true);
  assert.equal(body.count, 0, 'no new rows from the replay');
  assert.equal(body.deduplicated, 3, 'reports the number of records deduplicated');
  assert.equal(await countActivities(empA1.id), 3, 'still exactly the original three rows');
  assert.equal(await countReceipts(orgA.id, empA1.id, BATCH_1), 1, 'exactly one receipt');
});

// ─── P1-3 Concurrent duplicates ────────────────────────────────────────────

test('P1-3: two identical uploads at once → one row set, no race failure', async () => {
  const batchId = BATCH_RACE;
  const [r1, r2] = await Promise.all([
    route.POST(req(tokenA1, { method: 'POST', url: ACTIVITY_URL, body: { activities: activityBatch(2, 'race'), batchId, batchSeq: 1 } })),
    route.POST(req(tokenA1, { method: 'POST', url: ACTIVITY_URL, body: { activities: activityBatch(2, 'race'), batchId, batchSeq: 1 } })),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 200], 'both clients get a successful response');
  const bodies = await Promise.all([r1.json(), r2.json()]);
  const counts = bodies.map((b: { count: number }) => b.count).sort((a, b) => a - b);
  assert.deepEqual(counts, [0, 2], 'one insert + one dedupe');
  assert.equal(await countActivities(empA1.id), 5, 'no duplicate rows from the race (3 earlier + 2)');
  assert.equal(await countReceipts(orgA.id, empA1.id, batchId), 1, 'exactly one receipt from the race');
});

// ─── P1-4 Retry after commit (lost response) ───────────────────────────────

test('P1-4: committed-then-retried batch (lost response) → no duplicate rows', async () => {
  // First "attempt" commits server-side...
  const first = await route.POST(
    req(tokenA1, { method: 'POST', url: ACTIVITY_URL, body: { activities: activityBatch(2, 'retry'), batchId: BATCH_2, batchSeq: 3 } })
  );
  assert.equal((await first.json()).count, 2);
  // ...the agent never saw the response and replays the SAME batch.
  const replay = await route.POST(
    req(tokenA1, { method: 'POST', url: ACTIVITY_URL, body: { activities: activityBatch(2, 'retry'), batchId: BATCH_2, batchSeq: 3 } })
  );
  assert.equal(replay.status, 200);
  const body = (await replay.json()) as { count: number; deduplicated: number };
  assert.equal(body.count, 0);
  assert.equal(body.deduplicated, 2);
  assert.equal(await countActivities(empA1.id), 7, 'no growth from the replay');
});

// ─── P1-5 Old agent (no batchId) ───────────────────────────────────────────

test('P1-5: no batchId → accepted, legacy behavior + response shape preserved', async () => {
  const before_ = await countActivities(empA1.id);
  const res = await route.POST(
    req(tokenA1, { method: 'POST', url: ACTIVITY_URL, body: { activities: activityBatch(2, 'legacy') } })
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.success, true);
  assert.equal(body.count, 2);
  assert.equal('deduplicated' in body, false, 'legacy response has no deduplicated key');
  assert.equal(await countActivities(empA1.id), before_ + 2, 'rows inserted as before');
  // Replaying the same legacy payload inserts AGAIN (at-least-once legacy
  // semantics) — documented: dedupe only applies to batches that opt in.
  const again = await route.POST(
    req(tokenA1, { method: 'POST', url: ACTIVITY_URL, body: { activities: activityBatch(2, 'legacy') } })
  );
  assert.equal((await again.json()).count, 2);
  assert.equal(await countActivities(empA1.id), before_ + 4);
});

// ─── P1-6 Tenant isolation ─────────────────────────────────────────────────

test('P1-6: same batchId in a DIFFERENT org does NOT dedupe', async () => {
  await setActivityDedupe(orgB.id, true); // org B opts in independently of org A
  const res = await route.POST(
    req(tokenB1, { method: 'POST', url: ACTIVITY_URL, body: { activities: activityBatch(2, 'org-b'), batchId: BATCH_1, batchSeq: 1 } })
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { count: number };
  assert.equal(body.count, 2, 'org B accepts the same batchId org A already used');
  assert.equal(await countActivities(empB1.id), 2);
  assert.equal(await countReceipts(orgB.id, empB1.id, BATCH_1), 1, 'independent receipt under org B');
});

// ─── P1-7 Employee isolation ───────────────────────────────────────────────

test('P1-7: same batchId for a DIFFERENT employee in the SAME org does NOT dedupe', async () => {
  const res = await route.POST(
    req(tokenA2, { method: 'POST', url: ACTIVITY_URL, body: { activities: activityBatch(2, 'emp-a2'), batchId: BATCH_1, batchSeq: 1 } })
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { count: number };
  assert.equal(body.count, 2);
  assert.equal(await countActivities(empA2.id), 2);
  assert.equal(await countReceipts(orgA.id, empA2.id, BATCH_1), 1, 'independent receipt per employee');
});

// ─── P1-8 Flag off (safe-rollout default) ──────────────────────────────────

test('P1-8: activity_dedupe OFF → batchId ignored, legacy duplicate inserts allowed', async () => {
  await setActivityDedupe(orgA.id, false);
  const batchId = BATCH_FLAG_OFF;
  const first = await route.POST(
    req(tokenA1, { method: 'POST', url: ACTIVITY_URL, body: { activities: activityBatch(1, 'flag-off'), batchId, batchSeq: 1 } })
  );
  assert.equal((await first.json()).count, 1);
  const second = await route.POST(
    req(tokenA1, { method: 'POST', url: ACTIVITY_URL, body: { activities: activityBatch(1, 'flag-off'), batchId, batchSeq: 2 } })
  );
  const body = (await second.json()) as Record<string, unknown>;
  assert.equal(body.count, 1, 'flag off → legacy duplicate insert (documented at-least-once)');
  assert.equal('deduplicated' in body, false, 'no dedupe reporting when the flag is off');
  assert.equal(await countReceipts(orgA.id, empA1.id, batchId), 0, 'no receipts written when disabled');
  await setActivityDedupe(orgA.id, true);
});

// ─── P1-9 Validation ───────────────────────────────────────────────────────

test('P1-9: malformed batchId / batchSeq rejected with 422', async () => {
  const bad = [
    { activities: activityBatch(1), batchId: 'not-a-uuid' },
    { activities: activityBatch(1), batchId: '12345678-1234-1234-1234-1234567890ab' }, // wrong length
    { activities: activityBatch(1), batchId: BATCH_X, batchSeq: -1 },
    { activities: activityBatch(1), batchId: BATCH_X, batchSeq: 1.5 },
  ];
  for (const body of bad) {
    const res = await route.POST(req(tokenA1, { method: 'POST', url: ACTIVITY_URL, body }));
    assert.equal(res.status, 422, JSON.stringify(body));
  }
  // Nothing was written for the rejected batches.
  assert.equal(await countReceipts(orgA.id, empA1.id, BATCH_X), 0);
});

// ─── P1-10 Retention ───────────────────────────────────────────────────────

test('P1-10: stale receipts are purged by the activity retention sweep; fresh kept', async () => {
  // Fresh receipts exist under org A (BATCH_1 for empA1). Backdate one receipt
  // beyond the activity window and run the org sweep.
  await db.organizationSetting.create({
    data: { organizationId: orgA.id, key: 'activity_retention_days', value: '1', category: 'retention' },
  }).catch(() => db.organizationSetting.update({
    where: { organizationId_key: { organizationId: orgA.id, key: 'activity_retention_days' } },
    data: { value: '1' },
  }));

  const stale = await db.activityBatchReceipt.create({
    data: {
      organizationId: orgA.id,
      employeeId: empA2.id,
      batchId: BATCH_2, // empA2's own receipt — safe to mark stale
      rowCount: 2,
      receivedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    },
  });

  const result = await runRetentionForOrg(orgA.id, new Date());
  assert.ok(result.activityBatchReceipts >= 1, `stale receipts purged (${result.activityBatchReceipts})`);

  const gone = await db.activityBatchReceipt.findUnique({ where: { id: stale.id } });
  assert.equal(gone, null, 'stale receipt removed');
  const kept = await db.activityBatchReceipt.findUnique({
    where: {
      organizationId_employeeId_batchId: { organizationId: orgA.id, employeeId: empA1.id, batchId: BATCH_1 },
    },
  });
  assert.ok(kept, 'fresh receipt within the window is retained');
  await db.organizationSetting.deleteMany({
    where: { organizationId: orgA.id, key: 'activity_retention_days' },
  });
});

// ─── P1-11 Cross-repo contract (agent tree present) ────────────────────────

test('P1-11: agent sends batchId/batchSeq with a retry-stable batch id (contract)', () => {
  // Same sibling-tree convention as branding-regression.test.ts: when the
  // omnisight-agent checkout is present next to omnisight-web, verify the
  // agent's upload contract statically. When absent the check is skipped —
  // the web side never depends on the agent tree being checked out.
  const AGENT_ROOT = join(import.meta.dirname, '..', '..', 'omnisight-agent');
  if (!existsSync(AGENT_ROOT)) {
    return; // agent tree not present — runtime contract covered by P1-2..P1-5
  }
  const apiSrc = readFileSync(join(AGENT_ROOT, 'src/api/activity.ts'), 'utf8');
  assert.ok(apiSrc.includes('batchId') && apiSrc.includes('batchSeq'), 'agent upload attaches batchId + batchSeq');
  assert.ok(
    apiSrc.includes('payload.batchId = meta.batchId') && apiSrc.includes('payload.batchSeq = meta.batchSeq'),
    'agent sends the new fields inside the activity payload'
  );
  const uploaderSrc = readFileSync(join(AGENT_ROOT, 'src/services/queue-uploader.ts'), 'utf8');  assert.ok(uploaderSrc.includes('deriveBatchId') && uploaderSrc.includes('batch.map((i) => i.id)'),
    'one deterministic batchId per queued batch, never per row'
  );
  assert.ok(
    uploaderSrc.toLowerCase().includes('stable across retries'),
    'retry stability is documented in the derivation'
  );
});

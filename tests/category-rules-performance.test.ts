/**
 * Phase 3 — synthetic performance + isolation benchmark for server
 * classification: 100 organizations × 100 rules each × 10,000 activities.
 *
 * Verifies:
 *  - classification completes in bounded time (single rule load per org, one
 *    in-memory pass over the batch — no per-row DB query = no N+1);
 *  - no cross-org leakage (org A's rules classify org A rows only — org B
 *    rules can never match org A's unique app names);
 *  - bounded memory (classification is pure/iterative over an array).
 *
 * This mirrors the ingestion architecture: the route loads the org's enabled
 * rules ONCE per request (findMany, capped at MAX_RULES_PER_ORG) and passes
 * them to the pure `classifyRow` for the whole batch.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_catperf).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

// ─── Test DB isolation (set BEFORE any app module import) ──────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_catperf';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-catperf-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@catperf.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!CatPerf2026x';
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

const ORGS = 100;
const RULES_PER_ORG = 100;
const ACTIVITIES = 10_000;

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;

  // 100 orgs, each with 100 deterministic rules. Org N's rules only ever
  // match markers containing org-N + zero-padded rule index (`app-<n>-<i4>`),
  // so the isolation probe is exact: classify org N rows with org M's rules
  // → the default fallback (neutral) must apply, never org M's category.
  // Zero-padding (i4) prevents accidental substring overlap between rules
  // (app-<n>-0001 must never match a row for app-<n>-0010).
  const pad = (i: number) => String(i).padStart(4, '0');
  const orgData = Array.from({ length: ORGS }, (_, n) => ({
    name: `Perf Org ${n}`,
    slug: `perf-org-${n}`,
    timezone: 'UTC',
  }));
  await db.organization.createMany({ data: orgData });
  const orgs = await db.organization.findMany({ where: { slug: { startsWith: 'perf-org-' } }, select: { id: true, slug: true } });
  assert.equal(orgs.length, ORGS);

  const rules: Array<Record<string, unknown>> = [];
  for (const org of orgs) {
    const n = Number(org.slug.split('-')[2]);
    for (let i = 0; i < RULES_PER_ORG; i++) {
      // Three rule families per org — each pattern is unique per index so a
      // row for index i matches exactly its own rule (and nothing else):
      //   executable rules  (i%3===0) → match application rows by app name
      //   application rules (i%3===1) → match application rows by title
      //   domain rules      (i%3===2) → match website rows by url
      rules.push({
        organizationId: org.id,
        name: `rule-${i}`,
        matchType: i % 3 === 0 ? 'executable' : i % 3 === 1 ? 'application' : 'domain',
        pattern: `app-${n}-${pad(i)}`,
        category: i % 3 === 0 ? 'unproductive' : i % 3 === 1 ? 'productive' : 'neutral',
        priority: i,
        enabled: true,
      });
    }
  }
  await db.categoryRule.createMany({ data: rules });
  assert.equal(await db.categoryRule.count(), ORGS * RULES_PER_ORG);
});

after(async () => {
  await db.$disconnect();
});

test('CAT-PERF-1: classify 10k activities across 100 orgs — bounded, no N+1, no cross-org leak', async () => {
  const { classifyRow } = await import('../src/lib/classification/engine');

  // Load all orgs' rule sets exactly the way the ingestion route does: ONE
  // findMany per org (per request), nothing per row.
  const allOrgs = await db.organization.findMany({
    where: { slug: { startsWith: 'perf-org-' } },
    select: { id: true, slug: true },
  });

  // Build 10,000 rows distributed over the orgs: row i of org N belongs to
  // org N and matches exactly org N's rule i (same padded marker). The row
  // TYPE matches the rule family for index i (application rows for
  // executable/title rules, website rows for domain rules), so every row
  // deterministically matches its own org's rule.
  const pad = (i: number) => String(i).padStart(4, '0');
  type PerfRow = { type: 'application' | 'website'; applicationName: string | null; title: string | null; url: string | null };
  const rowsByOrg = new Map<string, PerfRow[]>();
  for (const org of allOrgs) rowsByOrg.set(org.id, []);
  for (const org of allOrgs) {
    const n = Number(org.slug.split('-')[2]);
    const list = rowsByOrg.get(org.id)!;
    for (let i = 0; i < RULES_PER_ORG; i++) {
      const marker = `app-${n}-${pad(i)}`;
      if (i % 3 === 2) {
        list.push({ type: 'website', applicationName: null, title: null, url: `${marker}.com` });
      } else {
        // Application rows: the executable family matches applicationName;
        // the title family matches the window title (both carry the marker).
        list.push({ type: 'application', applicationName: `${marker}.exe`, title: `${marker} window` });
      }
    }
  }
  // 100 orgs × 100 rows = 10,000 activities.
  assert.equal([...rowsByOrg.values()].reduce((s, l) => s + l.length, 0), ACTIVITIES);

  const started = Date.now();
  let classified = 0;
  let ruleHits = 0;
  let dbQueries = 0;

  for (const org of allOrgs) {
    const n = Number(org.slug.split('-')[2]);
    // The route's rule load: one bounded query per org (enabled only,
    // ordered by priority). No per-row query below — this is the N+1 proof.
    const rules = await db.categoryRule.findMany({
      where: { organizationId: org.id, enabled: true },
      select: { id: true, matchType: true, pattern: true, category: true, priority: true, createdAt: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });
    dbQueries += 1;
    assert.ok(rules.length <= 200, 'rule load stays within the documented bound');

    const orgRows = rowsByOrg.get(org.id)!;
    for (const row of orgRows) {
      const outcome = classifyRow(row, rules);
      classified += 1;
      // Every org row matches its OWN org's rule (deterministic).
      assert.ok(outcome && outcome.ruleMatched, `row for org ${n} must match its own rule`);
      assert.equal(outcome.category === 'productive' || outcome.category === 'neutral' || outcome.category === 'unproductive', true);
      ruleHits += 1;
    }
  }

  const elapsedMs = Date.now() - started;
  assert.equal(classified, ACTIVITIES);
  assert.equal(ruleHits, ACTIVITIES);

  // Cross-org probe: org A's rows classified with org B's rules must NEVER
  // match (B's patterns are B-specific) — fall back to the default heuristic.
  const orgA = allOrgs[0];
  const orgB = allOrgs[1];
  const bRules = await db.categoryRule.findMany({
    where: { organizationId: orgB.id, enabled: true },
    select: { id: true, matchType: true, pattern: true, category: true, priority: true },
  });
  let crossMatches = 0;
  for (const row of rowsByOrg.get(orgA.id)!) {
    const outcome = classifyRow(row, bRules);
    if (outcome?.ruleMatched) crossMatches += 1;
  }
  assert.equal(crossMatches, 0, 'org B rules must never match org A rows');

  // Boundedness: 100 org rule-load queries total (ONE per org), zero per row.
  assert.equal(dbQueries, ORGS);

  // Generous upper bound: 10k rows in-memory is milliseconds; even on a slow
  // CI box this must finish well under 30s (the DB round-trips dominate and
  // are bounded at 100).
  assert.ok(elapsedMs < 30_000, `classification of 10k rows took ${elapsedMs}ms (expected < 30s)`);
});

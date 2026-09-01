/**
 * Consent Management — Admin summary + grant flow (zero-consent employee fix).
 *
 * Covers:
 *   CS-A1  — summary lists an ACTIVE zero-consent employee (consents: [], 0/8)
 *   CS-A2  — employee from another organization is NOT listed (tenant isolation)
 *   CS-A3  — inactive employee is not listed (only active employees)
 *   CS-A4  — employees with consent records keep working (granted counts intact)
 *   CS-A5  — bulk grant_types creates + grants a single type for zero-consent
 *            employee after a policy is published (bound to policy version)
 *   CS-A6  — grant WITHOUT a published policy returns 409 (fail closed)
 *   CS-A7  — bulk grant_all creates all 8 types once policies are published
 *   CS-A8  — viewer cannot call the bulk grant endpoint (RBAC 403)
 *   CS-A9  — POST /api/agent/activity fails closed (403) without consent
 *   CS-A10 — POST /api/agent/activity succeeds (200) after consent is granted
 *
 * Every test seeds its OWN organization so policies/grants never leak between
 * cases (the ConsentPolicy (org, type, version) key is unique per org).
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_consent_summary).
 * Run: npm run test:consent-summary  (or npx tsx --test tests/consent-summary.test.ts)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

// ─── Test DB isolation (set BEFORE any app module import) ──────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_consent_summary';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-consent-summary-0123456789abcdef';
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
let summaryRoute: typeof import('../src/app/api/consent/summary/route');
let bulkRoute: typeof import('../src/app/api/consent/bulk/route');
let activityRoute: typeof import('../src/app/api/agent/activity/route');
let generateToken: (length?: number) => string;
let nextPolicyVersion: (versions: string[]) => string;

before(async () => {
  db = (await import('../src/lib/db')).db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  generateToken = (await import('../src/lib/agent/auth')).generateToken;
  nextPolicyVersion = (await import('../src/lib/consent')).nextPolicyVersion;

  const [sApi, bApi, aApi] = await Promise.all([
    import('../src/app/api/consent/summary/route'),
    import('../src/app/api/consent/bulk/route'),
    import('../src/app/api/agent/activity/route'),
  ]);
  summaryRoute = sApi;
  bulkRoute = bApi;
  activityRoute = aApi;
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
  return new NextRequest(opts.url || 'http://localhost:3000/api/test', {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function seedOrg(name: string) {
  return db.organization.create({ data: { name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') } });
}

async function seedEmployee(orgId: string, code: string, status = 'active') {
  return db.employee.create({
    data: {
      employeeId: code,
      firstName: code.split('-')[0],
      lastName: 'Test',
      email: `${code.toLowerCase()}@test.local`,
      organizationId: orgId,
      status,
      agentApproved: true,
    },
  });
}

function adminToken(orgId: string): Promise<string> {
  return signJWT({ userId: 'admin-test', email: 'admin@test.local', role: 'admin', organizationId: orgId });
}

function viewerToken(orgId: string): Promise<string> {
  return signJWT({ userId: 'viewer-test', email: 'viewer@test.local', role: 'viewer', organizationId: orgId });
}

/** Publish the NEXT version of a policy for a consent type (mirrors the real
 * policies route: previous published version is archived, new one is v+1, and
 * the unique (org, type, version) constraint is respected). */
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
      content: 'Test policy content for consent grant verification.',
      version,
      status: 'published',
      effectiveAt: new Date(),
      publishedAt: new Date(),
    },
  });
}

interface SummaryEmployee {
  employee: { id: string; employeeId: string; firstName: string; status: string };
  total: number;
  granted: number;
  pct: number;
  allGranted: boolean;
  complianceStatus: string;
  consents: unknown[];
}

async function getSummary(token: string): Promise<{ summary: Record<string, number>; employees: SummaryEmployee[]; typeBreakdown: Array<{ type: string; total: number }> }> {
  const res = await summaryRoute.GET(req(token));
  assert.equal(res.status, 200);
  return (await res.json()) as never;
}

// ─── CS-A1: zero-consent employee is visible ───────────────────────────────

test('CS-A1: summary lists an active zero-consent employee with 0/8, not granted', async () => {
  const org = await seedOrg('cs-a1-org');
  const emp = await seedEmployee(org.id, 'CS-A1');
  const token = await adminToken(org.id);

  const data = await getSummary(token);
  const row = data.employees.find((e) => e.employee.id === emp.id);
  assert.ok(row, 'zero-consent employee must appear in the summary');
  assert.equal(row!.total, 8, 'supported consent type count is 8');
  assert.equal(row!.granted, 0);
  assert.equal(row!.pct, 0);
  assert.equal(row!.allGranted, false, 'zero consents must NOT be fully compliant (vacuous-truth guard)');
  assert.equal(row!.complianceStatus, 'non_compliant');
  assert.deepEqual(row!.consents, [], 'consents array is empty for a zero-consent employee');
});

// ─── CS-A2: tenant isolation ───────────────────────────────────────────────

test('CS-A2: employee from another organization is NOT listed', async () => {
  const orgA = await seedOrg('cs-a2-org-a');
  const orgB = await seedOrg('cs-a2-org-b');
  const empB = await seedEmployee(orgB.id, 'CS-A2');
  const token = await adminToken(orgA.id);

  const data = await getSummary(token);
  const row = data.employees.find((e) => e.employee.id === empB.id);
  assert.equal(row, undefined, 'cross-org employee must never appear');
});

// ─── CS-A3: inactive employees are not listed ──────────────────────────────

test('CS-A3: inactive employees are excluded from the summary', async () => {
  const org = await seedOrg('cs-a3-org');
  const emp = await seedEmployee(org.id, 'CS-A3', 'inactive');
  const token = await adminToken(org.id);

  const data = await getSummary(token);
  const row = data.employees.find((e) => e.employee.id === emp.id);
  assert.equal(row, undefined, 'inactive employee must not be listed');
});

// ─── CS-A4: employees with consent records keep working ────────────────────

test('CS-A4: employee with consent records still reports granted counts', async () => {
  const org = await seedOrg('cs-a4-org');
  const emp = await seedEmployee(org.id, 'CS-A4');
  await publishPolicy(org.id, 'activity_tracking');
  await publishPolicy(org.id, 'screenshot');
  const token = await adminToken(org.id);

  // Grant two types through the bulk endpoint (admin).
  const grant = await bulkRoute.POST(
    req(token, {
      method: 'POST',
      body: { employeeId: emp.id, action: 'grant_types', consentTypes: ['activity_tracking', 'screenshot'] },
      ip: '203.0.113.44',
    })
  );
  assert.equal(grant.status, 200);

  const data = await getSummary(token);
  const row = data.employees.find((e) => e.employee.id === emp.id);
  assert.ok(row);
  assert.equal(row!.granted, 2);
  assert.equal(row!.total, 8);
  assert.equal(row!.consents.length, 2);
  // allGranted means "every EXISTING consent record is granted" — with exactly
  // the two granted records present it is true (pre-existing semantics), and
  // the employee is correctly NOT 100% of the 8 supported types.
  assert.equal(row!.allGranted, true);
  assert.equal(row!.pct, 25);
});

// ─── CS-A5: single-type grant for a zero-consent employee after publish ────

test('CS-A5: bulk grant_types creates + grants one type for a zero-consent employee, bound to the published policy', async () => {
  const org = await seedOrg('cs-a5-org');
  const emp = await seedEmployee(org.id, 'CS-A5');
  const pol = await publishPolicy(org.id, 'activity_tracking');
  const token = await adminToken(org.id);

  const res = await bulkRoute.POST(
    req(token, {
      method: 'POST',
      body: { employeeId: emp.id, action: 'grant_types', consentTypes: ['activity_tracking'] },
      ip: '203.0.113.45',
    })
  );
  assert.equal(res.status, 200);

  const row = await db.consent.findFirst({ where: { employeeId: emp.id, consentType: 'activity_tracking' } });
  assert.ok(row, 'consent row created');
  assert.equal(row!.status, 'granted');
  assert.equal(row!.consentVersion, pol.version, 'consent bound to the current published policy version');
  assert.equal(row!.policyId, pol.id, 'consent bound to the published policy');
  assert.ok(row!.grantedAt, 'grantedAt populated');
  assert.equal(await db.consent.count({ where: { employeeId: emp.id } }), 1, 'no duplicate row');
});

// ─── CS-A6: grant without a published policy → 409 ─────────────────────────

test('CS-A6: granting without a published policy returns 409 (fail closed)', async () => {
  const org = await seedOrg('cs-a6-org');
  const emp = await seedEmployee(org.id, 'CS-A6');
  const token = await adminToken(org.id);

  // No policy published for 'screenshot' in this org.
  const res = await bulkRoute.POST(
    req(token, {
      method: 'POST',
      body: { employeeId: emp.id, action: 'grant_types', consentTypes: ['screenshot'] },
      ip: '203.0.113.46',
    })
  );
  assert.equal(res.status, 409);
  const body = await res.json() as { error?: string };
  assert.match(body.error ?? '', /no published policy/i);

  const count = await db.consent.count({ where: { employeeId: emp.id } });
  assert.equal(count, 0, 'no consent row created when the grant is blocked');
});

// ─── CS-A7: grant_all for a zero-consent employee once all policies exist ──

test('CS-A7: grant_all creates all 8 types for a zero-consent employee', async () => {
  const org = await seedOrg('cs-a7-org');
  const emp = await seedEmployee(org.id, 'CS-A7');
  const types = ['monitoring', 'screenshot', 'activity_tracking', 'keystroke', 'usb_monitoring', 'webcam_access', 'location', 'email_monitoring'];
  for (const t of types) await publishPolicy(org.id, t);
  const token = await adminToken(org.id);

  const res = await bulkRoute.POST(
    req(token, {
      method: 'POST',
      body: { employeeId: emp.id, action: 'grant_all' },
      ip: '203.0.113.47',
    })
  );
  assert.equal(res.status, 200);

  const rows = await db.consent.findMany({ where: { employeeId: emp.id } });
  assert.equal(rows.length, 8, 'all 8 consent types created');
  assert.ok(rows.every((r) => r.status === 'granted'), 'all granted');
  assert.ok(rows.every((r) => r.policyId !== null), 'all bound to a published policy');
});

// ─── CS-A8: RBAC — viewer cannot grant ─────────────────────────────────────

test('CS-A8: viewer calling bulk grant gets 403', async () => {
  const org = await seedOrg('cs-a8-org');
  const emp = await seedEmployee(org.id, 'CS-A8');
  await publishPolicy(org.id, 'activity_tracking');
  const token = await viewerToken(org.id);

  const res = await bulkRoute.POST(
    req(token, {
      method: 'POST',
      body: { employeeId: emp.id, action: 'grant_types', consentTypes: ['activity_tracking'] },
      ip: '203.0.113.48',
    })
  );
  assert.equal(res.status, 403);

  const count = await db.consent.count({ where: { employeeId: emp.id } });
  assert.equal(count, 0, 'viewer grant must not write anything');
});

// ─── CS-A9 / CS-A10: agent activity endpoint fail-closed then allowed ──────

test('CS-A9 + CS-A10: /api/agent/activity rejects without consent (403), accepts after grant (200)', async () => {
  const org = await seedOrg('cs-a9-org');
  const emp = await seedEmployee(org.id, 'CS-A9');
  await publishPolicy(org.id, 'activity_tracking');
  const tokenStr = generateToken(64);
  await db.agentToken.create({
    data: { token: tokenStr, expiresAt: new Date(Date.now() + 3600_000),
      employee: { connect: { id: emp.id } },
      organization: { connect: { id: org.id } },
    },
  });

  const actReq = () =>
    new NextRequest('http://localhost:3000/api/agent/activity', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenStr}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ activities: [{ type: 'application', title: 'VS Code', duration: 60 }] }),
    });

  // CS-A9: no consent yet → 403
  const denied = await activityRoute.POST(actReq());
  assert.equal(denied.status, 403, 'activity upload must fail closed without consent');

  // Grant activity consent (admin, policy already published).
  const adminTokenStr = await adminToken(org.id);
  const grant = await bulkRoute.POST(
    req(adminTokenStr, {
      method: 'POST',
      body: { employeeId: emp.id, action: 'grant_types', consentTypes: ['activity_tracking'] },
      ip: '203.0.113.49',
    })
  );
  assert.equal(grant.status, 200);

  // CS-A10: with consent → 200 and the row is stored
  const allowed = await activityRoute.POST(actReq());
  assert.equal(allowed.status, 200, 'activity upload must succeed after consent');
  const stored = await db.activity.count({ where: { employeeId: emp.id } });
  assert.equal(stored, 1, 'activity row persisted');

  // Revoke → fail closed again immediately
  const revoke = await bulkRoute.POST(
    req(adminTokenStr, {
      method: 'POST',
      body: { employeeId: emp.id, action: 'revoke_types', consentTypes: ['activity_tracking'] },
      ip: '203.0.113.49',
    })
  );
  assert.equal(revoke.status, 200);
  const deniedAgain = await activityRoute.POST(actReq());
  assert.equal(deniedAgain.status, 403, 'revoked consent must fail closed immediately');
});

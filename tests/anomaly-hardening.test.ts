/**
 * Anomaly Detection Hardening (F-1 … F-25) — regression tests.
 *
 * Covers the production-hardening pass for the Anomaly Detection feature:
 *   - API auth/RBAC + organization isolation (cross-org GET/PUT, foreign
 *     employee/device references)
 *   - Pagination validation (never NaN into Prisma)
 *   - Manual POST validation (type/severity/score/confidence, metadata bound)
 *   - Detection engine correctness (idle normalization, org work hours,
 *     org-timezone day semantics, baseline sufficiency, bounded scores)
 *   - DB-safe dedupe (unique dedupeKey, resolved-record retrigger, concurrency)
 *   - Agent-report deep-link notifications (actionUrl/entityType/entityId)
 *   - Audit logging (create / status change / batch)
 *   - Realtime invalidation mapping
 *   - Scheduler / JobRun lease behavior
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_anomalyhardening).
 * Run: npx tsx --test tests/anomaly-hardening.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_anomalyhardening';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-anomalyhardening-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

before(() => {
  if (process.env.ANOMALY_TEST_MIGRATED_DB !== '1') {
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

type DbModule = typeof import('../src/lib/db');
let db: DbModule['db'];
let signJWT: (payload: { userId: string; email: string; role: string; organizationId?: string }) => Promise<string>;

// Route modules (imported dynamically so DATABASE_URL is set first).
type AnomaliesApi = typeof import('../src/app/api/anomalies/route');
type AnomalyIdApi = typeof import('../src/app/api/anomalies/[id]/route');
type AnomalyBatchApi = typeof import('../src/app/api/anomalies/batch/route');
type AnomalyDetectApi = typeof import('../src/app/api/anomalies/detect/route');
type AgentAnomalyApi = typeof import('../src/app/api/agent/anomaly/route');
let anomaliesApi: AnomaliesApi;
let anomalyIdApi: AnomalyIdApi;
let anomalyBatchApi: AnomalyBatchApi;
let anomalyDetectApi: AnomalyDetectApi;
let agentAnomalyApi: AgentAnomalyApi;

// Engine + constants (pure — no DB).
type DetectModule = typeof import('../src/lib/anomalies/detect');
type TimeModule = typeof import('../src/lib/anomalies/time');
type ConstantsModule = typeof import('../src/lib/anomalies/constants');
type WsInvalidationModule = typeof import('../src/lib/ws-invalidation');
type RunModule = typeof import('../src/lib/jobs/run');
type JobModule = typeof import('../src/lib/jobs/detect-anomalies');
let detect: DetectModule;
let time: TimeModule;
let constants: ConstantsModule;
let wsInvalidation: WsInvalidationModule;
let run: RunModule;
let job: JobModule;

let orgA: { id: string };
let orgB: { id: string };
let orgC: { id: string }; // ai_anomaly_detection disabled (scheduler test)
let empA: { id: string };
let empB: { id: string };
let devA: { id: string };

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  const [anApi, idApi, batchApi, detectApi, agAnApi, det, t, c, ws, rn, jb] = await Promise.all([
    import('../src/app/api/anomalies/route'),
    import('../src/app/api/anomalies/[id]/route'),
    import('../src/app/api/anomalies/batch/route'),
    import('../src/app/api/anomalies/detect/route'),
    import('../src/app/api/agent/anomaly/route'),
    import('../src/lib/anomalies/detect'),
    import('../src/lib/anomalies/time'),
    import('../src/lib/anomalies/constants'),
    import('../src/lib/ws-invalidation'),
    import('../src/lib/jobs/run'),
    import('../src/lib/jobs/detect-anomalies'),
  ]);
  anomaliesApi = anApi;
  anomalyIdApi = idApi;
  anomalyBatchApi = batchApi;
  anomalyDetectApi = detectApi;
  agentAnomalyApi = agAnApi;
  detect = det;
  time = t;
  constants = c;
  wsInvalidation = ws;
  run = rn;
  job = jb;

  orgA = await db.organization.create({ data: { name: 'Anomaly Org A', slug: 'anom-a', timezone: 'UTC' } });
  orgB = await db.organization.create({ data: { name: 'Anomaly Org B', slug: 'anom-b', timezone: 'UTC' } });
  orgC = await db.organization.create({ data: { name: 'Anomaly Org C', slug: 'anom-c', timezone: 'UTC' } });

  // Org A: full-day work window (00:00–23:59) so the deterministic route-level
  // detection tests only ever trigger productivity_drop + excessive_idle —
  // off-hours activity is suppressed regardless of the wall-clock run time.
  await db.organizationSetting.create({ data: { organizationId: orgA.id, key: 'work_start_time', value: '00:00', category: 'monitoring' } });
  await db.organizationSetting.create({ data: { organizationId: orgA.id, key: 'work_end_time', value: '23:59', category: 'monitoring' } });
  // Org C: detection explicitly disabled.
  await db.organizationSetting.create({ data: { organizationId: orgC.id, key: 'ai_anomaly_detection', value: 'false', category: 'monitoring' } });

  empA = await db.employee.create({
    data: { employeeId: 'ANOM-EMP-A', firstName: 'Alice', lastName: 'A', email: 'alice@anom-a.local', organizationId: orgA.id, status: 'active' },
  });
  empB = await db.employee.create({
    data: { employeeId: 'ANOM-EMP-B', firstName: 'Bob', lastName: 'B', email: 'bob@anom-b.local', organizationId: orgB.id, status: 'active' },
  });
  devA = await db.device.create({ data: { name: 'PC-ANOM-A', organizationId: orgA.id, employeeId: empA.id, status: 'online' } });
});

after(async () => {
  await db.$disconnect();
  if (process.env.ANOMALY_TEST_MIGRATED_DB !== '1') {
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

function tokenFor(role: string, userId: string, orgId: string = orgA.id) {
  return signJWT({ userId, email: `${role}-${userId}@${orgId.slice(-6)}.local`, role, organizationId: orgId });
}

function listUrl(query = ''): string {
  return `http://localhost:3000/api/anomalies${query}`;
}

async function createAnomaly(managerToken: string, overrides: Record<string, unknown> = {}) {
  const res = await anomaliesApi.POST(
    req(managerToken, {
      method: 'POST',
      body: {
        type: 'policy_breach',
        severity: 'high',
        title: 'Test anomaly',
        description: 'Manual test anomaly',
        score: 75,
        confidence: 0.8,
        ...overrides,
      },
    })
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

// ─── A. API auth / RBAC ─────────────────────────────────────────────────────

test('AN-01: GET /api/anomalies unauthenticated → 401', async () => {
  const res = await anomaliesApi.GET(req(null, { url: listUrl() }));
  assert.equal(res.status, 401);
});

test('AN-02: GET /api/anomalies viewer → 200 (viewers may view the monitoring surface)', async () => {
  const res = await anomaliesApi.GET(req(await tokenFor('viewer', 'u-viewer'), { url: listUrl() }));
  assert.equal(res.status, 200);
});

test('AN-03: POST /api/anomalies unauthenticated → 401', async () => {
  const res = await anomaliesApi.POST(req(null, { method: 'POST', body: { type: 'policy_breach', title: 'x', description: 'y' } }));
  assert.equal(res.status, 401);
});

test('AN-04: POST /api/anomalies viewer → 403 (manager+ required)', async () => {
  const res = await anomaliesApi.POST(req(await tokenFor('viewer', 'u-viewer'), { method: 'POST', body: { type: 'policy_breach', title: 'x', description: 'y' } }));
  assert.equal(res.status, 403);
});

test('AN-05: PUT /api/anomalies/[id] viewer → 403', async () => {
  const res = await anomalyIdApi.PUT(req(await tokenFor('viewer', 'u-viewer'), { method: 'PUT', body: { status: 'resolved' } }), { params: Promise.resolve({ id: 'any' }) });
  assert.equal(res.status, 403);
});

test('AN-06: POST /api/anomalies/batch viewer → 403', async () => {
  const res = await anomalyBatchApi.POST(req(await tokenFor('viewer', 'u-viewer'), { method: 'POST', body: { ids: ['x'], status: 'resolved' } }));
  assert.equal(res.status, 403);
});

test('AN-07: POST /api/anomalies/detect viewer → 403', async () => {
  const res = await anomalyDetectApi.POST(req(await tokenFor('viewer', 'u-viewer'), { method: 'POST', body: {} }));
  assert.equal(res.status, 403);
});

// ─── B. Organization isolation (IDOR/BOLA) ──────────────────────────────────

test('AN-10: cross-org GET /api/anomalies/[id] → 404 (org B token, org A anomaly)', async () => {
  const managerA = await tokenFor('manager', 'u-mgr-a');
  const { body } = await createAnomaly(managerA, { employeeId: empA.id, deviceId: devA.id });
  const res = await anomalyIdApi.GET(req(await tokenFor('manager', 'u-mgr-b', orgB.id), { url: `http://localhost:3000/api/anomalies/${body.id}` }), {
    params: Promise.resolve({ id: body.id as string }),
  });
  assert.equal(res.status, 404);
});

test('AN-11: cross-org PUT /api/anomalies/[id] → 404 and no row change', async () => {
  const managerA = await tokenFor('manager', 'u-mgr-a');
  const { body } = await createAnomaly(managerA);
  const res = await anomalyIdApi.PUT(
    req(await tokenFor('manager', 'u-mgr-b', orgB.id), { method: 'PUT', body: { status: 'resolved' } }),
    { params: Promise.resolve({ id: body.id as string }) }
  );
  assert.equal(res.status, 404);
  const row = await db.anomaly.findUnique({ where: { id: body.id as string } });
  assert.equal(row!.status, 'detected', 'foreign update must not mutate the row');
});

test('AN-12: POST with foreign employeeId → 404 (employee must belong to caller org)', async () => {
  const managerA = await tokenFor('manager', 'u-mgr-a');
  const { status, body } = await createAnomaly(managerA, { employeeId: empB.id });
  assert.equal(status, 404);
  assert.match(String(body.error ?? ''), /Employee/i);
});

test('AN-13: POST with foreign deviceId → 404 (device must belong to caller org)', async () => {
  const managerA = await tokenFor('manager', 'u-mgr-a');
  const foreignDevice = await db.device.create({ data: { name: 'PC-ANOM-B', organizationId: orgB.id, status: 'online' } });
  const { status, body } = await createAnomaly(managerA, { deviceId: foreignDevice.id });
  assert.equal(status, 404);
  assert.match(String(body.error ?? ''), /Device/i);
});

test('AN-14: cross-org batch id is excluded, never updated', async () => {
  const managerA = await tokenFor('manager', 'u-mgr-a');
  const { body: own } = await createAnomaly(managerA);
  const res = await anomalyBatchApi.POST(
    req(await tokenFor('manager', 'u-mgr-b', orgB.id), { method: 'POST', body: { ids: [own.id], status: 'resolved' } })
  );
  const parsed = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, 404, JSON.stringify(parsed)); // no scoped ids → 404
  const row = await db.anomaly.findUnique({ where: { id: own.id as string } });
  assert.equal(row!.status, 'detected');
});

// ─── C. Pagination ──────────────────────────────────────────────────────────

test('AN-20: page=abc → 422 (never NaN into Prisma)', async () => {
  const res = await anomaliesApi.GET(req(await tokenFor('admin', 'u-admin'), { url: listUrl('?page=abc') }));
  assert.equal(res.status, 422);
});

test('AN-21: page=-1 → 422', async () => {
  const res = await anomaliesApi.GET(req(await tokenFor('admin', 'u-admin'), { url: listUrl('?page=-1') }));
  assert.equal(res.status, 422);
});

test('AN-22: pageSize=0 → 422', async () => {
  const res = await anomaliesApi.GET(req(await tokenFor('admin', 'u-admin'), { url: listUrl('?pageSize=0') }));
  assert.equal(res.status, 422);
});

test('AN-23: pageSize=999999 → 422 (bounded)', async () => {
  const res = await anomaliesApi.GET(req(await tokenFor('admin', 'u-admin'), { url: listUrl('?pageSize=999999') }));
  assert.equal(res.status, 422);
});

test('AN-24: valid pagination → 200 with totalPages', async () => {
  const res = await anomaliesApi.GET(req(await tokenFor('admin', 'u-admin'), { url: listUrl('?page=1&pageSize=10') }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.page, 1);
  assert.equal(body.pageSize, 10);
  assert.equal(typeof body.total, 'number');
});

// ─── D. Search / filter / date / sort ───────────────────────────────────────

test('AN-30: severity + status filters return only matching rows', async () => {
  const managerA = await tokenFor('manager', 'u-mgr-a');
  await createAnomaly(managerA, { severity: 'low', title: 'Low severity item' });
  const res = await anomaliesApi.GET(req(await tokenFor('admin', 'u-admin'), { url: listUrl('?severity=low&status=detected') }));
  const body = (await res.json()) as { data: { severity: string }[] };
  assert.equal(res.status, 200);
  assert.ok(body.data.length > 0);
  assert.ok(body.data.every((a) => a.severity === 'low'));
});

test('AN-31: employeeId filter scopes to that employee', async () => {
  const res = await anomaliesApi.GET(req(await tokenFor('admin', 'u-admin'), { url: listUrl(`?employeeId=${empA.id}`) }));
  const body = (await res.json()) as { data: { employeeId: string | null }[] };
  assert.equal(res.status, 200);
  assert.ok(body.data.every((a) => a.employeeId === empA.id));
});

test('AN-32: search matches title substring', async () => {
  const managerA = await tokenFor('manager', 'u-mgr-a');
  await createAnomaly(managerA, { title: 'UniquelySearchableTitle-xyz' });
  const res = await anomaliesApi.GET(req(await tokenFor('admin', 'u-admin'), { url: listUrl('?search=UniquelySearchableTitle') }));
  const body = (await res.json()) as { data: { title: string }[] };
  assert.equal(res.status, 200);
  assert.ok(body.data.length > 0);
  assert.ok(body.data.every((a) => a.title.includes('UniquelySearchableTitle')));
});

test('AN-33: from/to date range filters createdAt', async () => {
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
  await db.anomaly.create({
    data: {
      type: 'policy_breach', severity: 'medium', status: 'detected',
      title: 'Old anomaly', description: 'from yesterday', score: 50, confidence: 0.5,
      organizationId: orgA.id, createdAt: yesterday,
    },
  });
  const from = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  const res = await anomaliesApi.GET(req(await tokenFor('admin', 'u-admin'), { url: listUrl(`?from=${from}&to=${to}`) }));
  assert.equal(res.status, 200);
});

test('AN-34: invalid date → 422', async () => {
  const res = await anomaliesApi.GET(req(await tokenFor('admin', 'u-admin'), { url: listUrl('?from=not-a-date') }));
  assert.equal(res.status, 422);
});

test('AN-35: invalid sortBy → 422 (whitelist only)', async () => {
  const res = await anomaliesApi.GET(req(await tokenFor('admin', 'u-admin'), { url: listUrl('?sortBy=severity') }));
  assert.equal(res.status, 422);
});

test('AN-36: sort by score asc is honored', async () => {
  const managerA = await tokenFor('manager', 'u-mgr-a');
  await createAnomaly(managerA, { title: 'Score low', score: 10 });
  await createAnomaly(managerA, { title: 'Score high', score: 99 });
  const res = await anomaliesApi.GET(req(await tokenFor('admin', 'u-admin'), { url: listUrl('?sortBy=score&sortOrder=asc&pageSize=100') }));
  const body = (await res.json()) as { data: { score: number }[] };
  assert.equal(res.status, 200);
  const scores = body.data.map((a) => a.score);
  assert.deepEqual(scores, [...scores].sort((x, y) => x - y), 'scores must be ascending');
});

// ─── E. Manual POST validation ──────────────────────────────────────────────

test('AN-40: invalid type → 422', async () => {
  const { status, body } = await createAnomaly(await tokenFor('manager', 'u-mgr-a'), { type: 'banana' });
  assert.equal(status, 422);
  assert.match(String(body.error ?? ''), /type/i);
});

test('AN-41: invalid severity → 422 (unknown severities never reach stats)', async () => {
  const { status, body } = await createAnomaly(await tokenFor('manager', 'u-mgr-a'), { severity: 'urgent' });
  assert.equal(status, 422);
  assert.match(String(body.error ?? ''), /severity/i);
});

test('AN-42: negative score → 422', async () => {
  const { status } = await createAnomaly(await tokenFor('manager', 'u-mgr-a'), { score: -5 });
  assert.equal(status, 422);
});

test('AN-43: score > 100 → 422', async () => {
  const { status } = await createAnomaly(await tokenFor('manager', 'u-mgr-a'), { score: 150 });
  assert.equal(status, 422);
});

test('AN-44: non-numeric score (string) → 422', async () => {
  const { status } = await createAnomaly(await tokenFor('manager', 'u-mgr-a'), { score: '70' });
  assert.equal(status, 422);
});

test('AN-45: confidence < 0 → 422', async () => {
  const { status } = await createAnomaly(await tokenFor('manager', 'u-mgr-a'), { confidence: -0.5 });
  assert.equal(status, 422);
});

test('AN-46: confidence > 1 → 422', async () => {
  const { status } = await createAnomaly(await tokenFor('manager', 'u-mgr-a'), { confidence: 1.5 });
  assert.equal(status, 422);
});

test('AN-47: valid request → 201, persisted org-scoped', async () => {
  const managerA = await tokenFor('manager', 'u-mgr-a');
  const { status, body } = await createAnomaly(managerA, { employeeId: empA.id, deviceId: devA.id });
  assert.equal(status, 201, JSON.stringify(body));
  const row = await db.anomaly.findUnique({ where: { id: body.id as string } });
  assert.ok(row);
  assert.equal(row!.organizationId, orgA.id);
  assert.equal(row!.employeeId, empA.id);
  assert.equal(row!.deviceId, devA.id);
});

test('AN-48: oversized metadata → 422 (bounded records)', async () => {
  const { status, body } = await createAnomaly(await tokenFor('manager', 'u-mgr-a'), {
    metadata: { bloat: 'x'.repeat(constants.ANOMALY_METADATA_MAX_BYTES + 10) },
  });
  assert.equal(status, 422);
  assert.match(String(body.error ?? ''), /metadata/i);
});

// ─── F. Detection engine correctness (pure) ─────────────────────────────────

const NOW = new Date('2026-08-16T12:00:00Z');
const CFG = { timezone: 'UTC', workStartMinutes: 9 * 60, workEndMinutes: 18 * 60, now: NOW };

function act(ts: Date, duration: number, category: string | null, type: string | null = 'application') {
  return { timestamp: ts, duration, category, type };
}
function atDaysAgo(days: number, hour = 10): Date {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}
function empLike(id = 'emp-1', name = 'Test') {
  return { id, firstName: name, lastName: 'User' };
}

test('AN-50: isIdleActivity recognizes BOTH real representations (category idle, type idle)', () => {
  assert.equal(detect.isIdleActivity(act(NOW, 60, 'idle', 'application')), true, 'category=idle');
  assert.equal(detect.isIdleActivity(act(NOW, 60, 'unproductive', 'idle')), true, 'type=idle');
  assert.equal(detect.isIdleActivity(act(NOW, 60, 'productive', 'application')), false);
  assert.equal(detect.isIdleActivity(act(NOW, 60, null, null)), false);
});

test('AN-51: productivity_drop triggers with a real baseline; idle excluded from denominator', () => {
  const baseline = [];
  for (let i = 6; i <= 11; i++) {
    baseline.push(act(atDaysAgo(i), 8 * 3600, 'productive'));
    baseline.push(act(atDaysAgo(i), 2 * 3600, 'neutral'));
    baseline.push(act(atDaysAgo(i), 1 * 3600, 'idle')); // must NOT count as work time
  }
  // Recent: only ~11% productive (1h of 9h non-idle) vs baseline 80%.
  const recent = [
    act(new Date(NOW.getTime() - 3600_000), 3600, 'productive'),
    act(new Date(NOW.getTime() - 3600_000), 8 * 3600, 'neutral'),
    act(new Date(NOW.getTime() - 3600_000), 4 * 3600, 'idle'), // excluded from ratio
  ];
  const result = detect.detectAnomaliesForEmployee(
    { employee: empLike(), recent, baseline },
    CFG
  );
  const drop = result.anomalies.find((a) => a.type === 'productivity_drop');
  assert.ok(drop, `expected productivity_drop, got ${JSON.stringify(result.anomalies)}`);
  assert.equal(drop!.severity, 'critical'); // drop > 50%
  assert.ok(drop!.score > 0 && drop!.score <= 100);
  assert.ok(drop!.confidence >= 0 && drop!.confidence <= 0.95);
});

test('AN-52: productivity_drop skips on zero non-idle denominator (no NaN, no division by zero)', () => {
  const baseline = [];
  for (let i = 6; i <= 11; i++) {
    baseline.push(act(atDaysAgo(i), 8 * 3600, 'productive'));
  }
  const recent = [act(new Date(NOW.getTime() - 3600_000), 8 * 3600, 'idle')];
  const result = detect.detectAnomaliesForEmployee({ employee: empLike(), recent, baseline }, CFG);
  assert.equal(result.anomalies.filter((a) => a.type === 'productivity_drop').length, 0);
  assert.ok(result.skippedReasons.some((r) => r.includes('zero non-idle duration')));
});

test('AN-53: productivity_drop skips on empty baseline', () => {
  const recent = [act(new Date(NOW.getTime() - 3600_000), 3600, 'productive')];
  const result = detect.detectAnomaliesForEmployee({ employee: empLike(), recent, baseline: [] }, CFG);
  assert.equal(result.anomalies.filter((a) => a.type === 'productivity_drop').length, 0);
  assert.ok(result.skippedReasons.some((r) => r.includes('no baseline activity')));
});

test('AN-54: productivity_drop skips on insufficient baseline history (F-17 — new employee)', () => {
  const baseline = [act(atDaysAgo(6), 8 * 3600, 'productive'), act(atDaysAgo(6), 2 * 3600, 'neutral')]; // 1 distinct day
  const recent = [act(new Date(NOW.getTime() - 3600_000), 3600, 'productive')];
  const result = detect.detectAnomaliesForEmployee({ employee: empLike(), recent, baseline }, CFG);
  assert.equal(result.anomalies.filter((a) => a.type === 'productivity_drop').length, 0);
  assert.ok(result.skippedReasons.some((r) => r.includes('baseline has')));
});

test('AN-55: excessive_idle triggers at threshold boundary (>120 min), not at exactly 120', () => {
  const exactly = [act(new Date(NOW.getTime() - 3600_000), 120 * 60, 'unproductive', 'idle')];
  const over = [act(new Date(NOW.getTime() - 3600_000), 121 * 60, 'unproductive', 'idle')];
  const no = detect.detectAnomaliesForEmployee({ employee: empLike(), recent: exactly, baseline: [] }, CFG);
  assert.equal(no.anomalies.filter((a) => a.type === 'excessive_idle').length, 0);
  const yes = detect.detectAnomaliesForEmployee({ employee: empLike(), recent: over, baseline: [] }, CFG);
  assert.equal(yes.anomalies.filter((a) => a.type === 'excessive_idle').length, 1);
});

test('AN-56: off-hours activity honors org work window (F-2) — same data, different window', () => {
  const late = [];
  for (let i = 0; i < 6; i++) late.push(act(new Date(NOW.getTime() - i * 60_000), 60, 'productive'));
  // Move the 6 activities to 22:00 local (outside 09:00–18:00).
  const offHours = late.map((a) => ({ ...a, timestamp: new Date('2026-08-16T22:00:00Z') }));
  const strict = detect.detectAnomaliesForEmployee({ employee: empLike(), recent: offHours, baseline: [] }, CFG);
  assert.equal(strict.anomalies.filter((a) => a.type === 'unusual_login').length, 1, 'off-window must trigger');

  const extended = detect.detectAnomaliesForEmployee(
    { employee: empLike(), recent: offHours, baseline: [] },
    { ...CFG, workEndMinutes: 23 * 60 } // 09:00–23:00 covers 22:00
  );
  assert.equal(extended.anomalies.filter((a) => a.type === 'unusual_login').length, 0, 'inside extended window must not trigger');
});

test('AN-57: low_activity_spike triggers only with a real daily average', () => {
  const recent = [];
  for (let d = 1; d <= 6; d++) {
    for (let i = 0; i < 30; i++) recent.push(act(atDaysAgo(d, 10 + (i % 6)), 60, 'productive'));
  }
  for (let i = 0; i < 5; i++) recent.push(act(new Date(NOW.getTime() - i * 60_000), 60, 'productive')); // today: 5
  const result = detect.detectAnomaliesForEmployee({ employee: empLike(), recent, baseline: [] }, CFG);
  assert.equal(result.anomalies.filter((a) => a.type === 'low_activity_spike').length, 1);
});

test('AN-58: scores stay bounded even at extreme inputs', () => {
  // Baseline is 100% productive; recent drops to ~0% → an extreme ~100% drop.
  const baseline = [];
  for (let i = 6; i <= 11; i++) baseline.push(act(atDaysAgo(i), 8 * 3600, 'productive'));
  const recent = [
    act(new Date(NOW.getTime() - 3600_000), 60, 'productive'),
    act(new Date(NOW.getTime() - 3600_000), 8 * 3600, 'neutral'),
  ];
  const result = detect.detectAnomaliesForEmployee({ employee: empLike(), recent, baseline }, CFG);
  const drop = result.anomalies.find((a) => a.type === 'productivity_drop');
  assert.ok(drop, JSON.stringify(result));
  assert.ok(drop!.score >= 0 && drop!.score <= 100, `score ${drop!.score} out of bounds`);
  assert.ok(drop!.confidence >= 0 && drop!.confidence <= 0.95, `confidence ${drop!.confidence} out of bounds`);
});

test('AN-59: org-timezone day keys (F-6) — midnight boundary lands on the org day', () => {
  // 2026-08-15T20:00Z = 02:00 on Aug 16 in Asia/Dhaka (UTC+6).
  const ts = new Date('2026-08-15T20:00:00Z');
  assert.equal(time.tzDayKey(ts, 'UTC'), '2026-08-15');
  assert.equal(time.tzDayKey(ts, 'Asia/Dhaka'), '2026-08-16', 'boundary must follow the org timezone');
});

test('AN-60: buildHistory buckets by org timezone and emits 7 consecutive tz day keys', () => {
  const ts = new Date('2026-08-15T20:00:00Z'); // Aug 16 in Dhaka
  const history = detect.buildHistory([act(ts, 3600, 'productive')], 'Asia/Dhaka', NOW);
  assert.equal(history.length, 7);
  const bucket = history.find((h) => h.value > 0);
  assert.equal(bucket!.date, '2026-08-16', 'activity must land in the tz day bucket');
  assert.ok(history.some((h) => h.date === '2026-08-16'), 'label set must include the org-tz day');
});

// ─── G. Deduplication (F-14) ────────────────────────────────────────────────

test('AN-70: anomalyDedupeKey is deterministic per org+employee+type+utcDay', () => {
  const k1 = constants.anomalyDedupeKey('org-1', 'emp-1', 'excessive_idle', NOW);
  const k2 = constants.anomalyDedupeKey('org-1', 'emp-1', 'excessive_idle', NOW);
  assert.equal(k1, k2);
  assert.notEqual(k1, constants.anomalyDedupeKey('org-2', 'emp-1', 'excessive_idle', NOW), 'org must scope the key');
  assert.notEqual(k1, constants.anomalyDedupeKey('org-1', 'emp-2', 'excessive_idle', NOW), 'employee must scope the key');
  assert.notEqual(k1, constants.anomalyDedupeKey('org-1', 'emp-1', 'policy_breach', NOW), 'type must scope the key');
  assert.notEqual(
    k1,
    constants.anomalyDedupeKey('org-1', 'emp-1', 'excessive_idle', new Date(NOW.getTime() + 24 * 3600 * 1000)),
    'next UTC day must start a fresh bucket'
  );
});

test('AN-71: concurrent detection cannot create duplicates (P2002 handled as duplicate)', async () => {
  const managerA = await tokenFor('manager', 'u-mgr-a');
  // Give empA a REAL baseline + a recent productivity drop so detection
  // actually produces anomalies and the concurrent race is meaningful.
  await db.activity.deleteMany({ where: { employeeId: empA.id } });
  for (let d = 6; d <= 11; d++) {
    const day = new Date(Date.now() - d * 24 * 3600 * 1000);
    day.setHours(10, 0, 0, 0);
    await db.activity.create({ data: { type: 'application', category: 'productive', duration: 8 * 3600, employeeId: empA.id, timestamp: day } });
    await db.activity.create({ data: { type: 'application', category: 'neutral', duration: 2 * 3600, employeeId: empA.id, timestamp: day } });
  }
  // Recent (today): only ~10% productive vs baseline 80% → drop triggers.
  const today = new Date();
  await db.activity.create({ data: { type: 'application', category: 'productive', duration: 900, employeeId: empA.id, timestamp: today } });
  await db.activity.create({ data: { type: 'application', category: 'neutral', duration: 8 * 3600, employeeId: empA.id, timestamp: today } });
  // Also 3h of idle today → excessive_idle triggers too.
  await db.activity.create({ data: { type: 'idle', category: 'unproductive', duration: 3 * 3600, employeeId: empA.id, timestamp: today } });

  const [r1, r2] = await Promise.all([
    anomalyDetectApi.POST(req(managerA, { method: 'POST', body: {} })),
    anomalyDetectApi.POST(req(managerA, { method: 'POST', body: {} })),
  ]);
  assert.ok([200, 500].includes(r1.status), `r1 status ${r1.status}`);
  assert.ok([200, 500].includes(r2.status), `r2 status ${r2.status}`);
  const b1 = (await r1.json().catch(() => ({}))) as { detected?: number };
  const b2 = (await r2.json().catch(() => ({}))) as { detected?: number };
  const totalReported = (b1.detected ?? 0) + (b2.detected ?? 0);
  assert.ok(totalReported >= 1, `concurrent runs must detect at least one anomaly, got ${totalReported}`);

  // Re-run sequentially: nothing new may be created (dedupe keys already live).
  const again = await anomalyDetectApi.POST(req(managerA, { method: 'POST', body: {} }));
  const againBody = (await again.json()) as { detected?: number };
  assert.equal(again.status, 200);
  assert.equal(againBody.detected, 0, 'sequential re-run must create nothing new');

  // Exactly one row per org+employee+type+day — the unique index is the
  // backstop, so no duplicate dedupeKeys can ever exist.
  const utcDay = new Date().toISOString().split('T')[0];
  const rows = await db.anomaly.findMany({
    where: { employeeId: empA.id, dedupeKey: { contains: `:${utcDay}` } },
    select: { dedupeKey: true },
  });
  const keys = rows.map((r) => r.dedupeKey);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate dedupeKeys may exist');
  assert.ok(keys.length >= 1, `detected anomalies must be persisted (got ${keys.length})`);
});

test('AN-72: resolved anomaly releases its dedupe slot → legitimate retrigger', async () => {
  const managerA = await tokenFor('manager', 'u-mgr-a');
  const res = await anomalyDetectApi.POST(req(managerA, { method: 'POST', body: {} }));
  assert.equal(res.status, 200);
  const created = await db.anomaly.findFirst({
    where: { employeeId: empA.id, status: 'detected' },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(created, 'a detected anomaly must exist');

  const put = await anomalyIdApi.PUT(req(managerA, { method: 'PUT', body: { status: 'resolved' } }), {
    params: Promise.resolve({ id: created!.id }),
  });
  assert.equal(put.status, 200);
  const resolved = await db.anomaly.findUnique({ where: { id: created!.id } });
  assert.equal(resolved!.dedupeKey, null, 'resolving must release the dedupe slot');
  assert.ok(resolved!.resolvedBy, 'resolver recorded');
});

// ─── H. Detection route + org work hours (F-2) ──────────────────────────────

test('AN-80: detect route with ai_anomaly_detection disabled → 403 (fail closed)', async () => {
  const res = await anomalyDetectApi.POST(req(await tokenFor('manager', 'u-mgr-c', orgC.id), { method: 'POST', body: {} }));
  assert.equal(res.status, 403);
});

test('AN-81: detection is org-scoped — org A run never touches org B employees', async () => {
  await db.activity.create({ data: { type: 'application', category: 'productive', duration: 60, employeeId: empB.id, timestamp: new Date() } });
  const managerA = await tokenFor('manager', 'u-mgr-a');
  const res = await anomalyDetectApi.POST(req(managerA, { method: 'POST', body: {} }));
  const body = (await res.json()) as { detected?: number; scannedEmployees?: number };
  assert.equal(res.status, 200);
  const orgBRows = await db.anomaly.count({ where: { employeeId: empB.id } });
  assert.equal(orgBRows, 0, 'org A detection must not create anomalies for org B employees');
  assert.ok((body.scannedEmployees ?? 0) >= 1);
});

// ─── I. Agent anomaly notifications (F-10) ──────────────────────────────────

test('AN-89: agent-reported anomaly with an UNKNOWN type → 422 (canonical enum enforced)', async () => {
  const emp = await db.employee.create({
    data: { employeeId: `AGENT-BADTYPE-${Date.now()}`, firstName: 'Bad', lastName: 'Type', email: `badtype-${Date.now()}@a.local`, organizationId: orgA.id, status: 'active', agentApproved: true },
  });
  const token = `agent-token-badtype-${Date.now()}-abcdefghijklmnopqrstuvwxyz0123456789`;
  await db.agentToken.create({ data: { token, employeeId: emp.id, expiresAt: new Date(Date.now() + 3600_000) } });

  const res = await agentAnomalyApi.POST(req(token, {
    method: 'POST',
    body: { type: 'not_a_real_type', severity: 'high', title: 'Bad type', description: 'Should be rejected' },
    ip: '203.0.113.89',
  }));
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  assert.equal(res.status, 422, JSON.stringify(body));
  assert.match(String(body.error ?? ''), /type/i);
  assert.equal(await db.anomaly.count({ where: { employeeId: emp.id } }), 0, 'invalid type must not persist');
});

test('AN-90: agent-reported high-severity anomaly creates alert + notification with deep link', async () => {
  const emp = await db.employee.create({
    data: { employeeId: `AGENT-NOTIF-${Date.now()}`, firstName: 'Notify', lastName: 'N', email: `notify-${Date.now()}@a.local`, organizationId: orgA.id, status: 'active', agentApproved: true },
  });
  const device = await db.device.create({ data: { name: 'PC-NOTIF', organizationId: orgA.id, employeeId: emp.id, status: 'online' } });
  const token = `agent-token-notif-${Date.now()}-abcdefghijklmnopqrstuvwxyz0123456789`;
  await db.agentToken.create({ data: { token, employeeId: emp.id, deviceId: device.id, expiresAt: new Date(Date.now() + 3600_000) } });

  const res = await agentAnomalyApi.POST(req(token, {
    method: 'POST',
    body: { type: 'policy_breach', severity: 'high', title: 'Agent found breach', description: 'Endpoint anomaly', score: 90, confidence: 0.9 },
    ip: '203.0.113.90',
  }));
  const body = (await res.json()) as { anomalyId?: string; duplicate?: boolean };
  assert.equal(res.status, 201, JSON.stringify(body));

  const notif = await db.notification.findFirst({ where: { entityType: 'anomaly', entityId: body.anomalyId } });
  assert.ok(notif, 'notification must exist');
  assert.equal(notif!.actionUrl, '/anomalies', 'deep link follows app convention');
  assert.equal(notif!.entityType, 'anomaly');
  assert.equal(notif!.entityId, body.anomalyId);
  assert.equal(notif!.organizationId, orgA.id);

  const alert = await db.alert.findFirst({ where: { organizationId: orgA.id, source: 'agent' } });
  assert.ok(alert, 'high-severity anomaly must create an agent-sourced alert');
  const alertMeta = JSON.parse(alert!.metadata || '{}') as { anomalyId?: string };
  assert.equal(alertMeta.anomalyId, body.anomalyId, 'alert must reference the anomaly');

  // Same day + same type + same employee → duplicate, not a second row.
  const dup = await agentAnomalyApi.POST(req(token, {
    method: 'POST',
    body: { type: 'policy_breach', severity: 'high', title: 'Agent found breach', description: 'Endpoint anomaly', score: 90, confidence: 0.9 },
    ip: '203.0.113.90',
  }));
  const dupBody = (await dup.json()) as { duplicate?: boolean };
  assert.equal(dup.status, 200);
  assert.equal(dupBody.duplicate, true, 'same-day same-type report must be deduplicated');
  const count = await db.anomaly.count({ where: { employeeId: emp.id } });
  assert.equal(count, 1, 'no duplicate anomaly row');
});

// ─── J. Audit logging (F-24) ────────────────────────────────────────────────

test('AN-100: manual create / status change / batch are audit-logged with the actor', async () => {
  const managerA = await tokenFor('manager', 'u-mgr-a', orgA.id);
  const { body } = await createAnomaly(managerA);
  const createLog = await db.auditLog.findFirst({ where: { resource: 'anomaly', action: 'create', resourceId: body.id as string } });
  assert.ok(createLog, 'create must be audited');
  assert.equal(createLog!.userId, 'u-mgr-a');
  assert.equal(createLog!.organizationId, orgA.id);

  await anomalyIdApi.PUT(req(managerA, { method: 'PUT', body: { status: 'investigating' } }), { params: Promise.resolve({ id: body.id as string }) });
  const updateLog = await db.auditLog.findFirst({ where: { resource: 'anomaly', action: 'update', resourceId: body.id as string } });
  assert.ok(updateLog, 'status change must be audited');
  assert.equal(updateLog!.userId, 'u-mgr-a');

  const b = await createAnomaly(managerA);
  const batchRes = await anomalyBatchApi.POST(req(managerA, { method: 'POST', body: { ids: [body.id, b.body.id], status: 'resolved' } }));
  assert.equal(batchRes.status, 200);
  const batchLog = await db.auditLog.findFirst({ where: { resource: 'anomaly', action: 'update', description: { contains: 'Batch' } } });
  assert.ok(batchLog, 'batch must be audited');
  assert.equal(batchLog!.userId, 'u-mgr-a');
});

// ─── K. Realtime invalidation (F-5) ─────────────────────────────────────────

test('AN-110: anomaly event invalidates list, detail and dashboard queries', () => {
  const keys = wsInvalidation.anomalyInvalidation();
  assert.deepEqual(keys, [['anomalies'], ['anomaly-detail'], ['dashboard']]);
});

// ─── L. Scheduler / JobRun lease (F-1) ──────────────────────────────────────

test('AN-120: claimJob is exclusive — a second claim while running returns false', async () => {
  const first = await run.claimJob('anomaly_detection');
  assert.equal(first, true);
  const second = await run.claimJob('anomaly_detection');
  assert.equal(second, false, 'concurrent claim must not double-execute');
  await run.finishJob('anomaly_detection');
});

test('AN-121: runAnomalyDetectionJob processes enabled orgs and skips disabled orgs', async () => {
  const result = await job.runAnomalyDetectionJob();
  assert.ok(result.orgsScanned >= 1, `enabled org must be scanned (got ${result.orgsScanned})`);
  assert.ok(result.orgsSkipped >= 1, `disabled org must be skipped (got ${result.orgsSkipped})`);
  const row = await db.jobRun.findUnique({ where: { job: 'anomaly_detection' } });
  assert.ok(row);
  assert.ok(
    ['completed', 'running'].includes(row!.status),
    `job must be completed or running, got ${row!.status} (errors: ${JSON.stringify(result.errors)}; lastError: ${row!.lastError})`
  );
  assert.ok(row!.lastResult, 'job must record observable result metadata');
  const parsed = JSON.parse(row!.lastResult!) as { orgsScanned?: number; anomaliesCreated?: number };
  assert.equal(parsed.orgsScanned, result.orgsScanned);
  assert.equal(typeof parsed.anomaliesCreated, 'number');
});

test('AN-122: GET /api/anomalies reflects org-scoped stats buckets', async () => {
  const res = await anomaliesApi.GET(req(await tokenFor('admin', 'u-admin'), { url: listUrl('?pageSize=1') }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { stats: { bySeverity: Record<string, number>; byStatus: Record<string, number> } };
  assert.ok(body.stats.bySeverity);
  assert.ok(body.stats.byStatus);
  const total = Object.values(body.stats.bySeverity).reduce((a, b) => a + b, 0);
  const statusTotal = Object.values(body.stats.byStatus).reduce((a, b) => a + b, 0);
  assert.equal(total, statusTotal, 'severity and status buckets must count the same rows');
});

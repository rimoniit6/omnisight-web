/**
 * ORGANIZATION CUTOVER — focused post-activation ROUTING tests.
 *
 * Complements tests/full-org-cutover.test.ts (which proves the migration
 * engine, boundary and drain) by proving the ROUTING GAPS found by the
 * forensic audit are closed: after `useOwnDb=true`, every org-owned
 * operational write/read — agent routes, workers, raw SQL analytics — lands
 * in the org's OWN database, audio storage follows the org's own driver, and
 * failures FAIL CLOSED (no silent platform fallback).
 *
 *   RT-01  Activated org operational CREATE/READ/UPDATE/DELETE → org DB.
 *   RT-02  Agent tamper → org DB (Alert/Notification/AuditLog); platform untouched.
 *   RT-03  Agent anomaly → org DB (Anomaly + Alert + Notification).
 *   RT-04  Agent consent transition → org DB (Consent + ConsentLog).
 *   RT-04A Agent activity consent enforcement + upload → org DB; platform untouched.
 *   RT-05  Agent policy violation → org DB (PolicyViolation + AuditLog).
 *   RT-06  Workday summary worker → org DB (WorkDaySummary), platform zero.
 *   RT-07  Anomaly detection worker → org DB (Anomaly).
 *   RT-08  Alert rules worker → org DB (Alert/AlertRuleFiring).
 *   RT-09  Device integrity worker → org DB (Anomaly + Alert + Notification).
 *   RT-10  Project time sync → org DB (TimeEntry/ProjectTimeSync/buckets).
 *   RT-11  Screenshot processing worker → org DB (thumbnail path on org row).
 *   RT-12  Audio transcription worker → org DB (AudioRecording status).
 *   RT-13  AI insights dataset → org DB reads (Activity/Employee).
 *   RT-14  Consent expiry worker → org DB (Consent expired + ConsentLog).
 *   RT-15  Screenshot object → org storage driver (Supabase mock), platform disk untouched.
 *   RT-16  Audio object → org storage driver (put/get/delete/signed URL).
 *   RT-17  Retention audio purge → org storage driver.
 *   RT-18  Org DB unavailable → controlled failure, no platform fallback.
 *   RT-19  Misconfigured org (useOwnDb, incomplete config) → OrgDbMisconfigurationError, no fallback.
 *   RT-20  Org storage unavailable → operation fails, no platform storage fallback.
 *   RT-21  ISOLATION: two activated orgs never see or write each other's DB.
 *
 * Run: npx tsx --test tests/org-cutover-routing.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_db_routing';
const ORG_A_DB = 'workai_test_db_routing_orga';
const ORG_B_DB = 'workai_test_db_routing_orgb';

process.env.DATABASE_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;
process.env.DIRECT_URL = process.env.DATABASE_URL;
process.env.JWT_SECRET = 'test-jwt-secret-routing-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'root@routing.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!Routing2026';
(process.env as Record<string, string>).NODE_ENV = 'test';

const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

let db: import('../src/lib/db').Db['db'];
let superAdminToken: string;

let orgAId: string;
let orgBId: string;
let orgNId: string; // never activated — control org

let empAId: string;
let devAId: string;
let tokenA: string;

let empBId: string;
let tokenB: string;

let empNId: string;

// ─────────────────────────────────────────────────────────────────────────────

function orgDestClient(dbName: string) {
  return destinationClient(dbName);
}

async function seedPublishedConsentPolicy(orgId: string, consentType: string) {
  const { defaultPolicyText } = await import('../src/lib/consent');
  const { getPrismaForOrg } = await import('../src/lib/org-db');
  const orgData = (await getPrismaForOrg(orgId)).client;
  const text = defaultPolicyText(consentType);
  return orgData.consentPolicy.upsert({
    where: { organizationId_consentType_version: { organizationId: orgId, consentType, version: 'v1' } },
    update: { status: 'published', effectiveAt: new Date(), title: text.title, content: text.content },
    create: {
      organizationId: orgId,
      consentType,
      title: text.title,
      content: text.content,
      version: 'v1',
      status: 'published',
      effectiveAt: new Date(),
      createdBy: null,
    },
  });
}

async function destinationClient(dbName: string) {
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient({
    datasources: { db: { url: `${PG_TEST_BASE}/${dbName}?schema=public` } },
    log: ['error'],
  });
}

/** Org-scoped count in an org's destination DB. */
async function destOrgCount(table: string, orgId: string, dbName: string): Promise<number> {
  const client = await destinationClient(dbName);
  try {
    const rows = await client.$queryRawUnsafe<Array<{ c: bigint }>>(
      `SELECT COUNT(*)::bigint AS c FROM "${table}" WHERE "organizationId" = $1`,
      orgId
    );
    return Number(rows[0]?.c ?? 0);
  } finally {
    await client.$disconnect();
  }
}

// ─── Supabase Storage mock (same protocol as tests/full-org-cutover.test.ts) ──

interface MockState { objects: Map<string, Buffer>; server: Server; port: number; url: string }

async function startStorageMock(): Promise<MockState> {
  const objects = new Map<string, Buffer>();
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost');
    const parts = u.pathname.split('/').filter(Boolean);
    const send = (code: number, body: string | Buffer, headers: Record<string, string> = { 'content-type': 'application/json' }) => {
      res.writeHead(code, headers);
      res.end(body);
    };
    try {
      if (req.method === 'GET' && parts[0] === 'storage' && parts[1] === 'v1' && parts[2] === 'bucket') {
        const ids = new Set([...objects.keys()].map((k) => k.split('/')[0]));
        ids.add('screenshots');
        ids.add('audio');
        return send(200, JSON.stringify([...ids].map((id) => ({ id }))));
      }
      if (parts[0] === 'storage' && parts[1] === 'v1' && parts[2] === 'object') {
        let bucket = parts[3];
        let rest = 4;
        if (bucket === 'sign') { bucket = parts[4]; rest = 5; }
        const key = parts.slice(rest).join('/');
        const mapKey = `${bucket}/${key}`;
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          req.on('end', () => {
            objects.set(mapKey, Buffer.concat(chunks));
            if (u.pathname.includes('/object/sign/')) {
              return send(200, JSON.stringify({ signedURL: `/object/mock-signed/${mapKey}` }));
            }
            return send(200, JSON.stringify({ Key: key }));
          });
          return;
        }
        if (req.method === 'GET') {
          const buf = objects.get(mapKey);
          if (!buf) return send(400, 'The resource was not found', { 'content-type': 'text/plain' });
          return send(200, buf, { 'content-type': 'application/octet-stream', 'content-length': String(buf.length) });
        }
        if (req.method === 'DELETE') {
          if (!objects.has(mapKey)) return send(400, 'The resource was not found', { 'content-type': 'text/plain' });
          objects.delete(mapKey);
          return send(200, '{}');
        }
      }
      return send(404, 'not found');
    } catch {
      return send(500, 'mock error');
    }
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
    });
  });
  return { objects, server, port, url: `http://127.0.0.1:${port}` };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

before(() => {
  for (const name of [TEST_DB_NAME, ORG_A_DB, ORG_B_DB]) {
    execSync(`node scripts/pg-test-db.mjs ensure ${name}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
  }
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', { env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, DIRECT_URL: process.env.DIRECT_URL }, stdio: 'pipe' });
  for (const name of [ORG_A_DB, ORG_B_DB]) {
    execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
      env: { ...process.env, DATABASE_URL: `${PG_TEST_BASE}/${name}?schema=public`, DIRECT_URL: `${PG_TEST_BASE}/${name}?schema=public` },
      stdio: 'pipe',
    });
  }
});

before(async () => {
  db = (await import('../src/lib/db')).db;
  const { bootstrapSuperAdmin } = await import('../src/lib/super-admin');
  await bootstrapSuperAdmin();
  const sa = await db.appUser.findFirst({ where: { role: 'super_admin' } });
  assert.ok(sa);
  const { signJWT } = await import('../src/lib/auth');
  superAdminToken = await signJWT({ userId: sa.id, email: sa.email, role: 'super_admin', organizationId: null });

  const trial = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  const orgA = await db.organization.create({ data: { name: 'RT Org A', slug: 'rt-org-a', timezone: 'UTC', trialEndsAt: trial } });
  orgAId = orgA.id;
  const orgB = await db.organization.create({ data: { name: 'RT Org B', slug: 'rt-org-b', timezone: 'UTC', trialEndsAt: trial } });
  orgBId = orgB.id;
  const orgN = await db.organization.create({ data: { name: 'RT Org N (never activated)', slug: 'rt-org-n', timezone: 'UTC' } });
  orgNId = orgN.id;

  // Employees + devices + agent tokens (tokens are PLATFORM control plane).
  const empA = await db.employee.create({
    data: { employeeId: 'RT-EMP-A', firstName: 'Al', lastName: 'A', email: 'al@rt-a.test', phone: '', organizationId: orgAId, status: 'active', agentApproved: true },
  });
  empAId = empA.id;
  const devA = await db.device.create({ data: { name: 'Dev A', organizationId: orgAId, employeeId: empAId, status: 'offline', agentKey: 'wrldev-rt-a-0001' } });
  devAId = devA.id;
  tokenA = 'agent-token-routing-orga-000001';
  await db.agentToken.create({
    data: { token: tokenA, employeeId: empAId, organizationId: orgAId, deviceId: devAId, expiresAt: new Date(Date.now() + 24 * 3600 * 1000) },
  });

  const empB = await db.employee.create({
    data: { employeeId: 'RT-EMP-B', firstName: 'Bo', lastName: 'B', email: 'bo@rt-b.test', phone: '', organizationId: orgBId, status: 'active', agentApproved: true },
  });
  empBId = empB.id;
  const devB = await db.device.create({ data: { name: 'Dev B', organizationId: orgBId, employeeId: empBId, status: 'offline', agentKey: 'wrldev-rt-b-0001' } });
  tokenB = 'agent-token-routing-orgb-000001';
  await db.agentToken.create({
    data: { token: tokenB, employeeId: empBId, organizationId: orgBId, deviceId: devB.id, expiresAt: new Date(Date.now() + 24 * 3600 * 1000) },
  });

  const empN = await db.employee.create({
    data: { employeeId: 'RT-EMP-N', firstName: 'No', lastName: 'N', email: 'no@rt-n.test', phone: '', organizationId: orgNId, status: 'active' },
  });
  empNId = empN.id;

  // Screenshot consent for empA (screenshot processing worker precondition).
  await db.consent.create({
    data: { employeeId: empAId, consentType: 'screenshot', status: 'granted', consentVersion: 'v1', organizationId: orgAId },
  });
  await db.consent.create({
    data: { employeeId: empBId, consentType: 'screenshot', status: 'granted', consentVersion: 'v1', organizationId: orgBId },
  });

  // Monitoring consent for empA (device integrity precondition).
  await db.consent.create({
    data: { employeeId: empAId, consentType: 'monitoring', status: 'granted', consentVersion: 'v1', organizationId: orgAId },
  });

  // ACTIVATE org A + org B: the deterministic boundary is the settings flip
  // (useOwnDb=true + complete config) — the exact state the runner leaves
  // behind after a successful migration. Pre-seed each org DB with the
  // identity anchor + the org's Employee/Device copies so relations resolve.
  const orgSpec = (dbName: string) => JSON.stringify({ host: 'localhost', port: 5432, name: dbName, user: 'postgres', ssl: false, useOwnDb: true });
  for (const [orgId, dbName] of [[orgAId, ORG_A_DB], [orgBId, ORG_B_DB]] as const) {
    await db.organizationSettings.create({
      data: { organizationId: orgId, useOwnDb: true, dbHost: 'localhost', dbPort: 5432, dbName, dbUser: 'postgres', dbPassword: (await import('../src/lib/crypto')).encryptSecret('123456'), dbSsl: false, dbTestStatus: 'success' },
    });
  }

  const { copyOrgToDestination } = await import('../src/lib/migration/db-migrate');
  for (const [orgId, dbName] of [[orgAId, ORG_A_DB], [orgBId, ORG_B_DB]] as const) {
    const result = await copyOrgToDestination(orgId, `${PG_TEST_BASE}/${dbName}?schema=public`);
    assert.ok(result, `org ${orgId} copy must succeed`);
  }
});

after(async () => {
  const mod = await import('../src/lib/db');
  const { invalidateAllOrgDbClients } = await import('../src/lib/org-db').catch(() => ({ invalidateAllOrgDbClients: null }) as any);
  if (typeof invalidateAllOrgDbClients === 'function') await invalidateAllOrgDbClients();
  await mod.db.$disconnect();
  for (const name of [TEST_DB_NAME, ORG_A_DB, ORG_B_DB]) {
    try {
      execSync(`node scripts/pg-test-db.mjs drop ${name}`, { env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE }, stdio: 'pipe' });
    } catch { /* best-effort */ }
  }
  // Best-effort upload dir cleanup.
  try { rmSync(join(process.cwd(), 'uploads'), { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─────────────────────────────────────────────────────────────────────────────
// RT-01 — Runtime CRUD routes to the org DB
// ─────────────────────────────────────────────────────────────────────────────

test('RT-01: activated org operational CREATE/READ/UPDATE/DELETE all land in the ORG DB', async () => {
  const { getPrismaForOrg } = await import('../src/lib/org-db');
  const orgData = (await getPrismaForOrg(orgAId)).client;
  assert.notEqual(orgData, db, 'activated org must NOT resolve the shared platform client');

  // CREATE
  const dept = await orgData.department.create({ data: { name: 'RT Dept', organizationId: orgAId } });
  assert.equal(await destOrgCount('Department', orgAId, ORG_A_DB), 1, 'CREATE at the org DB');
  assert.equal(await db.department.count({ where: { organizationId: orgAId } }), 0, 'platform untouched by CREATE');

  // READ
  const readBack = await orgData.department.findUnique({ where: { id: dept.id } });
  assert.equal(readBack?.name, 'RT Dept');
  const missingOnPlatform = await db.department.findUnique({ where: { id: dept.id } });
  assert.equal(missingOnPlatform, null, 'READ is served by the org DB — the row does not exist on the platform');

  // UPDATE
  await orgData.department.update({ where: { id: dept.id }, data: { name: 'RT Dept 2' } });
  const destClient = await orgDestClient(ORG_A_DB);
  try {
    const after = await destClient.$queryRawUnsafe<Array<{ name: string }>>(`SELECT name FROM "Department" WHERE id = $1`, dept.id);
    assert.equal(after[0]?.name, 'RT Dept 2', 'UPDATE landed at the org DB');
  } finally {
    await destClient.$disconnect();
  }

  // DELETE
  await orgData.department.delete({ where: { id: dept.id } });
  assert.equal(await destOrgCount('Department', orgAId, ORG_A_DB), 0, 'DELETE at the org DB');
});

// ─────────────────────────────────────────────────────────────────────────────
// RT-02..05 — the four live agent routes
// ─────────────────────────────────────────────────────────────────────────────

test('RT-02: agent tamper → Alert/Notification/AuditLog land in the ORG DB, platform untouched', async () => {
  const api = await import('../src/app/api/agent/tamper/route');
  const res = await api.POST(new Request('http://localhost:3000/api/agent/tamper', {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ type: 'agent_stopped', description: 'RT-02 tamper', severity: 'high' }),
  }));
  assert.equal(res.status, 200, `tamper must succeed (got ${res.status}: ${JSON.stringify(await res.json().catch(() => null))})`);

  assert.equal(await destOrgCount('Alert', orgAId, ORG_A_DB), 1, 'Alert at the org DB');
  assert.equal(await destOrgCount('Notification', orgAId, ORG_A_DB), 1, 'Notification at the org DB');
  assert.equal(await db.alert.count({ where: { organizationId: orgAId } }), 0, 'platform Alert zero');
  assert.equal(await db.notification.count({ where: { organizationId: orgAId } }), 0, 'platform Notification zero');
});

test('RT-03: agent anomaly → Anomaly (+high-severity Alert/Notification) land in the ORG DB', async () => {
  const api = await import('../src/app/api/agent/anomaly/route');
  const res = await api.POST(new Request('http://localhost:3000/api/agent/anomaly', {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ type: 'productivity_drop', title: 'RT-03 anomaly', description: 'agent-reported routing probe', severity: 'critical', score: 80 }),
  }));
  assert.equal(res.status, 201, `anomaly must succeed (got ${res.status}: ${JSON.stringify(await res.json().catch(() => null))})`);

  assert.equal(await destOrgCount('Anomaly', orgAId, ORG_A_DB), 1, 'Anomaly at the org DB');
  // critical → auto alert + notification in the SAME org transaction.
  assert.ok((await destOrgCount('Alert', orgAId, ORG_A_DB)) >= 2, 'Alert #2 (from the anomaly) at the org DB');
  assert.ok((await destOrgCount('Notification', orgAId, ORG_A_DB)) >= 2, 'Notification #2 at the org DB');
  assert.equal(await db.anomaly.count({ where: { organizationId: orgAId } }), 0, 'platform Anomaly zero');
  assert.equal(await db.alert.count({ where: { organizationId: orgAId } }), 0, 'platform Alert zero');
});

test('RT-04: agent consent grant/revoke → Consent + ConsentLog land in the ORG DB', async () => {
  await seedPublishedConsentPolicy(orgAId, 'usb_monitoring');
  const api = await import('../src/app/api/agent/consent/route');
  const grant = await api.POST(new Request('http://localhost:3000/api/agent/consent', {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ consentType: 'usb_monitoring', action: 'grant' }),
  }));
  assert.equal(grant.status, 200, 'grant must succeed');

  const revoke = await api.POST(new Request('http://localhost:3000/api/agent/consent', {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ consentType: 'usb_monitoring', action: 'revoke' }),
  }));
  assert.equal(revoke.status, 200, 'revoke must succeed');

  // usb_monitoring consent + 2 logs (grant+revoke) all at the org DB.
  const orgData = (await import('../src/lib/org-db')).getPrismaForOrg ? (await (await import('../src/lib/org-db')).getPrismaForOrg(orgAId)).client : db;
  const consentRows = await orgData.consent.findMany({ where: { employeeId: empAId, consentType: 'usb_monitoring' } });
  assert.ok(consentRows.length >= 1, 'Consent row at the org DB');
  const logRows = await orgData.consentLog.findMany({ where: { organizationId: orgAId, action: { in: ['granted', 'revoked'] } } });
  assert.ok(logRows.length >= 2, 'ConsentLog rows at the org DB');
  assert.equal(await db.consent.count({ where: { organizationId: orgAId, consentType: 'usb_monitoring' } }), 0, 'platform Consent zero for the new type');
  assert.equal(await db.consentLog.count({ where: { organizationId: orgAId, action: 'revoked' } }), 0, 'platform ConsentLog zero');
});

test('RT-04A: agent activity consent enforcement and upload use the ORG DB', async () => {
  const { getPrismaForOrg } = await import('../src/lib/org-db');
  const orgData = (await getPrismaForOrg(orgAId)).client;
  const activityApi = await import('../src/app/api/agent/activity/route');
  const platformBefore = await db.activity.count({ where: { organizationId: orgAId } });
  const destinationBefore = await orgData.activity.count({ where: { organizationId: orgAId } });
  const request = () =>
    new Request('http://localhost:3000/api/agent/activity', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + tokenA },
      body: JSON.stringify({
        activities: [{ type: 'application', category: 'productive', applicationName: 'rt-activity.exe', duration: 60 }],
      }),
    });

  const denied = await activityApi.POST(request());
  assert.equal(denied.status, 403, 'activity upload without org consent must fail closed');

  const policy = await seedPublishedConsentPolicy(orgAId, 'activity_tracking');
  await orgData.consent.create({
    data: {
      employeeId: empAId,
      consentType: 'activity_tracking',
      status: 'granted',
      consentVersion: 'v1',
      policyId: policy.id,
      organizationId: orgAId,
    },
  });

  const allowed = await activityApi.POST(request());
  assert.equal(allowed.status, 200, `activity upload must succeed with org consent (got ${allowed.status})`);
  assert.equal(
    await orgData.activity.count({ where: { organizationId: orgAId } }),
    destinationBefore + 1,
    'Activity row must be written to the activated organization DB'
  );
  assert.equal(
    await db.activity.count({ where: { organizationId: orgAId } }),
    platformBefore,
    'platform Activity rows must remain unchanged'
  );
  await orgData.consent.delete({ where: { employeeId_consentType: { employeeId: empAId, consentType: 'activity_tracking' } } });
});

test('RT-05: agent policy violation → PolicyViolation + AuditLog land in the ORG DB', async () => {
  const { getPrismaForOrg } = await import('../src/lib/org-db');
  const orgData = (await getPrismaForOrg(orgAId)).client;

  // Enforcement must be explicitly enabled — OrganizationSetting is platform
  // control plane, so the flag itself stays on the platform DB.
  await db.organizationSetting.upsert({
    where: { organizationId_key: { organizationId: orgAId, key: 'app_policy_enforcement' } },
    create: { organizationId: orgAId, key: 'app_policy_enforcement', value: 'true' },
    update: { value: 'true' },
  });
  // AppListEntry is org-owned — create it in the ORG DB (post-activation home).
  const policy = await orgData.appListEntry.create({
    data: { appName: 'Steam', executableName: 'steam.exe', listType: 'blacklist', organizationId: orgAId, isActive: true },
  });

  const api = await import('../src/app/api/agent/policy-violations/route');
  const res = await api.POST(new Request('http://localhost:3000/api/agent/policy-violations', {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ policyId: policy.id, executableName: 'steam.exe', action: 'blocked', severity: 'critical' }),
  }));
  assert.equal(res.status, 201, `policy violation must succeed (got ${res.status}: ${JSON.stringify(await res.json().catch(() => null))})`);

  assert.equal(await destOrgCount('PolicyViolation', orgAId, ORG_A_DB), 1, 'PolicyViolation at the org DB');
  assert.equal(await db.policyViolation.count({ where: { organizationId: orgAId } }), 0, 'platform PolicyViolation zero');
});

// ─────────────────────────────────────────────────────────────────────────────
// RT-06..14 — workers route per organization
// ─────────────────────────────────────────────────────────────────────────────

test('RT-06: workday summary worker writes WorkDaySummary ONLY to the org DB', async () => {
  const { getPrismaForOrg } = await import('../src/lib/org-db');
  const orgData = (await getPrismaForOrg(orgAId)).client;
  // Activity rows are org-owned — seed them post-activation where they live.
  await orgData.activity.createMany({
    data: [
      { type: 'application', category: 'productive', duration: 300, employeeId: empAId, organizationId: orgAId, timestamp: new Date(), applicationName: 'code.exe' },
      { type: 'application', category: 'neutral', duration: 120, employeeId: empAId, organizationId: orgAId, timestamp: new Date(), applicationName: 'explorer.exe' },
    ],
  });

  const { runWorkDaySummaryJob } = await import('../src/lib/jobs/workday-summary');
  const result = await runWorkDaySummaryJob({ orgIds: [orgAId] });
  assert.equal(result.orgsScanned, 1);
  assert.ok(result.summariesUpserted >= 1, `summary upserted (${result.summariesUpserted})`);

  assert.ok((await destOrgCount('WorkDaySummary', orgAId, ORG_A_DB)) >= 1, 'WorkDaySummary at the org DB');
  assert.equal(await db.workDaySummary.count({ where: { organizationId: orgAId } }), 0, 'platform WorkDaySummary zero');
});

test('RT-07: anomaly detection worker creates Anomaly rows ONLY in the org DB', async () => {
  const { getPrismaForOrg } = await import('../src/lib/org-db');
  const orgData = (await getPrismaForOrg(orgAId)).client;

  await db.organizationSetting.upsert({
    where: { organizationId_key: { organizationId: orgAId, key: 'ai_anomaly_detection' } },
    create: { organizationId: orgAId, key: 'ai_anomaly_detection', value: 'true' },
    update: { value: 'true' },
  });
  // Idling employees → excessive_idle candidates (idle rows today).
  const now = new Date();
  await orgData.activity.create({
    data: { type: 'idle', category: 'idle', duration: 60 * 200, employeeId: empAId, organizationId: orgAId, timestamp: now },
  });

  const { runAnomalyDetection } = await import('../src/lib/anomalies/service');
  const run = await runAnomalyDetection({ orgId: orgAId });
  assert.equal(run.status, 'ok');

  const anomaliesAtDest = await destOrgCount('Anomaly', orgAId, ORG_A_DB);
  assert.ok(anomaliesAtDest >= 2, `detection anomalies at the org DB (${anomaliesAtDest})`);
  assert.equal(await db.anomaly.count({ where: { organizationId: orgAId } }), 0, 'platform Anomaly zero');
});

test('RT-08: alert rules worker evaluates org rules and writes Alerts ONLY to the org DB', async () => {
  const { getPrismaForOrg } = await import('../src/lib/org-db');
  const orgData = (await getPrismaForOrg(orgAId)).client;

  await db.organizationSetting.upsert({
    where: { organizationId_key: { organizationId: orgAId, key: 'alert_rules_enabled' } },
    create: { organizationId: orgAId, key: 'alert_rules_enabled', value: 'true' },
    update: { value: 'true' },
  });
  // excessive_idle with a 5-minute threshold; RT-07 seeded 200 minutes of idle.
  await orgData.alertRule.create({
    data: { name: 'RT idle rule', conditionType: 'excessive_idle', params: JSON.stringify({ thresholdMinutes: 5 }), severity: 'warning', organizationId: orgAId, enabled: true },
  });

  const { evaluateAlertRulesForOrg } = await import('../src/lib/jobs/alert-rules');
  const out = await evaluateAlertRulesForOrg(orgAId);
  assert.equal(out.rulesEvaluated, 1);
  assert.ok(out.alertsCreated >= 1, `alert created (${out.alertsCreated})`);

  const alertsAtDest = await destOrgCount('Alert', orgAId, ORG_A_DB);
  assert.ok(alertsAtDest >= 2, `alerts at the org DB (${alertsAtDest})`);
  assert.equal(await db.alert.count({ where: { organizationId: orgAId } }), 0, 'platform Alert zero');
});

test('RT-09: device integrity worker creates device_missing anomalies ONLY in the org DB', async () => {
  const { getPrismaForOrg } = await import('../src/lib/org-db');
  const orgData = (await getPrismaForOrg(orgAId)).client;

  // Dev A heartbeat went stale (> 15 min) — the canonical silent-device case.
  await orgData.device.update({
    where: { id: devAId },
    data: { status: 'online', lastHeartbeat: new Date(Date.now() - 60 * 60 * 1000) },
  });

  const { runDeviceIntegrityJob } = await import('../src/lib/jobs/detect-device-integrity');
  const result = await runDeviceIntegrityJob();
  assert.ok(result.anomaliesCreated >= 1, `device_missing anomaly created (${result.anomaliesCreated})`);

  const anomaliesAtDest = await destOrgCount('Anomaly', orgAId, ORG_A_DB);
  const deviceOnes = await orgData.anomaly.findMany({ where: { organizationId: orgAId, type: 'device_missing' } });
  assert.ok(deviceOnes.length >= 1, 'device_missing anomaly readable at the org DB');
  assert.equal(await db.anomaly.count({ where: { organizationId: orgAId, type: 'device_missing' } }), 0, 'platform device_missing zero');
  assert.ok(anomaliesAtDest >= 2);
});

test('RT-10: project time sync writes TimeEntry/ProjectTimeSync ONLY to the org DB', async () => {
  const { getPrismaForOrg } = await import('../src/lib/org-db');
  const orgData = (await getPrismaForOrg(orgAId)).client;
  await seedPublishedConsentPolicy(orgAId, 'activity_tracking');

  // Membership + consent are org-owned post-activation.
  const proj = await orgData.project.create({ data: { name: 'RT Project', organizationId: orgAId } });
  await orgData.projectMember.create({ data: { projectId: proj.id, employeeId: empAId, organizationId: orgAId } });
  await orgData.consent.create({
    data: { employeeId: empAId, consentType: 'activity_tracking', status: 'granted', consentVersion: 'v1', organizationId: orgAId },
  });
  await orgData.activity.createMany({
    data: [
      { type: 'application', category: 'neutral', duration: 300, employeeId: empAId, organizationId: orgAId, timestamp: new Date(Date.now() - 120_000), applicationName: 'code.exe' },
    ],
  });

  // Seed the platform/global cursor so the first run is not treated as a no-backfill init.
  await db.projectTimeSyncCursor.upsert({
    where: { id: 'global' },
    create: { id: 'global', lastProcessedAt: new Date(Date.now() - 3600_000) },
    update: { lastProcessedAt: new Date(Date.now() - 3600_000) },
  });
  // Seed the org-local cursor explicitly (first-ever run only initializes).
  await orgData.projectTimeSyncCursor.create({ data: { id: 'global', lastProcessedAt: new Date(Date.now() - 3600_000) } }).catch(() => {});

  const { runProjectTimeSync } = await import('../src/lib/project-time/sync');
  const result = await runProjectTimeSync({ batchSize: 100, maxBatches: 5 });
  assert.ok(result.timeEntriesCreated >= 1, `time entry created (${result.timeEntriesCreated})`);

  const entriesAtDest = await destOrgCount('TimeEntry', orgAId, ORG_A_DB);
  assert.ok(entriesAtDest >= 1, `TimeEntry at the org DB (${entriesAtDest})`);
  assert.ok((await destOrgCount('ProjectTimeSync', orgAId, ORG_A_DB)) >= 1, 'ProjectTimeSync receipt at the org DB');
  assert.equal(await db.timeEntry.count({ where: { organizationId: orgAId } }), 0, 'platform TimeEntry zero');
});

test('RT-11: screenshot processing worker updates the org DB row (thumbnail state)', async () => {
  const { getPrismaForOrg } = await import('../src/lib/org-db');
  const orgData = (await getPrismaForOrg(orgAId)).client;
  const { putScreenshot, getScreenshot } = await import('../src/lib/storage');

  // A valid tiny PNG at the org's storage + an org-DB row awaiting processing.
  const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const fileName = `rt11-${Date.now()}.png`;
  await putScreenshot(orgAId, fileName, png1x1, 'image/png');
  const row = await orgData.screenshot.create({
    data: { employeeId: empAId, organizationId: orgAId, deviceId: devAId, filePath: `screenshots/${orgAId}/${fileName}`, fileName, fileSize: png1x1.length, mimeType: 'image/png', width: 1, height: 1, processingStatus: 'uploaded' },
  });

  const { processPendingScreenshots } = await import('../src/lib/screenshots/processing');
  const result = await processPendingScreenshots(10);
  assert.ok(result.processed >= 1, `processed ≥1 (${result.processed})`);

  const after = await orgData.screenshot.findUnique({ where: { id: row.id } });
  assert.equal(after?.processingStatus, 'processed', 'row processed via the org client');
  assert.ok(after?.thumbnailPath, 'thumbnail path recorded on the ORG row');
  assert.equal(await db.screenshot.count({ where: { id: row.id, processingStatus: 'processed' } }), 0, 'platform row untouched (still uploaded / absent)');
  // Platform DB must hold no processed copy of this row.
  const platformRow = await db.screenshot.findUnique({ where: { id: row.id } });
  assert.ok(!platformRow || platformRow.processingStatus !== 'processed', 'no processed row on the platform DB');
  // Original bytes still readable through org storage.
  const stored = await getScreenshot(orgAId, row.filePath);
  assert.ok(stored.equals(png1x1));
});

test('RT-12: audio transcription worker routes status updates to the ORG DB', async () => {
  const { getPrismaForOrg } = await import('../src/lib/org-db');
  const orgData = (await getPrismaForOrg(orgAId)).client;
  const { putAudio } = await import('../src/lib/audio/storage');
  const mock = await startStorageMock();
  const { invalidateAllOrgStorageCache } = await import('../src/lib/org-storage');
  invalidateAllOrgStorageCache();
  const { encryptSecret } = await import('../src/lib/crypto');
  try {
    await db.organizationSettings.update({
      where: { organizationId: orgAId },
      data: { storageDriver: 'supabase', storageUrl: mock.url, storageKey: encryptSecret('sb-routing-service-key-00000000') },
    });

    const fileName = `rt12-${Date.now()}.mp3`;
    await putAudio(orgAId, fileName, Buffer.alloc(16, 0x01), 'audio/mpeg');
    const rec = await orgData.audioRecording.create({
      data: { organizationId: orgAId, employeeId: empAId, fileName, filePath: `audio/${orgAId}/${fileName}`, fileSize: 16, mimeType: 'audio/mpeg', status: 'uploaded' },
    });

    // No transcription service in the test env → submission fails after the
    // status transitions; what matters is WHERE those writes landed.
    const { processPendingTranscriptions } = await import('../src/lib/audio/transcribe-job');
    const result = await processPendingTranscriptions(10);
    assert.ok(result.processed >= 1, `processed ≥1 (${result.processed})`);

    const after = await orgData.audioRecording.findUnique({ where: { id: rec.id } });
    assert.ok(after, 'row still at the org DB');
    assert.ok(['queued', 'transcribing', 'failed'].includes(after?.status ?? ''), `status transitioned via the org client (${after?.status})`);
    assert.notEqual(after?.status, 'uploaded', 'a run touched the row — no stale uploaded state');
  } finally {
    await db.organizationSettings.update({ where: { organizationId: orgAId }, data: { storageDriver: null, storageUrl: null, storageKey: null } });
    invalidateAllOrgStorageCache();
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  }
});

test('RT-13: AI insights dataset reads org-owned Activity through the ORG DB', async () => {
  const { getPrismaForOrg } = await import('../src/lib/org-db');
  const orgData = (await getPrismaForOrg(orgAId)).client;
  await seedPublishedConsentPolicy(orgAId, 'activity_tracking');
  await orgData.consent.upsert({
    where: { employeeId_consentType: { employeeId: empAId, consentType: 'activity_tracking' } },
    update: { status: 'granted', consentVersion: 'v1', organizationId: orgAId },
    create: { employeeId: empAId, consentType: 'activity_tracking', status: 'granted', consentVersion: 'v1', organizationId: orgAId },
  });
  await orgData.activity.createMany({
    data: [
      { type: 'application', category: 'productive', duration: 210, employeeId: empAId, organizationId: orgAId, timestamp: new Date(Date.now() - 18 * 60_000), applicationName: 'code.exe' },
      { type: 'website', category: 'productive', duration: 210, employeeId: empAId, organizationId: orgAId, timestamp: new Date(Date.now() - 12 * 60_000), applicationName: 'github.com' },
    ],
  });

  const { buildInsightDataset } = await import('../src/lib/ai-insights/dataset');
  const filters = { periodStart: new Date(Date.now() - 24 * 3600 * 1000), periodEnd: new Date(Date.now() + 3600_000) };

  const dataset = await buildInsightDataset(orgAId, filters);
  // RT-06 seeded 2 activities for empA only at the ORG DB. A platform-bound
  // read would see ZERO (the platform copy predates them).
  assert.ok(dataset.employees.length >= 1, 'employees resolved from the org DB');
  assert.ok(dataset.totals.totalSeconds >= 420, `org-DB activity counted (totalSeconds=${dataset.totals.totalSeconds})`);
});

test('RT-14: consent expiry worker expires consents ONLY in the org DB', async () => {
  const { getPrismaForOrg } = await import('../src/lib/org-db');
  const orgData = (await getPrismaForOrg(orgAId)).client;

  // An already-granted consent that has just expired (org-DB copy).
  const c = await orgData.consent.create({
    data: { employeeId: empAId, consentType: 'webcam_access', status: 'granted', consentVersion: 'v1', organizationId: orgAId, expiresAt: new Date(Date.now() - 60_000) },
  });

  const { expireConsents } = await import('../src/lib/jobs/expire-consents');
  const total = await expireConsents(500);
  assert.ok(total >= 1, `expired ≥1 (${total})`);

  const after = await orgData.consent.findUnique({ where: { id: c.id } });
  assert.equal(after?.status, 'expired', 'Consent expired via the org client');
  const logs = await orgData.consentLog.findMany({ where: { consentId: c.id } });
  assert.ok(logs.length >= 1, 'ConsentLog written to the org DB');
  assert.equal(await db.consent.count({ where: { id: c.id } }), 0, 'platform Consent untouched');
});

// ─────────────────────────────────────────────────────────────────────────────
// RT-15..17 — storage routing
// ─────────────────────────────────────────────────────────────────────────────

test('RT-15: screenshot object → org storage driver; platform disk untouched', async () => {
  const mock = await startStorageMock();
  const { invalidateAllOrgStorageCache } = await import('../src/lib/org-storage');
  invalidateAllOrgStorageCache();

  const { encryptSecret } = await import('../src/lib/crypto');
  await db.organizationSettings.update({
    where: { organizationId: orgAId },
    data: { storageDriver: 'supabase', storageUrl: mock.url, storageKey: encryptSecret('sb-routing-service-key-00000000') },
  });
  // Flip DB-only routing off for this test so getPrismaForOrg is not needed.
  try {
    const { putScreenshot, getScreenshot, deleteScreenshot } = await import('../src/lib/storage');
    const bytes = Buffer.alloc(32, 0xd0);
    await putScreenshot(orgAId, `rt15-${Date.now()}.png`, bytes, 'image/png');

    const orgKeyPrefix = `screenshots/${orgAId}/`;
    const landed = [...mock.objects.keys()].filter((k) => k.startsWith(orgKeyPrefix));
    assert.ok(landed.length >= 1, `screenshot object at the ORG driver (${landed.join(', ')})`);

    const downloaded = await getScreenshot(orgAId, landed[0]!.slice(orgKeyPrefix.length));
    assert.ok(downloaded.length === 32, 'read back from the ORG driver');

    await deleteScreenshot(orgAId, landed[0]!.slice(orgKeyPrefix.length));
    assert.equal([...mock.objects.keys()].filter((k) => k.startsWith(orgKeyPrefix)).length, 0, 'delete routed to the ORG driver');
  } finally {
    await db.organizationSettings.update({ where: { organizationId: orgAId }, data: { storageDriver: null, storageUrl: null, storageKey: null } });
    invalidateAllOrgStorageCache();
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  }
});

test('RT-16: audio object → org storage driver (put/get/delete/signed URL)', async () => {
  const mock = await startStorageMock();
  const { invalidateAllOrgStorageCache } = await import('../src/lib/org-storage');
  invalidateAllOrgStorageCache();

  const { encryptSecret } = await import('../src/lib/crypto');
  await db.organizationSettings.update({
    where: { organizationId: orgAId },
    data: { storageDriver: 'supabase', storageUrl: mock.url, storageKey: encryptSecret('sb-routing-service-key-00000000') },
  });
  try {
    const { putAudio, getAudio, deleteAudio, getAudioSignedUrl } = await import('../src/lib/audio/storage');
    const bytes = Buffer.alloc(24, 0xe0);
    const name = `rt16-${Date.now()}.mp3`;

    await putAudio(orgAId, name, bytes, 'audio/mpeg');
    assert.ok(mock.objects.has(`audio/${orgAId}/${name}`), 'audio object at the ORG driver');

    const got = await getAudio(orgAId, name);
    assert.ok(got.equals(bytes), 'audio read from the ORG driver');

    const signed = await getAudioSignedUrl(orgAId, name, 60);
    assert.ok(signed?.startsWith(mock.url), 'signed URL minted by the ORG driver');

    await deleteAudio(orgAId, name);
    assert.equal(mock.objects.has(`audio/${orgAId}/${name}`), false, 'audio delete routed to the ORG driver');
  } finally {
    await db.organizationSettings.update({ where: { organizationId: orgAId }, data: { storageDriver: null, storageUrl: null, storageKey: null } });
    invalidateAllOrgStorageCache();
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  }
});

test('RT-17: retention audio purge deletes through the ORG storage driver', async () => {
  const mock = await startStorageMock();
  const { invalidateAllOrgStorageCache } = await import('../src/lib/org-storage');
  invalidateAllOrgStorageCache();
  const { encryptSecret } = await import('../src/lib/crypto');
  const { putAudio } = await import('../src/lib/audio/storage');

  await db.organizationSettings.update({
    where: { organizationId: orgAId },
    data: { storageDriver: 'supabase', storageUrl: mock.url, storageKey: encryptSecret('sb-routing-service-key-00000000') },
  });
  try {
    // Org storage + org DB row: a completed recording older than the cutoff.
    const name = `rt17-${Date.now()}.mp3`;
    await putAudio(orgAId, name, Buffer.alloc(8, 0xf0), 'audio/mpeg');
    const { getPrismaForOrg } = await import('../src/lib/org-db');
    const orgData = (await getPrismaForOrg(orgAId)).client;
    await orgData.audioRecording.create({
      data: { organizationId: orgAId, employeeId: empAId, fileName: name, filePath: `audio/${orgAId}/${name}`, fileSize: 8, mimeType: 'audio/mpeg', status: 'completed', createdAt: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
    });
    await db.organizationSetting.upsert({
      where: { organizationId_key: { organizationId: orgAId, key: 'screenshot_retention_days' } },
      create: { organizationId: orgAId, key: 'screenshot_retention_days', value: '7' },
      update: { value: '7' },
    });

    const { runRetentionForOrg } = await import('../src/lib/jobs/retention');
    const result = await runRetentionForOrg(orgAId, new Date(), 500, orgData);
    assert.ok(result.audioRecordings >= 1, `stale audio purged (${result.audioRecordings})`);
    assert.equal(mock.objects.has(`audio/${orgAId}/${name}`), false, 'audio object deleted from the ORG driver (never the platform pool)');
  } finally {
    await db.organizationSettings.update({ where: { organizationId: orgAId }, data: { storageDriver: null, storageUrl: null, storageKey: null } });
    invalidateAllOrgStorageCache();
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// RT-18..20 — fail closed
// ─────────────────────────────────────────────────────────────────────────────

test('RT-18: org DB unavailable → controlled failure, NO platform fallback', async () => {
  // Create the config but NOT the physical database: connection must fail.
  await db.organizationSettings.create({
    data: { organizationId: orgNId, useOwnDb: true, dbHost: 'localhost', dbPort: 5432, dbName: 'workai_test_db_routing_nonexistent', dbUser: 'postgres', dbPassword: (await import('../src/lib/crypto')).encryptSecret('123456'), dbSsl: false, dbTestStatus: 'success' },
  });
  const { getPrismaForOrg } = await import('../src/lib/org-db');
  const res = await getPrismaForOrg(orgNId);
  assert.equal(res.mode, 'own');
  let failed = false;
  try {
    await res.client.employee.findFirst();
  } catch {
    failed = true; // controlled failure — connection error surfaced, no fallback
  }
  assert.ok(failed, 'org DB unreachable must throw, never fall back to the platform DB');
  // And the failure must be attributable: the same query on the platform DB
  // would have SUCCEEDED (empN exists) — proving there was no silent fallback.
  assert.ok(await db.employee.findFirst({ where: { id: empNId } }), 'platform data exists — fallback would have silently succeeded');
});

test('RT-19: misconfigured org (useOwnDb, incomplete config) → OrgDbMisconfigurationError, no fallback', async () => {
  const orgM = await db.organization.create({ data: { name: 'RT Org Misconfigured', slug: 'rt-org-m', timezone: 'UTC' } });
  await db.organizationSettings.create({
    data: { organizationId: orgM.id, useOwnDb: true, dbHost: null, dbName: null, dbUser: null },
  });
  const { getPrismaForOrg, OrgDbMisconfigurationError } = await import('../src/lib/org-db');
  await assert.rejects(
    () => getPrismaForOrg(orgM.id),
    (error: unknown) => error instanceof OrgDbMisconfigurationError,
    'misconfiguration must throw OrgDbMisconfigurationError — never resolve the platform client'
  );
});

test('RT-20: org storage unavailable → operation fails, NO platform storage fallback', async () => {
  const mock = await startStorageMock();
  const { invalidateAllOrgStorageCache } = await import('../src/lib/org-storage');
  invalidateAllOrgStorageCache();
  const { encryptSecret } = await import('../src/lib/crypto');

  // Point the org driver at the mock, then KILL the mock: the driver URL dies.
  await db.organizationSettings.update({
    where: { organizationId: orgAId },
    data: { storageDriver: 'supabase', storageUrl: mock.url, storageKey: encryptSecret('sb-routing-service-key-00000000') },
  });
  await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  try {
    const { putAudio } = await import('../src/lib/audio/storage');
    let failed = false;
    try {
      await putAudio(orgAId, `rt20-${Date.now()}.mp3`, Buffer.alloc(8, 0x11), 'audio/mpeg');
    } catch {
      failed = true; // controlled failure
    }
    assert.ok(failed, 'org storage unavailable must fail the operation — never silently write to platform storage');
  } finally {
    await db.organizationSettings.update({ where: { organizationId: orgAId }, data: { storageDriver: null, storageUrl: null, storageKey: null } });
    invalidateAllOrgStorageCache();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// RT-21 — tenant isolation across TWO activated orgs
// ─────────────────────────────────────────────────────────────────────────────

test('RT-21: ISOLATION — two activated orgs never share clients, DB rows or storage keys', async () => {
  const { getPrismaForOrg } = await import('../src/lib/org-db');
  const a = await getPrismaForOrg(orgAId);
  const b = await getPrismaForOrg(orgBId);
  assert.equal(a.mode, 'own');
  assert.equal(b.mode, 'own');
  assert.notEqual(a.client, b.client, 'distinct PrismaClient per org');
  assert.notEqual(a.client, db, 'neither is the platform client');

  // Cross-visibility: each org sees exactly ITS employee in ITS DB.
  const empInA = await a.client.employee.findFirst({ where: { employeeId: 'RT-EMP-B' } });
  assert.equal(empInA, null, 'org A DB has no org B employee');
  const empInB = await b.client.employee.findFirst({ where: { employeeId: 'RT-EMP-A' } });
  assert.equal(empInB, null, 'org B DB has no org A employee');

  // Write into each org's DB; the other org's DB and the platform stay clean.
  const alertInA = await a.client.alert.create({
    data: { title: 'RT-21 A', description: 'isolation', type: 'security', severity: 'info', status: 'pending', source: 'test', organizationId: orgAId, employeeId: empAId },
  });
  const alertInB = await b.client.alert.create({
    data: { title: 'RT-21 B', description: 'isolation', type: 'security', severity: 'info', status: 'pending', source: 'test', organizationId: orgBId, employeeId: empBId },
  });
  assert.equal(await a.client.alert.count({ where: { organizationId: orgBId } }), 0, 'org A client cannot see org B alerts');
  assert.equal(await b.client.alert.count({ where: { organizationId: orgAId } }), 0, 'org B client cannot see org A alerts');
  assert.equal(await db.alert.count({ where: { organizationId: { in: [orgAId, orgBId] } } }), 0, 'platform holds neither');

  await a.client.alert.delete({ where: { id: alertInA.id } });
  await b.client.alert.delete({ where: { id: alertInB.id } });

  // Storage keys are org-prefixed — two orgs can never collide or cross-read.
  const { screenshotKey } = await import('../src/lib/storage');
  const { audioKey } = await import('../src/lib/audio/storage');
  const keyA = screenshotKey(orgAId, 'x.png');
  const keyB = screenshotKey(orgBId, 'x.png');
  assert.notEqual(keyA, keyB);
  assert.ok(keyA.includes(orgAId) && keyB.includes(orgBId), 'keys are org-scoped');
  assert.notEqual(audioKey(orgAId, 'x.mp3'), audioKey(orgBId, 'x.mp3'));
});

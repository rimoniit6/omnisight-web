/**
 * Phase 4 — OPERATIONAL DATA PLANE security/attack tests.
 *
 * Exercises actual endpoint + storage behavior end-to-end:
 *
 *   P4A-01  Cross-org screenshot upload: client-supplied organizationId /
 *           employeeId fields are ignored — the row lands under the token's
 *           own org/employee; nothing is written for the spoofed tenant.
 *   P4A-02  Screenshot upload rejected while org screenshot_enabled=false
 *           (server policy wins even with consent).
 *   P4A-03  Screenshot upload rejected while org screenshotInterval=0
 *           (Phase 4 §11 — closes the Phase 3 parity gap at the API).
 *   P4A-04  Screenshot object-path traversal attempt → 404 (id is row-bound;
 *           storage keys are derived server-side, never from the request).
 *   P4A-06  Screenshot viewer is org-scoped: cross-org read → 404; org-less
 *           super_admin → 404; own org → 200 with magic-byte MIME.
 *   P4A-07  Retention purge removes BOTH the DB metadata and the storage
 *           object; the viewer 404s afterwards (no orphan, no ghost row).
 *   P4A-21  Audio stream boundary: own-org admin → 200; cross-org admin → 404;
 *           guessed id → 404; non-admin role → 403; org-less super_admin → 403.
 *   P4A-33  Offboarded employee → all agent operations rejected (401) and
 *           resume after reactivation.
 *   P4A-34  Revoked device → heartbeat + screenshot rejected (401).
 *   P4A-35  Suspended organization → agent ops rejected (401) AND admin
 *           operational reads rejected (403); restore resumes.
 *
 * Runs against a THROWAWAY PostgreSQL database + local storage driver.
 * Run: npx tsx --test tests/agent-phase4-data-plane.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { req } from './helpers/request';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_p4plane';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-p4plane-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@p4plane.test';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.STORAGE_DRIVER = 'local';

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

// 1×1 transparent PNG (valid signature + IHDR — magic-byte validation accepts it).
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

interface OrgSeed { org: { id: string }; emp: { id: string; employeeId: string }; dev: { id: string }; tok: string; }

let orgA: OrgSeed;
let orgOff: OrgSeed;   // screenshot_enabled=false
let orgZero: OrgSeed;  // screenshotInterval=0
let adminAToken: string;
let adminBToken: string;
let viewerAToken: string;
let saGlobalToken: string;

async function grantConsent(orgId: string, empId: string, consentType: string) {
  const policy = await db.consentPolicy.create({
    data: {
      organizationId: orgId,
      consentType,
      title: `${consentType} Policy`,
      content: 'Policy content.',
      version: 'v1',
      status: 'published',
      effectiveAt: new Date(),
      publishedAt: new Date(),
    },
  });
  await db.consent.create({
    data: {
      employeeId: empId,
      consentType,
      status: 'granted',
      grantedAt: new Date(),
      organizationId: orgId,
      policyId: policy.id,
      consentVersion: 'v1',
    },
  });
}

async function seedOrg(opts: {
  name: string; slug: string; empCode: string; devKey: string;
  screenshotInterval?: number; screenshotEnabled?: boolean;
}): Promise<OrgSeed> {
  const org = await db.organization.create({
    data: {
      name: opts.name,
      slug: opts.slug,
      timezone: 'UTC',
      screenshotInterval: opts.screenshotInterval ?? 5,
    },
  });
  const emp = await db.employee.create({
    data: {
      employeeId: opts.empCode,
      firstName: opts.name.split(' ')[0],
      lastName: 'Emp',
      email: `${opts.empCode.toLowerCase()}@p4plane.test`,
      organizationId: org.id,
      status: 'active',
      agentApproved: true,
    },
  });
  const dev = await db.device.create({
    data: {
      name: `${opts.name} Device`,
      hostname: opts.slug,
      agentKey: opts.devKey,
      organizationId: org.id,
      employeeId: emp.id,
      status: 'online',
      lastHeartbeat: new Date(),
    },
  });
  const { generateToken } = await import('../src/lib/agent/auth');
  const tok = generateToken(64);
  await db.agentToken.create({
    data: {
      token: tok,
      employeeId: emp.id,
      organizationId: org.id,
      deviceId: dev.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  if (opts.screenshotEnabled === false) {
    await db.organizationSetting.create({
      data: { organizationId: org.id, key: 'screenshot_enabled', value: 'false', category: 'monitoring' },
    });
  }
  await grantConsent(org.id, emp.id, 'screenshot');
  return { org, emp, dev, tok };
}

async function uploadShotReq(token: string, extra: Record<string, string>, withFile: boolean): Promise<NextRequest> {
  const form = new FormData();
  if (withFile) form.append('screenshot', new Blob([PNG_1PX], { type: 'image/png' }), 'shot.png');
  form.append('timestamp', new Date().toISOString());
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return new NextRequest('http://localhost:3000/api/agent/screenshot', {
    method: 'POST',
    headers: { 'authorization': `Bearer ${token}` },
    body: form,
  });
}

before(async () => {
  db = (await import('../src/lib/db')).db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  orgA = await seedOrg({ name: 'Tenant A', slug: 'p4a-orga', empCode: 'P4A-A', devKey: 'p4a-device-a-0001' });
  const orgB = await db.organization.create({ data: { name: 'Tenant B', slug: 'p4a-orgb', timezone: 'UTC' } });
  orgOff = await seedOrg({
    name: 'Off Org', slug: 'p4a-off', empCode: 'P4A-OFF', devKey: 'p4a-device-off-0001', screenshotEnabled: false,
  });
  orgZero = await seedOrg({
    name: 'Zero Org', slug: 'p4a-zero', empCode: 'P4A-ZERO', devKey: 'p4a-device-zero-0001', screenshotInterval: 0,
  });

  // Org A retention: 1 day (exercises the retention engine without long waits).
  await db.organizationSetting.create({
    data: { organizationId: orgA.org.id, key: 'screenshot_retention_days', value: '1', category: 'retention' },
  });

  adminAToken = await signJWT({ userId: 'admin-a', email: 'admin-a@p4plane.test', role: 'admin', organizationId: orgA.org.id });
  adminBToken = await signJWT({ userId: 'admin-b', email: 'admin-b@p4plane.test', role: 'admin', organizationId: orgB.id });
  viewerAToken = await signJWT({ userId: 'viewer-a', email: 'viewer-a@p4plane.test', role: 'viewer', organizationId: orgA.org.id });
  saGlobalToken = await signJWT({ userId: 'sa-root', email: 'sa@p4plane.test', role: 'super_admin' });
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
  } catch { /* best-effort */ }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function body(res: Response): Promise<any> {
  return res.json();
}

/** Next.js 16 dynamic-route params argument. */
function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

// ─── P4A-01: cross-org screenshot upload ────────────────────────────────

test('P4A-01: screenshot upload ignores spoofed org/employee fields — row lands under the token tenant', async () => {
  const api = await import('../src/app/api/agent/screenshot/route');

  const spoofOrg = (await db.organization.findUnique({ where: { slug: 'p4a-orgb' }, select: { id: true } }))!.id;

  const res = await api.POST(await uploadShotReq(orgA.tok, { organizationId: spoofOrg, employeeId: 'P4A-OFF' }, true));
  assert.equal(res.status, 200, 'legitimate upload accepted');
  const payload = await body(res);
  assert.ok(payload.filename, 'file stored');

  const row = await db.screenshot.findFirst({
    where: { organizationId: orgA.org.id },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(row, 'metadata row created');
  assert.equal(row!.organizationId, orgA.org.id, 'row under AUTHENTICATED org');
  assert.equal(row!.employeeId, orgA.emp.id, 'row under AUTHENTICATED employee');
  assert.equal(row!.deviceId, orgA.dev.id, 'row under AUTHENTICATED device');
  const foreignCount = await db.screenshot.count({ where: { organizationId: spoofOrg } });
  assert.equal(foreignCount, 0, 'nothing written under the spoofed org');

  // Cleanup: remove the object + metadata created by this test.
  await db.screenshot.delete({ where: { id: row!.id } });
  const { deleteScreenshot } = await import('../src/lib/storage');
  await deleteScreenshot(orgA.org.id, payload.filename as string);
});

// ─── P4A-02 / P4A-03: server policy gates ───────────────────────────────

test('P4A-02: upload rejected while org screenshot_enabled=false (consent present)', async () => {
  const api = await import('../src/app/api/agent/screenshot/route');
  const res = await api.POST(await uploadShotReq(orgOff.tok, {}, false));
  assert.equal(res.status, 403);
  assert.match((await body(res)).error ?? '', /SCREENSHOT_TRACKING_DISABLED/);
});

test('P4A-03: upload rejected while org screenshotInterval=0 (Phase 4 §11)', async () => {
  const api = await import('../src/app/api/agent/screenshot/route');
  const res = await api.POST(await uploadShotReq(orgZero.tok, {}, false));
  assert.equal(res.status, 403);
  assert.match((await body(res)).error ?? '', /SCREENSHOT_INTERVAL_DISABLED/);
});

// ─── P4A-04/06: viewer authorization + traversal ────────────────────────

test('P4A-04 + P4A-06: screenshot viewer is org-scoped and path-traversal safe', async () => {
  const imageApi = await import('../src/app/api/screenshots/[id]/image/route');
  const { putScreenshot } = await import('../src/lib/storage');

  const filename = `P4A-${orgA.emp.employeeId}_${randomUUID()}.png`;
  await putScreenshot(orgA.org.id, filename, PNG_1PX, 'image/png');
  const row = await db.screenshot.create({
    data: {
      employeeId: orgA.emp.id,
      deviceId: orgA.dev.id,
      filePath: `/uploads/screenshots/${filename}`,
      fileName: 'shot.png',
      fileSize: PNG_1PX.length,
      mimeType: 'image/png',
      organizationId: orgA.org.id,
      capturedAt: new Date(),
      processingStatus: 'processed',
    },
  });

  const url = (id: string) => `http://localhost:3000/api/screenshots/${id}/image`;

  // Own-org admin can read it (magic bytes → image/png).
  const own = await imageApi.GET(req(adminAToken, { url: url(row.id) }), params(row.id));
  assert.equal(own.status, 200, 'own-org admin reads screenshot');
  assert.equal(own.headers.get('content-type'), 'image/png');

  // Cross-org admin → concealing 404.
  const cross = await imageApi.GET(req(adminBToken, { url: url(row.id) }), params(row.id));
  assert.equal(cross.status, 404, 'cross-org admin denied');

  // Org-less super_admin → 403 (no tenant operational scope; the route
  // requires an org-bound session and never allows global scope on reads).
  const sa = await imageApi.GET(req(saGlobalToken, { url: url(row.id) }), params(row.id));
  assert.equal(sa.status, 403, 'org-less super_admin denied');

  // Viewer role within the org still reads (viewers can view screenshots) —
  // sanity that the 404s above are org-scoping, not role over-blocking.
  const viewer = await imageApi.GET(req(viewerAToken, { url: url(row.id) }), params(row.id));
  assert.equal(viewer.status, 200, 'org viewer reads own screenshot');

  // Path traversal attempts: ids are row-bound cuids — garbage/traversal ids
  // can never address a storage path.
  for (const evil of ['..%2F..%2Fsecret.png', '../../secret.png', '/uploads/screenshots/secret.png', '0'.repeat(24)]) {
    const evilRes = await imageApi.GET(req(adminAToken, { url: url(evil) }), params(evil));
    assert.equal(evilRes.status, 404, `traversal id ${evil} rejected`);
  }
});

// ─── P4A-07: retention purge removes metadata AND object ────────────────

test('P4A-07: retention purge deletes DB metadata + storage object; viewer 404s after', async () => {
  const imageApi = await import('../src/app/api/screenshots/[id]/image/route');
  const { putScreenshot, getScreenshot, isNotFound } = await import('../src/lib/storage');
  const { runRetentionForOrg } = await import('../src/lib/jobs/retention');

  const filename = `P4A-old_${randomUUID()}.png`;
  await putScreenshot(orgA.org.id, filename, PNG_1PX, 'image/png');
  const oldRow = await db.screenshot.create({
    data: {
      employeeId: orgA.emp.id,
      filePath: `/uploads/screenshots/${filename}`,
      fileName: 'old.png',
      fileSize: PNG_1PX.length,
      mimeType: 'image/png',
      organizationId: orgA.org.id,
      capturedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 days old
      processingStatus: 'processed',
    },
  });

  const result = await runRetentionForOrg(orgA.org.id, new Date(), 100);
  assert.ok(result.screenshots >= 1, 'expired screenshot metadata purged');

  const goneRow = await db.screenshot.findUnique({ where: { id: oldRow.id } });
  assert.equal(goneRow, null, 'DB metadata removed');

  // The physical object must be gone too — never a DB-delete-only purge.
  let objectGone = false;
  try {
    await getScreenshot(orgA.org.id, oldRow.filePath);
  } catch (error) {
    objectGone = isNotFound(error);
  }
  assert.equal(objectGone, true, 'storage object removed (no orphan)');

  // Viewer now 404s for the purged screenshot.
  const res = await imageApi.GET(
    req(adminAToken, { url: `http://localhost:3000/api/screenshots/${oldRow.id}/image` }),
    params(oldRow.id)
  );
  assert.equal(res.status, 404, 'purged screenshot is unreadable');
});

// ─── P4A-21/22: audio stream boundary ───────────────────────────────────

test('P4A-21/22: audio stream is org-scoped, role-gated, and id-safe', async () => {
  const streamApi = await import('../src/app/api/audio/[id]/stream/route');
  const { putAudio, deleteAudio } = await import('../src/lib/audio/storage');

  const audioName = `${randomUUID()}.webm`;
  await putAudio(orgA.org.id, audioName, Buffer.from('not-a-real-webm-but-bytes'), 'audio/webm');
  const rec = await db.audioRecording.create({
    data: {
      organizationId: orgA.org.id,
      employeeId: orgA.emp.id,
      deviceId: orgA.dev.id,
      fileName: 'capture.webm',
      filePath: `/uploads/audio/${audioName}`,
      fileSize: 25,
      mimeType: 'audio/webm',
      status: 'completed',
    },
  });
  const url = (id: string) => `http://localhost:3000/api/audio/${id}/stream`;

  // Own-org admin streams it.
  const own = await streamApi.GET(req(adminAToken, { url: url(rec.id) }), params(rec.id));
  assert.equal(own.status, 200, 'own-org admin streams audio');
  assert.equal(own.headers.get('content-type'), 'audio/webm');

  // Cross-org admin → 404 (concealing), never a cross-tenant byte.
  const cross = await streamApi.GET(req(adminBToken, { url: url(rec.id) }), params(rec.id));
  assert.equal(cross.status, 404, 'cross-org stream denied');

  // Guessed/forged id → 404.
  const guess = await streamApi.GET(req(adminAToken, { url: url('0'.repeat(24)) }), params('0'.repeat(24)));
  assert.equal(guess.status, 404, 'guessed id denied');

  // Role gate: viewer is not an admin → 403.
  const viewer = await streamApi.GET(req(viewerAToken, { url: url(rec.id) }), params(rec.id));
  assert.equal(viewer.status, 403, 'non-admin role cannot stream');

  // Org-less super_admin has no operational scope → 403.
  const sa = await streamApi.GET(req(saGlobalToken, { url: url(rec.id) }), params(rec.id));
  assert.equal(sa.status, 403, 'org-less super_admin cannot stream');

  // Cleanup the audio object.
  await db.audioRecording.delete({ where: { id: rec.id } });
  await deleteAudio(orgA.org.id, audioName);
});

// ─── P4A-33/34/35: lifecycle enforcement ────────────────────────────────

test('P4A-33/34/35: offboarding, device revocation and org suspension instantly block operations and resume after restore', async () => {
  const shotApi = await import('../src/app/api/agent/screenshot/route');
  const beatApi = await import('../src/app/api/agent/heartbeat/route');
  const imageApi = await import('../src/app/api/screenshots/[id]/image/route');
  // Baseline works (gate passes → file validation 400).
  const base = await shotApi.POST(await uploadShotReq(orgA.tok, {}, false));
  assert.equal(base.status, 400, 'baseline: gate passes → file validation 400');

  // P4A-33: offboard the employee.
  await db.employee.update({ where: { id: orgA.emp.id }, data: { status: 'inactive' } });
  const offboarded = await shotApi.POST(await uploadShotReq(orgA.tok, {}, false));
  assert.equal(offboarded.status, 401, 'offboarded employee cannot upload');
  await db.employee.update({ where: { id: orgA.emp.id }, data: { status: 'active' } });
  assert.equal(
    (await shotApi.POST(await uploadShotReq(orgA.tok, {}, false))).status,
    400,
    'reactivated employee resumes'
  );

  // P4A-34: revoke the device.
  await db.device.update({ where: { id: orgA.dev.id }, data: { status: 'inactive' } });
  assert.equal(
    (await beatApi.POST(req(orgA.tok, { method: 'POST', body: { timestamp: new Date().toISOString() } }))).status,
    401,
    'revoked device cannot heartbeat'
  );
  assert.equal(
    (await shotApi.POST(await uploadShotReq(orgA.tok, {}, false))).status,
    401,
    'revoked device cannot upload'
  );
  await db.device.update({ where: { id: orgA.dev.id }, data: { status: 'online' } });
  assert.equal(
    (await beatApi.POST(req(orgA.tok, { method: 'POST', body: { timestamp: new Date().toISOString() } }))).status,
    200,
    'restored device resumes'
  );

  // P4A-35: suspend the organization.
  await db.organization.update({ where: { id: orgA.org.id }, data: { status: 'suspended' } });
  assert.equal(
    (await beatApi.POST(req(orgA.tok, { method: 'POST', body: { timestamp: new Date().toISOString() } }))).status,
    401,
    'suspended org agent ops blocked'
  );
  assert.equal(
    (await shotApi.POST(await uploadShotReq(orgA.tok, {}, false))).status,
    401,
    'suspended org upload blocked'
  );
  // Web admin operational read is also blocked while suspended.
  const shot = await db.screenshot.findFirst({ where: { organizationId: orgA.org.id } });
  if (shot) {
    const adminRead = await imageApi.GET(
      req(adminAToken, { url: `http://localhost:3000/api/screenshots/${shot.id}/image` }),
      params(shot.id)
    );
    assert.equal(adminRead.status, 403, 'suspended org admin cannot read operational data');
  }
  await db.organization.update({ where: { id: orgA.org.id }, data: { status: 'active' } });
  assert.equal(
    (await beatApi.POST(req(orgA.tok, { method: 'POST', body: { timestamp: new Date().toISOString() } }))).status,
    200,
    'reactivated org resumes'
  );
});

/**
 * Screenshots module — production hardening tests.
 *
 * Phase: Screenshots Production Hardening. Covers:
 *   A. Upload validation — strict raster allowlist (PNG/JPEG/WebP), magic-byte
 *      verification, size limit, consent gates, token validation.
 *   B. Organization isolation — cross-org list/image/delete are concealed.
 *   C. Delete — admin-only, removes DB row + physical file, writes audit log;
 *      failed deletions never create a success audit record.
 *   D. Image serving — safe Content-Type from magic bytes, nosniff/private
 *      cache, path-traversal guard, 404 concealment, auth required.
 *   E. Transaction cleanup — a failed DB transaction after file write removes
 *      the newly created file and returns a generic 500 (no secrets).
 *   F. Filename collision — rapid-fire uploads produce unique filenames.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_screenshots).
 * Run: npx tsx --test tests/screenshots.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { rmSync, mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { NextRequest } from 'next/server';

// ─── Test DB isolation (must be set BEFORE any app module import) ──────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_screenshots';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-screenshots-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';
// This suite asserts against the physical filesystem (uploads/screenshots),
// so the storage driver must be the local one regardless of any developer's
// .env (which may select STORAGE_DRIVER=supabase for real deployments).
process.env.STORAGE_DRIVER = 'local';

const SCREENSHOT_DIR = join(process.cwd(), 'uploads', 'screenshots');

before(() => {
  if (process.env.SCREENSHOTS_TEST_MIGRATED_DB !== '1') {
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
let applyConsentTransition: (typeof import('../src/lib/consent'))['applyConsentTransition'];
import type { ConsentStatus } from '../src/lib/consent';

type ScreenshotApi = typeof import('../src/app/api/agent/screenshot/route');
type ScreenshotsApi = typeof import('../src/app/api/screenshots/route');
type ScreenshotDetailApi = typeof import('../src/app/api/screenshots/[id]/route');
type ScreenshotImageApi = typeof import('../src/app/api/screenshots/[id]/image/route');
type DiscoverApi = typeof import('../src/app/api/agent/discover/route');
type AuthApi = typeof import('../src/app/api/agent/authenticate/route');
type ClaimApproveApi = typeof import('../src/app/api/device-claims/[id]/approve/route');

let screenshotApi: ScreenshotApi;
let screenshotsApi: ScreenshotsApi;
let screenshotDetailApi: ScreenshotDetailApi;
let screenshotImageApi: ScreenshotImageApi;
let discoverApi: DiscoverApi;
let authApi: AuthApi;
let claimApproveApi: ClaimApproveApi;

// Primary org (discover attaches via its enrollment code) + a second org for
// isolation tests.
let orgA: { id: string };
let orgB: { id: string };
const ENROLL_CODE = 'test-enroll-code-shots-a-0123456789';
const ENROLL_CODE_B = 'test-enroll-code-shots-b-0123456789';

// Files this suite wrote into the shared uploads dir — cleaned in after().
const createdFiles: string[] = [];

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;
  applyConsentTransition = (await import('../src/lib/consent')).applyConsentTransition;

  const [sApi, ssApi, sdApi, siApi, dApi, aApi, caApi] = await Promise.all([
    import('../src/app/api/agent/screenshot/route'),
    import('../src/app/api/screenshots/route'),
    import('../src/app/api/screenshots/[id]/route'),
    import('../src/app/api/screenshots/[id]/image/route'),
    import('../src/app/api/agent/discover/route'),
    import('../src/app/api/agent/authenticate/route'),
    import('../src/app/api/device-claims/[id]/approve/route'),
  ]);
  screenshotApi = sApi;
  screenshotsApi = ssApi;
  screenshotDetailApi = sdApi;
  screenshotImageApi = siApi;
  discoverApi = dApi;
  authApi = aApi;
  claimApproveApi = caApi;

  orgA = await db.organization.create({ data: { name: 'Screenshots Org A', slug: 'shots-a' } });
  orgB = await db.organization.create({ data: { name: 'Screenshots Org B', slug: 'shots-b' } });

  // P2-3: anonymous zero-touch discover requires an EXPLICIT enrollment code.
  const { hashEnrollmentCode } = await import('../src/lib/agent/auth');
  await db.organizationSetting.create({
    data: { organizationId: orgA.id, key: 'agent_enrollment_code', value: hashEnrollmentCode(ENROLL_CODE), category: 'agent' },
  });
  await db.organizationSetting.create({
    data: { organizationId: orgB.id, key: 'agent_enrollment_code', value: hashEnrollmentCode(ENROLL_CODE_B), category: 'agent' },
  });
});

after(async () => {
  // Best-effort cleanup of any files this suite wrote into the shared dir.
  for (const file of createdFiles) {
    rmSync(join(SCREENSHOT_DIR, file), { force: true });
  }
  try {
    for (const entry of readdirSync(SCREENSHOT_DIR)) {
      if (/^SH\d+-EMP_/.test(entry)) rmSync(join(SCREENSHOT_DIR, entry), { force: true });
    }
  } catch {
    /* dir absent — nothing to clean */
  }
  await db.$disconnect();
  if (process.env.SCREENSHOTS_TEST_MIGRATED_DB !== '1') {
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

async function seedEmployee(code: string, orgId: string = orgA.id) {
  return db.employee.create({
    data: {
      employeeId: code,
      firstName: code.split('-')[0],
      lastName: 'Test',
      email: `${code.toLowerCase()}@test.local`,
      organizationId: orgId,
      status: 'active',
      agentApproved: false,
    },
  });
}

async function publishPolicy(orgId: string, consentType: string, version: string) {
  const existing = await db.consentPolicy.findFirst({ where: { organizationId: orgId, consentType, version } });
  if (existing) return existing;
  return db.consentPolicy.create({
    data: {
      organizationId: orgId,
      consentType,
      title: `${consentType} policy`,
      content: 'Test policy text for screenshot hardening tests.',
      version,
      status: 'published',
      effectiveAt: new Date(),
      publishedAt: new Date(),
    },
  });
}

async function setConsent(employeeId: string, orgId: string, consentType: string, to: 'granted' | 'revoked') {
  const existing = await db.consent.findFirst({ where: { employeeId, consentType } });
  await db.$transaction(async (tx) => {
    if (existing) {
      await applyConsentTransition(tx, { id: existing.id, status: existing.status as ConsentStatus, consentType, organizationId: orgId }, to, { performedBy: 'test' });
    } else {
      const created = await tx.consent.create({ data: { employeeId, consentType, status: 'pending', organizationId: orgId } });
      await applyConsentTransition(tx, { id: created.id, status: 'pending', consentType, organizationId: orgId }, to, { performedBy: 'test' });
    }
  });
}

function discoverBody(deviceKey: string, hostname = 'PC-SHOT') {
  return { deviceKey, hostname, os: 'Windows 11', osVersion: '23H2', processor: 'x64', memory: '16GB', agentVersion: '1.2.0', arch: 'x64', enrollmentCode: ENROLL_CODE };
}

async function discover(deviceKey: string, ip: string) {
  const res = await discoverApi.POST(req(null, { method: 'POST', body: discoverBody(deviceKey), ip }));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function approve(adminToken: string, claimId: string, employeeId: string) {
  const res = await claimApproveApi.POST(
    req(adminToken, { method: 'POST', body: { employeeId, projectIds: [] }, ip: '198.51.100.77' }),
    { params: Promise.resolve({ id: claimId }) }
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Full zero-touch setup: discover -> approve -> PATH A authenticate -> token. */
async function setupActiveDevice(label: string, ip: string, orgId: string = orgA.id) {
  const emp = await seedEmployee(`${label}-EMP`, orgId);
  const { body } = await discover(`key-shot-${label.toLowerCase()}-device-abcdef`, ip);
  const admin = await tokenFor('admin', `u-${label}-admin`, orgId);
  const ar = await approve(admin, body.claimId as string, emp.id);
  assert.equal(ar.status, 200, JSON.stringify(ar.body));
  const res = await authApi.POST(req(null, { method: 'POST', body: { deviceId: body.deviceId, deviceSecret: body.secret, agentVersion: '1.2.0' }, ip }));
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  assert.equal(res.status, 200, JSON.stringify(parsed));
  return { emp, claim: body as Record<string, string>, token: parsed.token as string };
}

/** Setup an active device with the requested screenshot-consent state. */
async function setupUploadDevice(label: string, consent: 'granted' | 'revoked' | 'none' = 'granted') {
  const { emp, token } = await setupActiveDevice(label, `203.0.113.${(label.length % 200) + 1}`);
  if (consent === 'granted') {
    await publishPolicy(orgA.id, 'screenshot', 'v1');
    await setConsent(emp.id, orgA.id, 'screenshot', 'granted');
  } else if (consent === 'revoked') {
    await publishPolicy(orgA.id, 'screenshot', 'v1');
    await setConsent(emp.id, orgA.id, 'screenshot', 'granted');
    await setConsent(emp.id, orgA.id, 'screenshot', 'revoked');
  }
  return { emp, token };
}

// Valid magic-byte fixtures.
const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(48, 0x11)]);
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(48, 0x22)]);
const GIF_BYTES = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(48, 0x33)]);
const SVG_BYTES = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(48, 0x44)]);

async function postScreenshot(
  token: string,
  bytes: Buffer,
  opts: { mimeType?: string; fileName?: string } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fd = new FormData();
  // Copy into a fresh Uint8Array: Buffer<ArrayBufferLike> is not a BlobPart.
  fd.append('screenshot', new File([new Uint8Array(bytes)], opts.fileName || 'test.png', { type: opts.mimeType || 'image/png' }));
  fd.append('timestamp', new Date().toISOString());
  fd.append('appWindow', 'chrome');
  const res = await screenshotApi.POST(
    new NextRequest('http://localhost:3000/api/agent/screenshot', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: fd,
    })
  );
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

/** Write a real file into the screenshots dir and create a matching DB row. */
async function seedScreenshotRow(empId: string, orgId: string, opts: { bytes?: Buffer; fileName?: string; filePath?: string; mimeType?: string } = {}) {
  const fileName = opts.fileName || `sh-seed-${Math.random().toString(36).slice(2)}.png`;
  const bytes = opts.bytes || PNG_BYTES;
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  if (opts.filePath === undefined) {
    writeFileSync(join(SCREENSHOT_DIR, fileName), bytes);
    createdFiles.push(fileName);
  }
  const row = await db.screenshot.create({
    data: {
      employeeId: empId,
      organizationId: orgId,
      filePath: opts.filePath ?? `/uploads/screenshots/${fileName}`,
      fileName,
      fileSize: bytes.length,
      mimeType: opts.mimeType || 'image/png',
    },
  });
  return { row, fileName };
}

// ─── A. Upload validation ───────────────────────────────────────────────────

test('SH-01: valid PNG accepted (magic bytes + allowlisted MIME)', async () => {
  const { emp, token } = await setupUploadDevice('SH01');
  const { status, body } = await postScreenshot(token, PNG_BYTES, { mimeType: 'image/png' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(typeof body.filename, 'string');
  assert.ok((body.filename as string).endsWith('.png'));
  assert.ok(existsSync(join(SCREENSHOT_DIR, body.filename as string)), 'physical file must exist');
  createdFiles.push(body.filename as string);
  assert.equal(await db.screenshot.count({ where: { employeeId: emp.id } }), 1);
});

test('SH-01b: PNG width/height are parsed from the file and persisted (never client-supplied)', async () => {
  const { emp, token } = await setupUploadDevice('SH01B');
  // A real 1938x1038 PNG IHDR (signature + IHDR chunk, matching magic bytes).
  const dimPng = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    Buffer.concat([
      Buffer.from([0, 0, 0, 13]), // IHDR chunk length = 13
      Buffer.from('IHDR', 'ascii'),
      (() => { const b = Buffer.alloc(13); b.writeUInt32BE(1938, 0); b.writeUInt32BE(1038, 4); return b; })(),
    ]),
  ]);
  const { status, body } = await postScreenshot(token, dimPng, { mimeType: 'image/png', fileName: 'dim.png' });
  assert.equal(status, 200, JSON.stringify(body));
  createdFiles.push(body.filename as string);
  const row = await db.screenshot.findFirst({ where: { employeeId: emp.id } });
  assert.equal(row!.width, 1938);
  assert.equal(row!.height, 1038);
});

test('SH-01c: truncated PNG uploads with NULL dimensions (never fabricated)', async () => {
  const { emp, token } = await setupUploadDevice('SH01C');
  // Valid signature but only 16 bytes — no complete IHDR, no valid dimensions.
  const trunc = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(8, 0x00)]);
  const { status, body } = await postScreenshot(token, trunc, { mimeType: 'image/png', fileName: 'trunc.png' });
  // The PNG signature is intact (magic-byte validation passes) but the IHDR
  // is not present; the upload is accepted with width/height NULL — never
  // fabricated from malformed content.
  assert.equal(status, 200, JSON.stringify(body));
  createdFiles.push(body.filename as string);
  const row = await db.screenshot.findFirst({ where: { employeeId: emp.id } });
  assert.equal(row!.width, null);
  assert.equal(row!.height, null);
});

test('SH-02: valid JPEG accepted', async () => {
  const { emp, token } = await setupUploadDevice('SH02');
  const { status, body } = await postScreenshot(token, JPEG_BYTES, { mimeType: 'image/jpeg', fileName: 'test.jpg' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok((body.filename as string).endsWith('.jpg'));
  const row = await db.screenshot.findFirst({ where: { employeeId: emp.id } });
  assert.equal(row!.mimeType, 'image/jpeg');
  createdFiles.push(body.filename as string);
});

test('SH-03: valid WebP accepted', async () => {
  const { emp, token } = await setupUploadDevice('SH03');
  const { status, body } = await postScreenshot(token, WEBP_BYTES, { mimeType: 'image/webp', fileName: 'test.webp' });
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok((body.filename as string).endsWith('.webp'));
  const row = await db.screenshot.findFirst({ where: { employeeId: emp.id } });
  assert.equal(row!.mimeType, 'image/webp');
  createdFiles.push(body.filename as string);
});

test('SH-04: SVG rejected with 400 even when the MIME claims image/svg+xml', async () => {
  const { emp, token } = await setupUploadDevice('SH04');
  const { status, body } = await postScreenshot(token, SVG_BYTES, { mimeType: 'image/svg+xml', fileName: 'x.svg' });
  assert.equal(status, 400, JSON.stringify(body));
  assert.equal(await db.screenshot.count({ where: { employeeId: emp.id } }), 0, 'no row may be persisted');
});

test('SH-05: GIF rejected with 400', async () => {
  const { emp, token } = await setupUploadDevice('SH05');
  const { status } = await postScreenshot(token, GIF_BYTES, { mimeType: 'image/gif', fileName: 'x.gif' });
  assert.equal(status, 400);
  assert.equal(await db.screenshot.count({ where: { employeeId: emp.id } }), 0);
});

test('SH-06: unsupported MIME (application/pdf) rejected with 400', async () => {
  const { emp, token } = await setupUploadDevice('SH06');
  const { status } = await postScreenshot(token, PDF_BYTES, { mimeType: 'application/pdf', fileName: 'x.pdf' });
  assert.equal(status, 400);
  assert.equal(await db.screenshot.count({ where: { employeeId: emp.id } }), 0);
});

test('SH-07: image/png claimed but JPEG magic bytes rejected (400 mismatch)', async () => {
  const { emp, token } = await setupUploadDevice('SH07');
  const { status, body } = await postScreenshot(token, JPEG_BYTES, { mimeType: 'image/png', fileName: 'spoof.png' });
  assert.equal(status, 400, JSON.stringify(body));
  assert.equal(await db.screenshot.count({ where: { employeeId: emp.id } }), 0);
});

test('SH-08: image/jpeg claimed but PNG magic bytes rejected (400 mismatch)', async () => {
  const { emp, token } = await setupUploadDevice('SH08');
  const { status } = await postScreenshot(token, PNG_BYTES, { mimeType: 'image/jpeg', fileName: 'spoof.jpg' });
  assert.equal(status, 400);
  assert.equal(await db.screenshot.count({ where: { employeeId: emp.id } }), 0);
});

test('SH-09: image/webp claimed but PNG magic bytes rejected (400 mismatch)', async () => {
  const { emp, token } = await setupUploadDevice('SH09');
  const { status } = await postScreenshot(token, PNG_BYTES, { mimeType: 'image/webp', fileName: 'spoof.webp' });
  assert.equal(status, 400);
  assert.equal(await db.screenshot.count({ where: { employeeId: emp.id } }), 0);
});

test('SH-10: screenshot larger than 5 MB rejected with 400', async () => {
  const { emp, token } = await setupUploadDevice('SH10');
  const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0x55);
  const { status, body } = await postScreenshot(token, big, { mimeType: 'image/png', fileName: 'big.png' });
  assert.equal(status, 400, JSON.stringify(body));
  assert.equal(await db.screenshot.count({ where: { employeeId: emp.id } }), 0);
});

test('SH-11: missing screenshot consent -> 403, nothing persisted', async () => {
  const { emp, token } = await setupUploadDevice('SH11', 'none');
  assert.equal(await db.consent.count({ where: { employeeId: emp.id } }), 0, 'no consent at all');
  const { status, body } = await postScreenshot(token, PNG_BYTES);
  assert.equal(status, 403, JSON.stringify(body));
  assert.equal(await db.screenshot.count({ where: { employeeId: emp.id } }), 0);
  let leftover: string[] = [];
  try {
    leftover = readdirSync(SCREENSHOT_DIR).filter((f) => f.startsWith('SH11-EMP_'));
  } catch {
    /* storage dir absent — nothing written */
  }
  assert.equal(leftover.length, 0, 'no orphan file for the rejected upload');
});

test('SH-12: revoked screenshot consent -> 403 (grant -> revoke -> upload)', async () => {
  const { emp, token } = await setupUploadDevice('SH12', 'revoked');
  const { status, body } = await postScreenshot(token, PNG_BYTES);
  assert.equal(status, 403, JSON.stringify(body));
  assert.equal(await db.screenshot.count({ where: { employeeId: emp.id } }), 0);
});

test('SH-13: invalid agent token -> 401 (no auth bypass)', async () => {
  const { status, body } = await postScreenshot('definitely-not-a-valid-token', PNG_BYTES);
  assert.equal(status, 401, JSON.stringify(body));
});

// ─── B. Organization isolation ──────────────────────────────────────────────

test('SH-14: admin A cannot list org B screenshots', async () => {
  const empB = await seedEmployee('SH14B-EMP', orgB.id);
  await seedScreenshotRow(empB.id, orgB.id, { fileName: 'sh-b-only-14.png' });

  const adminA = await tokenFor('admin', 'u-sh14-a');
  const res = await screenshotsApi.GET(req(adminA, { url: 'http://localhost:3000/api/screenshots?pageSize=100' }));
  const parsed = (await res.json()) as { data: { id: string }[]; total: number };
  assert.equal(res.status, 200);
  const ids = new Set(parsed.data.map((s) => s.id));
  const bRow = await db.screenshot.findFirst({ where: { organizationId: orgB.id } });
  assert.ok(bRow);
  assert.ok(!ids.has(bRow.id), 'org B screenshot must never appear in org A listing');

  const adminB = await tokenFor('admin', 'u-sh14-b', orgB.id);
  const resB = await screenshotsApi.GET(req(adminB, { url: 'http://localhost:3000/api/screenshots?pageSize=100' }));
  const parsedB = (await resB.json()) as { data: { id: string }[] };
  assert.ok(parsedB.data.some((s) => s.id === bRow.id), 'org B admin sees their own screenshot');
});

test('SH-15: admin A cannot view org B screenshot image (404 concealment)', async () => {
  const empB = await seedEmployee('SH15B-EMP', orgB.id);
  const { row } = await seedScreenshotRow(empB.id, orgB.id, { fileName: 'sh-b-only-15.png' });

  const adminA = await tokenFor('admin', 'u-sh15-a');
  const res = await screenshotImageApi.GET(req(adminA, { url: `http://localhost:3000/api/screenshots/${row.id}/image` }), {
    params: Promise.resolve({ id: row.id }),
  });
  assert.equal(res.status, 404, 'cross-org image access must be concealed');

  // The file itself is untouched and the org-B admin can still read it.
  const adminB = await tokenFor('admin', 'u-sh15-b', orgB.id);
  const ok = await screenshotImageApi.GET(req(adminB, { url: `http://localhost:3000/api/screenshots/${row.id}/image` }), {
    params: Promise.resolve({ id: row.id }),
  });
  assert.equal(ok.status, 200);
});

test('SH-16: admin A cannot delete org B screenshot (404), row survives', async () => {
  const empB = await seedEmployee('SH16B-EMP', orgB.id);
  const { row, fileName } = await seedScreenshotRow(empB.id, orgB.id, { fileName: 'sh-b-only-16.png' });

  const adminA = await tokenFor('admin', 'u-sh16-a');
  const res = await screenshotDetailApi.DELETE(req(adminA, { method: 'DELETE', url: `http://localhost:3000/api/screenshots/${row.id}` }), {
    params: Promise.resolve({ id: row.id }),
  });
  assert.equal(res.status, 404);
  assert.ok(await db.screenshot.findUnique({ where: { id: row.id } }), 'cross-org delete must not remove the row');
  assert.ok(existsSync(join(SCREENSHOT_DIR, fileName)), 'cross-org delete must not remove the file');
});

test('SH-17: client-supplied organizationId cannot bypass isolation', async () => {
  const empA = await seedEmployee('SH17A-EMP', orgA.id);
  await seedScreenshotRow(empA.id, orgA.id, { fileName: 'sh-a-17.png' });

  // Admin A requests org B's id in the query string — must be ignored.
  const adminA = await tokenFor('admin', 'u-sh17-a');
  const res = await screenshotsApi.GET(req(adminA, { url: `http://localhost:3000/api/screenshots?organizationId=${orgB.id}&pageSize=100` }));
  const parsed = (await res.json()) as { data: { id: string; organizationId: string }[]; total: number };
  assert.ok(parsed.total > 0, 'org A has screenshots from earlier tests in this suite');
  assert.ok(parsed.data.length > 0);
  for (const s of parsed.data) {
    assert.equal(s.organizationId, orgA.id, 'org filter must come from the JWT, never the client');
  }
  // And the org B id in the query must not inject B data.
  const bIds = await db.screenshot.findMany({ where: { organizationId: orgB.id }, select: { id: true } });
  const bSet = new Set(bIds.map((b) => b.id));
  assert.ok(!parsed.data.some((s) => bSet.has(s.id)), 'no org B screenshot may leak');
});

// ─── C. Delete ──────────────────────────────────────────────────────────────

test('SH-18: admin deletes own-org screenshot — DB row removed, file removed', async () => {
  const empA = await seedEmployee('SH18A-EMP', orgA.id);
  const { row, fileName } = await seedScreenshotRow(empA.id, orgA.id, { fileName: 'sh-a-18.png' });

  const adminA = await tokenFor('admin', 'u-sh18-a');
  const res = await screenshotDetailApi.DELETE(req(adminA, { method: 'DELETE', url: `http://localhost:3000/api/screenshots/${row.id}` }), {
    params: Promise.resolve({ id: row.id }),
  });
  assert.equal(res.status, 200);
  assert.equal(await db.screenshot.findUnique({ where: { id: row.id } }), null, 'DB record must be gone');
  assert.equal(existsSync(join(SCREENSHOT_DIR, fileName)), false, 'physical file must be gone');
});

test('SH-19: viewer cannot delete a screenshot (403)', async () => {
  const empA = await seedEmployee('SH19A-EMP', orgA.id);
  const { row } = await seedScreenshotRow(empA.id, orgA.id, { fileName: 'sh-a-19.png' });

  const viewer = await tokenFor('viewer', 'u-sh19-viewer');
  const res = await screenshotDetailApi.DELETE(req(viewer, { method: 'DELETE', url: `http://localhost:3000/api/screenshots/${row.id}` }), {
    params: Promise.resolve({ id: row.id }),
  });
  assert.equal(res.status, 403, 'viewer must not delete');
  assert.ok(await db.screenshot.findUnique({ where: { id: row.id } }), 'row must survive a viewer delete attempt');
});

test('SH-20: delete writes a delete audit log for the correct org/actor', async () => {
  const empA = await seedEmployee('SH20A-EMP', orgA.id);
  const { row } = await seedScreenshotRow(empA.id, orgA.id, { fileName: 'sh-a-20.png' });

  const adminA = await tokenFor('admin', 'u-sh20-admin');
  const res = await screenshotDetailApi.DELETE(req(adminA, { method: 'DELETE', url: `http://localhost:3000/api/screenshots/${row.id}` }), {
    params: Promise.resolve({ id: row.id }),
  });
  assert.equal(res.status, 200);

  const audit = await db.auditLog.findFirst({
    where: { resource: 'screenshot', resourceId: row.id, action: 'delete' },
  });
  assert.ok(audit, 'delete audit log must exist');
  assert.equal(audit!.organizationId, orgA.id);
  assert.equal(audit!.userId, 'u-sh20-admin');
});

test('SH-21: failed deletion (missing + cross-org) never creates a delete audit record', async () => {
  const empB = await seedEmployee('SH21B-EMP', orgB.id);
  const { row } = await seedScreenshotRow(empB.id, orgB.id, { fileName: 'sh-b-21.png' });
  const adminA = await tokenFor('admin', 'u-sh21-a');

  // Nonexistent id -> 404, no audit.
  const missing = await screenshotDetailApi.DELETE(req(adminA, { method: 'DELETE', url: 'http://localhost:3000/api/screenshots/cuid-nonexistent-000' }), {
    params: Promise.resolve({ id: 'cuid-nonexistent-000' }),
  });
  assert.equal(missing.status, 404);
  assert.equal(await db.auditLog.count({ where: { resource: 'screenshot', action: 'delete', resourceId: 'cuid-nonexistent-000' } }), 0);

  // Cross-org id -> 404, no audit.
  const cross = await screenshotDetailApi.DELETE(req(adminA, { method: 'DELETE', url: `http://localhost:3000/api/screenshots/${row.id}` }), {
    params: Promise.resolve({ id: row.id }),
  });
  assert.equal(cross.status, 404);
  assert.equal(await db.auditLog.count({ where: { resource: 'screenshot', action: 'delete', resourceId: row.id } }), 0, 'failed delete must not be audited as success');
  assert.ok(await db.screenshot.findUnique({ where: { id: row.id } }), 'cross-org row must survive');
});

// ─── D. Image serving ───────────────────────────────────────────────────────

test('SH-22: PNG image served as image/png with nosniff + private cache', async () => {
  const empA = await seedEmployee('SH22A-EMP', orgA.id);
  const { row } = await seedScreenshotRow(empA.id, orgA.id, { fileName: 'sh-a-22.png', bytes: PNG_BYTES, mimeType: 'image/png' });

  const adminA = await tokenFor('admin', 'u-sh22-a');
  const res = await screenshotImageApi.GET(req(adminA, { url: `http://localhost:3000/api/screenshots/${row.id}/image` }), {
    params: Promise.resolve({ id: row.id }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cache-control'), 'private, max-age=3600');
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.length, PNG_BYTES.length);
  assert.deepEqual([...body.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'served bytes must be the actual image');
});

test('SH-23: JPEG image served as image/jpeg', async () => {
  const empA = await seedEmployee('SH23A-EMP', orgA.id);
  const { row } = await seedScreenshotRow(empA.id, orgA.id, { fileName: 'sh-a-23.jpg', bytes: JPEG_BYTES, mimeType: 'image/jpeg' });

  const adminA = await tokenFor('admin', 'u-sh23-a');
  const res = await screenshotImageApi.GET(req(adminA, { url: `http://localhost:3000/api/screenshots/${row.id}/image` }), {
    params: Promise.resolve({ id: row.id }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('SH-24: WebP image served as image/webp', async () => {
  const empA = await seedEmployee('SH24A-EMP', orgA.id);
  const { row } = await seedScreenshotRow(empA.id, orgA.id, { fileName: 'sh-a-24.webp', bytes: WEBP_BYTES, mimeType: 'image/webp' });

  const adminA = await tokenFor('admin', 'u-sh24-a');
  const res = await screenshotImageApi.GET(req(adminA, { url: `http://localhost:3000/api/screenshots/${row.id}/image` }), {
    params: Promise.resolve({ id: row.id }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/webp');
});

test('SH-25: stored MIME lies about content — physical signature wins (never SVG as HTML)', async () => {
  const empA = await seedEmployee('SH25A-EMP', orgA.id);
  // Row says image/png, but the physical file is an SVG (e.g. legacy upload).
  const { row } = await seedScreenshotRow(empA.id, orgA.id, { fileName: 'sh-a-25.png', bytes: SVG_BYTES, mimeType: 'image/png' });

  const adminA = await tokenFor('admin', 'u-sh25-a');
  const res = await screenshotImageApi.GET(req(adminA, { url: `http://localhost:3000/api/screenshots/${row.id}/image` }), {
    params: Promise.resolve({ id: row.id }),
  });
  assert.equal(res.status, 200);
  const contentType = res.headers.get('content-type') || '';
  assert.equal(contentType, 'application/octet-stream', 'SVG content must never be served as image/png or text/html');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('SH-26: missing physical file returns a safe 404', async () => {
  const empA = await seedEmployee('SH26A-EMP', orgA.id);
  const { row } = await seedScreenshotRow(empA.id, orgA.id, {
    // DB row present but the file was already deleted.
    filePath: '/uploads/screenshots/sh-missing-26.png',
    fileName: 'sh-missing-26.png',
  });
  // Ensure the physical file is really absent.
  rmSync(join(SCREENSHOT_DIR, 'sh-missing-26.png'), { force: true });

  const adminA = await tokenFor('admin', 'u-sh26-a');
  const res = await screenshotImageApi.GET(req(adminA, { url: `http://localhost:3000/api/screenshots/${row.id}/image` }), {
    params: Promise.resolve({ id: row.id }),
  });
  assert.equal(res.status, 404);
});

test('SH-27: path-traversal filePath cannot escape the screenshots directory', async () => {
  // A marker file OUTSIDE the screenshots dir that must never be readable.
  const marker = join(process.cwd(), 'sh-traversal-marker-27.txt');
  writeFileSync(marker, 'TOP-SECRET-MARKER');
  const empA = await seedEmployee('SH27A-EMP', orgA.id);
  const { row } = await seedScreenshotRow(empA.id, orgA.id, {
    filePath: '/uploads/screenshots/../../sh-traversal-marker-27.txt',
    fileName: '../../sh-traversal-marker-27.txt',
  });

  const adminA = await tokenFor('admin', 'u-sh27-a');
  const res = await screenshotImageApi.GET(req(adminA, { url: `http://localhost:3000/api/screenshots/${row.id}/image` }), {
    params: Promise.resolve({ id: row.id }),
  });
  // basename guard normalizes to uploads/screenshots/sh-traversal-marker-27.txt
  // which does not exist -> 404; the real marker is never served.
  assert.equal(res.status, 404);
  rmSync(marker, { force: true });
});

test('SH-28: cross-org screenshot id returns 404 for the image endpoint', async () => {
  const empB = await seedEmployee('SH28B-EMP', orgB.id);
  const { row } = await seedScreenshotRow(empB.id, orgB.id, { fileName: 'sh-b-28.png' });

  const adminA = await tokenFor('admin', 'u-sh28-a');
  const res = await screenshotImageApi.GET(req(adminA, { url: `http://localhost:3000/api/screenshots/${row.id}/image` }), {
    params: Promise.resolve({ id: row.id }),
  });
  assert.equal(res.status, 404);
});

test('SH-29: unauthenticated image request rejected with 401', async () => {
  const empA = await seedEmployee('SH29A-EMP', orgA.id);
  const { row } = await seedScreenshotRow(empA.id, orgA.id, { fileName: 'sh-a-29.png' });

  const res = await screenshotImageApi.GET(req(null, { url: `http://localhost:3000/api/screenshots/${row.id}/image` }), {
    params: Promise.resolve({ id: row.id }),
  });
  assert.equal(res.status, 401, 'screenshot images must never be publicly accessible');
});

// ─── E. Transaction cleanup ─────────────────────────────────────────────────

test('SH-30: DB transaction failure after file write removes the new file, persists nothing, leaks nothing', async () => {
  const { emp, token } = await setupUploadDevice('SH30');

  const beforeCount = await db.screenshot.count({ where: { employeeId: emp.id } });
  const beforeFiles = readdirSync(SCREENSHOT_DIR).filter((f) => f.startsWith('SH30-EMP_'));

  // Stub the transaction so the DB commit fails after the route wrote the file.
  const realTx = db.$transaction;
  db.$transaction = (async () => {
    throw new Error('synthetic database failure for test');
  }) as typeof db.$transaction;

  // A secret marker embedded in the file bytes — must never surface in logs.
  const secretMarker = 'SH30-SECRET-FILE-CONTENT-MARKER';
  const bytesWithSecret = Buffer.concat([PNG_BYTES, Buffer.from(secretMarker)]);

  // Capture the console sink the project logger writes to (log.error -> console.error).
  const captured: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    captured.push(args.map((a) => String(a)).join(' '));
  };

  let status: number;
  let body: Record<string, unknown>;
  try {
    const res = await postScreenshot(token, bytesWithSecret, { mimeType: 'image/png', fileName: 'tx-fail.png' });
    status = res.status;
    body = res.body;
  } finally {
    db.$transaction = realTx;
    console.error = realError;
  }

  assert.equal(status, 500, JSON.stringify(body));
  assert.equal((body as { error?: string }).error, 'Internal server error', 'generic error, no internals');

  // No DB row survived the failed transaction.
  assert.equal(await db.screenshot.count({ where: { employeeId: emp.id } }), beforeCount);

  // The newly written physical file was cleaned up (no new SH30-EMP_ files).
  const afterFiles = readdirSync(SCREENSHOT_DIR).filter((f) => f.startsWith('SH30-EMP_'));
  assert.deepEqual(afterFiles, beforeFiles, 'orphaned upload file must be removed');

  // The capture must actually have received the logger output (proving the
  // negative assertions below are meaningful, not vacuously true).
  const combined = captured.join('\n');
  assert.ok(combined.includes('synthetic database failure for test'), 'route must log the safe diagnostic');

  // Nothing sensitive reaches logs: agent token and file contents stay out.
  assert.ok(!combined.includes(token), 'agent token must never be logged');
  assert.ok(!combined.includes(secretMarker), 'file contents must never be logged');
  // And the response body carries none of it either.
  const bodyText = JSON.stringify(body);
  assert.ok(!bodyText.includes(token) && !bodyText.includes(secretMarker));
});

test('SH-32: crafted employeeId cannot escape the screenshots storage dir (filename sanitization)', async () => {
  // Admin-created employeeId is NOT sanitized at the Employee API; the upload
  // route must therefore sanitize the filename segment itself.
  const emp = await seedEmployee('SH32X-EMP', orgA.id);
  await db.employee.update({ where: { id: emp.id }, data: { employeeId: '../../evil' } });
  await publishPolicy(orgA.id, 'screenshot', 'v1');
  await setConsent(emp.id, orgA.id, 'screenshot', 'granted');

  // Create an active device bound to this employee and upload a screenshot.
  const { body: claim } = await discover('key-shot-traversal-abcdef', '203.0.113.88');
  const admin = await tokenFor('admin', 'u-sh32-admin');
  assert.equal((await approve(admin, claim.claimId as string, emp.id)).status, 200);
  const auth = await authApi.POST(req(null, { method: 'POST', body: { deviceId: claim.deviceId, deviceSecret: claim.secret, agentVersion: '1.2.0' }, ip: '203.0.113.88' }));
  const authBody = (await auth.json().catch(() => ({}))) as Record<string, unknown>;
  assert.equal(auth.status, 200, JSON.stringify(authBody));

  const { status, body } = await postScreenshot(authBody.token as string, PNG_BYTES, { mimeType: 'image/png' });
  assert.equal(status, 200, JSON.stringify(body));
  const filename = body.filename as string;

  // The filename must be a single safe segment that RESOLVES inside the
  // screenshots dir — no separators survive sanitization, so a crafted
  // employeeId ("../../evil") can never escape the storage root.
  assert.ok(!filename.includes('/') && !filename.includes('\\'), 'filename must not contain separators');
  const resolved = resolve(SCREENSHOT_DIR, filename);
  assert.ok(resolved.startsWith(resolve(SCREENSHOT_DIR) + sep), 'file must resolve inside the screenshots directory');
  const onDisk = join(SCREENSHOT_DIR, filename);
  assert.ok(existsSync(onDisk), 'file must be inside the screenshots directory');
  createdFiles.push(filename);
});

// ─── F. Filename collision ──────────────────────────────────────────────────

test('SH-31: rapid-fire uploads produce unique, collision-proof filenames', async () => {
  const { token } = await setupUploadDevice('SH31');
  const filenames = new Set<string>();
  let failures = 0;
  for (let i = 0; i < 8; i++) {
    const { status, body } = await postScreenshot(token, PNG_BYTES, { mimeType: 'image/png', fileName: `burst-${i}.png` });
    if (status !== 200) failures += 1;
    else filenames.add(body.filename as string);
  }
  assert.equal(failures, 0, 'all burst uploads must succeed');
  assert.equal(filenames.size, 8, 'each filename must be unique (UUID-based)');
  for (const f of filenames) {
    assert.ok(existsSync(join(SCREENSHOT_DIR, f)), `file ${f} must exist`);
    createdFiles.push(f);
  }
});

// ─── G. Regression: environment + persistence verification ──────────────────

test('SH-33: placeholder Supabase configuration is detected and rejected', async () => {
  // The resolveStorageDriver function must reject placeholder URLs
  const { resolveStorageDriver } = await import('../src/lib/storage');
  const origUrl = process.env.SUPABASE_URL;
  const origKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const origDriver = process.env.STORAGE_DRIVER;
  try {
    process.env.STORAGE_DRIVER = 'supabase';
    process.env.SUPABASE_URL = 'REPLACE_WITH_YOUR_SUPABASE_URL';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'REPLACE_WITH_YOUR_KEY';
    assert.throws(
      () => resolveStorageDriver(),
      /placeholder/i,
      'must throw on placeholder Supabase URL'
    );
  } finally {
    if (origUrl !== undefined) process.env.SUPABASE_URL = origUrl; else delete process.env.SUPABASE_URL;
    if (origKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = origKey; else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (origDriver !== undefined) process.env.STORAGE_DRIVER = origDriver; else delete process.env.STORAGE_DRIVER;
  }
});

test('SH-34: real local storage upload persists to disk', async () => {
  const { token, emp } = await setupUploadDevice('SH34');
  const { status, body } = await postScreenshot(token, PNG_BYTES, { mimeType: 'image/png', fileName: 'persist-test.png' });
  assert.equal(status, 200, JSON.stringify(body));
  const filename = body.filename as string;
  createdFiles.push(filename);

  // File must exist on disk with correct size
  const onDisk = join(SCREENSHOT_DIR, filename);
  assert.ok(existsSync(onDisk), `file ${filename} must exist on disk`);
  const { statSync } = await import('node:fs');
  const stat = statSync(onDisk);
  assert.ok(stat.size > 0, 'file must be non-empty');
  assert.equal(stat.size, PNG_BYTES.length, 'file size must match uploaded bytes');
});

test('SH-35: DB row maps to physical storage file', async () => {
  const { token, emp } = await setupUploadDevice('SH35');
  const { status, body } = await postScreenshot(token, PNG_BYTES, { mimeType: 'image/png', fileName: 'db-map-test.png' });
  assert.equal(status, 200, JSON.stringify(body));
  const filename = body.filename as string;
  createdFiles.push(filename);

  // Find the DB row
  const row = await db.screenshot.findFirst({
    where: { employeeId: emp.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true, filePath: true, organizationId: true, fileName: true, fileSize: true },
  });
  assert.ok(row, 'DB row must exist');
  assert.equal(row.fileName, 'db-map-test.png', 'fileName must match');
  assert.equal(row.fileSize, PNG_BYTES.length, 'fileSize must match');

  // filePath basename must match the stored filename
  const { basename } = await import('node:path');
  assert.equal(basename(row.filePath), filename, 'filePath basename must match stored filename');

  // Physical file must exist at the path derived from the DB row
  const onDisk = join(SCREENSHOT_DIR, basename(row.filePath));
  assert.ok(existsSync(onDisk), 'physical file must exist at DB-derived path');
});

test('SH-36: admin list API returns newly uploaded screenshot', async () => {
  const { token, emp } = await setupUploadDevice('SH36');
  const { status, body } = await postScreenshot(token, PNG_BYTES, { mimeType: 'image/png', fileName: 'list-test.png' });
  assert.equal(status, 200, JSON.stringify(body));
  const filename = body.filename as string;
  createdFiles.push(filename);

  // Find the DB row to get the ID
  const row = await db.screenshot.findFirst({
    where: { employeeId: emp.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  assert.ok(row, 'DB row must exist');

  // Query the admin list API with the correct org session
  const adminToken = await tokenFor('admin', 'u-SH36-admin');
  const listReq = new NextRequest(`http://localhost:3000/api/screenshots?page=1&pageSize=50`, {
    headers: { cookie: `worklens_token=${adminToken}` },
  });
  const listRes = await screenshotsApi.GET(listReq);
  assert.equal(listRes.status, 200, 'list API must return 200');
  const listBody = await listRes.json() as { data: Array<{ id: string }>; total: number };
  assert.ok(listBody.data.some((s) => s.id === row.id), 'newly uploaded screenshot must appear in admin list');
});

test('SH-37: image endpoint serves newly uploaded screenshot', async () => {
  const { token, emp } = await setupUploadDevice('SH37');
  const { status, body } = await postScreenshot(token, PNG_BYTES, { mimeType: 'image/png', fileName: 'image-serve-test.png' });
  assert.equal(status, 200, JSON.stringify(body));
  const filename = body.filename as string;
  createdFiles.push(filename);

  // Find the DB row
  const row = await db.screenshot.findFirst({
    where: { employeeId: emp.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true, mimeType: true },
  });
  assert.ok(row, 'DB row must exist');

  // Request the image via the authenticated image endpoint
  const adminToken = await tokenFor('admin', 'u-SH37-admin');
  const imgReq = new NextRequest(`http://localhost:3000/api/screenshots/${row.id}/image`, {
    headers: { cookie: `worklens_token=${adminToken}` },
  });
  const imgRes = await screenshotImageApi.GET(imgReq, { params: Promise.resolve({ id: row.id }) });
  assert.equal(imgRes.status, 200, 'image endpoint must return 200');
  const ct = imgRes.headers.get('content-type');
  assert.ok(ct?.includes('image/png'), `Content-Type must be image/png, got: ${ct}`);
  assert.equal(imgRes.headers.get('x-content-type-options'), 'nosniff');
  const imgBytes = Buffer.from(await imgRes.arrayBuffer());
  assert.ok(imgBytes.length > 0, 'response must contain image bytes');
  assert.equal(imgBytes.length, PNG_BYTES.length, 'response bytes must match uploaded PNG');
  // Verify magic bytes
  assert.equal(imgBytes[0], 0x89, 'must be valid PNG (first byte)');
  assert.equal(imgBytes[1], 0x50, 'must be valid PNG (second byte)');
});

test('SH-38: organization B cannot see organization A screenshot', async () => {
  // Upload to org A
  const { token: tokenA, emp: empA } = await setupUploadDevice('SH38A');
  const { status, body } = await postScreenshot(tokenA, PNG_BYTES, { mimeType: 'image/png', fileName: 'org-a-only.png' });
  assert.equal(status, 200, JSON.stringify(body));
  const filename = body.filename as string;
  createdFiles.push(filename);

  const row = await db.screenshot.findFirst({
    where: { employeeId: empA.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  assert.ok(row, 'DB row must exist');

  // Org B admin must NOT see this screenshot
  const adminTokenB = await tokenFor('admin', 'u-SH38B-admin', orgB.id);
  const imgReq = new NextRequest(`http://localhost:3000/api/screenshots/${row.id}/image`, {
    headers: { cookie: `worklens_token=${adminTokenB}` },
  });
  const imgRes = await screenshotImageApi.GET(imgReq, { params: Promise.resolve({ id: row.id }) });
  assert.equal(imgRes.status, 404, 'org B must get 404 for org A screenshot');
});

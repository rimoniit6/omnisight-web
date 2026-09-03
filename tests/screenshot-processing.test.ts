/**
 * Phase 2 — screenshot storage/processing/thumbnail hardening tests.
 *
 * Covers:
 *   A. Upload enqueues async processing (processingStatus 'uploaded') without
 *      doing image work in the request lifecycle; original preserved.
 *   B. Worker generates bounded thumbnails (≤320px, aspect kept, never
 *      upscaled) for PNG/JPEG/WebP; original untouched; width/height backfilled
 *      for rows that were never parsed at upload (JPEG/WebP).
 *   C. Idempotency: a processed row is never reprocessed; re-running the
 *      worker creates no duplicate thumbnail objects.
 *   D. Failure handling: corrupt images retry (bounded) then mark
 *      processing_failed with a sanitized error; the ORIGINAL always survives.
 *      Missing original objects fail permanently (no infinite retry).
 *   E. Serving: /api/screenshots/[id]/thumbnail honors tenant isolation +
 *      session auth (mirrors the original image route); 404 when no thumbnail.
 *   F. Retention: stale rows purge original AND thumbnail objects together;
 *      fresh rows keep both; per-org isolation.
 *   G. DELETE removes thumbnail + original + row.
 *   H. Stats include thumbnail byte accounting (additive field).
 *   I. High-volume (10k rows): bounded worker drain, bounded retention purge,
 *      paginated list stays correct.
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_shotproc) with the
 * LOCAL storage driver (assertions touch the physical uploads/screenshots dir).
 *
 * Queue discipline: worker-count assertions run after `drainAllPending()` so
 * rows left 'uploaded' by earlier tests never skew exact counts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { rmSync, readdirSync } from 'node:fs';
import { NextRequest } from 'next/server';
import sharp from 'sharp';
import { req } from './helpers/request';

// ─── Test DB isolation (set BEFORE any app module import) ──────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_shotproc';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-shotproc-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@shotproc.local';
process.env.SUPER_ADMIN_PASSWORD = 'S3cure!ShotProc2026x';
process.env.STORAGE_DRIVER = 'local';
(process.env as Record<string, string>).NODE_ENV = 'test';

const SHOT_DIR = join(process.cwd(), 'uploads', 'screenshots');

before(() => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: 'pipe',
  });
  // Clean physical files from any prior run of this suite.
  rmSync(SHOT_DIR, { recursive: true, force: true });
});

type DbModule = typeof import('../src/lib/db');
let db: DbModule['db'];
let signJWT: (payload: { userId: string; email: string; role: string; organizationId?: string }) => Promise<string>;

let orgA: { id: string };
let orgB: { id: string };
let orgC: { id: string };
let empA: { id: string };
let empB: { id: string };
let empC: { id: string };
let adminAToken: string;
let adminBToken: string;
let adminCToken: string;
const AGENT_TOKEN_A = 'shotproc-agent-token-a-0123456789abcdef0123456789abcdef';
const AGENT_TOKEN_B = 'shotproc-agent-token-b-0123456789abcdef0123456789abcdef';

before(async () => {
  const dbModule = await import('../src/lib/db');
  db = dbModule.db;
  signJWT = (await import('../src/lib/auth')).signJWT;

  orgA = await db.organization.create({ data: { name: 'Shot Org A', slug: 'shot-org-a-p2' } });
  orgB = await db.organization.create({ data: { name: 'Shot Org B', slug: 'shot-org-b-p2' } });
  orgC = await db.organization.create({ data: { name: 'Shot Org C (bulk)', slug: 'shot-org-c-p2' } });

  applyConsentTransition = (await import('../src/lib/consent')).applyConsentTransition;

  empA = await db.employee.create({
    data: {
      employeeId: 'SHOT-EMP-A',
      firstName: 'Shot',
      lastName: 'Alpha',
      email: 'shot-a@p2.test',
      organizationId: orgA.id,
      status: 'active',
      agentApproved: true,
    },
  });
  empB = await db.employee.create({
    data: {
      employeeId: 'SHOT-EMP-B',
      firstName: 'Shot',
      lastName: 'Beta',
      email: 'shot-b@p2.test',
      organizationId: orgB.id,
      status: 'active',
      agentApproved: true,
    },
  });
  empC = await db.employee.create({
    data: {
      employeeId: 'SHOT-EMP-C',
      firstName: 'Shot',
      lastName: 'Gamma',
      email: 'shot-c@p2.test',
      organizationId: orgC.id,
      status: 'active',
      agentApproved: true,
    },
  });

  await db.agentToken.create({
    data: {
      token: AGENT_TOKEN_A,
      expiresAt: new Date(Date.now() + 3600_000),
      employee: { connect: { id: empA.id } },
      organization: { connect: { id: orgA.id } },
    },
  });
  await db.agentToken.create({
    data: {
      token: AGENT_TOKEN_B,
      expiresAt: new Date(Date.now() + 3600_000),
      employee: { connect: { id: empB.id } },
      organization: { connect: { id: orgB.id } },
    },
  });

  adminAToken = await signJWT({ userId: 'admin-a-p2', email: 'admin-a@p2.test', role: 'admin', organizationId: orgA.id });
  adminBToken = await signJWT({ userId: 'admin-b-p2', email: 'admin-b@p2.test', role: 'admin', organizationId: orgB.id });
  adminCToken = await signJWT({ userId: 'admin-c-p2', email: 'admin-c@p2.test', role: 'admin', organizationId: orgC.id });
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

let applyConsentTransition: (typeof import('../src/lib/consent'))['applyConsentTransition'];
import type { ConsentStatus } from '../src/lib/consent';

/** Publish a consent policy so a consent can be granted against it. */
async function publishPolicy(orgId: string, consentType: string, version: string) {
  const existing = await db.consentPolicy.findFirst({ where: { organizationId: orgId, consentType, version } });
  if (existing) return existing;
  return db.consentPolicy.create({
    data: {
      organizationId: orgId,
      consentType,
      version,
      title: `${consentType} policy`,
      content: 'Test policy content',
      status: 'published',
    },
  });
}

/** Grant screenshot consent for an employee (mirrors the screenshots suite). */
async function grantScreenshotConsent(employeeId: string, orgId: string) {
  await publishPolicy(orgId, 'screenshot', '1');
  await db.$transaction(async (tx) => {
    const existing = await tx.consent.findFirst({ where: { employeeId, consentType: 'screenshot' } });
    if (existing) {
      await applyConsentTransition(
        tx,
        { id: existing.id, status: existing.status as ConsentStatus, consentType: 'screenshot', organizationId: orgId },
        'granted',
        { performedBy: 'test' }
      );
    } else {
      const created = await tx.consent.create({
        data: { employeeId, consentType: 'screenshot', status: 'pending', organizationId: orgId },
      });
      await applyConsentTransition(
        tx,
        { id: created.id, status: 'pending', consentType: 'screenshot', organizationId: orgId },
        'granted',
        { performedBy: 'test' }
      );
    }
  });
}

/** Drain every currently-uploaded row (used to normalize the queue). */
async function drainAllPending() {
  const { processPendingScreenshots } = await import('../src/lib/screenshots/processing');
  await processPendingScreenshots(1000);
}

async function runWorker(limit?: number) {
  const { processPendingScreenshots } = await import('../src/lib/screenshots/processing');
  return processPendingScreenshots(limit);
}

async function pngFixture(width = 640, height = 400): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 90, b: 200 } },
  })
    .png()
    .toBuffer();
}

async function jpegFixture(width = 800, height = 600): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 120, b: 30 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

async function webpFixture(width = 320, height = 200): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 200, b: 120 } },
  })
    .webp({ quality: 80 })
    .toBuffer();
}

/** Claims PNG magic bytes but is corrupt past the header. */
function corruptPngFixture(): Buffer {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([head, Buffer.from('this is not a real png body at all', 'utf8')]);
}

async function uploadShotA(bytes: Buffer, mime: string, name: string, ts?: string) {
  const api = await import('../src/app/api/agent/screenshot/route');
  const form = new FormData();
  form.append('screenshot', new File([new Uint8Array(bytes)], name, { type: mime }));
  form.append('timestamp', ts || new Date().toISOString());
  form.append('appWindow', 'Test App');
  // A real NextRequest with the FormData body (multipart content-type is
  // derived by NextRequest — same as the existing screenshots suite).
  const res = await api.POST(
    new NextRequest('http://localhost:3000/api/agent/screenshot', {
      method: 'POST',
      headers: { authorization: `Bearer ${AGENT_TOKEN_A}` },
      body: form,
    })
  );
  assert.equal(res.status, 200, `upload must succeed (got ${res.status})`);
  const row = await db.screenshot.findFirst({
    where: { organizationId: orgA.id, fileName: name },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok(row, 'DB row must exist after upload');
  return { id: row.id, filePath: row.filePath };
}

// ═══════════════════════════════════════════════════════════════════════════
// A. Upload enqueues processing — no sync image work
// ═══════════════════════════════════════════════════════════════════════════
test('P2-01: upload persists original + enqueues processing (status uploaded, no thumbnail yet)', async () => {
  await grantScreenshotConsent(empA.id, orgA.id);
  const bytes = await pngFixture();
  const { id } = await uploadShotA(bytes, 'image/png', 'p2-01.png');

  const row = await db.screenshot.findUnique({ where: { id } });
  assert.equal(row?.processingStatus, 'uploaded', 'new upload must be enqueued for async processing');
  assert.equal(row?.processingAttempts, 0);
  assert.equal(row?.thumbnailPath, null, 'no thumbnail may exist during the request lifecycle');
  assert.equal(row?.processingError, null);

  // Original object persisted exactly as uploaded (source of truth untouched).
  const { getScreenshot } = await import('../src/lib/storage');
  const stored = await getScreenshot(orgA.id, row!.filePath);
  assert.ok(stored.equals(bytes), 'original bytes must round-trip unchanged');
});

// ═══════════════════════════════════════════════════════════════════════════
// B. Worker generates bounded thumbnails
// ═══════════════════════════════════════════════════════════════════════════
test('P2-02: worker processes PNG row — thumbnail ≤320px, aspect kept, original untouched', async () => {
  await drainAllPending(); // process P2-01's leftover row so counts are exact
  const bytes = await pngFixture(640, 400);
  const { id, filePath } = await uploadShotA(bytes, 'image/png', 'p2-02.png');
  const before = await db.screenshot.findUnique({ where: { id } });

  const result = await runWorker();
  assert.equal(result.processed, 1, 'exactly one row must be processed (queue was drained)');
  assert.equal(result.failed, 0);

  const row = await db.screenshot.findUnique({ where: { id } });
  assert.equal(row?.processingStatus, 'processed');
  assert.ok(row?.processedAt, 'processedAt must be set');
  assert.ok(row?.thumbnailPath?.endsWith('.thumb.png'), `thumb path: ${row?.thumbnailPath}`);
  assert.ok((row?.thumbnailSize ?? 0) > 0, 'thumbnailSize must be recorded');

  const originalName = filePath.split('/').pop()!;
  const thumbName = row!.thumbnailPath!.split('/').pop()!;
  const dir = readdirSync(SHOT_DIR);
  assert.ok(dir.includes(originalName), 'original file must still exist');
  assert.ok(dir.includes(thumbName), 'thumbnail file must exist on disk');

  // Dimensions: longest edge ≤ 320 and aspect ratio preserved (640×400 → 320×200).
  const meta = await sharp(join(SHOT_DIR, thumbName)).metadata();
  assert.ok((meta.width ?? 0) <= 320 && (meta.height ?? 0) <= 320, `thumb too large: ${meta.width}x${meta.height}`);
  assert.equal(meta.width, 320, 'longest edge must be exactly the max for a 640-wide source');
  assert.equal(meta.height, 200, 'aspect ratio (16:10) must be preserved');

  // Original bytes unchanged after processing.
  const { getScreenshot } = await import('../src/lib/storage');
  const stored = await getScreenshot(orgA.id, before!.filePath);
  assert.ok(stored.equals(bytes), 'original must never be altered by processing');
});

test('P2-03: worker never upscales small sources; JPEG/WebP rows get width/height backfilled', async () => {
  await drainAllPending();
  const jpg = await jpegFixture(100, 80);
  const { id: jpgId } = await uploadShotA(jpg, 'image/jpeg', 'p2-03a.jpg');
  const jpgBefore = await db.screenshot.findUnique({ where: { id: jpgId } });
  assert.equal(jpgBefore?.width, null, 'JPEG dimensions are never parsed at upload (pre-existing contract)');

  const webp = await webpFixture();
  const { id: webpId } = await uploadShotA(webp, 'image/webp', 'p2-03b.webp');

  const result = await runWorker();
  assert.equal(result.processed, 2);
  assert.equal(result.failed, 0);

  const jpgRow = await db.screenshot.findUnique({ where: { id: jpgId } });
  const jpgMeta = await sharp(join(SHOT_DIR, jpgRow!.thumbnailPath!.split('/').pop()!)).metadata();
  assert.equal(jpgRow?.width, 100, 'width must be backfilled from the actual decode');
  assert.equal(jpgRow?.height, 80);
  assert.equal(jpgMeta.width, 100, 'small source must never be upscaled');
  assert.equal(jpgMeta.height, 80);

  const webpRow = await db.screenshot.findUnique({ where: { id: webpId } });
  const webpThumbName = webpRow!.thumbnailPath!.split('/').pop()!;
  assert.ok(webpThumbName.endsWith('.thumb.webp'), 'thumb keeps the source format');
  assert.equal(webpRow?.width, 320, 'webp dims backfilled too');
});

test('P2-04: worker is bounded per run and leaves the rest queued', async () => {
  await drainAllPending();
  const a = await uploadShotA(await pngFixture(200, 200), 'image/png', 'p2-04a.png');
  const b = await uploadShotA(await pngFixture(200, 200), 'image/png', 'p2-04b.png');
  const c = await uploadShotA(await pngFixture(200, 200), 'image/png', 'p2-04c.png');

  const r1 = await runWorker(1);
  assert.equal(r1.processed, 1);
  const statuses1 = await db.screenshot.findMany({
    where: { id: { in: [a.id, b.id, c.id] } },
    select: { processingStatus: true },
  });
  assert.equal(statuses1.filter((s) => s.processingStatus === 'processed').length, 1, 'only one may be processed per run');
  assert.equal(statuses1.filter((s) => s.processingStatus === 'uploaded').length, 2, 'the rest must remain queued');

  await runWorker(10);
  const statuses2 = await db.screenshot.findMany({
    where: { id: { in: [a.id, b.id, c.id] } },
    select: { processingStatus: true },
  });
  assert.equal(statuses2.every((s) => s.processingStatus === 'processed'), true, 'second run drains the remainder');
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Idempotency
// ═══════════════════════════════════════════════════════════════════════════
test('P2-05: reprocessing never duplicates thumbnails (idempotent rerun)', async () => {
  await drainAllPending();
  const { id } = await uploadShotA(await pngFixture(500, 300), 'image/png', 'p2-05.png');
  const r1 = await runWorker();
  assert.equal(r1.processed, 1);

  const row1 = await db.screenshot.findUnique({ where: { id } });
  const thumbName = row1!.thumbnailPath!.split('/').pop()!;
  assert.equal(readdirSync(SHOT_DIR).filter((f) => f === thumbName).length, 1);

  // Second run: no 'uploaded' rows remain → zero processed → zero new objects.
  const r2 = await runWorker();
  assert.equal(r2.processed, 0, 'a processed row must never be picked up again');
  assert.equal(readdirSync(SHOT_DIR).filter((f) => f === thumbName).length, 1, 'no duplicate thumbnail object may exist');
});

// ═══════════════════════════════════════════════════════════════════════════
// D. Failure handling
// ═══════════════════════════════════════════════════════════════════════════
test('P2-06: corrupt image retries are bounded → processing_failed with sanitized error; original survives', async () => {
  await drainAllPending();
  const corrupt = corruptPngFixture();
  const { id, filePath } = await uploadShotA(corrupt, 'image/png', 'p2-06.png');

  const { MAX_SCREENSHOT_PROCESSING_ATTEMPTS } = await import('../src/lib/screenshots/processing');
  for (let i = 0; i < MAX_SCREENSHOT_PROCESSING_ATTEMPTS; i++) {
    await runWorker();
    const row = await db.screenshot.findUnique({ where: { id } });
    assert.ok(row, 'row must always exist');
    if (i < MAX_SCREENSHOT_PROCESSING_ATTEMPTS - 1) {
      assert.equal(row?.processingStatus, 'uploaded', `attempt ${i + 1} must stay retryable`);
      assert.equal(row?.processingAttempts, i + 1);
    }
  }

  const row = await db.screenshot.findUnique({ where: { id } });
  assert.equal(row?.processingStatus, 'processing_failed', 'row must fail permanently after MAX attempts');
  assert.equal(row?.processingAttempts, MAX_SCREENSHOT_PROCESSING_ATTEMPTS);
  assert.equal(row?.processingError, 'decode_failed', 'sanitized category, never a path/stack');
  assert.equal(row?.thumbnailPath, null, 'no thumbnail may exist for a corrupt image');

  // The ORIGINAL must survive the whole retry cycle, byte for byte.
  const { getScreenshot } = await import('../src/lib/storage');
  const stored = await getScreenshot(orgA.id, filePath);
  assert.ok(stored.equals(corrupt), 'original must be preserved on processing failure');

  // No infinite retry: another run changes nothing.
  await runWorker();
  const after = await db.screenshot.findUnique({ where: { id } });
  assert.equal(after?.processingStatus, 'processing_failed');
  assert.equal(after?.processingAttempts, MAX_SCREENSHOT_PROCESSING_ATTEMPTS);
});

test('P2-07: missing original object → permanent failure; one bad row cannot abort a batch', async () => {
  await drainAllPending();
  const a = await uploadShotA(await pngFixture(300, 300), 'image/png', 'p2-07a.png');
  const b = await uploadShotA(await pngFixture(300, 300), 'image/png', 'p2-07b.png');

  // Delete the physical object for row A (simulates Case B orphan).
  const { deleteScreenshot } = await import('../src/lib/storage');
  await deleteScreenshot(orgA.id, a.filePath);

  const result = await runWorker();
  assert.equal(result.processed, 1, 'healthy row must still be processed');
  assert.equal(result.failed, 1, 'missing-original row must fail');

  const rowAMeta = await db.screenshot.findUnique({ where: { id: a.id } });
  assert.equal(rowAMeta?.processingStatus, 'processing_failed');
  assert.equal(rowAMeta?.processingError, 'original_missing', 'sanitized reason');
  assert.equal(rowAMeta?.processingAttempts, 3, 'permanent failure is recorded without further retries');

  const rowBMeta = await db.screenshot.findUnique({ where: { id: b.id } });
  assert.equal(rowBMeta?.processingStatus, 'processed');

  // Subsequent runs don't churn on the permanently-failed row.
  await runWorker();
  const after = await db.screenshot.findUnique({ where: { id: a.id } });
  assert.equal(after?.processingStatus, 'processing_failed');
});

// ═══════════════════════════════════════════════════════════════════════════
// E. Serving + authorization
// ═══════════════════════════════════════════════════════════════════════════
test('P2-08: thumbnail route serves processed thumbnail with safe headers; 404 before processing', async () => {
  await drainAllPending();
  const processed = await uploadShotA(await pngFixture(400, 300), 'image/png', 'p2-08a.png');
  await runWorker();

  const thumbApi = await import('../src/app/api/screenshots/[id]/thumbnail/route');
  const res = await thumbApi.GET(req(adminAToken, { url: `http://localhost:3000/api/screenshots/${processed.id}/thumbnail` }), {
    params: Promise.resolve({ id: processed.id }),
  });
  assert.equal(res.status, 200);
  const headers = Object.fromEntries(res.headers.entries());
  assert.equal(headers['content-type'], 'image/png');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['cache-control'], 'private, max-age=86400');
  const thumbBytes = Buffer.from(await res.arrayBuffer());
  assert.ok(thumbBytes.length > 0, 'thumbnail body must be present');
  const meta = await sharp(thumbBytes).metadata();
  assert.ok((meta.width ?? 0) <= 320, 'served thumbnail respects the size policy');

  // A row that is still 'uploaded' → 404 (client falls back to original URL;
  // this route NEVER triggers synchronous thumbnail generation).
  const fresh = await uploadShotA(await pngFixture(100, 100), 'image/png', 'p2-08b.png');
  const resFresh = await thumbApi.GET(req(adminAToken, { url: `http://localhost:3000/api/screenshots/${fresh.id}/thumbnail` }), {
    params: Promise.resolve({ id: fresh.id }),
  });
  assert.equal(resFresh.status, 404, 'no thumbnail yet → 404, never a sync generation trigger');

  // Original image route still works for the processed row.
  const imageApi = await import('../src/app/api/screenshots/[id]/image/route');
  const resOrig = await imageApi.GET(req(adminAToken, { url: `http://localhost:3000/api/screenshots/${processed.id}/image` }), {
    params: Promise.resolve({ id: processed.id }),
  });
  assert.equal(resOrig.status, 200, 'original must remain available after processing');
});

test('P2-09: thumbnail access honors tenant isolation + auth (cross-org 404, unauth 401)', async () => {
  await drainAllPending();
  const processed = await uploadShotA(await pngFixture(400, 300), 'image/png', 'p2-09.png');
  await runWorker();

  const thumbApi = await import('../src/app/api/screenshots/[id]/thumbnail/route');

  // Org B admin cannot read Org A's thumbnail (404 concealment — same as the
  // original image route).
  const crossOrg = await thumbApi.GET(req(adminBToken, { url: `http://localhost:3000/api/screenshots/${processed.id}/thumbnail` }), {
    params: Promise.resolve({ id: processed.id }),
  });
  assert.equal(crossOrg.status, 404, 'cross-org thumbnail access must be concealed');

  // No session → 401 (global middleware normally enforces; route re-checks).
  const unauth = await thumbApi.GET(req('', { url: `http://localhost:3000/api/screenshots/${processed.id}/thumbnail` }), {
    params: Promise.resolve({ id: processed.id }),
  });
  assert.equal(unauth.status, 401);

  // Nonexistent id → 404.
  const missing = await thumbApi.GET(req(adminAToken, { url: 'http://localhost:3000/api/screenshots/doesnotexist123/thumbnail' }), {
    params: Promise.resolve({ id: 'doesnotexist123' }),
  });
  assert.equal(missing.status, 404);
});

// ═══════════════════════════════════════════════════════════════════════════
// F. Retention — original + thumbnail purged together, org-scoped
// ═══════════════════════════════════════════════════════════════════════════
test('P2-10: retention purges stale original + thumbnail together; fresh rows and other orgs untouched', async () => {
  await drainAllPending();
  // Stale org-A shot (40 days old → past the default 30-day window) + fresh.
  const staleA = await uploadShotA(await pngFixture(300, 300), 'image/png', 'p2-10a.png', new Date(Date.now() - 1000 * 86400 * 40).toISOString());
  const freshA = await uploadShotA(await pngFixture(300, 300), 'image/png', 'p2-10b.png');
  await runWorker();

  const staleRow = await db.screenshot.findUnique({ where: { id: staleA.id } });
  const freshRow = await db.screenshot.findUnique({ where: { id: freshA.id } });
  assert.equal(staleRow?.processingStatus, 'processed');
  assert.equal(freshRow?.processingStatus, 'processed');
  const staleOriginal = staleA.filePath.split('/').pop()!;
  const staleThumb = staleRow!.thumbnailPath!.split('/').pop()!;
  const freshOriginal = freshA.filePath.split('/').pop()!;
  const freshThumb = freshRow!.thumbnailPath!.split('/').pop()!;
  assert.ok(readdirSync(SHOT_DIR).includes(staleThumb), 'precondition: stale thumb exists on disk');

  // An org-B screenshot (also old) must never be touched by org-A retention.
  await grantScreenshotConsent(empB.id, orgB.id);
  const uploadBApi = await import('../src/app/api/agent/screenshot/route');
  const formB = new FormData();
  formB.append('screenshot', new File([new Uint8Array(await pngFixture(300, 300))], 'p2-10c.png', { type: 'image/png' }));
  formB.append('timestamp', new Date(Date.now() - 1000 * 86400 * 40).toISOString());
  const resB = await uploadBApi.POST(
    new NextRequest('http://localhost:3000/api/agent/screenshot', {
      method: 'POST',
      headers: { authorization: `Bearer ${AGENT_TOKEN_B}` },
      body: formB,
    })
  );
  assert.equal(resB.status, 200);

  const { runRetentionForOrg } = await import('../src/lib/jobs/retention');
  const result = await runRetentionForOrg(orgA.id, new Date(), 500);

  assert.equal(await db.screenshot.findUnique({ where: { id: staleA.id } }), null, 'stale row must be purged');
  assert.ok(await db.screenshot.findUnique({ where: { id: freshA.id } }), 'fresh row must survive');

  const dirAfter = readdirSync(SHOT_DIR);
  assert.ok(!dirAfter.includes(staleOriginal), 'stale ORIGINAL file must be deleted');
  assert.ok(!dirAfter.includes(staleThumb), 'stale THUMBNAIL file must be deleted');
  assert.ok(dirAfter.includes(freshOriginal), 'fresh original must survive');
  assert.ok(dirAfter.includes(freshThumb), 'fresh thumbnail must survive');

  assert.equal(await db.screenshot.count({ where: { organizationId: orgB.id } }), 1, 'org B row must never be touched');
  assert.ok(result.screenshots >= 1, 'retention reports the purged count');
});

// ═══════════════════════════════════════════════════════════════════════════
// G. DELETE removes all artifacts
// ═══════════════════════════════════════════════════════════════════════════
test('P2-11: admin DELETE removes thumbnail + original objects and the row', async () => {
  await drainAllPending();
  const shot = await uploadShotA(await pngFixture(400, 300), 'image/png', 'p2-11.png');
  await runWorker();
  const row = await db.screenshot.findUnique({ where: { id: shot.id } });
  const orig = shot.filePath.split('/').pop()!;
  const thumb = row!.thumbnailPath!.split('/').pop()!;
  assert.ok(readdirSync(SHOT_DIR).includes(thumb), 'precondition: thumbnail on disk');

  const detailApi = await import('../src/app/api/screenshots/[id]/route');
  const del = await detailApi.DELETE(
    req(adminAToken, { method: 'DELETE', url: `http://localhost:3000/api/screenshots/${shot.id}` }),
    { params: Promise.resolve({ id: shot.id }) }
  );
  assert.equal(del.status, 200);

  const dir = readdirSync(SHOT_DIR);
  assert.ok(!dir.includes(orig), 'original must be deleted');
  assert.ok(!dir.includes(thumb), 'thumbnail must be deleted (no orphan)');
  assert.equal(await db.screenshot.findUnique({ where: { id: shot.id } }), null, 'row must be deleted');
});

// ═══════════════════════════════════════════════════════════════════════════
// H. Stats — additive thumbnail byte accounting
// ═══════════════════════════════════════════════════════════════════════════
test('P2-12: stats expose thumbnail bytes additively without changing totalStorage semantics', async () => {
  await drainAllPending();
  await uploadShotA(await pngFixture(400, 300), 'image/png', 'p2-12a.png');
  await uploadShotA(await pngFixture(200, 150), 'image/png', 'p2-12b.png');
  await runWorker();

  const statsApi = await import('../src/app/api/screenshots/stats/route');
  const res = await statsApi.GET(req(adminAToken, { url: 'http://localhost:3000/api/screenshots/stats' }));
  const body = await res.json();

  const rows = await db.screenshot.findMany({ where: { organizationId: orgA.id } });
  const origSum = rows.reduce((n, r) => n + r.fileSize, 0);
  const thumbSum = rows.reduce((n, r) => n + (r.thumbnailSize ?? 0), 0);

  assert.equal(body.totalStorage, origSum, 'totalStorage keeps meaning original bytes (compat)');
  assert.ok(thumbSum > 0, 'precondition: thumbnails exist in org A');
  assert.equal(body.thumbnailStorage, thumbSum, 'thumbnailStorage equals the derived sum');
});

// ═══════════════════════════════════════════════════════════════════════════
// I. High-volume safety (10,000 rows in a dedicated org)
// ═══════════════════════════════════════════════════════════════════════════
test('P2-13: 10k-row dataset — bounded worker drain, bounded retention purge, bounded list page, no cross-org leak', async () => {
  await drainAllPending(); // normalize the global queue before bulk insert
  const TOTAL = 10_000;
  const now = Date.now();
  const rows = [];
  for (let i = 0; i < TOTAL; i++) {
    rows.push({
      employeeId: empC.id,
      organizationId: orgC.id,
      filePath: `/uploads/screenshots/bulk-${i}.png`,
      fileName: `bulk-${i}.png`,
      fileSize: 1000,
      mimeType: 'image/png',
      capturedAt: new Date(i % 2 === 0 ? now - 1000 * 86400 * 40 : now), // half stale, half fresh
      processingStatus: i < 250 ? 'uploaded' : 'processed', // 250 await the worker
      processingAttempts: 0,
      width: 640,
      height: 400,
    });
  }
  await db.screenshot.createMany({ data: rows });
  assert.equal(await db.screenshot.count({ where: { organizationId: orgC.id } }), TOTAL);

  // The worker only ever drains its bounded slice per run (250 uploaded; the
  // bulk files do not exist on disk → rows fail fast as 'original_missing').
  const r1 = await runWorker(100);
  assert.equal(r1.failed, 100, 'first run consumes exactly its limit');
  assert.equal(
    await db.screenshot.count({ where: { organizationId: orgC.id, processingStatus: 'uploaded' } }),
    150,
    'remainder stays queued'
  );

  await runWorker(500);
  assert.equal(
    await db.screenshot.count({
      where: { organizationId: orgC.id, processingStatus: 'processing_failed', processingError: 'original_missing' },
    }),
    250,
    'all missing-original bulk rows fail permanently, no retry storm'
  );

  // Retention purge is bounded per org run (stale half is 5,000; limit 500).
  const { runRetentionForOrg } = await import('../src/lib/jobs/retention');
  const ret = await runRetentionForOrg(orgC.id, new Date(), 500);
  assert.equal(ret.screenshots, 500, 'retention purges at most its per-run limit');

  // List API stays correct on the big dataset (org-scoped, index-backed).
  const listApi = await import('../src/app/api/screenshots/route');
  const listRes = await listApi.GET(req(adminCToken, { url: 'http://localhost:3000/api/screenshots?page=3&pageSize=24' }));
  assert.equal(listRes.status, 200);
  const listBody = await listRes.json();
  assert.equal(listBody.data.length, 24);
  assert.equal(listBody.page, 3);
  assert.ok(listBody.total > 9_000, `total reflects remaining rows: ${listBody.total}`);

  // No cross-org leakage at volume: org B and org A totals are their own.
  const orgBList = await listApi.GET(req(adminBToken, { url: 'http://localhost:3000/api/screenshots?pageSize=100' }));
  const orgBBody = await orgBList.json();
  assert.equal(orgBBody.total, 1, 'org B sees only its own 1 screenshot');
  const orgAList = await listApi.GET(req(adminAToken, { url: 'http://localhost:3000/api/screenshots?pageSize=100' }));
  const orgABody = await orgAList.json();
  assert.ok(orgABody.total > 0 && orgABody.total < 100, `org A sees only its own rows (${orgABody.total})`);
});

test('P2-14: upload response contract is unchanged by Phase 2 (same fields, no sync work)', async () => {
  const api = await import('../src/app/api/agent/screenshot/route');
  const form = new FormData();
  const bytes = await pngFixture(100, 100);
  form.append('screenshot', new File([new Uint8Array(bytes)], 'p2-14.png', { type: 'image/png' }));
  form.append('timestamp', new Date().toISOString());
  const res = await api.POST(
    new NextRequest('http://localhost:3000/api/agent/screenshot', {
      method: 'POST',
      headers: { authorization: `Bearer ${AGENT_TOKEN_A}` },
      body: form,
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.ok(typeof body.filename === 'string');
  assert.ok(typeof body.path === 'string');
  assert.ok(typeof body.size === 'number');
  assert.ok(typeof body.timestamp === 'string');
  assert.equal(body.appWindow, null, 'no appWindow supplied → null (same as before)');
  assert.equal('deduplicated' in body, false, 'no Phase 1 activity fields leak into screenshots');
});

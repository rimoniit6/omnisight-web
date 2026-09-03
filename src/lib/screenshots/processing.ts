import sharp from 'sharp';
import { basename, extname } from 'path';
import { db } from '@/lib/db';
import { log } from '@/lib/logger';
import { getScreenshot, putScreenshot, isNotFound } from '@/lib/storage';
import type { AllowedScreenshotMime } from '@/lib/screenshots/storage';

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2 — screenshot thumbnail processing
//
// Design (see docs/PHASE-2-IMPLEMENTATION.md):
//  - The UPLOAD path never performs image processing. It persists the original
//    and leaves the row in `processingStatus='uploaded'` (DB default) — that
//    state IS the queue.
//  - A background worker (`processPendingScreenshots`) drains rows oldest-first
//    in bounded batches, invoked under the JobRun lease ('screenshot_processing')
//    by the same scheduler that runs every other background job. The original
//    screenshot is always the source of truth and is never modified.
//  - Idempotent + restart-safe: the in-flight state is deliberately NOT
//    persisted. A crash mid-row leaves the row 'uploaded'; the next run simply
//    re-processes it. The thumbnail object key is deterministic
//    (<name>.thumb.<ext>), so a re-run overwrites the same object instead of
//    creating a duplicate. A row already 'processed' is never picked up again.
//  - Bounded retries: MAX_SCREENSHOT_PROCESSING_ATTEMPTS (3) per row. After the
//    limit the row is marked 'processing_failed' with a sanitized diagnostic.
//    A single corrupt screenshot cannot consume worker resources forever.
//  - Failure isolation: the original is preserved on ANY failure. Missing
//    original objects are treated as permanent (mark failed immediately).
// ═══════════════════════════════════════════════════════════════════════════

/** Longest edge of generated thumbnails (px). Never upscaled, aspect kept. */
export const SCREENSHOT_THUMBNAIL_MAX_DIMENSION = 320;

/** Thumbnail encode quality for lossy formats (JPEG/WebP). */
export const SCREENSHOT_THUMBNAIL_QUALITY = 80;

/** Per-row processing attempts before the row is marked failed. */
export const MAX_SCREENSHOT_PROCESSING_ATTEMPTS = 3;

/** Default rows drained per scheduler run (bounded CPU per tick). */
export const SCREENSHOT_PROCESSING_DEFAULT_LIMIT = 100;

/**
 * Decompression-bomb guard: refuse to decode an image whose pixel dimensions
 * exceed this many pixels. Screenshots from real agents are ≤ ~16 MP (4K);
 * the 5 MB upload cap plus this bound keeps memory/CPU per decode bounded.
 */
const MAX_DECODE_PIXELS = 64_000_000;

export type ScreenshotProcessingStatus = 'uploaded' | 'processed' | 'processing_failed';

/**
 * Deterministic thumbnail object filename for an original screenshot
 * filename, e.g. `a1b2c3.png` → `a1b2c3.thumb.png`. The derived name always
 * stays inside the same storage root as the original (same basename rules,
 * same extension allowlist), so no new path handling exists anywhere.
 */
export function thumbnailFilenameFor(originalFilename: string): string {
  const base = basename(originalFilename);
  const ext = extname(base); // includes the dot
  const stem = ext ? base.slice(0, -ext.length) : base;
  return `${stem}.thumb${ext}`;
}

/** Humanized status string for observability. */
export function processingStatusLabel(status: string): string {
  switch (status) {
    case 'uploaded':
      return 'uploaded';
    case 'processed':
      return 'processed';
    case 'processing_failed':
      return 'processing_failed';
    default:
      return status;
  }
}

/**
 * Generate a ≤ SCREENSHOT_THUMBNAIL_MAX_DIMENSION thumbnail from raw image
 * bytes. Keeps the input format (PNG/JPEG/WebP stay themselves — the same
 * magic-byte validation the upload path enforces therefore also applies to
 * thumbnails when served). Never upscales: a source smaller than the max
 * dimension is returned at its natural size. The encode is deterministic for
 * the same input bytes + policy.
 *
 * Returns the thumbnail bytes plus the ORIGINAL decoded dimensions (used to
 * backfill width/height for JPEG/WebP, which today are never parsed). Throws
 * only when the source is not a decodable raster image (corrupt/unsupported)
 * or decoding exceeds MAX_DECODE_PIXELS — callers treat that as a row failure.
 */
export async function generateThumbnail(
  sourceBytes: Buffer,
  sourceMime: AllowedScreenshotMime
): Promise<{ bytes: Buffer; width: number; height: number }> {
  const pipeline = sharp(sourceBytes, {
    // Refuse absurdly large decodes (decompression-bomb protection) — an
    // image that claims more pixels than this fails fast instead of exhausting
    // worker memory/CPU.
    limitInputPixels: MAX_DECODE_PIXELS,
  });

  const metadata = await pipeline.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  let resized = pipeline
    .rotate() // honor EXIF orientation so thumbnails are never sideways
    .resize({
      width: SCREENSHOT_THUMBNAIL_MAX_DIMENSION,
      height: SCREENSHOT_THUMBNAIL_MAX_DIMENSION,
      fit: 'inside', // preserve aspect ratio; never crop
      withoutEnlargement: true, // never upscale small captures
    });

  // Encode back to the source format with a bounded quality for lossy types.
  if (sourceMime === 'image/png') {
    resized = resized.png();
  } else if (sourceMime === 'image/webp') {
    resized = resized.webp({ quality: SCREENSHOT_THUMBNAIL_QUALITY });
  } else {
    resized = resized.jpeg({ quality: SCREENSHOT_THUMBNAIL_QUALITY });
  }

  const bytes = await resized.toBuffer();
  if (width === 0 || height === 0) {
    throw new Error('image_metadata_unavailable');
  }
  return { bytes, width, height };
}

/**
 * Process ONE screenshot row: read original → generate thumbnail → store →
 * update row. Never mutates the original object. Returns the outcome so the
 * batch loop can count successes/failures.
 */
export async function processScreenshotRow(row: {
  id: string;
  organizationId: string;
  employeeId: string;
  filePath: string;
  mimeType: string;
  processingAttempts: number;
  /** Original width — used to backfill JPEG/WebP rows that were never parsed. */
  width: number | null;
}): Promise<'processed' | 'failed' | 'skipped'> {
  const { id, organizationId, filePath, mimeType } = row;

  // Sanity: the physical original is required. A row whose object is missing
  // cannot ever produce a thumbnail — treat as permanent failure (Case B in
  // the orphan audit): mark failed with a safe diagnostic and stop retrying.
  let sourceBytes: Buffer;
  try {
    sourceBytes = await getScreenshot(organizationId, filePath);
  } catch (error) {
    const message = isNotFound(error) ? 'original_missing' : 'storage_read_failed';
    await markRowFailed(id, message, MAX_SCREENSHOT_PROCESSING_ATTEMPTS, organizationId);
    return 'failed';
  }

  const attemptsAfter = row.processingAttempts + 1;
  let thumb: { bytes: Buffer; width: number; height: number };
  try {
    thumb = await generateThumbnail(sourceBytes, mimeType as AllowedScreenshotMime);
  } catch (error) {
    // Decode/encode failure — retry until MAX_SCREENSHOT_PROCESSING_ATTEMPTS.
    const attempts = row.processingAttempts + 1;
    await markRowFailed(
      id,
      'decode_failed',
      attempts,
      organizationId,
      attempts < MAX_SCREENSHOT_PROCESSING_ATTEMPTS
    );
    log.warn('screenshots.processing.retry', {
      screenshotId: id,
      orgId: organizationId.slice(0, 8),
      attempt: attempts,
      max: MAX_SCREENSHOT_PROCESSING_ATTEMPTS,
      error: String((error as Error)?.message ?? error),
    });
    return 'failed';
  }

  // Deterministic key: same original filename → same thumbnail object. A
  // crash between put and DB update is repaired by the next run overwriting
  // this same object — never a duplicate.
  const thumbFilename = thumbnailFilenameFor(basename(filePath));
  try {
    await putScreenshot(organizationId, thumbFilename, thumb.bytes, mimeType);
  } catch {
    await markRowFailed(
      id,
      'storage_write_failed',
      attemptsAfter,
      organizationId,
      attemptsAfter < MAX_SCREENSHOT_PROCESSING_ATTEMPTS
    );
    return 'failed';
  }

  try {
    await db.screenshot.update({
      where: { id },
      data: {
        processingStatus: 'processed',
        processedAt: new Date(),
        processingError: null,
        thumbnailPath: `/uploads/screenshots/${thumbFilename}`,
        thumbnailSize: thumb.bytes.length,
        // Backfill width/height only when they are NULL (JPEG/WebP rows were
        // never parsed at upload). Never overwrite an existing value.
        ...(row.width === null ? { width: thumb.width, height: thumb.height } : {}),
      },
    });
  } catch (error) {
    // DB update failed after the object was written — the deterministic key
    // means the next run overwrites it; the row stays 'uploaded' for retry.
    log.error('screenshots.processing.db_update_failed', {
      screenshotId: id,
      orgId: organizationId.slice(0, 8),
      error: String((error as Error)?.message ?? error),
    });
    throw error;
  }

  log.info('screenshots.processing.completed', {
    screenshotId: id,
    orgId: organizationId.slice(0, 8),
    attempt: row.processingAttempts + 1,
    originalBytes: sourceBytes.length,
    thumbnailBytes: thumb.bytes.length,
    thumbnailWidth: thumb.width,
    thumbnailHeight: thumb.height,
  });
  return 'processed';
}

/**
 * Bounded drain of rows awaiting thumbnail generation. Selects the oldest
 * 'uploaded' rows first (FIFO fairness across the whole tenant set — the scan
 * is index-backed on (processingStatus, capturedAt) and never touches
 * 'processed' rows). Each row is processed individually with its own
 * try/catch, so one corrupt screenshot can never abort the batch.
 */
export async function processPendingScreenshots(limit = SCREENSHOT_PROCESSING_DEFAULT_LIMIT): Promise<{
  processed: number;
  failed: number;
  errors: string[];
}> {
  const result = { processed: 0, failed: 0, errors: [] as string[] };

  const pending = await db.screenshot.findMany({
    where: { processingStatus: 'uploaded', processingAttempts: { lt: MAX_SCREENSHOT_PROCESSING_ATTEMPTS } },
    orderBy: { capturedAt: 'asc' },
    take: Math.min(limit, 500), // hard safety ceiling per run
    select: {
      id: true,
      organizationId: true,
      employeeId: true,
      filePath: true,
      mimeType: true,
      processingAttempts: true,
      width: true,
    },
  });

  if (pending.length === 0) return result;

  log.info('screenshots.processing.batch_started', { count: pending.length });

  for (const row of pending) {
    try {
      const outcome = await processScreenshotRow(row);
      if (outcome === 'processed') result.processed += 1;
      else result.failed += 1;
    } catch (error) {
      // processScreenshotRow throws only on a DB failure after the object was
      // written. The row stays 'uploaded' (deterministic key ⇒ overwrite on
      // the next run), so this is a retryable, isolated failure.
      result.failed += 1;
      result.errors.push(`${row.id}: ${String((error as Error)?.message ?? error)}`);
    }
  }

  log.info('screenshots.processing.batch_completed', {
    processed: result.processed,
    failed: result.failed,
    errors: result.errors.length,
  });
  return result;
}

// ─── helpers ───────────────────────────────────────────────────────────────

/**
 * Advance a row's failure bookkeeping. When the attempt count reaches the max
 * the row is permanently marked 'processing_failed' with a SANITIZED error
 * category (never a filesystem path, stack trace or storage credential). Below
 * the max the row stays 'uploaded' so a later scheduler run retries it.
 */
async function markRowFailed(
  id: string,
  category: string,
  attempts: number,
  organizationId: string,
  retryable = false
): Promise<void> {
  const permanent = attempts >= MAX_SCREENSHOT_PROCESSING_ATTEMPTS;
  await db.screenshot.update({
    where: { id },
    data: {
      processingStatus: permanent ? 'processing_failed' : 'uploaded',
      processingAttempts: permanent ? MAX_SCREENSHOT_PROCESSING_ATTEMPTS : attempts,
      processingError: category,
    },
  });
  log.warn('screenshots.processing.failed', {
    screenshotId: id,
    orgId: organizationId.slice(0, 8),
    attempt: attempts,
    max: MAX_SCREENSHOT_PROCESSING_ATTEMPTS,
    status: processingStatusLabel(permanent ? 'processing_failed' : 'uploaded'),
    retryable,
    reason: category,
  });
}

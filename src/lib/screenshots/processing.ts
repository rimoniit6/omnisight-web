import sharp from 'sharp';
import { basename, extname } from 'path';
import type { PrismaClient } from '@prisma/client';
import { db } from '@/lib/db';
import { getPrismaForOrg } from '@/lib/org-db';
import { log } from '@/lib/logger';
import { getScreenshot, putScreenshot, isNotFound } from '@/lib/storage';
import type { AllowedScreenshotMime } from '@/lib/screenshots/storage';
import {
  callAIProviderVision,
  getSettings,
  aiInsightsEnabledForOrg,
  type AIProviderResult,
  type ImageInput,
} from '@/lib/ai-provider-helper';

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
//
//  Phase 3 — vision task detection + PII redaction (bg job only):
//  - Per-org AI gate (fail-close): `ai_insights_enabled` is false OR no AI key
//    resolves → ZERO AI work (no Vision calls, no annotations). The gate reads
//    the org's own OrganizationSetting with the platform SystemSetting fallback.
//  - Step order per row: (A) Vision PII detection → [x,y,w,h] boxes; (B) blur
//    those regions with sharp; (C) Vision task detection run on the BLURRED
//    image; (D) persist. The blurred image OVERWRITES the main stored object
//    (same deterministic key) when PII was found; no PII → the original object
//    is never rewritten.
//  - Privacy invariant: a successful PII blur is NEVER undone by a later
//    classification failure (the blurred image still lands on disk). When the
//    PII call itself fails/unparses, the original stays stored untouched.
//  - AI failure is never a row failure: `analysisFailed=true` + `aiAnalysis=null`
//    record the miss; the row still completes thumbnail processing. Row-level
//    AI work is injectable (`opts.aiVision`) so tests drive it without egress.
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

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3 — vision task detection + PII redaction
// ═══════════════════════════════════════════════════════════════════════════

/** Gaussian sigma used when blurring detected PII regions (heavy enough to render text illegible). */
export const PII_BLUR_SIGMA = 10;

/** Prompt verbatim per Phase 3 spec — PII detection with [x,y,w,h] boxes. */
const PII_DETECTION_SYSTEM_PROMPT =
  'You are a PII detection system for workplace screenshots. ' +
  'Detect any PII (Credit Cards, Passwords, Emails, Phone Numbers, SSN) in the screenshot. ' +
  'Return bounding boxes [x,y,w,h] for each. If none, return empty array. ' +
  'Respond ONLY with a JSON array of { "x": number, "y": number, "w": number, "h": number }, e.g. [{"x":10,"y":20,"w":120,"h":16}].';

const PII_DETECTION_USER_PROMPT = 'Detect any PII (Credit Cards, Passwords, Emails, Phone Numbers, SSN) in the screenshot. Return bounding boxes [x,y,w,h] for each. If none, respond with an empty array [].';

/** Prompt verbatim per Phase 3 spec — task classification over the blurred image. */
const TASK_DETECTION_SYSTEM_PROMPT =
  'You are a workforce activity classifier. ' +
  'Classify the task as: Coding, Emailing, Meeting, Social Media, Browsing, Documentation, or Other. ' +
  'Return JSON with category and confidence. ' +
  'Respond ONLY with valid JSON: {"category": "Coding", "confidence": 0.93}.';

const TASK_DETECTION_USER_PROMPT = 'Classify the task as: Coding, Emailing, Meeting, Social Media, Browsing, Documentation, or Other. Return JSON with category and confidence.';

/** Allowed task categories (exact labels from the Phase 3 spec). */
const TASK_CATEGORIES = [
  'Coding',
  'Emailing',
  'Meeting',
  'Social Media',
  'Browsing',
  'Documentation',
  'Other',
] as const;

export interface PiiBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TaskAnalysis {
  category: string;
  /** 0–1 provider-reported confidence; null when the model omitted it. */
  confidence: number | null;
}

/** Injectable vision provider — defaults to the real callAIProviderVision. */
export interface ScreenshotAiVisionCall {
  (
    systemPrompt: string,
    userPrompt: string,
    image: ImageInput,
    options?: { maxTokens?: number; organizationId?: string }
  ): Promise<AIProviderResult | null>;
}

export interface ScreenshotAiOutcome {
  /** True when PII was found AND blurred (the stored main object gets overwritten). */
  redacted: boolean;
  /** Post-redaction image bytes — set exactly when `redacted` is true. */
  redactedBytes?: Buffer;
  /** Task classification persisted as a JSON string; null when unparseable/failed. */
  aiAnalysis: string | null;
  /** True when an AI call was attempted but failed or returned unparseable output. */
  analysisFailed: boolean;
}

export interface ScreenshotProcessingOptions {
  /** Injectable vision provider (tests stub this; production uses the real client). */
  aiVision?: ScreenshotAiVisionCall;
}

/** Trim a ```json … ``` fence some models wrap JSON in. */
function stripJsonFence(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

/**
 * Parse a PII-detection response into normalized [x,y,w,h] boxes. Accepts a
 * bare JSON array, `{"boxes":[…]}` or `{"pii":[…]}`. Returns null only when
 * the top-level payload is not a list-shaped structure (unparseable output);
 * individual malformed entries are skipped, and a structurally valid list with
 * only bad entries is treated as no-PII rather than a failure.
 */
export function parsePiiBoxes(text: string): PiiBox[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonFence(text));
  } catch {
    return null;
  }
  let list: unknown;
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.boxes)) list = obj.boxes;
    else if (Array.isArray(obj.pii)) list = obj.pii;
  }
  if (list === undefined) return null;
  const boxes: PiiBox[] = [];
  for (const item of list as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const x = Number(o.x);
    const y = Number(o.y);
    const w = Number(o.w);
    const h = Number(o.h);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue;
    if (w <= 0 || h <= 0) continue;
    boxes.push({ x, y, w, h });
  }
  return boxes;
}

/**
 * Parse a task-detection response into { category, confidence }. The category
 * must be one of the seven Phase 3 labels (case-insensitive) or the whole
 * classification is treated as invalid/unparseable.
 */
export function parseTaskAnalysis(text: string): TaskAnalysis | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonFence(text));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const category = typeof obj.category === 'string' ? obj.category.trim() : '';
  const match = TASK_CATEGORIES.find((c) => c.toLowerCase() === category.toLowerCase());
  if (!match) return null;
  let confidence: number | null = null;
  if (typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)) {
    confidence = Math.max(0, Math.min(1, obj.confidence));
  }
  return { category: match, confidence };
}

/** Clamp VLM-reported boxes to the actual image bounds, dropping zero-sized regions. */
function clampPiiBoxes(boxes: PiiBox[], width: number, height: number): PiiBox[] {
  const clamped: PiiBox[] = [];
  for (const b of boxes) {
    const x = Math.floor(Math.max(0, Math.min(width, b.x)));
    const y = Math.floor(Math.max(0, Math.min(height, b.y)));
    const w = Math.ceil(Math.min(Math.max(0, b.w), width - x));
    const h = Math.ceil(Math.min(Math.max(0, b.h), height - y));
    if (w > 0 && h > 0) clamped.push({ x, y, w, h });
  }
  return clamped;
}

/**
 * Blur every detected region in an already orientation-normalized image by
 * compositing a heavily blurred crop of each region back onto the source, then
 * re-encoding to the source format (so stored magic bytes stay valid).
 * Returns null when no valid region survives clamping (the caller then treats
 * the image as no-PII and never touches the stored original).
 */
async function blurPiiRegions(
  normalized: Buffer,
  mimeType: AllowedScreenshotMime,
  boxes: PiiBox[]
): Promise<Buffer | null> {
  const meta = await sharp(normalized, { limitInputPixels: MAX_DECODE_PIXELS }).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const clamped = clampPiiBoxes(boxes, width, height);
  if (clamped.length === 0) return null;

  const overlays: { input: Buffer; left: number; top: number }[] = [];
  for (const b of clamped) {
    const region = await sharp(normalized, { limitInputPixels: MAX_DECODE_PIXELS })
      .extract({ left: b.x, top: b.y, width: b.w, height: b.h })
      .blur(PII_BLUR_SIGMA)
      .toBuffer();
    overlays.push({ input: region, left: b.x, top: b.y });
  }

  let out = sharp(normalized, { limitInputPixels: MAX_DECODE_PIXELS }).composite(overlays);
  if (mimeType === 'image/png') out = out.png();
  else if (mimeType === 'image/webp') out = out.webp({ quality: SCREENSHOT_THUMBNAIL_QUALITY });
  else out = out.jpeg({ quality: SCREENSHOT_THUMBNAIL_QUALITY });
  return out.toBuffer();
}

/**
 * Organizational AI gate for the screenshot background job (fail-close).
 * Skips AI entirely when:
 *  - `ai_insights_enabled` is false (org setting, or platform fallback), or
 *  - no usable provider/key resolves via getSettings(organizationId).
 * A settings-resolution error is treated as "AI unavailable" — the row is
 * processed normally and never marked analysisFailed for an infra skip.
 */
export async function aiPipelineEnabled(organizationId: string): Promise<boolean> {
  try {
    if (!(await aiInsightsEnabledForOrg(organizationId))) return false;
    const loaded = await getSettings(organizationId);
    if ('error' in loaded) return false;
    return Boolean(loaded.settings.provider);
  } catch {
    return false;
  }
}

/**
 * Run the Phase 3 vision pipeline for ONE screenshot: (A) PII detection →
 * (B) blur regions → (C) task detection on the blurred image. Never throws —
 * every failure mode is mapped to `outcome.analysisFailed` and the caller
 * keeps the original image.
 */
export async function analyzeScreenshotWithVision(
  sourceBytes: Buffer,
  sourceMime: AllowedScreenshotMime,
  organizationId: string,
  aiVision: ScreenshotAiVisionCall
): Promise<ScreenshotAiOutcome> {
  const outcome: ScreenshotAiOutcome = { redacted: false, aiAnalysis: null, analysisFailed: false };
  const orgId = organizationId.slice(0, 8);

  // Normalize EXIF orientation ONCE so the VLM and the blur geometry share the
  // exact same pixel space (an EXIF-rotated capture never misaligns a box).
  let workBytes: Buffer;
  try {
    workBytes = await sharp(sourceBytes, { limitInputPixels: MAX_DECODE_PIXELS }).rotate().toBuffer();
  } catch {
    outcome.analysisFailed = true;
    return outcome;
  }
  const workMeta = await sharp(workBytes, { limitInputPixels: MAX_DECODE_PIXELS }).metadata();
  if ((workMeta.width ?? 0) === 0 || (workMeta.height ?? 0) === 0) {
    outcome.analysisFailed = true;
    return outcome;
  }

  // (A) PII detection.
  const imageInput: ImageInput = {
    type: 'base64',
    base64: workBytes.toString('base64'),
    mimeType: sourceMime,
  };
  const piiResult = await aiVision(
    PII_DETECTION_SYSTEM_PROMPT,
    PII_DETECTION_USER_PROMPT,
    imageInput,
    { maxTokens: 500, organizationId }
  );
  if (!piiResult?.text) {
    outcome.analysisFailed = true;
    log.warn('screenshots.ai.pii_failed', { orgId, error: piiResult?.error ?? 'no_response' });
    return outcome;
  }
  const boxes = parsePiiBoxes(piiResult.text);
  if (boxes === null) {
    outcome.analysisFailed = true;
    log.warn('screenshots.ai.pii_unparseable', { orgId });
    return outcome;
  }

  // (B) Blur the detected regions. No PII (or no valid region) → the original
  //     stored object is never rewritten.
  let redactedBytes: Buffer | null = null;
  if (boxes.length > 0) {
    try {
      redactedBytes = await blurPiiRegions(workBytes, sourceMime, boxes);
      if (redactedBytes !== null) {
        outcome.redacted = true;
        outcome.redactedBytes = redactedBytes;
      }
    } catch (error) {
      outcome.analysisFailed = true;
      log.error('screenshots.ai.blur_failed', {
        orgId,
        boxes: boxes.length,
        error: String((error as Error)?.message ?? error),
      });
      return outcome;
    }
  }

  // (C) Task detection on the blurred image (or the original when no PII).
  const taskResult = await aiVision(
    TASK_DETECTION_SYSTEM_PROMPT,
    TASK_DETECTION_USER_PROMPT,
    { type: 'base64', base64: (redactedBytes ?? workBytes).toString('base64'), mimeType: sourceMime },
    { maxTokens: 200, organizationId }
  );
  if (!taskResult?.text) {
    outcome.analysisFailed = true;
    log.warn('screenshots.ai.task_failed', { orgId, error: taskResult?.error ?? 'no_response' });
    return outcome;
  }
  const analysis = parseTaskAnalysis(taskResult.text);
  if (analysis === null) {
    outcome.analysisFailed = true;
    log.warn('screenshots.ai.task_unparseable', { orgId });
    return outcome;
  }
  outcome.aiAnalysis = JSON.stringify(analysis);
  log.info('screenshots.ai.analyzed', {
    orgId,
    redacted: outcome.redacted,
    category: analysis.category,
  });
  return outcome;
}

/**
 * Process ONE screenshot row: read original → [AI gate + vision pipeline] →
 * generate thumbnail → store → update row. The original object is preserved
 * on ANY failure. When PII is detected the main stored object is overwritten
 * with the blurred (redacted) version; the thumbnail is always derived from the
 * final render so admin views never leak unredacted pixels.
 */
export async function processScreenshotRow(
  row: {
    id: string;
    organizationId: string;
    employeeId: string;
    filePath: string;
    mimeType: string;
    processingAttempts: number;
    /** Original width — used to backfill JPEG/WebP rows that were never parsed. */
    width: number | null;
  },
  data: PrismaClient = db,
  opts: ScreenshotProcessingOptions = {}
): Promise<'processed' | 'failed' | 'skipped'> {
  const { id, organizationId, filePath, mimeType } = row;

  // Sanity: the physical original is required. A row whose object is missing
  // cannot ever produce a thumbnail — treat as permanent failure (Case B in
  // the orphan audit): mark failed with a safe diagnostic and stop retrying.
  let sourceBytes: Buffer;
  try {
    sourceBytes = await getScreenshot(organizationId, filePath);
  } catch (error) {
    const message = isNotFound(error) ? 'original_missing' : 'storage_read_failed';
    await markRowFailed(id, message, MAX_SCREENSHOT_PROCESSING_ATTEMPTS, organizationId, false, data);
    return 'failed';
  }

  // ── Phase 3: AI gate + vision pipeline (fail-close; errors never lose rows) ──
  const aiVision = opts.aiVision ?? callAIProviderVision;
  let piiRedacted = false;
  let aiAnalysis: string | null = null;
  let analysisFailed = false;
  let renderBytes = sourceBytes;
  try {
    if (await aiPipelineEnabled(organizationId)) {
      const outcome = await analyzeScreenshotWithVision(
        sourceBytes,
        mimeType as AllowedScreenshotMime,
        organizationId,
        aiVision
      );
      piiRedacted = outcome.redacted;
      aiAnalysis = outcome.aiAnalysis;
      analysisFailed = outcome.analysisFailed;
      if (outcome.redacted && outcome.redactedBytes) {
        renderBytes = outcome.redactedBytes;
      }
    }
  } catch (error) {
    // Unexpected infra/provider throw — never lose the screenshot.
    analysisFailed = true;
    log.error('screenshots.ai.pipeline_error', {
      screenshotId: id,
      orgId: organizationId.slice(0, 8),
      error: String((error as Error)?.message ?? error),
    });
  }

  const thumbSource = piiRedacted ? renderBytes : sourceBytes;
  const attemptsAfter = row.processingAttempts + 1;
  let thumb: { bytes: Buffer; width: number; height: number };
  try {
    thumb = await generateThumbnail(thumbSource, mimeType as AllowedScreenshotMime);
  } catch (error) {
    // Decode/encode failure — retry until MAX_SCREENSHOT_PROCESSING_ATTEMPTS.
    const attempts = row.processingAttempts + 1;
    await markRowFailed(
      id,
      'decode_failed',
      attempts,
      organizationId,
      attempts < MAX_SCREENSHOT_PROCESSING_ATTEMPTS,
      data
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

  const thumbFilename = thumbnailFilenameFor(basename(filePath));
  try {
    await putScreenshot(organizationId, thumbFilename, thumb.bytes, mimeType);
  } catch {
    await markRowFailed(
      id,
      'storage_write_failed',
      attemptsAfter,
      organizationId,
      attemptsAfter < MAX_SCREENSHOT_PROCESSING_ATTEMPTS,
      data
    );
    return 'failed';
  }

  // Phase 3: overwrite the main stored object with the blurred image when PII
  // was found. The retry-safe design mirrors the thumbnail path: a deterministic
  // key means the next run overwrites the same object, never a duplicate. If
  // this write fails the row stays 'uploaded' so the next run re-detects,
  // re-blurs, and retries the overwrite — the blurred version will eventually
  // land on disk (bounded by MAX_SCREENSHOT_PROCESSING_ATTEMPTS).
  if (piiRedacted) {
    try {
      await putScreenshot(organizationId, basename(filePath), renderBytes, mimeType);
    } catch (error) {
      await markRowFailed(
        id,
        'redacted_write_failed',
        attemptsAfter,
        organizationId,
        attemptsAfter < MAX_SCREENSHOT_PROCESSING_ATTEMPTS,
        data
      );
      log.warn('screenshots.processing.redacted_write_failed', {
        screenshotId: id,
        orgId: organizationId.slice(0, 8),
        error: String((error as Error)?.message ?? error),
      });
      return 'failed';
    }
  }

  try {
    // Screenshot rows are org-owned (copied at activation) — the status
    // update lands on the org's own client, never the platform DB after cutover.
    await data.screenshot.update({
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
        piiRedacted,
        aiAnalysis,
        analysisFailed,
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
    piiRedacted,
    analysisFailed,
  });
  return 'processed';
}

/**
 * Bounded drain of rows awaiting thumbnail generation. Scans each ACTIVE
 * organization's OWN database (rows are org-owned and copied at activation —
 * a global platform scan would miss post-cutover rows entirely), selects the
 * oldest 'uploaded' rows first per org, and processes each row individually
 * with its own try/catch so one corrupt screenshot can never abort the batch.
 * `limit` bounds the run across the WHOLE tenant set (attempts counted toward
 * it, so one org's backlog cannot starve the others) — never a global platform
 * scan. Remaining rows are picked up by the next scheduler tick.
 */
export async function processPendingScreenshots(limit = SCREENSHOT_PROCESSING_DEFAULT_LIMIT): Promise<{
  processed: number;
  failed: number;
  errors: string[];
}> {
  const result = { processed: 0, failed: 0, errors: [] as string[] };

  const perOrgTake = Math.min(limit, 500); // hard safety ceiling per run
  const orgs = await db.organization.findMany({ where: { status: 'active' }, select: { id: true } });
  if (orgs.length === 0) return result;

  for (const org of orgs) {
    // Global budget: once the run's total attempt count reaches `limit`, stop —
    // the remainder is drained by the next scheduled run.
    if (result.processed + result.failed >= limit) break;

    const orgData = (await getPrismaForOrg(org.id)).client;
    // Org filter: on a shared platform client (org not yet activated) this
    // restricts the scan to THIS org's rows — otherwise every iteration would
    // re-process the same rows (burning retry budgets N× per run).
    const pending = await orgData.screenshot.findMany({
      where: {
        organizationId: org.id,
        processingStatus: 'uploaded',
        processingAttempts: { lt: MAX_SCREENSHOT_PROCESSING_ATTEMPTS },
      },
      orderBy: { capturedAt: 'asc' },
      take: perOrgTake,
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

    if (pending.length === 0) continue;

    log.info('screenshots.processing.batch_started', { count: pending.length, orgId: org.id.slice(0, 8) });

    for (const row of pending) {
      if (result.processed + result.failed >= limit) break;
      try {
        const outcome = await processScreenshotRow(row, orgData);
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
  retryable = false,
  data: PrismaClient = db
): Promise<void> {
  const permanent = attempts >= MAX_SCREENSHOT_PROCESSING_ATTEMPTS;
  await data.screenshot.update({
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

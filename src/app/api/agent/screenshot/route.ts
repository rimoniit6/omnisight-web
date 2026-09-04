import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { db } from '@/lib/db';
import { validateAgentToken, getClientIp } from '@/lib/agent/auth';
import { hasActiveConsent } from '@/lib/consent';
import { resolveOrgMonitoring } from '@/lib/jobs/settings';
import { validateScreenshotUpload, extensionForMime, sanitizeFilenameSegment, sanitizeDisplayFilename, parsePngDimensions } from '@/lib/screenshots/storage';
import { putScreenshot, deleteScreenshot, isNotFound } from '@/lib/storage';
import { log, requestContext } from '@/lib/logger';

const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024; // 5 MB

// POST /api/agent/screenshot
// Agent uploads periodic screenshots
// Stores as files in /uploads/screenshots/ with metadata in DB.
//
// Hardening (Phase: Screenshots Production Hardening):
//  - Only PNG/JPEG/WebP are accepted; the client-declared MIME must match the
//    actual magic bytes (SVG/GIF/arbitrary content is rejected with 400).
//  - Filenames use crypto.randomUUID() — collision-resistant, never
//    client-controlled.
//  - If the DB transaction fails after the file is written, the newly created
//    file is removed (best-effort) so no orphan remains; only safe diagnostic
//    information is logged (never secrets/tokens/file contents).
export async function POST(req: NextRequest) {
  const requestStart = Date.now();
  try {
    const authResult = await validateAgentToken(req);
    if (!authResult.valid) {
      log.warn('agent.screenshot.auth_failed', {
        error: authResult.error,
        ip: getClientIp(req),
      });
      return NextResponse.json({ error: authResult.error }, { status: 401 });
    }

    // Privacy enforcement: screenshot capture requires a valid, unexpired
    // 'screenshot' consent. Revoked or missing consent fails closed — the
    // agent must surface this to the employee and stop capturing.
    const employeeId = authResult.employee!.id;
    const organizationId = authResult.employee!.organizationId;
    if (!(await hasActiveConsent(employeeId, 'screenshot'))) {
      log.warn('agent.screenshot.consent_denied', {
        employeeId: authResult.employee!.employeeId,
        orgId: organizationId,
      });
      return NextResponse.json(
        { error: 'Screenshot capture requires consent. Consent is not granted or has been revoked.' },
        { status: 403 }
      );
    }

    // Server-authoritative org policy (Phase 3 §31 / Phase 4 §11 parity with
    // the location and website gates): the org's screenshot_enabled flag AND
    // the org's screenshotInterval (=0 disables capture) are re-enforced at
    // the upload boundary INDEPENDENTLY of the agent/config. A stale or rogue
    // agent can never upload while the organization has disabled screenshots
    // — resolved from the authenticated token's organization through the same
    // canonical resolver the agent config endpoint uses, so server and agent
    // can never disagree.
    const [monitoring, orgRow] = await Promise.all([
      resolveOrgMonitoring(organizationId),
      db.organization.findUnique({
        where: { id: organizationId },
        select: { screenshotInterval: true },
      }),
    ]);
    if (monitoring.screenshot_enabled !== true) {
      log.warn('agent.screenshot.policy_denied', {
        employeeId: authResult.employee!.employeeId,
        orgId: organizationId,
      });
      return NextResponse.json(
        { error: 'SCREENSHOT_TRACKING_DISABLED' },
        { status: 403 }
      );
    }
    // Phase 4 §11: an effective interval of 0 means capture is disabled by the
    // organization (Super Admin on MANAGED, Org Admin elsewhere). Rejecting
    // here closes the parity gap where only the agent-side config suppressed
    // capture — a direct upload is now refused as well. Same server-side
    // default (5 minutes) as the config endpoint when the row is absent.
    const effectiveInterval = orgRow?.screenshotInterval ?? 5;
    if (effectiveInterval <= 0) {
      log.warn('agent.screenshot.interval_denied', {
        employeeId: authResult.employee!.employeeId,
        orgId: organizationId,
      });
      return NextResponse.json(
        { error: 'SCREENSHOT_INTERVAL_DISABLED' },
        { status: 403 }
      );
    }

    const formData = await req.formData();
    const file = formData.get('screenshot') as File | null;
    const timestamp = formData.get('timestamp') as string | null;
    const appWindow = formData.get('appWindow') as string | null; // Active app title

    if (!file) {
      log.warn('agent.screenshot.no_file', {
        employeeId: authResult.employee!.employeeId,
      });
      return NextResponse.json({ error: 'No screenshot file provided' }, { status: 400 });
    }

    // Validate file size (max 5MB) BEFORE reading the whole body.
    if (file.size > MAX_SCREENSHOT_BYTES) {
      log.warn('agent.screenshot.too_large', {
        employeeId: authResult.employee!.employeeId,
        size: file.size,
      });
      return NextResponse.json({ error: 'Screenshot too large (max 5MB)' }, { status: 400 });
    }

    // Read bytes once; magic-byte validation operates on the actual content.
    const bytes = Buffer.from(await file.arrayBuffer());

    // Strict raster allowlist + magic-byte verification. The detected file
    // signature must match the claimed MIME type — never trust the
    // client-declared type alone. SVG/GIF/BMP/TIFF are rejected.
    const validation = validateScreenshotUpload(bytes, file.type);
    if (!validation.ok) {
      log.warn('agent.screenshot.invalid_type', {
        employeeId: authResult.employee!.employeeId,
        claimedType: file.type,
        error: validation.error,
      });
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const mimeType = validation.mimeType;

    // Resolution is parsed from the ACTUAL file bytes (PNG IHDR) — never from
    // a client-supplied value. JPEG/WebP keep NULL dimensions.
    const dimensions = mimeType === 'image/png' ? parsePngDimensions(bytes) : null;

    // Validate the client timestamp BEFORE any disk write: a garbage value
    // would otherwise surface as a 500 inside the DB transaction.
    let capturedAt: Date;
    if (timestamp) {
      const parsedMs = Date.parse(timestamp);
      if (Number.isNaN(parsedMs)) {
        return NextResponse.json({ error: 'Invalid timestamp' }, { status: 400 });
      }
      capturedAt = new Date(parsedMs);
    } else {
      capturedAt = new Date();
    }

    // Save the screenshot object with a collision-resistant, server-generated
    // name. {sanitizedEmployeeId}_{randomUUID()}.{ext} — the employee
    // association is kept, the UUID guarantees uniqueness, and the employee
    // code segment is sanitized so a crafted employeeId can never escape the
    // storage key. The object goes to the active storage driver (local
    // filesystem, or Supabase Storage on Vercel).
    const ext = extensionForMime(mimeType);
    const filename = `${sanitizeFilenameSegment(authResult.employee!.employeeId)}_${randomUUID()}.${ext}`;
    const orgId = organizationId;

    await putScreenshot(orgId, filename, bytes, mimeType);

    try {
      await db.$transaction(async (tx) => {
        // Create screenshot record in database. processingStatus defaults to
        // 'uploaded' — that state IS the background thumbnail-processing queue:
        // the row is picked up by the bounded 'screenshot_processing' job and
        // transitioned to 'processed' or 'processing_failed' WITHOUT any image
        // work happening in this request lifecycle.
        await tx.screenshot.create({
          data: {
            employeeId: authResult.employee!.id,
            deviceId: authResult.deviceId || null,
            filePath: `/uploads/screenshots/${filename}`,
            // P3-8: the client-supplied name is sanitized before storage — it
            // is display-only (the physical file uses the UUID name above) but
            // must never carry path separators or control characters.
            fileName: sanitizeDisplayFilename(file.name),
            fileSize: file.size,
            mimeType,
            appWindow: appWindow || null,
            capturedAt,
            organizationId: orgId,
            width: dimensions?.width ?? null,
            height: dimensions?.height ?? null,
            processingStatus: 'uploaded',
          },
        });

        // Update device's last screenshot time
        if (authResult.deviceId) {
          await tx.device.update({
            where: { id: authResult.deviceId },
            data: { lastHeartbeat: new Date() },
          });
        }

        // Audit log for screenshot capture
        await tx.auditLog.create({
          data: {
            action: 'create',
            resource: 'device',
            description: `Screenshot captured for ${authResult.employee!.firstName} ${authResult.employee!.lastName}`,
            resourceId: authResult.deviceId,
            ipAddress: getClientIp(req),
            organizationId: orgId,
          },
        });
      });
    } catch (transactionError) {
      // The DB transaction failed after the object was written. Remove the
      // newly created object (best-effort) so it does not remain orphaned.
      // Log only safe diagnostics — never tokens, secrets, or file contents.
      try {
        await deleteScreenshot(orgId, filename);
      } catch (deleteError) {
        if (!isNotFound(deleteError)) {
          log.error('agent.screenshot.cleanup_failed', {
            filename,
            error: String((deleteError as Error)?.message ?? deleteError),
          });
        }
      }
      log.error('agent.screenshot.transaction_failed', {
        filename,
        error: String((transactionError as Error)?.message ?? transactionError),
      });
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }

    log.info('agent.screenshot.upload.success', {
      employeeId: authResult.employee!.employeeId,
      orgId: orgId.slice(0, 8),
      filename,
      bytes: file.size,
      mime: mimeType,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      appWindow: appWindow || null,
      durationMs: Date.now() - requestStart,
    });

    return NextResponse.json({
      success: true,
      filename,
      path: `/uploads/screenshots/${filename}`,
      size: file.size,
      timestamp: timestamp || new Date().toISOString(),
      appWindow: appWindow || null,
    });
  } catch (error) {
    log.error('api.agent.screenshot.error', {
      error: String((error as Error)?.message ?? error),
      durationMs: Date.now() - requestStart,
    }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

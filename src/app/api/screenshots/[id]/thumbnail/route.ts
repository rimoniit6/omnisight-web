import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';
import { safeServeMime } from '@/lib/screenshots/storage';
import { getScreenshot, isNotFound } from '@/lib/storage';
import { log, requestContext } from '@/lib/logger';

// GET /api/screenshots/[id]/thumbnail
// Serves the stored THUMBNAIL for a screenshot (Phase 2). The admin grid/list
// loads this small asset instead of the full-resolution original — bandwidth,
// browser memory, server load and storage egress all stay bounded. The
// original stays available at /api/screenshots/[id]/image and is loaded only
// when the admin opens a screenshot.
//
// Authorization mirrors the original-image route EXACTLY (never weaker):
//   - session auth (global middleware + requireSessionOrg),
//   - org-scoped row lookup — a user from another org gets 404 concealment,
//   - org-less super_admin gets 404 (no org to read from),
//   - the physical object is read through the active storage driver and its
//     magic bytes are authoritative for the served Content-Type (nosniff),
//   - thumbnails are immutable once written (deterministic key per original),
//     so a longer private cache is safe.
//
// A row with no thumbnail yet (uploaded/processing_failed) returns 404 — the
// client falls back to the original image URL or a placeholder; this route
// never triggers synchronous thumbnail generation (that is the background
// worker's job).
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const scope = await requireSessionOrg(req);
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) {
      // Org-less super_admin has no organization to read screenshots from.
      return new NextResponse('Not found', { status: 404 });
    }
    const orgId = scope.organizationId;

    const { id } = await params;

    const screenshot = await db.screenshot.findFirst({
      where: { id, organizationId: orgId },
      select: { thumbnailPath: true, mimeType: true },
    });
    if (!screenshot || !screenshot.thumbnailPath) {
      return new NextResponse('Not found', { status: 404 });
    }

    let data: Buffer;
    try {
      data = await getScreenshot(orgId, screenshot.thumbnailPath);
    } catch (error) {
      if (isNotFound(error)) {
        return new NextResponse('File missing', { status: 404 });
      }
      throw error;
    }

    // Magic bytes are authoritative (same policy as the original route): an
    // unrecognized thumbnail is served as octet-stream + nosniff, never as
    // executable HTML/SVG.
    const contentType = safeServeMime(data);

    return new NextResponse(new Uint8Array(data), {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(data.length),
        // Thumbnails are deterministic per screenshot (same original → same
        // object key), so a longer private cache is safe and cuts egress.
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    log.error('api.screenshots.id.thumbnail.', { error: String('Screenshot thumbnail error:') }, requestContext(req));
    return new NextResponse('Internal error', { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';
import { safeServeMime } from '@/lib/screenshots/storage';
import { getScreenshot, isNotFound } from '@/lib/storage';
import { log, requestContext } from '@/lib/logger';

// GET /api/screenshots/[id]/image
// Serves the stored screenshot file. The global middleware already enforces
// JWT/session auth on all /api/* routes (the browser sends the httpOnly
// session cookie automatically for <img> requests).
//
// Tenant isolation: the screenshot must belong to the caller's organization
// — an authenticated user from another org (or an org-less super_admin) can
// never read a screenshot by guessing an id.
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
      select: { filePath: true, mimeType: true },
    });
    if (!screenshot) {
      return new NextResponse('Not found', { status: 404 });
    }

    // The screenshot must have a stored object to serve; the object is read
    // through the active storage driver (local filesystem, or Supabase
    // Storage on Vercel). The DB filePath is display-only — the storage key
    // is derived server-side from the org + basename, never from the path.
    if (!screenshot.filePath) {
      return new NextResponse('Not found', { status: 404 });
    }
    let data: Buffer;
    try {
      data = await getScreenshot(orgId, screenshot.filePath || '');
    } catch (error) {
      if (isNotFound(error)) {
        return new NextResponse('File missing', { status: 404 });
      }
      throw error;
    }

    // Never trust the stored MIME blindly: the physical file signature is
    // authoritative. A recognized raster image is served with its real type;
    // anything unrecognized (corrupt file, tampered content, SVG) is served
    // as application/octet-stream with nosniff so it can never be interpreted
    // as executable HTML/SVG by the browser.
    const contentType = safeServeMime(data);

    return new NextResponse(new Uint8Array(data), {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(data.length),
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    log.error('api.screenshots.id.image.', { error: String('Screenshot image error:') }, requestContext(req));
    return new NextResponse('Internal error', { status: 500 });
  }
}

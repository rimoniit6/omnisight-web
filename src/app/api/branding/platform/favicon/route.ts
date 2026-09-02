import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSuperAdmin } from '@/lib/api';
import { storage } from '@/lib/storage';
import { invalidateBrandingCache, sanitizeSvg } from '@/lib/branding';
import { log, requestContext } from '@/lib/logger';

const PLATFORM_FAVICON_PREFIX = 'branding/platform';
const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/x-icon'];
const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico'];
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

/**
 * POST /api/branding/platform/favicon
 *
 * Upload a new platform favicon. Replaces any existing favicon.
 * super_admin only.
 */
export async function POST(req: NextRequest) {
  try {
    const superAdmin = await requireSuperAdmin(req);
    if (!superAdmin.ok) return authError(superAdmin);

    const formData = await req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'File too large. Maximum size is 2MB.' }, { status: 413 });
    }

    // Validate MIME type
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      return NextResponse.json({ error: 'Unsupported file type. Allowed: PNG, JPEG, WebP, SVG, ICO.' }, { status: 415 });
    }

    // Validate extension
    const ext = '.' + file.name.split('.').pop()?.toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return NextResponse.json({ error: 'Unsupported file extension.' }, { status: 415 });
    }

    let buffer: Buffer = Buffer.from(await file.arrayBuffer());

    // Sanitize SVG
    if (file.type === 'image/svg+xml') {
      buffer = sanitizeSvg(buffer);
    }

    // Read old favicon URL before uploading (for safe cleanup after DB commit)
    const existing = await db.platformBranding.findFirst();
    const oldFaviconUrl = existing?.faviconUrl || null;

    // Generate unique filename
    const timestamp = Date.now();
    const safeFilename = `favicon-${timestamp}${ext}`;
    const storageKey = `${PLATFORM_FAVICON_PREFIX}/${safeFilename}`;

    // Store new favicon FIRST (before DB update)
    await storage().put(storageKey, {
      bytes: buffer,
      contentType: file.type,
    });

    // Update DB atomically
    const publicUrl = `/${storageKey}`;
    const { branding } = await db.$transaction(async (tx) => {
      let result;
      if (existing) {
        result = await tx.platformBranding.update({
          where: { id: existing.id },
          data: { faviconUrl: publicUrl, updatedBy: superAdmin.userId },
        });
      } else {
        result = await tx.platformBranding.create({
          data: { faviconUrl: publicUrl, updatedBy: superAdmin.userId },
        });
      }

      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'platform_branding',
          resourceId: result.id,
          description: `Platform favicon uploaded by ${superAdmin.email}`,
          userId: superAdmin.userId,
          organizationId: null,
        },
      });

      return { branding: result };
    });

    invalidateBrandingCache();

    // Safe cleanup: delete old favicon AFTER successful DB commit
    if (oldFaviconUrl && oldFaviconUrl !== publicUrl) {
      try {
        const oldKey = oldFaviconUrl.startsWith('/') ? oldFaviconUrl.slice(1) : oldFaviconUrl;
        await storage().delete(oldKey);
      } catch {
        // Non-fatal
      }
    }

    return NextResponse.json({ data: { faviconUrl: branding.faviconUrl } });
  } catch (error) {
    log.error('api.branding.platform.favicon.post', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Failed to upload favicon' }, { status: 500 });
  }
}

/**
 * DELETE /api/branding/platform/favicon
 *
 * Remove the platform favicon (resets to built-in default).
 * super_admin only.
 */
export async function DELETE(req: NextRequest) {
  try {
    const superAdmin = await requireSuperAdmin(req);
    if (!superAdmin.ok) return authError(superAdmin);

    const existing = await db.platformBranding.findFirst();
    if (!existing?.faviconUrl) {
      return NextResponse.json({ message: 'No custom favicon to remove' });
    }

    // Delete stored file
    try {
      const key = existing.faviconUrl.startsWith('/') ? existing.faviconUrl.slice(1) : existing.faviconUrl;
      await storage().delete(key);
    } catch {
      // Non-fatal
    }

    // Update DB
    await db.$transaction(async (tx) => {
      await tx.platformBranding.update({
        where: { id: existing.id },
        data: { faviconUrl: null, updatedBy: superAdmin.userId },
      });

      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'platform_branding',
          resourceId: existing.id,
          description: `Platform favicon removed by ${superAdmin.email}`,
          userId: superAdmin.userId,
          organizationId: null,
        },
      });
    });

    invalidateBrandingCache();

    return NextResponse.json({ message: 'Favicon removed' });
  } catch (error) {
    log.error('api.branding.platform.favicon.delete', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Failed to remove favicon' }, { status: 500 });
  }
}

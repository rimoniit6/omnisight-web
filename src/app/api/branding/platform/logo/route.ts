import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSuperAdmin } from '@/lib/api';
import { storage } from '@/lib/storage';
import { invalidateBrandingCache, sanitizeSvg, validateSvgCode } from '@/lib/branding';
import { log, requestContext } from '@/lib/logger';

const PLATFORM_LOGO_PREFIX = 'branding/platform';
const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.svg'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * POST /api/branding/platform/logo
 *
 * Upload a new platform logo. Replaces any existing logo.
 * super_admin only.
 */
export async function POST(req: NextRequest) {
  try {
    const superAdmin = await requireSuperAdmin(req);
    if (!superAdmin.ok) return authError(superAdmin);

    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const svgCode = formData.get('svgCode') as string | null;

    // Support both file upload and SVG code paste
    if (!file && !svgCode) {
      return NextResponse.json({ error: 'No file or SVG code provided' }, { status: 400 });
    }

    let buffer: Buffer;
    let contentType: string;
    let ext: string;

    if (svgCode) {
      // SVG code paste mode
      const trimmed = svgCode.trim();
      if (trimmed.length > 1 * 1024 * 1024) {
        return NextResponse.json({ error: 'SVG code exceeds maximum size of 1MB' }, { status: 413 });
      }
      const svgResult = validateSvgCode(trimmed);
      if (!svgResult.valid) {
        return NextResponse.json({ error: svgResult.error }, { status: 422 });
      }
      buffer = sanitizeSvg(Buffer.from(trimmed, 'utf-8'));
      contentType = 'image/svg+xml';
      ext = '.svg';
    } else {
      // File upload mode
      if (!file) {
        return NextResponse.json({ error: 'No file provided' }, { status: 400 });
      }
      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json({ error: 'File too large. Maximum size is 5MB.' }, { status: 413 });
      }
      if (!ALLOWED_MIME_TYPES.includes(file.type)) {
        return NextResponse.json({ error: 'Unsupported file type. Allowed: PNG, JPEG, WebP, SVG.' }, { status: 415 });
      }
      ext = '.' + file.name.split('.').pop()?.toLowerCase();
      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        return NextResponse.json({ error: 'Unsupported file extension.' }, { status: 415 });
      }
      buffer = Buffer.from(await file.arrayBuffer());
      contentType = file.type;
      if (file.type === 'image/svg+xml') {
        const svgResult = validateSvgCode(buffer.toString('utf-8'));
        if (!svgResult.valid) {
          return NextResponse.json({ error: svgResult.error }, { status: 422 });
        }
        buffer = sanitizeSvg(buffer);
      }
    }

    // Read old logo URL before uploading (for safe cleanup after DB commit)
    const existing = await db.platformBranding.findFirst();
    const oldLogoUrl = existing?.logoUrl || null;

    // Generate unique filename
    const timestamp = Date.now();
    const safeFilename = `logo-${timestamp}${ext}`;
    const storageKey = `${PLATFORM_LOGO_PREFIX}/${safeFilename}`;

    // Store new logo FIRST (before DB update)
    await storage().put(storageKey, {
      bytes: buffer,
      contentType: contentType,
    });

    // Update DB atomically — also set logoType to 'svg' for SVG code uploads
    const publicUrl = `/${storageKey}`;
    const logoTypeUpdate = svgCode ? 'svg' : undefined;
    const { branding } = await db.$transaction(async (tx) => {
      let result;
      if (existing) {
        result = await tx.platformBranding.update({
          where: { id: existing.id },
          data: {
            logoUrl: publicUrl,
            ...(logoTypeUpdate ? { logoType: logoTypeUpdate } : {}),
            updatedBy: superAdmin.userId,
          },
        });
      } else {
        result = await tx.platformBranding.create({
          data: {
            logoUrl: publicUrl,
            ...(logoTypeUpdate ? { logoType: logoTypeUpdate } : {}),
            updatedBy: superAdmin.userId,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'platform_branding',
          resourceId: result.id,
          description: `Platform logo uploaded by ${superAdmin.email}`,
          userId: superAdmin.userId,
          organizationId: null,
        },
      });

      return { branding: result };
    });

    invalidateBrandingCache();

    // Safe cleanup: delete old logo AFTER successful DB commit
    if (oldLogoUrl && oldLogoUrl !== publicUrl) {
      try {
        const oldKey = oldLogoUrl.startsWith('/') ? oldLogoUrl.slice(1) : oldLogoUrl;
        await storage().delete(oldKey);
      } catch {
        // Old logo cleanup is non-fatal
      }
    }

    return NextResponse.json({ data: { logoUrl: branding.logoUrl } });
  } catch (error) {
    log.error('api.branding.platform.logo.post', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Failed to upload logo' }, { status: 500 });
  }
}

/**
 * DELETE /api/branding/platform/logo
 *
 * Remove the platform logo (resets to built-in default).
 * super_admin only.
 */
export async function DELETE(req: NextRequest) {
  try {
    const superAdmin = await requireSuperAdmin(req);
    if (!superAdmin.ok) return authError(superAdmin);

    const existing = await db.platformBranding.findFirst();
    if (!existing?.logoUrl) {
      return NextResponse.json({ message: 'No custom logo to remove' });
    }

    // Delete stored file
    try {
      const key = existing.logoUrl.startsWith('/') ? existing.logoUrl.slice(1) : existing.logoUrl;
      await storage().delete(key);
    } catch {
      // Non-fatal
    }

    // Update DB
    await db.$transaction(async (tx) => {
      await tx.platformBranding.update({
        where: { id: existing.id },
        data: { logoUrl: null, updatedBy: superAdmin.userId },
      });

      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'platform_branding',
          resourceId: existing.id,
          description: `Platform logo removed by ${superAdmin.email}`,
          userId: superAdmin.userId,
          organizationId: null,
        },
      });
    });

    invalidateBrandingCache();

    return NextResponse.json({ message: 'Logo removed' });
  } catch (error) {
    log.error('api.branding.platform.logo.delete', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Failed to remove logo' }, { status: 500 });
  }
}

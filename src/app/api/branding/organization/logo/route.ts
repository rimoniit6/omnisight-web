import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg, authenticateRequest } from '@/lib/api';
import { storage } from '@/lib/storage';
import { invalidateBrandingCache, sanitizeSvg, validateSvgCode } from '@/lib/branding';
import { log, requestContext } from '@/lib/logger';

const ORG_LOGO_PREFIX = 'branding/organizations';
const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.svg'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * POST /api/branding/organization/logo
 *
 * Upload a new organization logo. Replaces any existing org logo.
 * Admin+ for own org; super_admin for any org.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) return authError({ ok: false, status: 401 });

    const orgId = auth.activeOrganizationId || auth.organizationId;
    if (!orgId) {
      return NextResponse.json({ error: 'No organization context' }, { status: 403 });
    }

    // Tenant isolation check
    if (auth.role !== 'super_admin') {
      const admin = await requireAdminOrg(req);
      if (!admin.ok) return authError(admin);
      if (admin.organizationId !== orgId) {
        return NextResponse.json({ error: 'Cannot modify another organization' }, { status: 403 });
      }
    }

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
    const existing = await db.organizationBranding.findUnique({
      where: { organizationId: orgId },
    });
    const oldLogoUrl = existing?.logoUrl || null;

    // Generate unique filename
    const timestamp = Date.now();
    const safeFilename = `logo-${timestamp}${ext}`;
    const storageKey = `${ORG_LOGO_PREFIX}/${orgId}/${safeFilename}`;

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
        result = await tx.organizationBranding.update({
          where: { organizationId: orgId },
          data: {
            logoUrl: publicUrl,
            ...(logoTypeUpdate ? { logoType: logoTypeUpdate } : {}),
            updatedBy: auth.userId,
          },
        });
      } else {
        result = await tx.organizationBranding.create({
          data: {
            organizationId: orgId,
            logoUrl: publicUrl,
            ...(logoTypeUpdate ? { logoType: logoTypeUpdate } : {}),
            updatedBy: auth.userId,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'organization_branding',
          resourceId: result.id,
          description: `Organization logo uploaded`,
          userId: auth.userId,
          organizationId: orgId,
        },
      });

      return { branding: result };
    });

    invalidateBrandingCache(orgId);

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
    log.error('api.branding.org.logo.post', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Failed to upload organization logo' }, { status: 500 });
  }
}

/**
 * DELETE /api/branding/organization/logo
 *
 * Remove the organization logo (resets to inherit from platform).
 * Admin+ for own org; super_admin for any org.
 */
export async function DELETE(req: NextRequest) {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) return authError({ ok: false, status: 401 });

    const orgId = auth.activeOrganizationId || auth.organizationId;
    if (!orgId) {
      return NextResponse.json({ error: 'No organization context' }, { status: 403 });
    }

    // Tenant isolation check
    if (auth.role !== 'super_admin') {
      const admin = await requireAdminOrg(req);
      if (!admin.ok) return authError(admin);
      if (admin.organizationId !== orgId) {
        return NextResponse.json({ error: 'Cannot modify another organization' }, { status: 403 });
      }
    }

    const existing = await db.organizationBranding.findUnique({
      where: { organizationId: orgId },
    });
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
      await tx.organizationBranding.update({
        where: { organizationId: orgId },
        data: { logoUrl: null, updatedBy: auth.userId },
      });

      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'organization_branding',
          resourceId: existing.id,
          description: `Organization logo removed`,
          userId: auth.userId,
          organizationId: orgId,
        },
      });
    });

    invalidateBrandingCache(orgId);

    return NextResponse.json({ message: 'Logo removed' });
  } catch (error) {
    log.error('api.branding.org.logo.delete', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Failed to remove organization logo' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg, authenticateRequest } from '@/lib/api';
import { storage } from '@/lib/storage';
import { invalidateBrandingCache, sanitizeSvg } from '@/lib/branding';
import { log, requestContext } from '@/lib/logger';

const ORG_FAVICON_PREFIX = 'branding/organizations';
const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/x-icon'];
const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico'];
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

/**
 * POST /api/branding/organization/favicon
 *
 * Upload a new organization favicon. Replaces any existing org favicon.
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
    const existing = await db.organizationBranding.findUnique({
      where: { organizationId: orgId },
    });
    const oldFaviconUrl = existing?.faviconUrl || null;

    // Generate unique filename
    const timestamp = Date.now();
    const safeFilename = `favicon-${timestamp}${ext}`;
    const storageKey = `${ORG_FAVICON_PREFIX}/${orgId}/${safeFilename}`;

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
        result = await tx.organizationBranding.update({
          where: { organizationId: orgId },
          data: { faviconUrl: publicUrl, updatedBy: auth.userId },
        });
      } else {
        result = await tx.organizationBranding.create({
          data: { organizationId: orgId, faviconUrl: publicUrl, updatedBy: auth.userId },
        });
      }

      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'organization_branding',
          resourceId: result.id,
          description: `Organization favicon uploaded`,
          userId: auth.userId,
          organizationId: orgId,
        },
      });

      return { branding: result };
    });

    invalidateBrandingCache(orgId);

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
    log.error('api.branding.org.favicon.post', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Failed to upload organization favicon' }, { status: 500 });
  }
}

/**
 * DELETE /api/branding/organization/favicon
 *
 * Remove the organization favicon (resets to inherit from platform).
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
      await tx.organizationBranding.update({
        where: { organizationId: orgId },
        data: { faviconUrl: null, updatedBy: auth.userId },
      });

      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'organization_branding',
          resourceId: existing.id,
          description: `Organization favicon removed`,
          userId: auth.userId,
          organizationId: orgId,
        },
      });
    });

    invalidateBrandingCache(orgId);

    return NextResponse.json({ message: 'Favicon removed' });
  } catch (error) {
    log.error('api.branding.org.favicon.delete', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Failed to remove organization favicon' }, { status: 500 });
  }
}

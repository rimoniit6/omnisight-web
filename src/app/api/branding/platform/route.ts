import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSuperAdmin, parseJsonBody, BodyParseError } from '@/lib/api';
import { invalidateBrandingCache, isValidBrandName, isValidBrowserTitle, isValidHexColor, isValidTagline, getRawPlatformBranding, validateSvgCode } from '@/lib/branding';
import { log, requestContext } from '@/lib/logger';

/**
 * GET /api/branding/platform
 *
 * Returns the current platform branding configuration.
 * super_admin only.
 */
export async function GET(req: NextRequest) {
  try {
    const superAdmin = await requireSuperAdmin(req);
    if (!superAdmin.ok) return authError(superAdmin);

    const branding = await getRawPlatformBranding();
    return NextResponse.json({ data: branding });
  } catch (error) {
    log.error('api.branding.platform.get', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch platform branding' }, { status: 500 });
  }
}

/**
 * PATCH /api/branding/platform
 *
 * Update platform branding fields. Only provided fields are updated (PATCH semantics).
 * super_admin only.
 */
export async function PATCH(req: NextRequest) {
  try {
    const superAdmin = await requireSuperAdmin(req);
    if (!superAdmin.ok) return authError(superAdmin);

    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      if (e instanceof BodyParseError) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      throw e;
    }

    // Validate fields
    const updates: Record<string, string | number | null> = {};
    const allowedFields = ['brandName', 'logoUrl', 'faviconUrl', 'primaryColor', 'browserTitle', 'tagline', 'logoType', 'logoSvg', 'logoWidth', 'logoHeight'];

    for (const field of allowedFields) {
      if (field in body) {
        const value = body[field];
        if (value === null || value === undefined || value === '') {
          updates[field] = null; // Reset to default
        } else if (typeof value === 'string') {
          const trimmed = value.trim();
          switch (field) {
            case 'brandName':
              if (!isValidBrandName(trimmed)) {
                return NextResponse.json({ error: 'Invalid brand name (1-100 characters, no control chars)' }, { status: 422 });
              }
              break;
            case 'browserTitle':
              if (!isValidBrowserTitle(trimmed)) {
                return NextResponse.json({ error: 'Invalid browser title (1-200 characters, no control chars)' }, { status: 422 });
              }
              break;
            case 'primaryColor':
              if (!isValidHexColor(trimmed)) {
                return NextResponse.json({ error: 'Invalid color format. Use #RRGGBB or #RRGGBBAA' }, { status: 422 });
              }
              break;
            case 'tagline':
              if (!isValidTagline(trimmed)) {
                return NextResponse.json({ error: 'Invalid tagline (1-100 characters, no control chars)' }, { status: 422 });
              }
              break;
            case 'logoUrl':
            case 'faviconUrl':
              // URLs are set via upload endpoint, not PATCH directly
              return NextResponse.json({ error: `Use POST /api/branding/platform/logo to upload ${field}` }, { status: 400 });
            case 'logoType':
              if (trimmed !== 'file' && trimmed !== 'svg') {
                return NextResponse.json({ error: 'logoType must be "file" or "svg"' }, { status: 422 });
              }
              break;
            case 'logoSvg':
              // Validate and sanitize SVG code
              const svgResult = validateSvgCode(trimmed);
              if (!svgResult.valid) {
                return NextResponse.json({ error: svgResult.error }, { status: 422 });
              }
              break;
          }
          updates[field] = trimmed;
        } else if (typeof value === 'number') {
          // Handle numeric fields (logoWidth, logoHeight)
          if (field === 'logoWidth' || field === 'logoHeight') {
            if (value < 0 || value > 1000) {
              return NextResponse.json({ error: `${field} must be between 0 and 1000 pixels` }, { status: 422 });
            }
            updates[field] = Math.round(value);
          } else {
            return NextResponse.json({ error: `${field} must be a string or null` }, { status: 422 });
          }
        } else if (typeof value === 'boolean') {
          return NextResponse.json({ error: `${field} must be a string, number, or null` }, { status: 422 });
        } else {
          return NextResponse.json({ error: `${field} must be a string, number, or null` }, { status: 422 });
        }
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    // Upsert the singleton row
    const existing = await db.platformBranding.findFirst();

    const { branding } = await db.$transaction(async (tx) => {
      let result;
      if (existing) {
        result = await tx.platformBranding.update({
          where: { id: existing.id },
          data: {
            ...updates,
            updatedBy: superAdmin.userId,
          },
        });
      } else {
        result = await tx.platformBranding.create({
          data: {
            ...updates,
            updatedBy: superAdmin.userId,
          },
        });
      }

      // Audit log
      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'platform_branding',
          resourceId: result.id,
          description: `Platform branding updated by ${superAdmin.email}: ${Object.keys(updates).join(', ')}`,
          userId: superAdmin.userId,
          organizationId: null,
        },
      });

      return { branding: result };
    });

    invalidateBrandingCache();

    return NextResponse.json({ data: branding });
  } catch (error) {
    log.error('api.branding.platform.patch', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Failed to update platform branding' }, { status: 500 });
  }
}

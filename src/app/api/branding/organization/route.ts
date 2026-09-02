import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg, parseJsonBody, BodyParseError, authenticateRequest } from '@/lib/api';
import { invalidateBrandingCache, isValidBrandName, isValidBrowserTitle, isValidHexColor, isValidTagline, getRawOrganizationBranding, validateSvgCode } from '@/lib/branding';
import { log, requestContext } from '@/lib/logger';

/**
 * GET /api/branding/organization
 *
 * Returns the current organization's branding configuration.
 * Admin+ for own org; super_admin for any org.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) return authError({ ok: false, status: 401 });

    const orgId = auth.activeOrganizationId || auth.organizationId;
    if (!orgId) {
      return NextResponse.json({ error: 'No organization context' }, { status: 403 });
    }

    // Super admin can read any org; normal users only their own
    if (auth.role !== 'super_admin') {
      const admin = await requireAdminOrg(req);
      if (!admin.ok) return authError(admin);
    }

    const branding = await getRawOrganizationBranding(orgId);
    return NextResponse.json({ data: branding });
  } catch (error) {
    log.error('api.branding.organization.get', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch organization branding' }, { status: 500 });
  }
}

/**
 * PATCH /api/branding/organization
 *
 * Update organization branding fields. Only provided fields are updated.
 * Admin+ for own org; super_admin for any org.
 */
export async function PATCH(req: NextRequest) {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) return authError({ ok: false, status: 401 });

    const orgId = auth.activeOrganizationId || auth.organizationId;
    if (!orgId) {
      return NextResponse.json({ error: 'No organization context' }, { status: 403 });
    }

    // Tenant isolation: super_admin can update any org; normal users only their own
    if (auth.role !== 'super_admin') {
      const admin = await requireAdminOrg(req);
      if (!admin.ok) return authError(admin);
      // Double-check: the admin must belong to THIS org
      if (admin.organizationId !== orgId) {
        return NextResponse.json({ error: 'Cannot modify another organization' }, { status: 403 });
      }
    }

    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      if (e instanceof BodyParseError) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      throw e;
    }

    // SECURITY: Ignore any client-supplied organizationId
    // The org is always derived from the session

    // Validate fields
    const updates: Record<string, string | number | null> = {};
    const allowedFields = ['brandName', 'logoUrl', 'faviconUrl', 'primaryColor', 'browserTitle', 'tagline', 'logoType', 'logoSvg', 'logoWidth', 'logoHeight'];

    for (const field of allowedFields) {
      if (field in body) {
        const value = body[field];
        if (value === null || value === undefined || value === '') {
          updates[field] = null; // Reset to inherit from platform
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
              return NextResponse.json({ error: `Use POST /api/branding/organization/logo to upload ${field}` }, { status: 400 });
            case 'logoType':
              if (trimmed !== 'file' && trimmed !== 'svg') {
                return NextResponse.json({ error: 'logoType must be "file" or "svg"' }, { status: 422 });
              }
              break;
            case 'logoSvg':
              const svgResult = validateSvgCode(trimmed);
              if (!svgResult.valid) {
                return NextResponse.json({ error: svgResult.error }, { status: 422 });
              }
              break;
          }
          updates[field] = trimmed;
        } else if (typeof value === 'number') {
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

    // Upsert the organization branding row
    const existing = await db.organizationBranding.findUnique({
      where: { organizationId: orgId },
    });

    const { branding } = await db.$transaction(async (tx) => {
      let result;
      if (existing) {
        result = await tx.organizationBranding.update({
          where: { organizationId: orgId },
          data: {
            ...updates,
            updatedBy: auth.userId,
          },
        });
      } else {
        result = await tx.organizationBranding.create({
          data: {
            organizationId: orgId,
            ...updates,
            updatedBy: auth.userId,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'organization_branding',
          resourceId: result.id,
          description: `Organization branding updated: ${Object.keys(updates).join(', ')}`,
          userId: auth.userId,
          organizationId: orgId,
        },
      });

      return { branding: result };
    });

    invalidateBrandingCache(orgId);

    return NextResponse.json({ data: branding });
  } catch (error) {
    log.error('api.branding.organization.patch', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Failed to update organization branding' }, { status: 500 });
  }
}

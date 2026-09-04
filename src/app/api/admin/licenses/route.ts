import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin, apiError } from '@/lib/api';
import { generateLicenseKey } from '@/lib/licenses';
import { log, requestContext } from '@/lib/logger';
import { checkRateLimit, RATE_LIMITS, getClientIpFromHeaders } from '@/lib/rate-limit';

// Super-admin management of self-hosted license keys.
//
// Keys are generated, revoked and listed here. The KEY STRING ITSELF is only
// ever returned to an authenticated super admin — it is NOT exposed through
// the public validation endpoint or any org-facing API.

const LICENSE_TERM_MS = 365 * 24 * 60 * 60 * 1000; // 1 year default

// GET /api/admin/licenses — list license keys (newest first), with the owning
// organization and plan for the management UI.
// Support: ?organizationId=, ?planId=, ?status=active|revoked|all (default all)
export async function GET(req: NextRequest) {
  try {
    const admin = await requireSuperAdmin(req);
    if (!admin.ok) return apiError(admin.status === 401 ? 'Unauthorized' : 'Super admin access required', admin.status);

    const { searchParams } = new URL(req.url);
    const organizationId = searchParams.get('organizationId') || undefined;
    const planId = searchParams.get('planId') || undefined;
    const status = searchParams.get('status') || 'all';

    const where: Record<string, unknown> = {};
    if (organizationId) where.organizationId = organizationId;
    if (planId) where.planId = planId;
    if (status === 'active') where.isRevoked = false;
    if (status === 'revoked') where.isRevoked = true;

    const [licenses, total] = await Promise.all([
      db.licenseKey.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: {
          id: true,
          key: true,
          validFrom: true,
          validUntil: true,
          isActive: true,
          isRevoked: true,
          revokedAt: true,
          revokedReason: true,
          lastVerifiedAt: true,
          verificationCount: true,
          createdAt: true,
          organizationId: true,
          organization: { select: { id: true, name: true } },
          plan: { select: { id: true, name: true } },
        },
      }),
      db.licenseKey.count({ where }),
    ]);

    return NextResponse.json({ data: { licenses, total } });
  } catch (error) {
    log.error('api.admin.licenses.list', { error: String(error) }, requestContext(req));
    return apiError('Failed to list license keys', 500);
  }
}

export type GenerateLicenseBody = {
  organizationId?: unknown;
  planId?: unknown;
  validUntil?: unknown;
};

// POST /api/admin/licenses/generate — create a new license key for an org.
// Body: { organizationId, planId, validUntil? (ISO; defaults to 1 year) }
export async function POST(req: NextRequest) {
  try {
    const admin = await requireSuperAdmin(req);
    if (!admin.ok) return apiError(admin.status === 401 ? 'Unauthorized' : 'Super admin access required', admin.status);

    const clientIp = getClientIpFromHeaders(req.headers);
    const rl = await checkRateLimit(
      `license-generate:${clientIp}`,
      RATE_LIMITS.licenseGenerate.limit,
      RATE_LIMITS.licenseGenerate.windowMs
    );
    if (!rl.allowed) {
      return apiError(`Too many requests. Try again in ${rl.retryAfterSeconds} seconds.`, 429);
    }

    const body = (await req.json().catch(() => ({}))) as GenerateLicenseBody;
    const organizationId = typeof body.organizationId === 'string' ? body.organizationId : '';
    const planId = typeof body.planId === 'string' ? body.planId : '';

    if (!organizationId || !planId) {
      return apiError('organizationId and planId are required', 422);
    }

    const org = await db.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true },
    });
    if (!org) return apiError('Organization not found', 404);

    const plan = await db.plan.findUnique({
      where: { id: planId },
      select: { id: true, name: true, isSelfHosted: true },
    });
    if (!plan) return apiError('Plan not found', 404);
    if (!plan.isSelfHosted) {
      return apiError('Only self-hosted plans can issue license keys', 422);
    }

    // validUntil — default 1 year from now, must be in the future.
    let validUntil = new Date(Date.now() + LICENSE_TERM_MS);
    if (typeof body.validUntil === 'string' && body.validUntil) {
      const parsed = new Date(body.validUntil);
      if (Number.isNaN(parsed.getTime())) return apiError('validUntil must be a valid ISO date', 422);
      if (parsed.getTime() <= Date.now()) return apiError('validUntil must be in the future', 422);
      validUntil = parsed;
    }

    const key = generateLicenseKey();
    const validFrom = new Date();

    const created = await db.$transaction(async (tx) => {
      const license = await tx.licenseKey.create({
        data: {
          key,
          organizationId,
          planId,
          validFrom,
          validUntil,
          isActive: true,
        },
      });

      // Point the org at its new current license.
      await tx.organization.update({
        where: { id: organizationId },
        data: { licenseKeyId: license.id },
      });

      await tx.auditLog.create({
        data: {
          action: 'create',
          resource: 'license_key',
          resourceId: license.id,
          description: `Super admin (${admin.email}) generated a license key for org "${org.name}" (plan ${plan.name})`,
          userId: admin.userId,
          organizationId,
        },
      });

      return license;
    });

    return NextResponse.json({ success: true, license: created }, { status: 201 });
  } catch (error) {
    log.error('api.admin.licenses.generate', { error: String(error) }, requestContext(req));
    return apiError('Failed to generate license key', 500);
  }
}

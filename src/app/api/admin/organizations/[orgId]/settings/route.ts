import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin, apiError } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

// Super-admin management of the per-organization screenshot cadence.
//
// screenshotInterval (Organization column, minutes between screenshots; 0 =
// disabled) is a SUPER-ADMIN-owned setting — the org-facing monitoring UI no
// longer exposes a screenshot cadence control (Prompt 3, item 1A), because the
// desktop agent's cadence is now driven by this column via GET /api/agent/config.

const MIN_INTERVAL = 0;
const MAX_INTERVAL = 60;

function parseInterval(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < MIN_INTERVAL || n > MAX_INTERVAL) return null;
  return n;
}

// GET /api/admin/organizations/[orgId]/settings — org identity + current SaaS
// settings so the admin page can render without a second lookup.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const admin = await requireSuperAdmin(req);
    if (!admin.ok) return apiError(admin.status === 401 ? 'Unauthorized' : 'Super admin access required', admin.status);

    const { orgId } = await params;
    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: {
        id: true,
        name: true,
        email: true,
        screenshotInterval: true,
        activeDeviceCount: true,
        subscription: { select: { plan: { select: { name: true } } } },
      },
    });
    if (!org) return apiError('Organization not found', 404);

    return NextResponse.json({
      data: {
        id: org.id,
        name: org.name,
        email: org.email,
        screenshotInterval: org.screenshotInterval,
        activeDeviceCount: org.activeDeviceCount,
        planName: org.subscription?.plan?.name ?? 'Free',
      },
    });
  } catch (error) {
    log.error('api.admin.org.settings', { error: String(error) }, requestContext(req));
    return apiError('Failed to load organization settings', 500);
  }
}

// PUT /api/admin/organizations/[orgId]/settings — update the screenshot cadence.
// Body: { screenshotInterval: number } (0-60 minutes; 0 = disabled).
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const admin = await requireSuperAdmin(req);
    if (!admin.ok) return apiError(admin.status === 401 ? 'Unauthorized' : 'Super admin access required', admin.status);

    const { orgId } = await params;
    const body = (await req.json().catch(() => ({}))) as { screenshotInterval?: unknown };

    const interval = parseInterval(body.screenshotInterval);
    if (interval === null) {
      return apiError(`screenshotInterval must be a whole number between ${MIN_INTERVAL} and ${MAX_INTERVAL} (0 = disabled)`, 422);
    }

    const org = await db.organization.findUnique({ where: { id: orgId }, select: { id: true } });
    if (!org) return apiError('Organization not found', 404);

    await db.organization.update({
      where: { id: orgId },
      data: { screenshotInterval: interval },
    });

    await db.auditLog.create({
      data: {
        action: 'configure',
        resource: 'organization',
        resourceId: orgId,
        description: `Super admin (${admin.email}) set screenshot interval to ${interval} minute(s)`,
        userId: admin.userId,
        organizationId: orgId,
      },
    });

    return NextResponse.json({ success: true, screenshotInterval: interval });
  } catch (error) {
    log.error('api.admin.org.settings', { error: String(error) }, requestContext(req));
    return apiError('Failed to update organization settings', 500);
  }
}

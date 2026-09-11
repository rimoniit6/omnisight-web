'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSessionOrg, authenticateRequest, getPrismaForOrg } from '@/lib/api';
import { hasRolePermission } from '@/lib/auth';
import { isValidTimezone } from '@/lib/timezone';
import { log, requestContext } from '@/lib/logger';

export async function GET(req: NextRequest) {
  try {
    // Tenant isolation: org identity comes from the authenticated session.
    const sessionOrg = await getSessionOrg(req);
    const org = sessionOrg
      ? await db.organization.findUnique({ where: { id: sessionOrg.id } })
      : null;
    if (!org) {
      return NextResponse.json({ error: 'No organization found' }, { status: 404 });
    }
    const orgData = (await getPrismaForOrg(org.id)).client;

    const [employeeCount, activeEmployeeCount, deviceCount, departments, recentAuditLogs, activeAlertsCount] =
      await Promise.all([
        orgData.employee.count({ where: { organizationId: org.id } }),
        orgData.employee.count({ where: { organizationId: org.id, status: 'active' } }),
        orgData.device.count({ where: { organizationId: org.id } }),
        orgData.department.findMany({
          where: { organizationId: org.id },
          include: {
            manager: { select: { id: true, firstName: true, lastName: true } },
            _count: { select: { employees: true } },
          },
          orderBy: { name: 'asc' },
        }),
        orgData.auditLog.findMany({
          where: { organizationId: org.id },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
        orgData.alert.count({ where: { organizationId: org.id, status: 'pending' } }),
      ]);

    return NextResponse.json({
      ...org,
      employeeCount,
      activeEmployeeCount,
      deviceCount,
      departments,
      recentAuditLogs,
      activeAlertsCount,
    });
  } catch (error) {
    log.error('api.organization.', { error: String('Organization GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch organization' }, { status: 500 });
  }
}

// PATCH /api/organization — update organization-scoped configuration.
// Currently supports `timezone` (admin+). Organization identity always comes
// from the verified session; the timezone is validated as a real IANA zone
// (never an arbitrary string) and the change is audited.
export async function PATCH(req: NextRequest) {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }
    if (!hasRolePermission(auth.role, 'admin')) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }
    const sessionOrg = await getSessionOrg(req);
    if (!sessionOrg) {
      return NextResponse.json({ error: 'No organization found' }, { status: 404 });
    }

    const body = await req.json();
    const { timezone } = body as { timezone?: unknown };

    if (typeof timezone !== 'string' || !isValidTimezone(timezone)) {
      return NextResponse.json(
        { error: 'Invalid timezone. Provide a valid IANA timezone (e.g. Asia/Dhaka, UTC, America/New_York).' },
        { status: 400 }
      );
    }

    const updated = await db.$transaction(async (tx) => {
      const org = await tx.organization.update({
        where: { id: sessionOrg.id },
        data: { timezone },
      });
      await tx.auditLog.create({
        data: {
          action: 'configure',
          resource: 'organization',
          resourceId: sessionOrg.id,
          description: `Organization timezone changed to ${timezone} by ${auth.email}`,
          userId: auth.userId,
          organizationId: sessionOrg.id,
        },
      });
      return org;
    });

    return NextResponse.json({ data: updated });
  } catch (error) {
    log.error('api.organization.', { error: String('Organization PATCH error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to update organization' }, { status: 500 });
  }
}

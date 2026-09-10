'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg, requireAdminOrg } from '@/lib/api';
import { getDeviceDeleteImpact } from '@/lib/delete-impact';
import { getClientIp } from '@/lib/agent/auth';
import { effectiveDeviceStatus } from '@/lib/device-status';
import { log, requestContext } from '@/lib/logger';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    const { id } = await params;
    const device = await db.device.findFirst({
      where: { id, ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) },
      include: {
        employee: { select: { id: true, firstName: true, lastName: true } },
        // Explicit select: the response only exposes the timeline-relevant
        // activity fields — heavy columns (url, applicationName, deviceId) are
        // not transferred for the recent-activity summary.
        activities: {
          select: { id: true, title: true, category: true, type: true, duration: true, timestamp: true },
          orderBy: { timestamp: 'desc' },
          take: 10,
        },
      },
    });
    // Cross-org device ids must not be disclosed -> 404, never 403/200.
    if (!device) return NextResponse.json({ error: 'Device not found' }, { status: 404 });
    // Lazy stale-offline on the detail view too (read-side only), using the
    // centralized presence threshold.
    if (scope.organizationId) {
      device.status = effectiveDeviceStatus(device.status, device.lastHeartbeat);
    }
    return NextResponse.json({ data: device });
  } catch (error) {
    log.error('api.devices.id.', { error: String('Device GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch device' }, { status: 500 });
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const { id } = await params;
    const body = await req.json();

    const existing = await db.device.findFirst({
      where: { id, organizationId: admin.organizationId },
      select: { id: true },
    });
    if (!existing) return NextResponse.json({ error: 'Device not found' }, { status: 404 });

    // Cross-org validation: employeeId must belong to the caller's org.
    if (body.employeeId) {
      const employee = await db.employee.findFirst({
        where: { id: body.employeeId, organizationId: admin.organizationId },
        select: { id: true },
      });
      if (!employee) {
        return NextResponse.json({ error: 'Employee not found in your organization' }, { status: 422 });
      }
    }

    const device = await db.device.update({
      where: { id },
      data: {
        name: body.name,
        hostname: body.hostname,
        operatingSystem: body.operatingSystem,
        osVersion: body.osVersion,
        processor: body.processor,
        memory: body.memory,
        ipAddress: body.ipAddress,
        macAddress: body.macAddress,
        status: body.status,
        employeeId: body.employeeId || null,
      },
      include: { employee: { select: { id: true, firstName: true, lastName: true } } },
    });
    return NextResponse.json({ data: device });
  } catch (error) {
    log.error('api.devices.id.', { error: String('Device PUT error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to update device' }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const { id } = await params;
    const existing = await db.device.findFirst({
      where: { id, organizationId: admin.organizationId },
      select: { id: true, name: true },
    });
    if (!existing) return NextResponse.json({ error: 'Device not found' }, { status: 404 });

    // Dependency-aware delete: a Device whose historical records (activities,
    // screenshots, locations, webcam/break/audio sessions, USB, policy
    // violations, claims) would be silently cascade-deleted when the row is
    // removed is NEVER hard-deleted by this API. It is retired instead, which
    // keeps every record — mirroring the project's employee/project soft-delete
    // pattern. Only an EMPTY device (no dependents) may be physically removed.
    const impact = await getDeviceDeleteImpact(id, admin.organizationId);

    const audit = async () => {
      await db.auditLog.create({
        data: {
          action: 'delete',
          resource: 'device',
          resourceId: id,
          description:
            impact.disposition === 'soft'
              ? `Device "${existing.name}" retired (DELETE → soft): ${impact.totalImpacted} historical record(s) preserved across ${impact.rows.length} table(s).`
              : `Device "${existing.name}" deleted (no dependent records).`,
          userId: admin.userId,
          ipAddress: getClientIp(req),
          organizationId: admin.organizationId,
        },
      });
    };

    if (impact.disposition === 'soft' && impact.softAction === 'retire') {
      const retired = await db.device.update({
        where: { id },
        data: { status: 'retired' },
      });
      await audit();
      return NextResponse.json({
        data: retired,
        softDeleted: true,
        message: `Device retired instead of deleted — ${impact.totalImpacted} historical record(s) across ${impact.rows.length} table(s) were preserved.`,
        preservedCounts: impact.rows,
      });
    }

    await db.device.delete({ where: { id } });
    await audit();
    return NextResponse.json({ success: true });
  } catch (error) {
    log.error('api.devices.id.', { error: String('Device DELETE error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to delete device' }, { status: 500 });
  }
}

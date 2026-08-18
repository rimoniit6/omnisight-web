'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg, requireAdminOrg } from '@/lib/api';
import { effectiveDeviceStatus } from '@/lib/device-status';

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
    console.error('Device GET error:', error);
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
    console.error('Device PUT error:', error);
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
      select: { id: true },
    });
    if (!existing) return NextResponse.json({ error: 'Device not found' }, { status: 404 });

    await db.device.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Device DELETE error:', error);
    return NextResponse.json({ error: 'Failed to delete device' }, { status: 500 });
  }
}

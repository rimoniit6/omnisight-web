import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg, getPrismaForOrg } from '@/lib/api';
import { effectiveDeviceStatus } from '@/lib/device-status';
import { log, requestContext } from '@/lib/logger';

// GET /api/employees/[id]/devices
// Lightweight device list for UI controls (screenshot capture button).
// Returns only id, name, status, lastHeartbeat — no telemetry data.

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const scope = await requireSessionOrg(request, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    const orgData = scope.organizationId ? (await getPrismaForOrg(scope.organizationId)).client : db;

    const { id } = await params;
    const employee = await orgData.employee.findFirst({
      where: { id, ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) },
      select: { id: true },
    });
    if (!employee) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }

    const devices = await orgData.device.findMany({
      where: { employeeId: id, status: { not: 'retired' } },
      orderBy: { registeredAt: 'desc' },
      select: { id: true, name: true, status: true, lastHeartbeat: true },
    });

    const now = Date.now();
    return NextResponse.json({
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name,
        status: effectiveDeviceStatus(d.status, d.lastHeartbeat, undefined, now),
        lastHeartbeat: d.lastHeartbeat ? d.lastHeartbeat.toISOString() : null,
      })),
    });
  } catch (error) {
    log.error('api.employees.id.devices.', { error: String('Device list error:') }, requestContext(request));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

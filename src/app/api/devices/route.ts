'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg, requireAdminOrg, validatePagination } from '@/lib/api';
import { effectiveDeviceStatus } from '@/lib/device-status';
import { log, requestContext } from '@/lib/logger';

export async function GET(req: NextRequest) {
  try {
    // Authenticated, org-scoped: never trust a client-supplied organizationId.
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status');
    const employeeId = searchParams.get('employeeId');

    // Strict pagination validation at the API boundary (P2-7): missing params
    // fall back to safe defaults; garbage (non-numeric, 0, negative, NaN,
    // Infinity, absurd sizes) is rejected with 422 — never a 500.
    const pagination = validatePagination(searchParams, { defaultPageSize: 10, maxPageSize: 200 });
    if (!pagination.ok) {
      return NextResponse.json({ error: pagination.error }, { status: pagination.status });
    }
    const { page, pageSize } = pagination;

    const where: Record<string, unknown> = {};
    if (scope.organizationId) where.organizationId = scope.organizationId;
    if (status) where.status = status;
    if (employeeId) where.employeeId = employeeId;

    const [devices, total] = await Promise.all([
      db.device.findMany({
        where,
        include: {
          employee: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.device.count({ where }),
    ]);

    // Lazy stale-offline: a device whose lastHeartbeat is older than the
    // centralized presence threshold reads as offline even though the stored
    // status is still 'online' (the agent never sends an explicit offline
    // signal). The DB row is untouched — pure read-side view, and it uses the
    // same threshold as the presence API / realtime events so all "online?"
    // decisions agree.
    for (const d of devices) {
      d.status = effectiveDeviceStatus(d.status, d.lastHeartbeat);
    }

    const totalPages = Math.ceil(total / pageSize);
    return NextResponse.json({ data: devices, total, page, pageSize, totalPages });
  } catch (error) {
    log.error('api.devices.', { error: String('Devices GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch devices' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    // Admin-only mutation, org derived from the session.
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const body = await req.json();
    const { name, hostname, operatingSystem, osVersion, processor, memory, ipAddress, macAddress, employeeId } = body;
    if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 });

    // Cross-org validation: an employeeId from another organization is rejected.
    if (employeeId) {
      const employee = await db.employee.findFirst({
        where: { id: employeeId, organizationId: admin.organizationId },
        select: { id: true },
      });
      if (!employee) {
        return NextResponse.json({ error: 'Employee not found in your organization' }, { status: 422 });
      }
    }

    const device = await db.device.create({
      data: {
        name, hostname, operatingSystem, osVersion, processor, memory,
        ipAddress, macAddress, employeeId: employeeId || null,
        status: 'online', organizationId: admin.organizationId,
      },
      include: { employee: { select: { id: true, firstName: true, lastName: true } } },
    });
    return NextResponse.json({ data: device }, { status: 201 });
  } catch (error) {
    log.error('api.devices.', { error: String('Devices POST error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to create device' }, { status: 500 });
  }
}

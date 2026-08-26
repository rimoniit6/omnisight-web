import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import type { Prisma } from '@prisma/client';
import { authError, requireSessionOrg, validatePagination, parseOptionalDate } from '@/lib/api';
import { isValidUsbEventType } from '@/lib/policies/constants';
import { log, requestContext } from '@/lib/logger';

// GET /api/usb-events — List USB monitoring events.
// Tenant isolation: USB events are organization-scoped from the verified
// session — never from client input. Strict pagination: malformed page/
// pageSize/from/to -> 4xx (never NaN/negative reaching Prisma). The 7-day
// summary is computed with DB-side aggregation — no dataset is loaded into
// memory.
export async function GET(req: NextRequest) {
  try {
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) {
      return NextResponse.json({
        data: [],
        total: 0,
        page: 1,
        pageSize: 20,
        totalPages: 0,
        summary: { total: 0, blocked: 0, inserts: 0, removes: 0 },
      });
    }
    const orgId = scope.organizationId;

    const { searchParams } = new URL(req.url);
    const pagination = validatePagination(searchParams, { defaultPageSize: 20, maxPageSize: 100 });
    if (!pagination.ok) {
      return NextResponse.json({ error: pagination.error }, { status: pagination.status });
    }

    const eventType = searchParams.get('eventType') || '';
    if (eventType && !isValidUsbEventType(eventType)) {
      return NextResponse.json({ error: 'eventType must be usb_insert, usb_remove or usb_blocked' }, { status: 422 });
    }
    const blockedOnly = searchParams.get('blocked') === 'true';
    if (searchParams.get('blocked') && searchParams.get('blocked') !== 'true' && searchParams.get('blocked') !== 'false') {
      return NextResponse.json({ error: 'blocked must be true or false' }, { status: 422 });
    }

    // Optional date-range filter with strict validation (reversed ranges 422).
    const from = parseOptionalDate(searchParams.get('from') ?? undefined);
    if (from === 'invalid') return NextResponse.json({ error: 'from must be a valid date' }, { status: 422 });
    const to = parseOptionalDate(searchParams.get('to') ?? undefined);
    if (to === 'invalid') return NextResponse.json({ error: 'to must be a valid date' }, { status: 422 });
    if (from && to && from.getTime() > to.getTime()) {
      return NextResponse.json({ error: 'from must not be after to' }, { status: 422 });
    }

    const where: Prisma.UsbEventWhereInput = { organizationId: orgId };
    if (eventType) where.eventType = eventType;
    if (blockedOnly) where.blocked = true;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = from;
      if (to) where.createdAt.lte = to;
    }

    const [events, total] = await Promise.all([
      db.usbEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.pageSize,
      }),
      db.usbEvent.count({ where }),
    ]);

    // UsbEvent has no relations in the schema — join employees/devices manually
    const empIds = [...new Set(events.map((e) => e.employeeId).filter((id): id is string => Boolean(id)))];
    const devIds = [...new Set(events.map((e) => e.deviceId).filter((id): id is string => Boolean(id)))];
    type EmployeeBrief = { id: string; firstName: string; lastName: string; employeeId: string };
    type DeviceBrief = { id: string; name: string };
    const employees: EmployeeBrief[] = empIds.length > 0
      ? await db.employee.findMany({
          where: { id: { in: empIds } },
          select: { id: true, firstName: true, lastName: true, employeeId: true },
        })
      : [];
    const devices: DeviceBrief[] = devIds.length > 0
      ? await db.device.findMany({
          where: { id: { in: devIds } },
          select: { id: true, name: true },
        })
      : [];
    const employeeMap = new Map(employees.map((e) => [e.id, e]));
    const deviceMap = new Map(devices.map((d) => [d.id, d]));
    const data = events.map((e) => ({
      ...e,
      employee: e.employeeId ? (employeeMap.get(e.employeeId) ?? null) : null,
      device: e.deviceId ? (deviceMap.get(e.deviceId) ?? null) : null,
    }));

    // 7-day summary via DB-side aggregation (bounded — no row loading).
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const summaryScope: Prisma.UsbEventWhereInput = { organizationId: orgId, createdAt: { gte: sevenDaysAgo } };
    const [eventCount, blockedCount, insertCount, removeCount] = await Promise.all([
      db.usbEvent.count({ where: summaryScope }),
      db.usbEvent.count({ where: { ...summaryScope, blocked: true } }),
      db.usbEvent.count({ where: { ...summaryScope, eventType: 'usb_insert' } }),
      db.usbEvent.count({ where: { ...summaryScope, eventType: 'usb_remove' } }),
    ]);

    return NextResponse.json({
      data,
      total,
      page: pagination.page,
      pageSize: pagination.pageSize,
      totalPages: Math.ceil(total / pagination.pageSize),
      summary: { total: eventCount, blocked: blockedCount, inserts: insertCount, removes: removeCount },
    });
  } catch (error) {
    log.error('api.usb-events.', { error: String('USB events GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch USB events' }, { status: 500 });
  }
}

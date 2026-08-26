import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { authError, requireSessionOrg, requireAdminOrg, validatePagination } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    const { id } = await params;
    const { searchParams } = new URL(req.url);

    const employeeId = searchParams.get('employeeId');
    const category = searchParams.get('category');
    const dateFrom = searchParams.get('dateFrom');
    const dateTo = searchParams.get('dateTo');
    const billable = searchParams.get('billable');

    const pagination = validatePagination(searchParams, { defaultPageSize: 50 });
    if (!pagination.ok) {
      return NextResponse.json({ error: pagination.error }, { status: pagination.status });
    }
    const { page, pageSize, skip } = pagination;

    // Validate date filters — an invalid date would produce a 500 inside
    // Prisma; reject it as a client error instead.
    if (dateFrom && Number.isNaN(new Date(dateFrom).getTime())) {
      return NextResponse.json({ error: 'Invalid dateFrom' }, { status: 422 });
    }
    if (dateTo && Number.isNaN(new Date(dateTo).getTime())) {
      return NextResponse.json({ error: 'Invalid dateTo' }, { status: 422 });
    }

    const project = await db.project.findFirst({
      where: { id, ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) },
    });
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const where: Prisma.TimeEntryWhereInput = { projectId: id };
    if (employeeId) where.employeeId = employeeId;
    if (category) where.category = category;
    if (dateFrom || dateTo) {
      const dateFilter: Record<string, Date> = {};
      if (dateFrom) dateFilter.gte = new Date(dateFrom);
      if (dateTo) dateFilter.lte = new Date(dateTo);
      where.date = dateFilter;
    }
    if (billable !== null && billable !== undefined && billable !== '') {
      where.billable = billable === 'true';
    }

    const [timeEntries, total, totalHoursAgg, billableHoursAgg, byCategory, byDate, bySource] = await Promise.all([
      db.timeEntry.findMany({
        where,
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, avatar: true } },
        },
        orderBy: { date: 'desc' },
        skip,
        take: pageSize,
      }),
      // Filter-aware total: the count MUST apply the exact same filters as
      // the data query so pagination math stays consistent.
      db.timeEntry.count({ where }),
      db.timeEntry.aggregate({
        where: { projectId: id },
        _sum: { hours: true },
      }),
      db.timeEntry.aggregate({
        where: { projectId: id, billable: true },
        _sum: { hours: true },
      }),
      db.timeEntry.groupBy({
        by: ['category'],
        where: { projectId: id },
        _sum: { hours: true },
      }),
      // By date — last 30 days
      (() => {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        thirtyDaysAgo.setHours(0, 0, 0, 0);
        return db.timeEntry.groupBy({
          by: ['date'],
          where: { projectId: id, date: { gte: thirtyDaysAgo } },
          _sum: { hours: true },
          orderBy: { date: 'asc' },
        });
      })(),
      db.timeEntry.groupBy({
        by: ['source'],
        where: { projectId: id },
        _sum: { hours: true },
      }),
    ]);

    const totalPages = Math.ceil(total / pageSize);

    return NextResponse.json({
      data: timeEntries,
      total,
      page,
      pageSize,
      totalPages,
      aggregates: {
        totalHours: totalHoursAgg._sum.hours || 0,
        billableHours: billableHoursAgg._sum.hours || 0,
        manualHours: bySource.find((s) => s.source === 'MANUAL')?._sum.hours || 0,
        autoHours: bySource.find((s) => s.source === 'ACTIVITY_AUTO')?._sum.hours || 0,
        byCategory: Object.fromEntries(byCategory.map((c) => [c.category, c._sum.hours || 0])),
        byDate: byDate.map((d) => ({
          date: d.date.toISOString().split('T')[0],
          hours: d._sum.hours || 0,
        })),
      },
    });
  } catch (error) {
    log.error('api.projects.id.time-entries.', { error: String('Project time entries GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch time entries' }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const { id } = await params;
    const body = await req.json();
    const { employeeId, date, hours, description, category, billable } = body;

    if (!employeeId || !date || hours === undefined || hours === null || hours === '') {
      return NextResponse.json({ error: 'employeeId, date, and hours are required' }, { status: 400 });
    }

    // Hours must be a positive number, capped at 24h for a single day.
    const hoursNum = Number(hours);
    if (Number.isNaN(hoursNum) || hoursNum <= 0 || hoursNum > 24) {
      return NextResponse.json({ error: 'Hours must be greater than 0 and at most 24' }, { status: 422 });
    }

    const entryDate = new Date(date);
    if (Number.isNaN(entryDate.getTime())) {
      return NextResponse.json({ error: 'Invalid date' }, { status: 422 });
    }

    const TIME_CATEGORIES = ['development', 'design', 'meeting', 'research', 'testing', 'review', 'admin'] as const;
    if (category !== undefined && category !== null && category !== '' && !(TIME_CATEGORIES as readonly string[]).includes(category)) {
      return NextResponse.json(
        { error: `Invalid category. Allowed: ${TIME_CATEGORIES.join(', ')}` },
        { status: 422 }
      );
    }

    const project = await db.project.findFirst({
      where: { id, organizationId: admin.organizationId },
    });
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Validate employee is an active project member AND belongs to the same org.
    const membership = await db.projectMember.findFirst({
      where: { projectId: id, employeeId, leftAt: null, organizationId: admin.organizationId },
    });
    if (!membership) {
      return NextResponse.json(
        { error: 'Employee is not an active member of this project' },
        { status: 403 }
      );
    }

    const timeEntry = await db.timeEntry.create({
      data: {
        projectId: id,
        employeeId,
        date: entryDate,
        hours: hoursNum,
        description: description || null,
        category: category || null,
        billable: billable !== undefined ? billable : true,
        organizationId: project.organizationId,
      },
      include: {
        employee: { select: { id: true, firstName: true, lastName: true, avatar: true } },
      },
    });

    // Audit log
    await db.auditLog.create({
      data: {
        action: 'create',
        resource: 'time_entry',
        resourceId: timeEntry.id,
        description: `Added ${hoursNum}h time entry to project "${project.name}"`,
        userId: admin.userId,
        organizationId: project.organizationId,
      },
    });

    return NextResponse.json({ data: timeEntry }, { status: 201 });
  } catch (error) {
    log.error('api.projects.id.time-entries.', { error: String('Project time entries POST error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to create time entry' }, { status: 500 });
  }
}

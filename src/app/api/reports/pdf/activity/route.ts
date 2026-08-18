import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { generateActivityReport } from '@/lib/pdf-generator';
import { format, startOfMonth, endOfMonth } from 'date-fns';
import { getSessionOrg, authError, requireManagerOrg, isValidDate, parseJsonBody, BodyParseError } from '@/lib/api';
import { excludeInternalAgentActivities } from '@/lib/agent-process';

export async function POST(request: NextRequest) {
  try {
    // S-3: PDF report generation requires manager-or-above.
    const scope = await requireManagerOrg(request);
    if (!scope.ok) return authError(scope);
    const orgId = scope.organizationId;

    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(request);
    } catch (e) {
      if (e instanceof BodyParseError) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      throw e;
    }
    const { employeeId, dateFrom, dateTo, department, category } = body as {
      employeeId?: string; dateFrom?: string; dateTo?: string; department?: string; category?: string;
    };

    if (employeeId !== undefined && (typeof employeeId !== 'string' || !employeeId)) {
      return NextResponse.json({ error: 'employeeId must be a non-empty string' }, { status: 422 });
    }
    if (department !== undefined && (typeof department !== 'string' || !department)) {
      return NextResponse.json({ error: 'department must be a non-empty string' }, { status: 422 });
    }
    if (category !== undefined && typeof category !== 'string') {
      return NextResponse.json({ error: 'category must be a string' }, { status: 422 });
    }

    // Parse date range — default to current month if not provided
    const startDate = dateFrom ? new Date(dateFrom) : startOfMonth(new Date());
    const endDate = dateTo ? new Date(dateTo) : endOfMonth(new Date());
    if (!isValidDate(startDate) || !isValidDate(endDate)) {
      return NextResponse.json(
        { error: 'Invalid date range. Provide valid ISO dates for dateFrom/dateTo.' },
        { status: 422 },
      );
    }

    // Tenant isolation: every activity is scoped to the caller's org via the
    // employee relation (Activity has no organizationId column).
    const where: Record<string, unknown> = {
      timestamp: { gte: startDate, lte: endDate },
      employee: { organizationId: orgId },
    };

    if (employeeId) {
      where.employeeId = employeeId;
    }

    if (category) {
      where.category = category;
    }

    // If department filter is provided, find employees in THAT ORG's
    // department (cross-org department names resolve to nothing — they can
    // never enumerate foreign employees).
    if (department) {
      const dept = await db.department.findFirst({
        where: { organizationId: orgId, name: { equals: department, mode: 'insensitive' } },
      });
      if (dept) {
        const deptEmployees = await db.employee.findMany({
          where: { departmentId: dept.id },
          select: { id: true },
        });
        const deptEmployeeIds = deptEmployees.map((e) => e.id);
        if (deptEmployeeIds.length > 0) {
          where.employeeId = employeeId
            ? { in: [...deptEmployeeIds, employeeId] as unknown as string }
            : { in: deptEmployeeIds };
        } else {
          // No employees in that department — return empty report
          where.employeeId = '__none__';
        }
      } else {
        // Unknown department name → no rows (never a global fallback).
        where.employeeId = '__none__';
      }
    }

    // Fetch activities (limit to 200 for PDF). Internal agent processes are
    // excluded at the data layer (lib/agent-process.ts).
    const activities = excludeInternalAgentActivities(await db.activity.findMany({
      where,
      include: {
        employee: { include: { department: true } },
        device: true,
      },
      orderBy: { timestamp: 'desc' },
      take: 200,
    }));

    // Compute summary stats
    const totalActivities = activities.length;
    const totalDuration = activities.reduce(
      (sum, a) => sum + (a.duration || 0),
      0,
    );
    const productiveDuration = activities
      .filter((a) => a.category === 'productive')
      .reduce((sum, a) => sum + (a.duration || 0), 0);
    const neutralDuration = activities
      .filter((a) => a.category === 'neutral')
      .reduce((sum, a) => sum + (a.duration || 0), 0);
    const unproductiveDuration = activities
      .filter((a) => a.category === 'unproductive')
      .reduce((sum, a) => sum + (a.duration || 0), 0);

    const productivePercent =
      totalDuration > 0
        ? Math.round((productiveDuration / totalDuration) * 100)
        : 0;
    const neutralPercent =
      totalDuration > 0
        ? Math.round((neutralDuration / totalDuration) * 100)
        : 0;
    const unproductivePercent =
      totalDuration > 0
        ? Math.round((unproductiveDuration / totalDuration) * 100)
        : 0;

    // Fetch organization (name only) from the authenticated session.
    const sessionOrg = await getSessionOrg(request);
    const org = sessionOrg
      ? await db.organization.findUnique({ where: { id: sessionOrg.id }, select: { name: true } })
      : null;

    // Resolve employee name for filter display — org-scoped; a foreign
    // employeeId is concealed (404) rather than echoed into the PDF.
    let employeeName: string | undefined;
    if (employeeId) {
      const emp = await db.employee.findFirst({
        where: { id: employeeId, organizationId: orgId },
        select: { firstName: true, lastName: true },
      });
      if (!emp) {
        return NextResponse.json(
          { error: 'Employee not found' },
          { status: 404 },
        );
      }
      employeeName = `${emp.firstName} ${emp.lastName}`;
    }

    // Generate PDF
    const pdfBuffer = await generateActivityReport(
      activities.map((a) => ({
        id: a.id,
        timestamp: a.timestamp,
        employeeName: `${a.employee.firstName} ${a.employee.lastName}`,
        appOrWebsite:
          a.applicationName || a.title || a.url || '',
        category: a.category || 'neutral',
        duration: a.duration,
        type: a.type,
      })),
      {
        dateRange: { start: startDate, end: endDate },
        department: department || undefined,
        category: category || undefined,
        employee: employeeName,
      },
      {
        totalActivities,
        totalDuration,
        productivePercent,
        neutralPercent,
        unproductivePercent,
      },
      {
        organization: org?.name || 'OmniSight',
      },
    );

    const filename = `activity-report-${format(new Date(), 'yyyy-MM-dd')}.pdf`;

    return new NextResponse(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    console.error('PDF generation error:', error);
    return NextResponse.json(
      { error: 'Failed to generate report' },
      { status: 500 },
    );
  }
}

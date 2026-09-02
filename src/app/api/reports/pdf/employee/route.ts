import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { generateEmployeeReport } from '@/lib/pdf-generator';
import { format, startOfMonth, endOfMonth } from 'date-fns';
import { authError, requireManagerOrg, isValidDate, parseJsonBody, BodyParseError } from '@/lib/api';
import { NON_INTERNAL_AGENT_ACTIVITY_FILTER, excludeInternalAgentActivities } from '@/lib/agent-process';
import { log, requestContext } from '@/lib/logger';
import { getEffectiveBranding } from '@/lib/branding';

export async function POST(request: NextRequest) {
  try {
    // S-3: PDF report generation requires manager-or-above.
    const scope = await requireManagerOrg(request);
    if (!scope.ok) return authError(scope);

    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(request);
    } catch (e) {
      if (e instanceof BodyParseError) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      throw e;
    }
    const { employeeId, dateFrom, dateTo } = body as { employeeId?: string; dateFrom?: string; dateTo?: string };

    if (!employeeId || typeof employeeId !== 'string') {
      return NextResponse.json(
        { error: 'employeeId is required' },
        { status: 400 },
      );
    }

    // Tenant isolation: the employee MUST belong to the caller's org. A
    // foreign employeeId returns 404 (existence concealed) — never a PDF of
    // another organization's employee.
    const employee = await db.employee.findFirst({
      where: { id: employeeId, organizationId: scope.organizationId },
      include: { department: true, organization: true },
    });

    if (!employee) {
      return NextResponse.json(
        { error: 'Employee not found' },
        { status: 404 },
      );
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

    // Fetch activities + run aggregates in parallel (they share the same date range)
    const [rawActivities, totalResult, productiveResult] = await Promise.all([
      // Fetch activities in date range — only select fields needed for the PDF
      // No need to include employee data — we already have the employee's name
      db.activity.findMany({
        where: {
          employeeId,
          timestamp: { gte: startDate, lte: endDate },
        },
        select: {
          id: true,
          timestamp: true,
          applicationName: true,
          title: true,
          url: true,
          category: true,
          duration: true,
          type: true,
        },
        orderBy: { timestamp: 'desc' },
        take: 200,
      }),
      // Aggregate total stats
      db.activity.aggregate({
        where: { employeeId, timestamp: { gte: startDate, lte: endDate }, ...NON_INTERNAL_AGENT_ACTIVITY_FILTER },
        _sum: { duration: true },
        _count: true,
      }),
      // Productive activities aggregate
      db.activity.aggregate({
        where: {
          employeeId,
          category: 'productive',
          timestamp: { gte: startDate, lte: endDate },
          ...NON_INTERNAL_AGENT_ACTIVITY_FILTER,
        },
        _sum: { duration: true },
      }),
    ]);
    const activities = excludeInternalAgentActivities(rawActivities);

    // Compute stats
    const totalDuration = totalResult._sum.duration || 0;
    const productiveDuration = productiveResult._sum.duration || 0;
    const totalHours = totalDuration / 3600;
    const productivityPercent =
      totalDuration > 0
        ? Math.round((productiveDuration / totalDuration) * 100)
        : 0;

    // Active days: count distinct dates
    const activeDaysSet = new Set(
      activities.map((a) => format(new Date(a.timestamp), 'yyyy-MM-dd')),
    );
    const activeDays = activeDaysSet.size;
    const avgDailyHours =
      activeDays > 0 ? parseFloat((totalHours / activeDays).toFixed(2)) : 0;

    // Apps used (unique application names)
    const appsSet = new Set(
      activities
        .filter((a) => a.applicationName)
        .map((a) => a.applicationName),
    );
    const appsUsed = appsSet.size;

    // Websites visited (unique URLs or titles where type is website)
    const websitesSet = new Set(
      activities
        .filter((a) => a.type === 'website' && (a.url || a.title))
        .map((a) => a.url || a.title),
    );
    const websitesVisited = websitesSet.size;

    // Organization name is already available from the scope — no extra query needed
    const org = scope.organizationId
      ? await db.organization.findUnique({ where: { id: scope.organizationId }, select: { name: true } })
      : null;

    const effectiveBranding = await getEffectiveBranding(scope.organizationId);

    // Build employee data for PDF generator
    const employeeData = {
      id: employee.id,
      name: `${employee.firstName} ${employee.lastName}`,
      email: employee.email,
      designation: employee.designation || '',
      department: employee.department?.name || '',
      status: employee.status,
      joinDate: employee.joinDate || new Date(),
    };

    // Build activity data for PDF generator
    // Employee name comes from the employee object (already fetched, no join needed)
    const empFullName = `${employee.firstName} ${employee.lastName}`;
    const activityData = activities.map((a) => ({
      id: a.id,
      timestamp: a.timestamp,
      employeeName: empFullName,
      appOrWebsite:
        a.applicationName || a.title || a.url || '',
      category: a.category || 'neutral',
      duration: a.duration,
      type: a.type,
    }));

    // Generate PDF
    const pdfBuffer = await generateEmployeeReport(
      employeeData,
      activityData,
      {
        totalHours,
        productivityPercent,
        activeDays,
        avgDailyHours,
        appsUsed,
        websitesVisited,
      },
      {
        dateRange: { start: startDate, end: endDate },
        organization: org?.name || 'OmniSight',
        branding: { brandName: effectiveBranding.brandName, primaryColor: effectiveBranding.primaryColor, tagline: effectiveBranding.tagline },
      },
    );

    // Build filename
    const safeName = employee.lastName.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const filename = `employee-report-${safeName}-${format(new Date(), 'yyyy-MM-dd')}.pdf`;

    return new NextResponse(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    log.error('api.reports.pdf.employee.', { error: String('PDF generation error:') }, requestContext(request));
    return NextResponse.json(
      { error: 'Failed to generate report' },
      { status: 500 },
    );
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { generateProjectReport } from '@/lib/pdf-generator';
import { format } from 'date-fns';
import { authError, authenticateRequest, requireSessionOrg } from '@/lib/api';
import { hasRolePermission as hasRole } from '@/lib/auth';
import { log, requestContext } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { projectId } = body;

    if (!projectId || typeof projectId !== 'string') {
      return NextResponse.json(
        { error: 'projectId is required' },
        { status: 400 },
      );
    }

    // S-3: report generation requires manager-or-above.
    const auth = await authenticateRequest(request);
    if (!auth) return authError({ ok: false, status: 401 });
    if (!hasRole(auth.role, 'manager')) return authError({ ok: false, status: 403 });

    // Tenant isolation: the project must belong to the caller's org.
    const scope = await requireSessionOrg(request, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    // Fetch project with department, scoped to the session org (cross-org 404).
    const project = await db.project.findFirst({
      where: { id: projectId, ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) },
      include: { department: true },
    });

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 },
      );
    }

    // Fetch members with employee data (same org boundary). Only the name is
    // rendered into the PDF — never load the full row (it carries
    // agentPassword).
    const members = await db.projectMember.findMany({
      where: { projectId, ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) },
      include: { employee: { select: { id: true, firstName: true, lastName: true } } },
    });

    // Fetch time entries for the project (same org boundary).
    const timeEntries = await db.timeEntry.findMany({
      where: { projectId, ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) },
      include: { employee: { select: { id: true, firstName: true, lastName: true } } },
      orderBy: { date: 'desc' },
      take: 200,
    });

    // Compute total hours per member
    const totalMemberHours: Record<string, number> = {};
    for (const te of timeEntries) {
      totalMemberHours[te.employeeId] =
        (totalMemberHours[te.employeeId] || 0) + te.hours;
    }

    // Organization name for the header (scoped to the session org).
    const org = scope.organizationId
      ? await db.organization.findUnique({ where: { id: scope.organizationId }, select: { name: true } })
      : null;

    // Parse tags
    let tags: string[] = [];
    if (project.tags) {
      try {
        tags = JSON.parse(project.tags);
      } catch {
        tags = [];
      }
    }

    // Generate PDF
    const pdfBuffer = await generateProjectReport(
      {
        name: project.name,
        description: project.description || undefined,
        status: project.status,
        priority: project.priority,
        startDate: project.startDate || undefined,
        deadline: project.deadline || undefined,
        tags,
        estimatedHours: project.estimatedHours,
        budgetType: project.budgetType || undefined,
      },
      members.map((m) => ({
        name: `${m.employee.firstName} ${m.employee.lastName}`,
        role: m.role,
        hoursPerWeek: m.hoursPerWeek,
        totalHours: parseFloat(
          (totalMemberHours[m.employeeId] || 0).toFixed(1),
        ),
        joinDate: m.joinedAt,
      })),
      timeEntries.map((te) => ({
        date: te.date,
        employee: `${te.employee.firstName} ${te.employee.lastName}`,
        hours: te.hours,
        category: te.category || 'general',
        billable: te.billable,
      })),
      {
        organization: org?.name || 'OmniSight',
      },
    );

    // Build filename
    const safeName = project.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const filename = `project-report-${safeName}-${format(new Date(), 'yyyy-MM-dd')}.pdf`;

    return new NextResponse(new Uint8Array(pdfBuffer), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    log.error('api.reports.pdf.project.', { error: String('PDF generation error:') }, requestContext(request));
    return NextResponse.json(
      { error: 'Failed to generate report' },
      { status: 500 },
    );
  }
}

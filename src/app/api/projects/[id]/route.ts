import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg, requireAdminOrg } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

// Authoritative value sets (mirror of the Project model comments).
const PROJECT_STATUSES = ['active', 'on_hold', 'completed', 'cancelled'] as const;
const PROJECT_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
const PROJECT_BUDGET_TYPES = ['fixed', 'hourly', 'retainer'] as const;
const MAX_NAME_LENGTH = 120;

/** Case-insensitive duplicate-name check within an org (provider-agnostic:
 *  fetches the org's project names and compares lowercased in JS). */
async function findDuplicateName(organizationId: string, name: string, excludeId?: string) {
  const existing = await db.project.findMany({
    where: { organizationId, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true, name: true },
  });
  const needle = name.toLowerCase();
  return existing.find((p) => p.name.toLowerCase() === needle) ?? null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    const { id } = await params;

    // Resolve inside the caller's org only; cross-org ids -> 404.
    const project = await db.project.findFirst({
      where: { id, ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) },
      include: {
        department: { select: { id: true, name: true } },
        organization: { select: { id: true, name: true } },
        members: {
          where: { leftAt: null },
          include: {
            employee: {
              select: {
                id: true, firstName: true, lastName: true, avatar: true,
                designation: true, department: { select: { name: true } },
              },
            },
          },
          orderBy: { joinedAt: 'asc' },
        },
        timeEntries: {
          include: {
            employee: { select: { id: true, firstName: true, lastName: true, avatar: true } },
          },
          orderBy: { date: 'desc' },
          take: 50,
        },
      },
    });

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Compute total hours, billable hours and the manual vs auto breakdown.
    const [hoursAgg, memberHours, sourceAgg] = await Promise.all([
      db.timeEntry.aggregate({
        where: { projectId: id },
        _sum: { hours: true },
      }),
      db.timeEntry.groupBy({
        by: ['employeeId'],
        where: { projectId: id },
        _sum: { hours: true },
      }),
      db.timeEntry.groupBy({
        by: ['source'],
        where: { projectId: id },
        _sum: { hours: true },
      }),
    ]);
    const manualHours = sourceAgg.find((s) => s.source === 'MANUAL')?._sum.hours || 0;
    const autoHours = sourceAgg.find((s) => s.source === 'ACTIVITY_AUTO')?._sum.hours || 0;

    const totalHours = hoursAgg._sum.hours || 0;

    const billableAgg = await db.timeEntry.aggregate({
      where: { projectId: id, billable: true },
      _sum: { hours: true },
    });
    const billableHours = billableAgg._sum.hours || 0;

    const progress = project.estimatedHours > 0
      ? Math.min(Math.round((totalHours / project.estimatedHours) * 100), 999)
      : 0;

    const memberHoursMap = new Map(memberHours.map((m) => [m.employeeId, m._sum.hours || 0]));

    const enrichedMembers = project.members.map((m) => ({
      ...m,
      totalHours: memberHoursMap.get(m.employeeId) || 0,
    }));

    // Parse tags
    let parsedTags: string[] = [];
    try {
      parsedTags = project.tags ? JSON.parse(project.tags) : [];
    } catch { /* ignore parse error */ }

    return NextResponse.json({
      data: {
        ...project,
        tags: parsedTags,
        totalHours,
        manualHours,
        autoHours,
        billableHours,
        progress,
        members: enrichedMembers,
      },
    });
  } catch (error) {
    log.error('api.projects.id.', { error: String('Project GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch project' }, { status: 500 });
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

    const existing = await db.project.findFirst({
      where: { id, organizationId: admin.organizationId },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const {
      name, description, status, priority, deadline,
      estimatedHours, color, budgetType, hourlyRate,
      departmentId, tags, startDate,
    } = body;

    // Name may not be blanked out.
    if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
      return NextResponse.json({ error: 'Project name is required' }, { status: 400 });
    }
    if (name !== undefined && name.trim().length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: `Project name must be ${MAX_NAME_LENGTH} characters or fewer` }, { status: 422 });
    }

    // Status / priority / budget type / numbers / dates — same rules as POST.
    if (status !== undefined && !(PROJECT_STATUSES as readonly string[]).includes(status)) {
      return NextResponse.json({ error: `Invalid status. Allowed: ${PROJECT_STATUSES.join(', ')}` }, { status: 422 });
    }
    if (priority !== undefined && !(PROJECT_PRIORITIES as readonly string[]).includes(priority)) {
      return NextResponse.json({ error: `Invalid priority. Allowed: ${PROJECT_PRIORITIES.join(', ')}` }, { status: 422 });
    }
    if (budgetType !== undefined && budgetType !== null && !(PROJECT_BUDGET_TYPES as readonly string[]).includes(budgetType)) {
      return NextResponse.json({ error: `Invalid budget type. Allowed: ${PROJECT_BUDGET_TYPES.join(', ')}` }, { status: 422 });
    }
    if (estimatedHours !== undefined && estimatedHours !== null && (typeof estimatedHours !== 'number' || Number.isNaN(estimatedHours) || estimatedHours < 0)) {
      return NextResponse.json({ error: 'Estimated hours must be a non-negative number' }, { status: 422 });
    }
    if (hourlyRate !== undefined && hourlyRate !== null && (typeof hourlyRate !== 'number' || Number.isNaN(hourlyRate) || hourlyRate < 0)) {
      return NextResponse.json({ error: 'Hourly rate must be a non-negative number' }, { status: 422 });
    }

    const start = startDate ? new Date(startDate) : null;
    const end = deadline ? new Date(deadline) : null;
    if (startDate && (!start || Number.isNaN(start.getTime()))) {
      return NextResponse.json({ error: 'Invalid start date' }, { status: 422 });
    }
    if (deadline && (!end || Number.isNaN(end.getTime()))) {
      return NextResponse.json({ error: 'Invalid deadline' }, { status: 422 });
    }
    if (start && end && start.getTime() > end.getTime()) {
      return NextResponse.json({ error: 'Start date must be on or before the deadline' }, { status: 422 });
    }

    // Duplicate names (case-insensitive) within the org, excluding self.
    if (name !== undefined) {
      const dup = await findDuplicateName(admin.organizationId, name.trim(), id);
      if (dup) {
        return NextResponse.json(
          { error: 'A project with this name already exists in your organization' },
          { status: 409 }
        );
      }
    }

    // Cross-org validation: departmentId must belong to the caller's org.
    if (departmentId) {
      const dept = await db.department.findFirst({
        where: { id: departmentId, organizationId: admin.organizationId },
        select: { id: true },
      });
      if (!dept) {
        return NextResponse.json({ error: 'Department not found in your organization' }, { status: 422 });
      }
    }

    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name.trim();
    if (description !== undefined) updateData.description = description;
    if (status !== undefined) updateData.status = status;
    if (priority !== undefined) updateData.priority = priority;
    if (deadline !== undefined) updateData.deadline = end;
    if (startDate !== undefined) updateData.startDate = start;
    if (estimatedHours !== undefined) updateData.estimatedHours = estimatedHours;
    if (color !== undefined) updateData.color = color;
    if (budgetType !== undefined) updateData.budgetType = budgetType;
    if (hourlyRate !== undefined) updateData.hourlyRate = hourlyRate;
    if (departmentId !== undefined) updateData.departmentId = departmentId;
    if (tags !== undefined) updateData.tags = JSON.stringify(tags);

    const project = await db.project.update({
      where: { id },
      data: updateData,
      include: { department: { select: { id: true, name: true } } },
    });

    // Audit log
    const changes = Object.keys(updateData).join(', ');
    await db.auditLog.create({
      data: {
        action: 'update',
        resource: 'project',
        resourceId: id,
        description: `Updated project "${existing.name}": ${changes}`,
        userId: admin.userId,
        organizationId: existing.organizationId,
      },
    });

    return NextResponse.json({ data: project });
  } catch (error) {
    log.error('api.projects.id.', { error: String('Project PUT error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to update project' }, { status: 500 });
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

    const existing = await db.project.findFirst({
      where: { id, organizationId: admin.organizationId },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Archive (soft delete) by setting status to cancelled. Any employee whose
    // ADMIN-SELECTED active tracking project pointed at this project has it
    // cleared in the same transaction — an archived project can never remain
    // an active tracking target (the sync engine also rejects cancelled
    // projects, but the field should stay honest).
    const project = await db.$transaction(async (tx) => {
      const saved = await tx.project.update({
        where: { id },
        data: { status: 'cancelled' },
        include: { department: { select: { id: true, name: true } } },
      });

      const cleared = await tx.employee.updateMany({
        where: { activeTrackingProjectId: id },
        data: { activeTrackingProjectId: null },
      });

      // Audit log
      await tx.auditLog.create({
        data: {
          action: 'delete',
          resource: 'project',
          resourceId: id,
          description: `Archived project "${existing.name}" (set to cancelled)`,
          userId: admin.userId,
          organizationId: existing.organizationId,
          metadata: cleared.count > 0
            ? JSON.stringify({ clearedActiveTrackingProjects: cleared.count })
            : undefined,
        },
      });

      return saved;
    });

    return NextResponse.json({ data: project, message: 'Project archived (status set to cancelled)' });
  } catch (error) {
    log.error('api.projects.id.', { error: String('Project DELETE error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to archive project' }, { status: 500 });
  }
}

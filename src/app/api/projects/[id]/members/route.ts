import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { authError, requireSessionOrg, requireAdminOrg } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    const { id } = await params;

    const project = await db.project.findFirst({
      where: { id, ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) },
    });
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const members = await db.projectMember.findMany({
      where: { projectId: id, leftAt: null },
      include: {
        employee: {
          select: {
            id: true, employeeId: true, firstName: true, lastName: true, avatar: true,
            designation: true, department: { select: { name: true } },
            // Lets the Team tab render the admin-selected active tracking
            // project state without a second fetch.
            activeTrackingProjectId: true,
          },
        },
      },
      orderBy: { joinedAt: 'asc' },
    });

    // Compute total hours per member for this project
    const memberIds = members.map((m) => m.employeeId);
    const hoursByEmployee = memberIds.length > 0
      ? await db.timeEntry.groupBy({
          by: ['employeeId'],
          where: { projectId: id, employeeId: { in: memberIds } },
          _sum: { hours: true },
        })
      : [];
    const hoursMap = new Map(hoursByEmployee.map((h) => [h.employeeId, h._sum.hours || 0]));

    // Compute this week hours per member (Monday to Sunday of current week)
    const now = new Date();
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(now);
    monday.setDate(now.getDate() - mondayOffset);
    monday.setHours(0, 0, 0, 0);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);

    const weekHoursByEmployee = memberIds.length > 0
      ? await db.timeEntry.groupBy({
          by: ['employeeId'],
          where: {
            projectId: id,
            employeeId: { in: memberIds },
            date: { gte: monday, lte: sunday },
          },
          _sum: { hours: true },
        })
      : [];
    const weekHoursMap = new Map(weekHoursByEmployee.map((h) => [h.employeeId, h._sum.hours || 0]));

    const enrichedMembers = members.map((m) => ({
      id: m.id,
      projectId: m.projectId,
      employeeId: m.employeeId,
      role: m.role,
      hoursPerWeek: m.hoursPerWeek,
      joinedAt: m.joinedAt,
      employee: m.employee,
      // Admin-selected active tracking project state (null = not selected).
      activeTrackingProjectId: m.employee.activeTrackingProjectId ?? null,
      isActiveTracking: m.employee.activeTrackingProjectId === m.projectId,
      totalHours: hoursMap.get(m.employeeId) || 0,
      thisWeekHours: weekHoursMap.get(m.employeeId) || 0,
    }));

    return NextResponse.json({ data: enrichedMembers, total: enrichedMembers.length });
  } catch (error) {
    log.error('api.projects.id.members.', { error: String('Project members GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch project members' }, { status: 500 });
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
    const { employeeId, role, hoursPerWeek } = body;

    if (!employeeId) {
      return NextResponse.json({ error: 'employeeId is required' }, { status: 400 });
    }

    const PROJECT_ROLES = ['lead', 'member', 'reviewer', 'stakeholder'] as const;
    if (role !== undefined) {
      if (role === null || typeof role !== 'string' || !(PROJECT_ROLES as readonly string[]).includes(role)) {
        return NextResponse.json(
          { error: `Invalid role. Allowed: ${PROJECT_ROLES.join(', ')}` },
          { status: 422 }
        );
      }
    }
    if (hoursPerWeek !== undefined) {
      const h = Number(hoursPerWeek);
      if (hoursPerWeek === null || Number.isNaN(h) || !Number.isFinite(h) || h < 0 || h > 168) {
        return NextResponse.json({ error: 'hoursPerWeek must be between 0 and 168' }, { status: 422 });
      }
    }

    // Project must belong to the caller's org; cross-org ids -> 404.
    const project = await db.project.findFirst({
      where: { id, organizationId: admin.organizationId },
    });
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Cross-org validation: employee must belong to the SAME org as the project.
    const employee = await db.employee.findFirst({
      where: { id: employeeId, organizationId: admin.organizationId },
    });
    if (!employee) {
      return NextResponse.json({ error: 'Employee not found in your organization' }, { status: 422 });
    }

    const memberRole = role || 'member';
    const memberHours = hoursPerWeek !== undefined && hoursPerWeek !== null ? Number(hoursPerWeek) : 40;

    // Active membership? 409. A previously soft-removed membership (leftAt set)
    // is REACTIVATED instead of recreated — the (projectId, employeeId) unique
    // constraint forbids a second row and history must be preserved.
    //
    // The find→create/update runs inside a transaction so two concurrent
    // requests for the same (projectId, employeeId) can't both attempt a
    // `create` and blow up on the unique constraint; a lost race surfaces as a
    // clean 409 instead.
    try {
      const member = await db.$transaction(async (tx) => {
        const existing = await tx.projectMember.findUnique({
          where: { projectId_employeeId: { projectId: id, employeeId } },
        });
        if (existing && existing.leftAt === null) {
          return { conflict: true as const };
        }

        const saved = existing
          ? await tx.projectMember.update({
              where: { id: existing.id },
              data: {
                role: memberRole,
                hoursPerWeek: memberHours,
                leftAt: null,
                joinedAt: new Date(),
              },
              include: {
                employee: {
                  select: {
                    id: true, employeeId: true, firstName: true, lastName: true, avatar: true,
                    designation: true, department: { select: { name: true } },
                  },
                },
              },
            })
          : await tx.projectMember.create({
              data: {
                projectId: id,
                employeeId,
                role: memberRole,
                hoursPerWeek: memberHours,
                organizationId: project.organizationId,
              },
              include: {
                employee: {
                  select: {
                    id: true, employeeId: true, firstName: true, lastName: true, avatar: true,
                    designation: true, department: { select: { name: true } },
                  },
                },
              },
            });

        // Audit log
        await tx.auditLog.create({
          data: {
            action: 'create',
            resource: 'project_member',
            resourceId: saved.id,
            description: `${existing ? 'Re-activated' : 'Added'} ${employee.firstName} ${employee.lastName} to project "${project.name}" as ${memberRole}`,
            userId: admin.userId,
            organizationId: project.organizationId,
          },
        });

        return { conflict: false as const, member: saved };
      });

      if (member.conflict) {
        return NextResponse.json({ error: 'Employee is already a member of this project' }, { status: 409 });
      }
      return NextResponse.json({ data: member.member }, { status: 201 });
    } catch (error: unknown) {
      // A concurrent request won the create race — the unique constraint fired.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return NextResponse.json({ error: 'Employee is already a member of this project' }, { status: 409 });
      }
      throw error;
    }
  } catch (error: unknown) {
    log.error('api.projects.id.members.', { error: String('Project members POST error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to add project member' }, { status: 500 });
  }
}

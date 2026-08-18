'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg, requireAdminOrg } from '@/lib/api';

/**
 * Employee ↔ Project memberships.
 *
 * GET — list every membership (active + past) for one employee, enriched
 *       with project info and logged time. Org-scoped: cross-org ids -> 404.
 * PUT — replace the employee's ACTIVE project assignments with the given
 *       projectIds. Runs in a transaction: missing memberships are created,
 *       stale ones are soft-removed (leftAt = now) so history and time
 *       entries stay intact. Duplicate (projectId, employeeId) is impossible
 *       by schema unique constraint; an idempotent re-assign is a no-op.
 */

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    const { id } = await params;
    const employee = await db.employee.findFirst({
      where: { id, ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) },
      select: { id: true },
    });
    if (!employee) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }

    const memberships = await db.projectMember.findMany({
      where: { employeeId: id },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            status: true,
            priority: true,
            color: true,
            startDate: true,
            deadline: true,
          },
        },
      },
      orderBy: [{ leftAt: 'asc' }, { joinedAt: 'desc' }],
    });

    // Total logged hours per project for this employee.
    const hours = await db.timeEntry.groupBy({
      by: ['projectId'],
      where: { employeeId: id, projectId: { in: memberships.map((m) => m.projectId) } },
      _sum: { hours: true },
    });
    const hoursMap = new Map(hours.map((h) => [h.projectId, h._sum.hours || 0]));

    const data = memberships.map((m) => ({
      id: m.id,
      projectId: m.projectId,
      role: m.role,
      hoursPerWeek: m.hoursPerWeek,
      joinedAt: m.joinedAt,
      leftAt: m.leftAt,
      project: m.project,
      totalHours: hoursMap.get(m.projectId) || 0,
    }));

    return NextResponse.json({ data, total: data.length });
  } catch (error) {
    console.error('Employee projects GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch employee projects' }, { status: 500 });
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
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || !Array.isArray(body.projectIds)) {
      return NextResponse.json({ error: 'projectIds array is required' }, { status: 400 });
    }
    const rawIds = body.projectIds as unknown[];
    const projectIds: string[] = [...new Set(rawIds.filter((p): p is string => typeof p === 'string'))];
    if (projectIds.length > 100) {
      return NextResponse.json({ error: 'Too many projects (max 100)' }, { status: 400 });
    }

    const employee = await db.employee.findFirst({
      where: { id, organizationId: admin.organizationId },
      select: { id: true, firstName: true, lastName: true, activeTrackingProjectId: true },
    });
    if (!employee) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }

    // Every requested project must belong to the caller's org; cross-org -> 422.
    const projects = projectIds.length > 0
      ? await db.project.findMany({
          where: { id: { in: projectIds }, organizationId: admin.organizationId },
          select: { id: true, name: true },
        })
      : [];
    if (projects.length !== projectIds.length) {
      return NextResponse.json(
        { error: 'One or more projects were not found in your organization' },
        { status: 422 }
      );
    }

    const name = `${employee.firstName} ${employee.lastName}`.trim() || employee.id;
    const projectNameMap = new Map(projects.map((p) => [p.id, p.name]));

    const result = await db.$transaction(async (tx) => {
      // ALL memberships (active + left) so previously-removed projects can be
      // REACTIVATED — the (projectId, employeeId) unique constraint forbids
      // creating a second row for a soft-removed membership.
      const current = await tx.projectMember.findMany({
        where: { employeeId: id },
        select: { id: true, projectId: true, leftAt: true },
      });
      const activeIds = new Set(current.filter((m) => !m.leftAt).map((m) => m.projectId));
      const byProject = new Map(current.map((m) => [m.projectId, m]));
      const now = new Date();

      const toAdd = projectIds.filter((p) => !activeIds.has(p));
      const toRemove = current.filter((m) => !m.leftAt && !projectIds.includes(m.projectId));

      if (toAdd.length > 0) {
        const toCreate = toAdd.filter((projectId) => !byProject.has(projectId));
        const toReactivate = toAdd.filter((projectId) => byProject.has(projectId));

        if (toCreate.length > 0) {
          await tx.projectMember.createMany({
            data: toCreate.map((projectId) => ({
              projectId,
              employeeId: id,
              role: 'member',
              hoursPerWeek: 40,
              organizationId: admin.organizationId,
              joinedAt: now,
            })),
          });
        }
        if (toReactivate.length > 0) {
          await tx.projectMember.updateMany({
            where: { id: { in: toReactivate.map((p) => byProject.get(p)!.id) } },
            data: { leftAt: null, joinedAt: now },
          });
        }
        for (const projectId of toAdd) {
          await tx.auditLog.create({
            data: {
              action: 'create',
              resource: 'project_member',
              resourceId: id,
              description: `${byProject.has(projectId) ? 'Re-activated' : 'Assigned'} ${name} to project "${projectNameMap.get(projectId)}"`,
              userId: admin.userId,
              organizationId: admin.organizationId,
            },
          });
        }
      }

      if (toRemove.length > 0) {
        // Soft-remove: preserves the membership history and keeps existing
        // time entries valid. Never deletes the project itself.
        await tx.projectMember.updateMany({
          where: { id: { in: toRemove.map((m) => m.id) } },
          data: { leftAt: now },
        });
        for (const member of toRemove) {
          await tx.auditLog.create({
            data: {
              action: 'delete',
              resource: 'project_member',
              resourceId: member.id,
              description: `Removed ${name} from project "${projectNameMap.get(member.projectId)}"`,
              userId: admin.userId,
              organizationId: admin.organizationId,
            },
          });
        }

        // If the removed membership was this employee's ADMIN-SELECTED active
        // tracking project, clear it in the same transaction — a stale
        // reference must never survive a removal.
        if (employee.activeTrackingProjectId && toRemove.some((m) => m.projectId === employee.activeTrackingProjectId)) {
          await tx.employee.update({
            where: { id },
            data: { activeTrackingProjectId: null },
          });
        }
      }

      return { added: toAdd.length, removed: toRemove.length };
    });

    return NextResponse.json({ data: result, message: 'Project assignments updated' });
  } catch (error: unknown) {
    console.error('Employee projects PUT error:', error);
    return NextResponse.json({ error: 'Failed to update project assignments' }, { status: 500 });
  }
}

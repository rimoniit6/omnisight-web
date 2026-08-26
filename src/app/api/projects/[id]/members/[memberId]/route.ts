import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; memberId: string }> }
) {
  try {
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const { id, memberId } = await params;
    const body = await req.json();
    const { role, hoursPerWeek } = body;

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
      select: { id: true },
    });
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const member = await db.projectMember.findFirst({
      where: { id: memberId, projectId: id },
      // Employee fields are used for the audit description only — never load
      // the full row (it carries agentPassword).
      include: {
        employee: { select: { id: true, firstName: true, lastName: true } },
        project: true,
      },
    });

    if (!member) {
      return NextResponse.json({ error: 'Project member not found' }, { status: 404 });
    }

    const updateData: Record<string, unknown> = {};
    if (role !== undefined) updateData.role = role;
    if (hoursPerWeek !== undefined) updateData.hoursPerWeek = hoursPerWeek;

    const updated = await db.projectMember.update({
      where: { id: memberId },
      data: updateData,
      include: {
        employee: {
          select: {
            id: true, firstName: true, lastName: true, avatar: true,
            designation: true, department: { select: { name: true } },
          },
        },
      },
    });

    // Audit log
    await db.auditLog.create({
      data: {
        action: 'update',
        resource: 'project_member',
        resourceId: memberId,
        description: `Updated ${member.employee.firstName} ${member.employee.lastName} in project "${member.project.name}": ${Object.keys(updateData).join(', ')}`,
        userId: admin.userId,
        organizationId: member.organizationId,
      },
    });

    return NextResponse.json({ data: updated });
  } catch (error) {
    log.error('api.projects.id.members.param.', { error: String('Project member PUT error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to update project member' }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; memberId: string }> }
) {
  try {
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const { id, memberId } = await params;

    // Project must belong to the caller's org; cross-org ids -> 404.
    const project = await db.project.findFirst({
      where: { id, organizationId: admin.organizationId },
      select: { id: true },
    });
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    const member = await db.projectMember.findFirst({
      where: { id: memberId, projectId: id },
      // Employee fields are used for the audit description + the
      // active-tracking-project check below — never load the full row (it
      // carries agentPassword).
      include: {
        employee: {
          select: { id: true, firstName: true, lastName: true, activeTrackingProjectId: true },
        },
        project: true,
      },
    });

    if (!member) {
      return NextResponse.json({ error: 'Project member not found' }, { status: 404 });
    }

    // Soft removal: set leftAt instead of deleting the row so membership
    // history and any recorded time entries stay intact. Re-assigning the
    // employee later reactivates this same row (unique constraint).
    //
    // If this project was the employee's ADMIN-SELECTED active tracking
    // project, it is cleared in the SAME transaction — a stale reference
    // must never survive a removal (the sync engine also rejects it, but the
    // field should stay honest).
    const updated = await db.$transaction(async (tx) => {
      const saved = await tx.projectMember.update({
        where: { id: memberId },
        data: { leftAt: new Date() },
        include: {
          employee: {
            select: {
              id: true, firstName: true, lastName: true, avatar: true,
              designation: true,
              // Internal-only: checked below to clear a stale active-tracking
              // project reference. Not sensitive (an FK), never credential
              // material.
              activeTrackingProjectId: true,
              department: { select: { name: true } },
            },
          },
        },
      });

      if (member.employee.activeTrackingProjectId === member.projectId) {
        await tx.employee.update({
          where: { id: member.employeeId },
          data: { activeTrackingProjectId: null },
        });
      }

      // Audit log
      await tx.auditLog.create({
        data: {
          action: 'delete',
          resource: 'project_member',
          resourceId: memberId,
          description: `Removed ${member.employee.firstName} ${member.employee.lastName} from project "${member.project.name}" (membership kept for history)`,
          userId: admin.userId,
          organizationId: member.organizationId,
          metadata: member.employee.activeTrackingProjectId === member.projectId
            ? JSON.stringify({ clearedActiveTrackingProject: true })
            : undefined,
        },
      });

      return saved;
    });

    return NextResponse.json({ data: updated, message: 'Member removed from project' });
  } catch (error) {
    log.error('api.projects.id.members.param.', { error: String('Project member DELETE error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to remove project member' }, { status: 500 });
  }
}

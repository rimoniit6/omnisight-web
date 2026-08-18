'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg } from '@/lib/api';

/**
 * Admin-controlled Active Tracking Project — single authoritative control.
 *
 * PUT /api/employees/[employeeId]/active-project
 *   Body:  { "projectId": "..." }   → set / switch the active project
 *          { "projectId": null }    → clear it
 *
 * Guarantees (server-enforced, never UI-only):
 *  - Admin-or-above, org-bound session (requireAdminOrg).
 *  - Employee must belong to the caller's org (cross-org ids → 404, never leaks).
 *  - Project must belong to the SAME org as the employee (cross-org → 404).
 *  - Employee must be an ACTIVE member (ProjectMember.leftAt IS NULL).
 *  - Project must not be cancelled/archived.
 *  - Exactly ONE active project per employee (single nullable column).
 *
 * Every change is audited with the previous value so the tracking history is
 * reconstructible: ACTIVE_TRACKING_PROJECT_SET / _CHANGED / _CLEARED.
 *
 * NOTE: setting an active project NEVER grants or bypasses consent — the
 * sync engine still requires activity_tracking consent at sync time.
 */

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const { id: employeeId } = await params;

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid payload: JSON object with projectId is required' }, { status: 400 });
    }
    const { projectId } = body as { projectId?: unknown };

    // `null` clears; otherwise it must be a non-empty string.
    if (projectId !== null) {
      if (typeof projectId !== 'string' || projectId.trim().length === 0) {
        return NextResponse.json(
          { error: 'Invalid payload: projectId must be a string or null' },
          { status: 400 }
        );
      }
    }
    const targetProjectId = projectId as string | null;

    // Employee must exist in the caller's org; cross-org ids -> 404 (concealed).
    const employee = await db.employee.findFirst({
      where: { id: employeeId, organizationId: admin.organizationId },
      select: { id: true, firstName: true, lastName: true, activeTrackingProjectId: true },
    });
    if (!employee) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }

    const name = `${employee.firstName} ${employee.lastName}`.trim() || employee.id;

    // Clearing is a no-op state check + audit; nothing else to validate.
    let project: { id: string; name: string; status: string } | null = null;
    if (targetProjectId !== null) {
      // Project must belong to the SAME org as the employee (and caller).
      project = await db.project.findFirst({
        where: { id: targetProjectId, organizationId: admin.organizationId },
        select: { id: true, name: true, status: true },
      });
      if (!project) {
        return NextResponse.json({ error: 'Project not found' }, { status: 404 });
      }
      if (project.status === 'cancelled') {
        return NextResponse.json(
          { error: 'Project is archived and cannot be an active tracking project' },
          { status: 409 }
        );
      }

      // Active membership required: leftAt IS NULL.
      const membership = await db.projectMember.findUnique({
        where: { projectId_employeeId: { projectId: targetProjectId, employeeId } },
        select: { leftAt: true },
      });
      if (!membership || membership.leftAt !== null) {
        return NextResponse.json(
          { error: 'Employee is not an active member of this project' },
          { status: 409 }
        );
      }
    }

    const previousProjectId = employee.activeTrackingProjectId;

    // No-op when the state already matches — return current state untouched
    // (no redundant audit row, no updatedAt churn).
    if (previousProjectId === targetProjectId) {
      const activeProject =
        targetProjectId === null
          ? null
          : await db.project.findUnique({
              where: { id: targetProjectId },
              select: { id: true, name: true },
            });
      return NextResponse.json({
        data: {
          employeeId,
          activeProject: activeProject ?? null,
        },
      });
    }

    // Derive the audit action from the transition.
    const action =
      previousProjectId === null
        ? 'ACTIVE_TRACKING_PROJECT_SET'
        : targetProjectId === null
          ? 'ACTIVE_TRACKING_PROJECT_CLEARED'
          : 'ACTIVE_TRACKING_PROJECT_CHANGED';

    await db.$transaction(async (tx) => {
      await tx.employee.update({
        where: { id: employeeId },
        data: { activeTrackingProjectId: targetProjectId },
      });
      await tx.auditLog.create({
        data: {
          action,
          resource: 'employee_active_project',
          resourceId: employeeId,
          description:
            targetProjectId === null
              ? `Cleared ${name}'s active tracking project`
              : `Set ${name}'s active tracking project to "${project!.name}"`,
          userId: admin.userId,
          organizationId: admin.organizationId,
          metadata: JSON.stringify({
            employeeId,
            projectId: targetProjectId,
            previousProjectId,
            organizationId: admin.organizationId,
            actorId: admin.userId,
            action,
          }),
        },
      });
    });

    return NextResponse.json({
      data: {
        employeeId,
        activeProject: project
          ? { id: project.id, name: project.name }
          : targetProjectId
            ? await db.project.findUnique({
                where: { id: targetProjectId },
                select: { id: true, name: true },
              })
            : null,
      },
      message: action === 'ACTIVE_TRACKING_PROJECT_CLEARED'
        ? 'Active tracking project cleared'
        : 'Active tracking project updated',
    });
  } catch (error) {
    console.error('Active project PUT error:', error);
    return NextResponse.json({ error: 'Failed to update active tracking project' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { authError, requireAdminOrg } from '@/lib/api';

// Authoritative value set (mirror of the TimeEntry model comment + POST route).
const TIME_CATEGORIES = ['development', 'design', 'meeting', 'research', 'testing', 'review', 'admin'] as const;

/**
 * PUT /api/projects/[projectId]/time-entries/[entryId]
 *
 * Edit a time entry. Admin-only (same role required to create entries).
 * Closed request schema — only employeeId, date, hours, description, category
 * and billable are accepted; any other field is rejected. All values are
 * re-validated with the same rules as creation so aggregation stays exact.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; entryId: string }> }
) {
  try {
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const { id, entryId } = await params;

    // Project must belong to the caller's org; cross-org ids -> 404.
    const project = await db.project.findFirst({
      where: { id, organizationId: admin.organizationId },
      select: { id: true, name: true },
    });
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Entry must exist, belong to this project, and belong to this org.
    const existing = await db.timeEntry.findFirst({
      where: { id: entryId, projectId: id, organizationId: admin.organizationId },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Time entry not found' }, { status: 404 });
    }

    const body = await req.json();

    // Strict/closed schema — reject unknown fields instead of ignoring them.
    const ALLOWED_FIELDS = ['employeeId', 'date', 'hours', 'description', 'category', 'billable'];
    const unknownFields = Object.keys(body).filter((k) => !ALLOWED_FIELDS.includes(k));
    if (unknownFields.length > 0) {
      return NextResponse.json(
        { error: `Unknown field${unknownFields.length > 1 ? 's' : ''}: ${unknownFields.join(', ')}` },
        { status: 422 }
      );
    }

    const updateData: Prisma.TimeEntryUncheckedUpdateInput = {};

    if (body.employeeId !== undefined) {
      if (typeof body.employeeId !== 'string' || !body.employeeId) {
        return NextResponse.json({ error: 'employeeId must be a non-empty string' }, { status: 422 });
      }
      // Employee must be an active member of this project AND belong to the
      // caller's org (same constraint as creation).
      const membership = await db.projectMember.findFirst({
        where: { projectId: id, employeeId: body.employeeId, leftAt: null, organizationId: admin.organizationId },
      });
      if (!membership) {
        return NextResponse.json(
          { error: 'Employee is not an active member of this project' },
          { status: 403 }
        );
      }
      updateData.employeeId = body.employeeId;
    }

    if (body.date !== undefined) {
      const entryDate = new Date(body.date);
      if (Number.isNaN(entryDate.getTime())) {
        return NextResponse.json({ error: 'Invalid date' }, { status: 422 });
      }
      updateData.date = entryDate;
    }

    if (body.hours !== undefined && body.hours !== null && body.hours !== '') {
      const hoursNum = Number(body.hours);
      if (Number.isNaN(hoursNum) || hoursNum <= 0 || hoursNum > 24) {
        return NextResponse.json({ error: 'Hours must be greater than 0 and at most 24' }, { status: 422 });
      }
      updateData.hours = hoursNum;
    }

    if (body.category !== undefined) {
      if (body.category !== null && body.category !== '' && !(TIME_CATEGORIES as readonly string[]).includes(body.category)) {
        return NextResponse.json(
          { error: `Invalid category. Allowed: ${TIME_CATEGORIES.join(', ')}` },
          { status: 422 }
        );
      }
      updateData.category = body.category || null;
    }

    if (body.description !== undefined) {
      if (body.description !== null && typeof body.description !== 'string') {
        return NextResponse.json({ error: 'description must be a string or null' }, { status: 422 });
      }
      updateData.description = body.description || null;
    }

    if (body.billable !== undefined) {
      if (typeof body.billable !== 'boolean') {
        return NextResponse.json({ error: 'billable must be a boolean' }, { status: 422 });
      }
      updateData.billable = body.billable;
    }

    const timeEntry = await db.timeEntry.update({
      where: { id: entryId },
      data: updateData,
      include: {
        employee: { select: { id: true, firstName: true, lastName: true, avatar: true } },
      },
    });

    // Audit log
    await db.auditLog.create({
      data: {
        action: 'update',
        resource: 'time_entry',
        resourceId: entryId,
        description: `Updated time entry in project "${project.name}" (fields: ${Object.keys(updateData).join(', ')})`,
        userId: admin.userId,
        organizationId: admin.organizationId,
      },
    });

    return NextResponse.json({ data: timeEntry });
  } catch (error) {
    console.error('Project time entry PUT error:', error);
    return NextResponse.json({ error: 'Failed to update time entry' }, { status: 500 });
  }
}

/**
 * DELETE /api/projects/[projectId]/time-entries/[entryId]
 *
 * Hard-delete a single time entry (TimeEntry has no dependent rows — the
 * schema's relations point FROM the entry, so safe deletion is supported).
 * Admin-only, org-scoped, and audited.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; entryId: string }> }
) {
  try {
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const { id, entryId } = await params;

    // Project must belong to the caller's org; cross-org ids -> 404.
    const project = await db.project.findFirst({
      where: { id, organizationId: admin.organizationId },
      select: { id: true, name: true },
    });
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Entry must exist, belong to this project, and belong to this org.
    const existing = await db.timeEntry.findFirst({
      where: { id: entryId, projectId: id, organizationId: admin.organizationId },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Time entry not found' }, { status: 404 });
    }

    await db.timeEntry.delete({ where: { id: entryId } });

    // Audit log
    await db.auditLog.create({
      data: {
        action: 'delete',
        resource: 'time_entry',
        resourceId: entryId,
        description: `Deleted time entry (${existing.hours}h) from project "${project.name}"`,
        userId: admin.userId,
        organizationId: admin.organizationId,
      },
    });

    return NextResponse.json({ data: { id: entryId }, message: 'Time entry deleted' });
  } catch (error) {
    console.error('Project time entry DELETE error:', error);
    return NextResponse.json({ error: 'Failed to delete time entry' }, { status: 500 });
  }
}

'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { findOrgGuest, requireGuestWriteScope } from '@/lib/guests';

// POST /api/guests/[id]/convert
// Convert a guest to a normal employee (admin-only, org-scoped, explicit).
//
// Conversion semantics:
//   - Employee.type -> "employee" (the SAME row id and ALL telemetry history
//     are preserved — no duplicate telemetry records, no org change)
//   - Identity fields are updated from the provided valid values; the
//     synthesized employeeId is kept unless a real one is supplied
//   - The Guest row is deleted (audit retains the association) so the record
//     disappears from guest listings
//   - Collision checks: email unique per org, employeeId globally unique,
//     department (if provided) belongs to the org
//   - NEVER creates an AgentAccount automatically and NEVER grants consent
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_IDENTITY_LENGTH = 80;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const scope = await requireGuestWriteScope(req);
    if (!scope.ok) return scope.response;

    const { id } = await params;
    const body = await req.json().catch(() => ({})) as {
      employeeId?: unknown;
      firstName?: unknown;
      lastName?: unknown;
      email?: unknown;
      departmentId?: unknown;
    };

    const firstName = typeof body.firstName === 'string' ? body.firstName.trim() : '';
    const lastName = typeof body.lastName === 'string' ? body.lastName.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const newEmployeeId = typeof body.employeeId === 'string' ? body.employeeId.trim() : '';
    const departmentId = typeof body.departmentId === 'string' && body.departmentId ? body.departmentId : null;

    if (!firstName || firstName.length > MAX_IDENTITY_LENGTH) {
      return NextResponse.json({ error: 'firstName is required (max 80 chars)' }, { status: 422 });
    }
    if (!lastName || lastName.length > MAX_IDENTITY_LENGTH) {
      return NextResponse.json({ error: 'lastName is required (max 80 chars)' }, { status: 422 });
    }
    if (!email || !EMAIL_RE.test(email) || email.length > 254) {
      return NextResponse.json({ error: 'A valid email is required' }, { status: 422 });
    }
    if (newEmployeeId && newEmployeeId.length > 64) {
      return NextResponse.json({ error: 'employeeId must be at most 64 characters' }, { status: 422 });
    }

    const guest = await findOrgGuest(id, scope.organizationId);
    if (!guest) {
      return NextResponse.json({ error: 'Guest not found' }, { status: 404 });
    }
    if (guest.status !== 'ACTIVE' && guest.status !== 'SUSPENDED') {
      return NextResponse.json(
        { error: `Only active or suspended guests can be converted (current: ${guest.status})` },
        { status: 400 }
      );
    }

    // ── Collision checks (org-scoped; exclude the guest's own employee) ────
    if (email.toLowerCase() !== guest.employee.email.toLowerCase()) {
      const emailTaken = await db.employee.findFirst({
        where: { email: { equals: email, mode: 'insensitive' }, organizationId: scope.organizationId, id: { not: guest.employeeId } },
        select: { id: true },
      });
      if (emailTaken) {
        return NextResponse.json({ error: 'An employee with this email already exists in your organization' }, { status: 422 });
      }
    }
    if (newEmployeeId) {
      const idTaken = await db.employee.findFirst({
        where: { employeeId: newEmployeeId, id: { not: guest.employeeId } },
        select: { id: true },
      });
      if (idTaken) {
        return NextResponse.json({ error: 'An employee with this ID already exists' }, { status: 422 });
      }
    }
    if (departmentId) {
      const department = await db.department.findFirst({
        where: { id: departmentId, organizationId: scope.organizationId },
        select: { id: true },
      });
      if (!department) {
        return NextResponse.json({ error: 'Selected department does not exist in your organization' }, { status: 422 });
      }
    }

    const result = await db.$transaction(async (tx) => {
      const employee = await tx.employee.update({
        where: { id: guest.employeeId },
        data: {
          type: 'employee',
          firstName,
          lastName,
          email,
          ...(newEmployeeId ? { employeeId: newEmployeeId } : {}),
          ...(departmentId ? { departmentId } : {}),
          guestId: null,
        },
        select: {
          id: true,
          employeeId: true,
          firstName: true,
          lastName: true,
          email: true,
          status: true,
          type: true,
          organizationId: true,
          departmentId: true,
        },
      });

      // Remove the guest lifecycle row (audit retains the association). The
      // Employee row — and its telemetry history — is preserved.
      await tx.guest.delete({ where: { id: guest.id } });

      await tx.auditLog.create({
        data: {
          action: 'guest_converted',
          resource: 'guest',
          resourceId: guest.id,
          description: `Guest "${guest.device.hostname || guest.device.name}" converted to employee ${employee.employeeId} (${email}) — telemetry history preserved on employee ${employee.id}`,
          userId: scope.userId,
          ipAddress: scope.clientIp,
          organizationId: scope.organizationId,
        },
      });

      return employee;
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error('Guest convert error:', error);
    return NextResponse.json({ error: 'Failed to convert guest' }, { status: 500 });
  }
}

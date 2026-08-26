'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { findOrgGuest, requireGuestWriteScope } from '@/lib/guests';
import { log, requestContext } from '@/lib/logger';

// POST /api/guests/[id]/suspend
// Suspend an ACTIVE guest (admin-only, org-scoped). Reversible via
// /api/guests/[id]/reactivate:
//   - Guest.status -> SUSPENDED
//   - Employee.status -> inactive (future authentication fails closed)
//   - Device.status -> inactive (bound AgentTokens fail closed immediately)
//   - audit event (guest_suspended)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const scope = await requireGuestWriteScope(req);
    if (!scope.ok) return scope.response;

    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;

    const guest = await findOrgGuest(id, scope.organizationId);
    if (!guest) {
      return NextResponse.json({ error: 'Guest not found' }, { status: 404 });
    }
    if (guest.status !== 'ACTIVE') {
      return NextResponse.json(
        { error: `Only active guests can be suspended (current: ${guest.status})` },
        { status: 400 }
      );
    }

    const result = await db.$transaction(async (tx) => {
      await tx.guest.update({
        where: { id: guest.id },
        data: { status: 'SUSPENDED', suspendedAt: new Date(), suspendedBy: scope.userId },
      });
      await tx.employee.update({
        where: { id: guest.employeeId },
        data: { status: 'inactive' },
      });
      await tx.device.update({
        where: { id: guest.deviceId },
        data: { status: 'inactive' },
      });

      await tx.auditLog.create({
        data: {
          action: 'guest_suspended',
          resource: 'guest',
          resourceId: guest.id,
          description: `Guest "${guest.device.hostname || guest.device.name}" suspended${reason ? ` (${reason})` : ''} — runtime access disabled`,
          userId: scope.userId,
          ipAddress: scope.clientIp,
          organizationId: scope.organizationId,
        },
      });

      return tx.guest.findUnique({ where: { id: guest.id }, include: { device: true, employee: true } });
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    log.error('api.guests.id.suspend.', { error: String('Guest suspend error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to suspend guest' }, { status: 500 });
  }
}

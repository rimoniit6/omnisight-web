'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { findOrgGuest, requireGuestWriteScope } from '@/lib/guests';

// POST /api/guests/[id]/reactivate
// Restore a SUSPENDED guest (admin-only, org-scoped):
//   - Guest.status -> ACTIVE
//   - Employee.status -> active (authentication allowed again)
//   - Device.status -> offline (eligible; the agent's PATH A re-auth brings it
//     back to online — the approved claim secret is still valid)
//   - audit event (guest_reactivated)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const scope = await requireGuestWriteScope(req);
    if (!scope.ok) return scope.response;

    const { id } = await params;

    const guest = await findOrgGuest(id, scope.organizationId);
    if (!guest) {
      return NextResponse.json({ error: 'Guest not found' }, { status: 404 });
    }
    if (guest.status !== 'SUSPENDED') {
      return NextResponse.json(
        { error: `Only suspended guests can be reactivated (current: ${guest.status})` },
        { status: 400 }
      );
    }

    const result = await db.$transaction(async (tx) => {
      await tx.guest.update({
        where: { id: guest.id },
        data: { status: 'ACTIVE', suspendedAt: null, suspendedBy: null },
      });
      await tx.employee.update({
        where: { id: guest.employeeId },
        data: { status: 'active' },
      });
      await tx.device.update({
        where: { id: guest.deviceId },
        data: { status: 'offline' },
      });

      await tx.auditLog.create({
        data: {
          action: 'guest_reactivated',
          resource: 'guest',
          resourceId: guest.id,
          description: `Guest "${guest.device.hostname || guest.device.name}" reactivated — runtime access restored`,
          userId: scope.userId,
          ipAddress: scope.clientIp,
          organizationId: scope.organizationId,
        },
      });

      return tx.guest.findUnique({ where: { id: guest.id }, include: { device: true, employee: true } });
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error('Guest reactivate error:', error);
    return NextResponse.json({ error: 'Failed to reactivate guest' }, { status: 500 });
  }
}

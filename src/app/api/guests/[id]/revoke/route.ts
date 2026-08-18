'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { findOrgGuest, requireGuestWriteScope } from '@/lib/guests';

// POST /api/guests/[id]/revoke
// Revoke an ACTIVE/SUSPENDED guest (admin-only, org-scoped). Terminal state:
//   - Guest.status -> REVOKED
//   - Employee.status -> inactive (PATH A auth + validateAgentToken fail closed)
//   - Device.status -> inactive (bound AgentTokens fail closed immediately)
//   - audit event (guest_revoked)
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
    if (guest.status !== 'ACTIVE' && guest.status !== 'SUSPENDED') {
      return NextResponse.json(
        { error: `Only active or suspended guests can be revoked (current: ${guest.status})` },
        { status: 400 }
      );
    }

    const result = await db.$transaction(async (tx) => {
      await tx.guest.update({
        where: { id: guest.id },
        data: { status: 'REVOKED', revokedAt: new Date(), revokedBy: scope.userId },
      });
      // Fail closed everywhere: employee-level (auth + token validation) and
      // device-level (token validation checks device.status online/offline).
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
          action: 'guest_revoked',
          resource: 'guest',
          resourceId: guest.id,
          description: `Guest "${guest.device.hostname || guest.device.name}" revoked${reason ? ` (${reason})` : ''} — device deactivated, tokens invalidated`,
          userId: scope.userId,
          ipAddress: scope.clientIp,
          organizationId: scope.organizationId,
        },
      });

      return tx.guest.findUnique({ where: { id: guest.id }, include: { device: true, employee: true } });
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    console.error('Guest revoke error:', error);
    return NextResponse.json({ error: 'Failed to revoke guest' }, { status: 500 });
  }
}

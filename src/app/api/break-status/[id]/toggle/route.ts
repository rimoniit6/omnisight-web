import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg } from '@/lib/api';
import { startBreak, endBreak, getCurrentBreak } from '@/lib/breaks/service';
import { EMPLOYEE_ONLINE_THRESHOLD_MS, LIFECYCLE_PINNED_STATUSES } from '@/lib/presence';
import { getClientIpFromHeaders, UNKNOWN_CLIENT_IP } from '@/lib/client-ip';

// POST /api/break-status/[id]/toggle
// Admin force-starts / force-ends an employee's break mode.
//
// Security (S-1): admin-only mutation, organization derived from the verified
// session — never from client input. A viewer/manager (or any lower role) is
// rejected with 403, and an employee id belonging to ANOTHER organization is
// concealed with 404. Failed authorization never reaches a write.
//
// The mutation goes through the canonical break service (src/lib/breaks/
// service.ts) — the same lifecycle the agent and self-service endpoints use —
// and is idempotent/concurrency-safe (no duplicate active breaks).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const { id } = await params;

    // Tenant isolation: the target employee must belong to the authenticated
    // admin's organization. Cross-org / nonexistent ids both return 404.
    const employee = await db.employee.findFirst({
      where: { id, organizationId: admin.organizationId },
      select: { id: true, employeeId: true, firstName: true, lastName: true, organizationId: true },
    });

    if (!employee) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }

    // Only a LIVE device (fresh heartbeat, non-lifecycle status) is attributed
    // as the employee's active device — org-scoped so the activity/session can
    // never carry a deviceId referencing another organization.
    const device = await db.device.findFirst({
      where: {
        employeeId: id,
        organizationId: admin.organizationId,
        status: { notIn: [...LIFECYCLE_PINNED_STATUSES] },
        lastHeartbeat: { gt: new Date(Date.now() - EMPLOYEE_ONLINE_THRESHOLD_MS) },
      },
      select: { id: true },
    });

    // Canonical spoof-resistant client IP (same resolver as rate limiting /
    // audit logs) — never the attacker-controlled left-most XFF entry.
    const clientIp = getClientIpFromHeaders(req.headers);
    const ipAddress = clientIp === UNKNOWN_CLIENT_IP ? null : clientIp;
    const current = await getCurrentBreak(employee.id);

    let result: { session: { id: string; startedAt: Date; endedAt: Date | null } | null; action: string };
    if (current) {
      const ended = await endBreak({
        employeeId: employee.id,
        deviceId: device?.id || null,
        source: 'admin',
        actor: admin.userId,
        ipAddress,
      });
      result = { session: ended.session, action: 'ended' };
    } else {
      const started = await startBreak({
        organizationId: admin.organizationId,
        employeeId: employee.id,
        deviceId: device?.id || null,
        source: 'admin',
        actor: admin.userId,
        ipAddress,
      });
      result = { session: started.session, action: 'started' };
    }

    const isEnd = result.action === 'ended';
    return NextResponse.json({
      success: true,
      action: isEnd ? 'ended' : 'started',
      breakMode: !isEnd,
      startedAt: result.session?.startedAt.toISOString() ?? null,
      endedAt: result.session?.endedAt ? result.session.endedAt.toISOString() : null,
      message: `Break ${isEnd ? 'ended' : 'started'} for ${employee.firstName} ${employee.lastName}`,
    });
  } catch (error) {
    console.error('Break toggle error:', error);
    return NextResponse.json({ error: 'Failed to toggle break mode' }, { status: 500 });
  }
}

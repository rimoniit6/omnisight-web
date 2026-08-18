import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { log } from '@/lib/logger';
import { revokeAgentSession } from '@/lib/agent/session';
import { getClientIpFromHeaders } from '@/lib/rate-limit';

// POST /api/agent/logout
// Server-side agent session/token revocation. The agent sends its current
// bearer token; the server deletes it so it can no longer be used for
// discover, heartbeats, activity uploads, screenshot uploads, or any other
// agent API. The renderer returns to the login screen after a successful
// logout.
//
// CRITICAL: this does NOT delete the Device, DeviceClaim history, Employee,
// or AgentAccount. It only revokes the current credential(s). The agent can
// log in again with the same AgentAccount credentials.
export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    const clientIp = getClientIpFromHeaders(req.headers);
    if (!authHeader?.startsWith('Bearer ')) {
      // Idempotent: if the renderer already cleared its local token, this
      // is not an error — the server has no credential to revoke.
      return NextResponse.json({ success: true, message: 'No active session' });
    }

    const token = authHeader.substring(7);
    if (!token || token.length < 20) {
      return NextResponse.json({ success: true, message: 'No active session' });
    }

    // Revoke an AgentSession (login-only credential) OR a device-bound
    // AgentToken (connected device). Both are handled so logout works whether
    // the agent is mid-bootstrap or fully connected. One query each; both are
    // idempotent.
    let employeeId: string | null = null;
    const matched = await db.agentSession.findUnique({
      where: { token },
      select: { id: true, employeeId: true, organizationId: true },
    });

    if (matched) {
      await db.agentSession.delete({ where: { id: matched.id } });
      employeeId = matched.employeeId;
    } else {
      const deviceToken = await db.agentToken.findUnique({
        where: { token },
        select: {
          id: true,
          employeeId: true,
          employee: { select: { firstName: true, lastName: true, organizationId: true } },
        },
      });
      if (deviceToken) {
        await db.agentToken.delete({ where: { id: deviceToken.id } });
        employeeId = deviceToken.employeeId;
      }
      if (!deviceToken) {
        return NextResponse.json({ success: true, message: 'Session ended' });
      }
    }

    if (employeeId) {
      try {
        const employee = await db.employee.findUnique({
          where: { id: employeeId },
          select: { id: true, firstName: true, lastName: true, organizationId: true },
        });
        // Audit the logout (safe fields only — never the token value).
        await db.auditLog.create({
          data: {
            action: 'logout',
            resource: 'agent_account',
            resourceId: employeeId,
            description: `Agent logout: ${employee ? `${employee.firstName} ${employee.lastName}` : employeeId}`,
            userId: employeeId,
            ipAddress: clientIp,
            organizationId: employee?.organizationId ?? null,
          },
        });
      } catch (e) {
        log.warn('agent.logout.audit_failed', { err: e });
      }
    }

    log.info('agent.logout', {
      employeeId: employeeId?.slice(0, 12) ?? 'unknown',
      ip: clientIp,
    });

    return NextResponse.json({ success: true, message: 'Session ended' });
  } catch (error) {
    log.error('agent.logout.error', { err: error });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
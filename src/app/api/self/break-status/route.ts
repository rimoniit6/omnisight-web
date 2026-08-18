import { NextRequest, NextResponse } from 'next/server';
import { authError, requireManagerOrg, parseJsonBody, BodyParseError } from '@/lib/api';
import { getScopedEmployee } from '@/lib/self-guard';
import { startBreak, endBreak, getCurrentBreak } from '@/lib/breaks/service';
import { getClientIpFromHeaders, UNKNOWN_CLIENT_IP } from '@/lib/client-ip';

// GET /api/self/break-status?employeeId=xxx
// Current break state for one employee (org-scoped).
export async function GET(req: NextRequest) {
  try {
    const scope = await requireManagerOrg(req);
    if (!scope.ok) return authError(scope);

    const { searchParams } = new URL(req.url);
    const employeeId = searchParams.get('employeeId');
    if (!employeeId) {
      return NextResponse.json({ error: 'employeeId is required' }, { status: 400 });
    }

    const { employee, error: scopeError } = await getScopedEmployee(req, employeeId);
    if (scopeError || !employee) {
      return NextResponse.json({ error: scopeError || 'Employee not found' }, { status: 404 });
    }

    const current = await getCurrentBreak(employee.id);
    return NextResponse.json({
      data: {
        employeeId: employee.id,
        onBreak: current !== null,
        startedAt: current ? current.startedAt.toISOString() : null,
        sessionId: current?.id ?? null,
      },
    });
  } catch (error) {
    console.error('Self break-status GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch break status' }, { status: 500 });
  }
}

// POST /api/self/break-status
// Self-service break toggle (Employee Portal).
//
// Auth/RBAC: manager-or-above, org identity derived from the verified session
// (mirrors every other /api/self/* route). The target employee is resolved
// with getScopedEmployee — the employee id/code may belong ONLY to the
// caller's organization; cross-org / unknown ids are concealed with 404.
// Client-supplied organizationId / deviceId are never accepted.
//
// Body: { employeeId: string, breakMode: boolean }
//
// Uses the SAME canonical break lifecycle as the admin toggle and the agent
// endpoint — one source of truth, idempotent and concurrency-safe.
export async function POST(req: NextRequest) {
  try {
    const scope = await requireManagerOrg(req);
    if (!scope.ok) return authError(scope);

    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      if (e instanceof BodyParseError) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      throw e;
    }

    const { employeeId, breakMode } = body as { employeeId?: unknown; breakMode?: unknown };

    if (typeof employeeId !== 'string' || employeeId.trim().length === 0) {
      return NextResponse.json({ error: 'employeeId is required' }, { status: 400 });
    }
    if (typeof breakMode !== 'boolean') {
      return NextResponse.json({ error: 'breakMode must be boolean' }, { status: 400 });
    }

    // Tenant-scoped lookup: employee must belong to the caller's org.
    const { employee, error: scopeError } = await getScopedEmployee(req, employeeId.trim());
    if (scopeError || !employee) {
      return NextResponse.json({ error: scopeError || 'Employee not found' }, { status: 404 });
    }

    // Canonical spoof-resistant client IP (same resolver as rate limiting /
    // audit logs) — never the attacker-controlled left-most XFF entry.
    const clientIp = getClientIpFromHeaders(req.headers);
    const ipAddress = clientIp === UNKNOWN_CLIENT_IP ? null : clientIp;
    const current = await getCurrentBreak(employee.id);

    let session: { id: string; startedAt: Date; endedAt: Date | null } | null;
    let action: string;
    if (breakMode) {
      const started = await startBreak({
        organizationId: employee.organizationId,
        employeeId: employee.id,
        source: 'self_service',
        actor: scope.userId,
        ipAddress,
      });
      session = started.session;
      action = started.action;
    } else if (current) {
      const ended = await endBreak({
        employeeId: employee.id,
        source: 'self_service',
        actor: scope.userId,
        ipAddress,
      });
      session = ended.session;
      action = 'ended';
    } else {
      session = null;
      action = 'no_active_break';
    }

    return NextResponse.json({
      success: true,
      breakMode: action === 'started' || action === 'already_active',
      action,
      startedAt: session?.startedAt.toISOString() ?? null,
      endedAt: session?.endedAt ? session.endedAt.toISOString() : null,
      message:
        action === 'started'
          ? 'Break started. Monitoring paused.'
          : action === 'already_active'
            ? 'Break already active.'
            : action === 'ended'
              ? 'Break ended. Monitoring resumed.'
              : 'No active break to end.',
    });
  } catch (error) {
    console.error('Self break-status error:', error);
    return NextResponse.json({ error: 'Failed to update break status' }, { status: 500 });
  }
}

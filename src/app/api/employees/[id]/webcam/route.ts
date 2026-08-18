'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';
import { hasActiveConsent } from '@/lib/consent';
import { resolveOrgMonitoring } from '@/lib/jobs/settings';
import { effectiveDeviceStatus } from '@/lib/device-status';

// GET /api/employees/[id]/webcam
// Admin status for the on-demand webcam control UI.
//
// Returns ONLY safe metadata:
//   - The employee's ACTIVE webcam session (if any) + the most recent ended
//     session (audit context). No frames, no video — the live frame is read
//     separately via the existing authenticated frame relay endpoint.
//   - Consent state (`webcam_access`) and org config state
//     (`webcam_capture_enabled`) so the UI can show NO CONSENT / DISABLED
//     without guessing.
//   - The employee's devices with effective online/offline status (lazy
//     stale-offline, same rule as the device list) so the UI never enqueues
//     a command for an offline agent.
//
//   - Employee lookup is org-scoped (foreign ids → 404).
//   - Manager+ read scope; the device-commands POST route independently
//     enforces admin-only for the start/stop mutation.

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const scope = await requireSessionOrg(request, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    const { id } = await params;
    const employee = await db.employee.findFirst({
      where: { id, ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) },
      select: { id: true, organizationId: true },
    });
    if (!employee) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }

    const [activeSession, recentSessions, consentOk, monitoring, devices] = await Promise.all([
      db.webcamSession.findFirst({
        where: { employeeId: id, status: 'active' },
        orderBy: { startedAt: 'desc' },
      }),
      db.webcamSession.findMany({
        where: { employeeId: id, status: { not: 'active' } },
        orderBy: { startedAt: 'desc' },
        take: 5,
      }),
      hasActiveConsent(employee.id, 'webcam_access'),
      resolveOrgMonitoring(employee.organizationId),
      db.device.findMany({
        where: { employeeId: id, status: { not: 'retired' } },
        orderBy: { registeredAt: 'desc' },
        select: { id: true, name: true, status: true, lastHeartbeat: true },
      }),
]);

    const now = Date.now();

    // Stale-session convergence: an "active" session whose frames went silent
    // (e.g. the agent ended it but the end-session POST was rate-limited or
    // lost) must not be reported as LIVE forever. Frames are relayed ~10fps,
    // so a session with lastFrameAt older than the frame TTL (60s) plus a
    // grace window is dead — close it here (idempotent; the same rule runs in
    // the frame GET when the relay is empty).
    //
    // NOTE: lastFrameAt === null (brand-new session, first frame can take ~2s)
    // is deliberately NOT converged — only sessions that HAD frames and then
    // went silent are treated as dead.
    const FRAME_TTL_GRACE_MS = 90_000;
    if (activeSession && activeSession.lastFrameAt) {
      const framesSilentMs = now - activeSession.lastFrameAt.getTime();
      if (framesSilentMs > FRAME_TTL_GRACE_MS) {
        await db.webcamSession.updateMany({
          where: { sessionId: activeSession.sessionId, status: 'active' },
          data: { status: 'ended', endedAt: new Date(), endedReason: 'disconnect' },
        });
        activeSession.status = 'ended' as const;
        activeSession.endedAt = new Date();
        activeSession.endedReason = 'disconnect';
      }
    }

    return NextResponse.json({
      consentGranted: consentOk,
      configEnabled: monitoring.webcam_capture_enabled === true,
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name,
        status: effectiveDeviceStatus(d.status, d.lastHeartbeat, undefined, now),
        lastHeartbeat: d.lastHeartbeat ? d.lastHeartbeat.toISOString() : null,
      })),
      activeSession: activeSession && activeSession.status === 'active'
        ? {
            sessionId: activeSession.sessionId,
            startedAt: activeSession.startedAt.toISOString(),
            startedBy: activeSession.startedBy,
            lastFrameAt: activeSession.lastFrameAt ? activeSession.lastFrameAt.toISOString() : null,
          }
        : null,
      recentSessions: recentSessions.map((s) => ({
        sessionId: s.sessionId,
        startedAt: s.startedAt.toISOString(),
        endedAt: s.endedAt ? s.endedAt.toISOString() : null,
        endedReason: s.endedReason,
        startedBy: s.startedBy,
      })),
    });
  } catch (error) {
    console.error('Admin webcam status error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

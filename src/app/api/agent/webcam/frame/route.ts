import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { validateAgentToken } from '@/lib/agent/auth';
import { hasActiveConsent } from '@/lib/consent';
import { resolveOrgMonitoring } from '@/lib/jobs/settings';
import { requireAdminOrg } from '@/lib/api';
import {
  setLatestFrame,
  getLatestFrame,
  frameFreshness,
  gateDue,
  markGateOk,
  clearSession,
  __MAX_FRAME_BYTES,
} from '@/lib/webcam-relay';

// POST /api/agent/webcam/frame — the agent relays one encoded (JPEG) frame.
// GET  /api/agent/webcam/frame?sessionId=... — admin viewer reads the LATEST
//       frame (the Admin Panel UI itself ships in a later phase; this is the
//       minimal relay contract the Agent needs).
//
// PRIVACY CONTRACT:
//   - Frames live ONLY in the in-memory relay (latest per session, 60s TTL)
//     and are NEVER persisted, logged, queued or analyzed.
//   - The relay accepts JPEG only (magic-byte check), bounded to 1 MB.
//   - Server re-validates `webcam_access` consent + `webcam_capture_enabled`
//     at session creation AND at least every 5s during the session (the
//     gate interval in src/lib/webcam-relay.ts) — a revocation terminates
//     frame flow server-side within ≤5s even if the agent lags.
//   - Only the session-owning device may POST frames; only admin+ of the
//     session's org may GET them.

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

export async function POST(req: NextRequest) {
  try {
    const authResult = await validateAgentToken(req);
    if (!authResult.valid || !authResult.employee || !authResult.deviceId) {
      return NextResponse.json({ error: authResult.error || 'Authentication failed' }, { status: 401 });
    }
    const employee = authResult.employee;
    const deviceId = authResult.deviceId;

    const sessionId = new URL(req.url).searchParams.get('sessionId');
    if (!sessionId || sessionId.length === 0 || sessionId.length > 128) {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 422 });
    }

    const session = await db.webcamSession.findUnique({ where: { sessionId } });
    if (!session || session.deviceId !== deviceId || session.organizationId !== employee.organizationId) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    if (session.status !== 'active') {
      return NextResponse.json({ error: 'Session is not active' }, { status: 409 });
    }

    // Periodic server-side gate re-validation (bounded to every 5s — see
    // gateDue's intervalMs in src/lib/webcam-relay.ts). A consent/config
    // revocation takes effect at the next gate, i.e. within ≤5s.
    if (gateDue(sessionId)) {
      const consentOk = await hasActiveConsent(employee.id, 'webcam_access');
      const monitoring = await resolveOrgMonitoring(employee.organizationId);
      if (!consentOk || monitoring.webcam_capture_enabled !== true) {
        clearSession(sessionId);
        await db.webcamSession.updateMany({
          where: { sessionId, status: 'active' },
          data: { status: 'ended', endedAt: new Date(), endedReason: consentOk ? 'config_disabled' : 'consent_revoked' },
        });
        return NextResponse.json({ error: 'Webcam access revoked or disabled' }, { status: 403 });
      }
      markGateOk(sessionId);
    }

    const form = await req.formData().catch(() => null);
    const file = form?.get('frame');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'frame file is required' }, { status: 422 });
    }
    if (file.size <= 0 || file.size > __MAX_FRAME_BYTES) {
      return NextResponse.json({ error: `frame must be 1..${__MAX_FRAME_BYTES} bytes` }, { status: 422 });
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length < 3 || !bytes.subarray(0, 3).equals(JPEG_MAGIC)) {
      return NextResponse.json({ error: 'frame must be a JPEG image' }, { status: 422 });
    }

    setLatestFrame(sessionId, bytes);
    await db.webcamSession.updateMany({
      where: { sessionId, status: 'active' },
      data: { lastFrameAt: new Date() },
    });

    return NextResponse.json({ success: true, received: bytes.length });
  } catch (error) {
    console.error('Agent webcam frame error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAdminOrg(req);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.status === 401 ? 'Unauthorized. Please sign in.' : 'Insufficient permissions' }, { status: auth.status });
    }
    const sessionId = new URL(req.url).searchParams.get('sessionId');
    if (!sessionId || sessionId.length === 0 || sessionId.length > 128) {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 422 });
    }

    // Org-scoped session lookup — a foreign session is concealed as 404.
    const session = await db.webcamSession.findFirst({
      where: { sessionId, organizationId: auth.organizationId, status: 'active' },
      select: { sessionId: true },
    });
    if (!session) {
      return NextResponse.json({ error: 'No active session' }, { status: 404 });
    }

    const frame = getLatestFrame(sessionId);
    if (!frame) {
      return NextResponse.json({ error: 'No frame available' }, { status: 404 });
    }
    return new NextResponse(new Uint8Array(frame), {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'no-store',
        'X-Frame-Freshness': String(frameFreshness(sessionId) ?? 0),
      },
    });
  } catch (error) {
    console.error('Webcam frame GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

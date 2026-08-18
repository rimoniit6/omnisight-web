// OmniSight — Webcam-session cleanup on consent revocation (S-06).
//
// Consent revocation must stop webcam frame flow IMMEDIATELY, not on the next
// agent frame. This helper ends every active WebcamSession row for an employee
// (status → 'ended', endedReason → 'consent_revoked') and drops the session's
// buffered frames from the in-memory relay so the admin frame-reader can no
// longer retrieve the last frame after revocation (relay TTL would otherwise
// keep it readable for up to 60s).
import { db } from '@/lib/db';
import { clearSession } from '@/lib/webcam-relay';

export async function endWebcamSessionsOnRevoke(employeeId: string): Promise<number> {
  // Resolve the affected opaque session ids first (updateMany does not return rows).
  const active = await db.webcamSession.findMany({
    where: { employeeId, status: 'active' },
    select: { sessionId: true },
  });
  if (active.length === 0) return 0;

  await db.webcamSession.updateMany({
    where: { employeeId, status: 'active' },
    data: { status: 'ended', endedAt: new Date(), endedReason: 'consent_revoked' },
  });

  for (const s of active) clearSession(s.sessionId);

  return active.length;
}

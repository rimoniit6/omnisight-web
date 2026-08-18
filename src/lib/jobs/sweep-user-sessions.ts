// OmniSight — web-session hygiene sweep (S-04 companion).
//
// UserSession rows (one per web login) are deleted once they are both past
// expiry AND revoked — or past expiry AND older than a grace period — so the
// table stays bounded by live/actively-revoked sessions instead of growing
// forever. A revoked-but-unexpired row is KEPT (the JWT carrying that sessionId
// must keep failing its session check; deleting the row would make
// isWebSessionActive() return false either way, but an explicit revokedAt row
// is better evidence for forensics). Runs on the same hourly schedule under
// the shared JobRun lease.
import { db } from '@/lib/db';

export interface UserSessionSweepResult {
  deleted: number;
}

const REVOKED_GRACE_MS = 30 * 24 * 60 * 60 * 1000; // keep revoked rows 30 days

export async function sweepExpiredUserSessions(): Promise<UserSessionSweepResult> {
  const now = new Date();
  // 1) Expired AND revoked — dead twice, safe to delete immediately.
  // 2) Expired (never revoked) beyond the grace period — the token has long
  //    been rejected; no reason to keep the row.
  const { count } = await db.userSession.deleteMany({
    where: {
      expiresAt: { lt: now },
      OR: [{ revokedAt: { not: null } }, { createdAt: { lt: new Date(now.getTime() - REVOKED_GRACE_MS) } }],
    },
  });
  return { deleted: count };
}

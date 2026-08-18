// OmniSight — expired agent-credential sweep (P3-4).
//
// AgentToken (device-bound bearer) and AgentSession (login-only bootstrap)
// rows carry an `expiresAt`. Until this sweep existed, expired rows were only
// deleted lazily on the NEXT attempted use of that token (the auth path deletes
// a stale row when it is presented), so fully-expired credentials accumulated
// in the table indefinitely. The sweep is cheap, indexed on the session's
// expiresAt (and the token table is small), runs on the same hourly schedule
// as the other jobs, and is crash-safe under the shared JobRun lease — exactly
// one worker deletes per round.
import { db } from '@/lib/db';

export interface AgentTokenSweepResult {
  expiredAgentTokens: number;
  expiredAgentSessions: number;
}

export async function sweepExpiredAgentCredentials(): Promise<AgentTokenSweepResult> {
  const now = new Date();
  const [expiredAgentTokens, expiredAgentSessions] = await Promise.all([
    db.agentToken.deleteMany({ where: { expiresAt: { lt: now } } }),
    db.agentSession.deleteMany({ where: { expiresAt: { lt: now } } }),
  ]);
  return {
    expiredAgentTokens: expiredAgentTokens.count,
    expiredAgentSessions: expiredAgentSessions.count,
  };
}

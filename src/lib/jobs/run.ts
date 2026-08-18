import { db } from '@/lib/db';
import { expireConsents } from './expire-consents';
import { runRetention } from './retention';
import type { RetentionResult } from './retention';
import { runProjectTimeSync, type SyncRunResult } from '@/lib/project-time/sync';
import { runAnomalyDetectionJob, type AnomalyDetectionJobResult } from './detect-anomalies';
import { sweepExpiredAgentCredentials, type AgentTokenSweepResult } from './sweep-agent-tokens';
import { sweepStaleRateLimitCounters, type RateLimitSweepResult } from './sweep-rate-limit-counters';
import { runDeviceIntegrityJob, type DeviceIntegrityResult } from './detect-device-integrity';
import { sweepExpiredUserSessions, type UserSessionSweepResult } from './sweep-user-sessions';

const JOB_LEASE_MS = 5 * 60 * 1000;

export interface JobsResult {
  expiredConsents: number;
  retention: RetentionResult;
  projectTimeSync: SyncRunResult | null;
  anomalyDetection: AnomalyDetectionJobResult | null;
  agentTokenSweep: AgentTokenSweepResult | null;
  rateLimitSweep: RateLimitSweepResult | null;
  deviceIntegrity: DeviceIntegrityResult | null;
  userSessionSweep: UserSessionSweepResult | null;
  errors: string[];
}

function emptySyncResult(): SyncRunResult {
  return {
    initialized: false,
    batches: 0,
    advancedTo: null,
    activitiesScanned: 0,
    activitiesAttributed: 0,
    skippedNoMembership: 0,
    skippedAmbiguousMembership: 0,
    skippedStaleActiveProject: 0,
    skippedEmployeeInactive: 0,
    skippedOrgMismatch: 0,
    skippedNoConsent: 0,
    skippedArchivedProject: 0,
    skippedInvalidDuration: 0,
    secondsAttributed: 0,
    buckets: 0,
    timeEntriesCreated: 0,
    timeEntriesUpdated: 0,
    auditWritten: false,
  };
}

export async function claimJob(job: string): Promise<boolean> {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + JOB_LEASE_MS);

  // Atomic claim: a single UPDATE that only matches when the job is NOT owned
  // (not running, or its lease has lapsed). Concurrent workers serialize on the
  // row lock — exactly one UPDATE matches, the rest see the freshly written
  // `running` status and match zero rows. (The previous check-then-upsert had a
  // TOCTOU race: two simultaneous workers could both claim the same job.)
  const claimed = await db.jobRun.updateMany({
    where: {
      job,
      OR: [{ status: { not: 'running' } }, { leaseExpiresAt: { lt: now } }],
    },
    data: { status: 'running', startedAt: now, leaseExpiresAt, lastError: null },
  });
  if (claimed.count > 0) return true;

  // No row yet (or the row exists but is actively leased). Ensure the row
  // exists in a NEUTRAL state (status defaults to 'idle' — creating it as
  // 'running' would make the claim below unable to match it), then retry the
  // atomic claim — the retry is what decides ownership.
  await db.jobRun.upsert({
    where: { job },
    create: { job }, // neutral 'idle' row — claim below decides ownership
    update: { job }, // no-op on the content; ownership is decided by the claim below
  });
  const retry = await db.jobRun.updateMany({
    where: {
      job,
      OR: [{ status: { not: 'running' } }, { leaseExpiresAt: { lt: now } }],
    },
    data: { status: 'running', startedAt: now, leaseExpiresAt, lastError: null },
  });
  return retry.count > 0;
}

export async function finishJob(job: string, error?: string, lastResult?: Record<string, unknown> | null): Promise<void> {
  await db.jobRun.update({
    where: { job },
    data: {
      status: error ? 'failed' : 'completed',
      finishedAt: new Date(),
      lastRunAt: new Date(),
      lastError: error ?? null,
      lastResult: lastResult ? JSON.stringify(lastResult) : null,
    },
  });
}

const EMPTY_RETENTION: RetentionResult = {
  screenshots: 0,
  activities: 0,
  reports: 0,
  aiInsights: 0,
  sentimentRecords: 0,
  auditLogsAnonymized: 0,
  consentLogsAnonymized: 0,
  usbEvents: 0,
  policyViolations: 0,
  notifications: 0,
  alerts: 0,
  breakSessions: 0,
  breakActivityRows: 0,
  orphanScreenshotsRemoved: 0,
  fileErrors: [],
  errors: [],
};

/**
 * Runs all scheduled jobs under crash-safe JobRun leases. Safe to call from
 * multiple processes (instrumentation + external cron): a running lease is
 * never double-executed, and a crashed worker's lease expires after 5 minutes.
 * Each run records affected counts in JobRun.lastResult for observability.
 */
/**
 * Lease-guarded project-time sync. Safe to call from the hourly scheduler, the
 * realtime loop and `npm run jobs`: a running lease is never double-executed.
 * Returns an empty result when another worker owns the lease (no-op).
 */
export async function runProjectTimeSyncJob(): Promise<SyncRunResult> {
  if (await claimJob('project_time_sync')) {
    try {
      const result = await runProjectTimeSync();
      await finishJob('project_time_sync', undefined, {
        batches: result.batches,
        activitiesAttributed: result.activitiesAttributed,
        secondsAttributed: result.secondsAttributed,
        buckets: result.buckets,
        timeEntriesCreated: result.timeEntriesCreated,
        timeEntriesUpdated: result.timeEntriesUpdated,
        initialized: result.initialized,
        advancedTo: result.advancedTo ? result.advancedTo.toISOString() : null,
      });
      return result;
    } catch (error) {
      await finishJob('project_time_sync', String(error));
      throw error;
    }
  }
  return emptySyncResult(); // lease held elsewhere — no-op this round
}

export async function runScheduledJobs(): Promise<JobsResult> {
  const result: JobsResult = { expiredConsents: 0, retention: { ...EMPTY_RETENTION }, projectTimeSync: null, anomalyDetection: null, agentTokenSweep: null, rateLimitSweep: null, deviceIntegrity: null, userSessionSweep: null, errors: [] };

  const started = Date.now();

  if (await claimJob('expire_consents')) {
    try {
      result.expiredConsents = await expireConsents();
      await finishJob('expire_consents', undefined, { expiredConsents: result.expiredConsents });
    } catch (error) {
      result.errors.push(`expire_consents: ${String(error)}`);
      await finishJob('expire_consents', String(error));
    }
  }

  if (await claimJob('retention_cleanup')) {
    try {
      result.retention = await runRetention();
      // Retention now runs every org under its own try/catch; any per-org
      // failure is surfaced here so the job is marked failed but the data is
      // never silently reported as purged.
      const retentionErrors = [...result.retention.errors, ...result.retention.fileErrors.map((f) => `file unlink failed: ${f}`)];
      if (retentionErrors.length > 0) {
        await finishJob('retention_cleanup', retentionErrors.join('; '), {
          ...result.retention,
        });
        result.errors.push(`retention_cleanup: ${retentionErrors.join('; ')}`);
      } else {
        await finishJob('retention_cleanup', undefined, { ...result.retention });
      }
    } catch (error) {
      result.errors.push(`retention_cleanup: ${String(error)}`);
      await finishJob('retention_cleanup', String(error));
    }
  }

  // Automatic project-time sync — also triggered faster by the realtime loop
  // (instrumentation.ts) and by `npm run jobs`; the lease keeps them exclusive.
  try {
    result.projectTimeSync = await runProjectTimeSyncJob();
  } catch (error) {
    result.errors.push(`project_time_sync: ${String(error)}`);
    await finishJob('project_time_sync', String(error)).catch(() => {});
  }

  // Automatic anomaly detection (F-1) — org-scoped, honors each org's
  // ai_anomaly_detection setting, idempotent via the unique dedupeKey, and
  // crash-safe under the same JobRun lease as every other job.
  try {
    result.anomalyDetection = await runAnomalyDetectionJob();
  } catch (error) {
    result.errors.push(`anomaly_detection: ${String(error)}`);
    await finishJob('anomaly_detection', String(error)).catch(() => {});
  }

  // Expired agent-credential sweep (P3-4) — deletes AgentToken/AgentSession
  // rows past their expiresAt so expired credentials never accumulate. Cheap,
  // lease-guarded, and only ever deletes already-expired rows (a token that is
  // still valid is never touched, so active agents are unaffected).
  if (await claimJob('agent_token_sweep')) {
    try {
      result.agentTokenSweep = await sweepExpiredAgentCredentials();
      await finishJob('agent_token_sweep', undefined, { ...result.agentTokenSweep });
    } catch (error) {
      result.errors.push(`agent_token_sweep: ${String(error)}`);
      await finishJob('agent_token_sweep', String(error));
    }
  }

  // Stale shared rate-limit counter rows (topology-independent limiter). Rows
  // untouched for 3h are long past the longest 5-minute window; removing them
  // keeps the table bounded by active keys.
  if (await claimJob('rate_limit_sweep')) {
    try {
      result.rateLimitSweep = await sweepStaleRateLimitCounters();
      await finishJob('rate_limit_sweep', undefined, { ...result.rateLimitSweep });
    } catch (error) {
      result.errors.push(`rate_limit_sweep: ${String(error)}`);
      await finishJob('rate_limit_sweep', String(error));
    }
  }

  // Device-integrity / telemetry-interruption detection (R3) — approved,
  // actively-monitored devices whose heartbeat went silent are surfaced as
  // dedupe-keyed `device_missing` anomalies. Server-authoritative: the client
  // never attests to its own health.
  try {
    result.deviceIntegrity = await runDeviceIntegrityJob();
  } catch (error) {
    result.errors.push(`device_integrity: ${String(error)}`);
    await finishJob('device_integrity', String(error)).catch(() => {});
  }

  // Web-session hygiene sweep (S-04) — expired+revoked sessions are deleted
  // so the UserSession table stays bounded; live or recently-revoked rows are
  // never touched.
  if (await claimJob('user_session_sweep')) {
    try {
      result.userSessionSweep = await sweepExpiredUserSessions();
      await finishJob('user_session_sweep', undefined, { ...result.userSessionSweep });
    } catch (error) {
      result.errors.push(`user_session_sweep: ${String(error)}`);
      await finishJob('user_session_sweep', String(error));
    }
  }

  const durationMs = Date.now() - started;
  await db.jobRun.updateMany({
    where: { job: { in: ['expire_consents', 'retention_cleanup', 'project_time_sync', 'anomaly_detection', 'agent_token_sweep', 'rate_limit_sweep', 'device_integrity', 'user_session_sweep'] } },
    data: { lastDurationMs: durationMs },
  });

  return result;
}

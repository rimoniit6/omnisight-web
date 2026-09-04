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
import { processPendingTranscriptions } from '@/lib/audio/transcribe-job';
import { processPendingScreenshots } from '@/lib/screenshots/processing';
import { runWorkDaySummaryJob, type WorkDaySummaryJobResult } from './workday-summary';
import { runAlertRulesJob, type AlertRuleJobResult } from './alert-rules';
import { runSubscriptionSweep, type SubscriptionSweepResult } from './subscription-sweep';
import { syncDeviceCounts, type SyncDeviceCountResult } from './sync-device-count';
import { runDataExpiryReminder, type DataExpiryReminderResult } from './data-expiry-reminder';

const JOB_LEASE_MS = 5 * 60 * 1000;

export interface JobsResult {
  expiredConsents: number;
  audioTranscriptions?: { processed: number; submitted: number; failed: number; errors: string[] };
  screenshotProcessing?: { processed: number; failed: number; errors: string[] };
  retention: RetentionResult;
  projectTimeSync: SyncRunResult | null;
  anomalyDetection: AnomalyDetectionJobResult | null;
  agentTokenSweep: AgentTokenSweepResult | null;
  rateLimitSweep: RateLimitSweepResult | null;
  deviceIntegrity: DeviceIntegrityResult | null;
  userSessionSweep: UserSessionSweepResult | null;
  workDaySummary: WorkDaySummaryJobResult | null;
  alertRuleEvaluation: AlertRuleJobResult | null;
  subscriptionSweep: SubscriptionSweepResult | null;
  syncDeviceCount: SyncDeviceCountResult | null;
  dataExpiryReminder: DataExpiryReminderResult | null;
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
  aiUsage: 0,
  sentimentRecords: 0,
  auditLogsAnonymized: 0,
  consentLogsAnonymized: 0,
  usbEvents: 0,
  policyViolations: 0,
  notifications: 0,
  alerts: 0,
  breakSessions: 0,
  breakActivityRows: 0,
  activityBatchReceipts: 0,
  orphanScreenshotsRemoved: 0,
  fileErrors: [],
  audioRecordings: 0,
  audioTranscriptions: 0,
  audioFileErrors: [],
  workDaySummaries: 0,
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

/**
 * Lease-guarded screenshot thumbnail processing. Safe to call from the
 * periodic scheduler, instrumentation's faster loop, and `npm run jobs`: a
 * running lease is never double-executed. Returns undefined when another
 * worker owns the lease (no-op this round).
 *
 * Bounded per run (see SCREENSHOT_PROCESSING_DEFAULT_LIMIT in
 * src/lib/screenshots/processing.ts) so sharp CPU work never blocks the event
 * loop for long, and rows that fail decode are retired after 3 attempts.
 */
export async function runScreenshotProcessingJob(limit?: number): Promise<JobsResult['screenshotProcessing']> {
  if (await claimJob('screenshot_processing')) {
    try {
      const result = await processPendingScreenshots(limit);
      await finishJob('screenshot_processing', undefined, { ...result });
      return result;
    } catch (error) {
      await finishJob('screenshot_processing', String(error));
      throw error;
    }
  }
  return { processed: 0, failed: 0, errors: ['lease held elsewhere'] };
}

/**
 * Lease-guarded device-count sync. Called from instrumentation's ~30-minute
 * loop AND from the hourly runScheduledJobs pass; the JobRun lease keeps them
 * exclusive. Returns an empty result when another worker owns the lease.
 */
export async function runSyncDeviceCountsJob(): Promise<SyncDeviceCountResult> {
  if (await claimJob('sync_device_count')) {
    try {
      const result = await syncDeviceCounts();
      await finishJob('sync_device_count', undefined, { ...result });
      return result;
    } catch (error) {
      await finishJob('sync_device_count', String(error));
      throw error;
    }
  }
  return { organizations: 0, activeDevices: 0, updated: 0, errors: ['lease held elsewhere'] };
}

/**
 * Lease-guarded daily data-expiry reminder pass. Runs from the hourly
 * runScheduledJobs pass AND `npm run jobs`; the lease keeps overlapping
 * invocations a safe no-op.
 */
export async function runDataExpiryReminderJob(): Promise<DataExpiryReminderResult> {
  if (await claimJob('data_expiry_reminder')) {
    try {
      const result = await runDataExpiryReminder();
      await finishJob('data_expiry_reminder', undefined, { ...result });
      return result;
    } catch (error) {
      await finishJob('data_expiry_reminder', String(error));
      throw error;
    }
  }
  return { evaluatedOrgs: 0, remindersSent: 0, warningsSent: 0, finalsSent: 0, errors: ['lease held elsewhere'] };
}

export async function runScheduledJobs(): Promise<JobsResult> {
  const result: JobsResult = { expiredConsents: 0, retention: { ...EMPTY_RETENTION }, projectTimeSync: null, anomalyDetection: null, agentTokenSweep: null, rateLimitSweep: null, deviceIntegrity: null, userSessionSweep: null, workDaySummary: null, alertRuleEvaluation: null, subscriptionSweep: null, syncDeviceCount: null, dataExpiryReminder: null, errors: [] };

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

  // Audio transcription processing — pick up uploaded/queued recordings
  if (await claimJob('audio_transcription')) {
    try {
      result.audioTranscriptions = await processPendingTranscriptions();
      await finishJob('audio_transcription', undefined, { ...result.audioTranscriptions });
    } catch (error) {
      result.errors.push(`audio_transcription: ${String(error)}`);
      await finishJob('audio_transcription', String(error)).catch(() => {});
    }
  }

  // Screenshot thumbnail processing — bounded drain of 'uploaded' rows.
  // Runs here (hourly / `npm run jobs`) AND on instrumentation's faster loop;
  // the JobRun lease makes overlapping invocations a safe no-op.
  try {
    result.screenshotProcessing = await runScreenshotProcessingJob();
  } catch (error) {
    result.errors.push(`screenshot_processing: ${String(error)}`);
    await finishJob('screenshot_processing', String(error)).catch(() => {});
  }

  // Daily WorkDaySummary aggregation (Phase 4) — deterministic whole-day
  // rebuild + upsert over each org's trailing window. Self-claiming lease;
  // also reachable from `npm run jobs` and the admin rebuild route.
  try {
    result.workDaySummary = await runWorkDaySummaryJob();
  } catch (error) {
    result.errors.push(`workday_summary: ${String(error)}`);
    await finishJob('workday_summary', String(error)).catch(() => {});
  }

  // AlertRule evaluation (Phase 5) — org-scoped structured rules over real
  // telemetry; cooldown/dedupe state is persisted per (rule, entity) so
  // replayed runs cannot double-fire. Fail-closed master flag per org.
  try {
    result.alertRuleEvaluation = await runAlertRulesJob();
  } catch (error) {
    result.errors.push(`alert_rule_evaluation: ${String(error)}`);
    await finishJob('alert_rule_evaluation', String(error)).catch(() => {});
  }

  // SaaS subscription expiry/suspension sweep — marks lapsed ACTIVE
  // subscriptions EXPIRED and suspends orgs with no remaining subscription or
  // trial. Plan-driven screenshot retention is enforced by retention_cleanup
  // via resolveRetentionDays (which consults the active plan).
  if (await claimJob('subscription_sweep')) {
    try {
      result.subscriptionSweep = await runSubscriptionSweep();
      await finishJob('subscription_sweep', undefined, { ...result.subscriptionSweep });
    } catch (error) {
      result.errors.push(`subscription_sweep: ${String(error)}`);
      await finishJob('subscription_sweep', String(error));
    }
  }

  // SaaS device-count sync — recompute Organization.activeDeviceCount from
  // heartbeat-fresh (non-lifecycle) devices so plan enforcement and the billing
  // UI stay current. Also triggered on a ~30-minute cadence by instrumentation;
  // the JobRun lease keeps the two exclusive.
  try {
    result.syncDeviceCount = await runSyncDeviceCountsJob();
  } catch (error) {
    result.errors.push(`sync_device_count: ${String(error)}`);
    await finishJob('sync_device_count', String(error)).catch(() => {});
  }

  // SaaS data-expiry reminders — emails org admins/super admins as each org's
  // retention window closes (7-day warning + expiry-day final). Never deletes
  // anything; dedup is guarded by Organization.lastDataExpiryReminderAt.
  try {
    result.dataExpiryReminder = await runDataExpiryReminderJob();
  } catch (error) {
    result.errors.push(`data_expiry_reminder: ${String(error)}`);
    await finishJob('data_expiry_reminder', String(error)).catch(() => {});
  }


  const durationMs = Date.now() - started;
  await db.jobRun.updateMany({
    where: { job: { in: ['expire_consents', 'retention_cleanup', 'project_time_sync', 'anomaly_detection', 'agent_token_sweep', 'rate_limit_sweep', 'device_integrity', 'user_session_sweep', 'audio_transcription', 'screenshot_processing', 'workday_summary', 'alert_rule_evaluation', 'subscription_sweep', 'sync_device_count', 'data_expiry_reminder'] } },
    data: { lastDurationMs: durationMs },
  });

  return result;
}

import { db } from '@/lib/db';
import { resolveRetentionDays, retentionCutoff } from './settings';
import { sweepOrphanScreenshotFiles } from '@/lib/screenshots/sweep';
import { removeArtifactByPath } from '@/lib/storage';
import { BREAK_TITLES } from '@/lib/breaks/service';
import { localDayKey } from '@/lib/timezone';

export interface RetentionResult {
  screenshots: number;
  activities: number;
  reports: number;
  aiInsights: number;
  /** Phase 5 per-call AI metering rows purged past ai_insight_retention_days. */
  aiUsage: number;
  sentimentRecords: number;
  auditLogsAnonymized: number;
  consentLogsAnonymized: number;
  /** USB device events purged past the org's usb_event_retention_days. */
  usbEvents: number;
  /** Policy violations purged past the org's policy_violation_retention_days. */
  policyViolations: number;
  /** Read/archived notifications purged past notification_retention_days. */
  notifications: number;
  /** Resolved/archived alerts purged past alert_retention_days. */
  alerts: number;
  /** Ended BreakSession rows purged past break_session_retention_days (active breaks are never purged). */
  breakSessions: number;
  /** Legacy "Break Mode …" Activity mirror rows purged with their sessions. */
  breakActivityRows: number;
  /** ActivityBatchReceipt idempotency rows purged past the activity window. */
  activityBatchReceipts: number;
  /** WorkDaySummary daily rollups purged past the activity window (their raw rows are gone too). */
  workDaySummaries: number;
  /** Physical screenshot files with no matching DB row, removed this run. */
  orphanScreenshotsRemoved: number;
  /** Paths whose physical artifact could NOT be deleted this run — the DB row
   * is deliberately retained so a later run can retry the unlink. */
  fileErrors: string[];
  /** Audio recordings and transcriptions purged past retention. */
  audioRecordings: number;
  audioTranscriptions: number;
  audioFileErrors: string[];
  /** Organization-level failures (continue-on-error isolation in runRetention). */
  errors: string[];
}

const EMPTY: RetentionResult = {
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
  workDaySummaries: 0,
  audioRecordings: 0,
  audioTranscriptions: 0,
  audioFileErrors: [],
  orphanScreenshotsRemoved: 0,
  fileErrors: [],
  errors: [],
};

function mergeInto(target: RetentionResult, other: RetentionResult): RetentionResult {
  for (const key of Object.keys(EMPTY) as (keyof RetentionResult)[]) {
    if (key === 'fileErrors' || key === 'errors' || key === 'audioFileErrors') {
      target[key] = [...target[key], ...other[key]];
    } else {
      target[key] += other[key];
    }
  }
  return target;
}

/**
 * Attempt to remove a stored artifact through the active storage driver
 * (local filesystem, or Supabase Storage on Vercel). Screenshot paths map to
 * driver keys; any other artifact type is only meaningful on the local
 * filesystem and is unlinked directly (legacy report files). Returns true
 * when the artifact is confirmed gone (deleted, or already absent); false on
 * any real failure — the caller must then KEEP the DB row so cleanup retries.
 */
async function removeFile(orgId: string, filePath: string, kind: 'screenshot' | 'legacy'): Promise<boolean> {
  return removeArtifactByPath(orgId, filePath, kind);
}

/**
 * Two-phase purge of a file-backed table: unlink the physical artifact FIRST
 * and only delete the DB row for artifacts that are confirmed gone. A file
 * that cannot be deleted keeps its row (retryable next run) and is reported
 * in result.fileErrors — we never report a purge while the artifact remains.
 *
 * Screenshot rows may carry a derived thumbnail object (Phase 2): when a
 * `thumbnailPath` is present it is unlinked BEFORE the original, and a failure
 * to remove EITHER artifact keeps the DB row so a later run can retry — we
 * never delete a row while one of its physical artifacts may still exist
 * (that would orphan the other object).
 */
async function purgeFileRows(
  orgId: string,
  rows: { id: string; filePath: string | null; thumbnailPath?: string | null }[],
  result: RetentionResult,
  label: string,
  kind: 'screenshot' | 'legacy',
  deleteRows: (ids: string[]) => Promise<{ count: number }>
): Promise<number> {
  const removableIds: string[] = [];
  for (const row of rows) {
    if (!row.filePath && !row.thumbnailPath) {
      removableIds.push(row.id); // no physical artifact to manage
      continue;
    }
    // Derived thumbnail first (screenshots only — other kinds never have one).
    if (row.thumbnailPath) {
      if (await removeFile(orgId, row.thumbnailPath, kind)) {
        // thumbnail gone — fall through to the original below
      } else {
        result.fileErrors.push(`${label} ${row.id} (thumb ${row.thumbnailPath})`);
        continue; // keep the row: thumbnail artifact remains, retry next run
      }
    }
    if (!row.filePath) {
      removableIds.push(row.id);
      continue;
    }
    if (await removeFile(orgId, row.filePath, kind)) {
      removableIds.push(row.id);
    } else {
      result.fileErrors.push(`${label} ${row.id} (${row.filePath})`);
    }
  }
  if (removableIds.length === 0) return 0;
  const del = await deleteRows(removableIds);
  return del.count;
}

/**
 * Real retention enforcement for one organization. Operational data
 * (screenshots incl. physical files, activities, reports, AI insights) is
 * deleted past its retention window; compliance records (audit + consent
 * logs) are NEVER deleted — they are anonymized instead.
 *
 * CONCURRENCY/IDEMPOTENCY: every predicate is a pure "older than cutoff"
 * query, so concurrent runs and repeated runs are safe — a second run finds
 * nothing already purged and deletes nothing twice.
 */
export async function runRetentionForOrg(
  orgId: string,
  now = new Date(),
  limit = 500
): Promise<RetentionResult> {
  const result: RetentionResult = { ...EMPTY };

  const shotDays = await resolveRetentionDays(orgId, 'screenshot_retention_days');
  if (shotDays > 0) {
    const stale = await db.screenshot.findMany({
      where: { organizationId: orgId, capturedAt: { lt: retentionCutoff(shotDays, now) } },
      take: limit,
      select: { id: true, filePath: true, thumbnailPath: true },
    });
    if (stale.length > 0) {
      result.screenshots = await purgeFileRows(orgId, stale, result, 'screenshot', 'screenshot', (ids) => db.screenshot.deleteMany({ where: { id: { in: ids } } }));
    }
  }

  const actDays = await resolveRetentionDays(orgId, 'activity_retention_days');
  if (actDays > 0) {
    // Activity rows carry no organizationId — scope through the employee relation.
    // F-08: "Break Mode …" rows are EXCLUDED — break history is governed by
    // break_session_retention_days (BreakSession is canonical; these mirror
    // rows back the realtime/report event stream and must not be silently
    // destroyed by generic telemetry cleanup).
    // Note: `OR: [{ title: null }, ...]` is REQUIRED — in Postgres `NOT IN`
    // excludes NULL titles (NULL NOT IN (...) evaluates to unknown/false), so
    // a plain `title: { notIn: [...] }` would silently skip every untitled
    // activity row. NULL titles are ordinary telemetry and must be purged.
    const del = await db.activity.deleteMany({
      where: {
        timestamp: { lt: retentionCutoff(actDays, now) },
        employee: { organizationId: orgId },
        OR: [{ title: null }, { title: { notIn: [...BREAK_TITLES] } }],
      },
    });
    result.activities = del.count;

    // ActivityBatchReceipt idempotency rows follow the SAME activity window:
    // once a receipt is older than the activity retention cutoff, any
    // legitimate retry/replay window has long passed, so it can be dropped.
    // Scoped by organizationId directly (receipts carry their own org FK).
    const receiptDel = await db.activityBatchReceipt.deleteMany({
      where: { organizationId: orgId, receivedAt: { lt: retentionCutoff(actDays, now) } },
    });
    result.activityBatchReceipts = receiptDel.count;

    // WorkDaySummary daily rollups follow the SAME activity window: once the
    // raw rows a summary was derived from are past the cutoff, the summary is
    // stale and would only mislead — delete it with the data it summarizes.
    // workDate is the ORGANIZATION-local day (never UTC), so a summary is only
    // obsolete once its entire local day ended before the cutoff instant:
    // purge workDate < the org-local day of the cutoff. Keeps the summary of
    // the local day the cutoff lands on (its later rows survive retention).
    const cutoff = retentionCutoff(actDays, now);
    const orgTz = await db.organization.findUnique({ where: { id: orgId }, select: { timezone: true } });
    const cutoffKey = localDayKey(cutoff, orgTz?.timezone ?? 'UTC');
    const summaryDel = await db.workDaySummary.deleteMany({
      where: { organizationId: orgId, workDate: { lt: cutoffKey } },
    });
    result.workDaySummaries = summaryDel.count;
  }

  // Break/privacy history: only ENDED sessions older than the cutoff are
  // purged (active breaks are NEVER deleted by retention). Their legacy
  // Activity mirror rows are purged in the same pass.
  const breakDays = await resolveRetentionDays(orgId, 'break_session_retention_days');
  if (breakDays > 0) {
    const cutoff = retentionCutoff(breakDays, now);
    let purged = 0;
    let mirrorPurged = 0;
    for (;;) {
      const stale = await db.breakSession.findMany({
        where: { organizationId: orgId, endedAt: { not: null, lt: cutoff } },
        take: limit,
        select: { id: true, employeeId: true },
      });
      if (stale.length === 0) break;
      const ids = stale.map((s) => s.id);
      const employeeIds = [...new Set(stale.map((s) => s.employeeId))];
      // Legacy mirror rows for the SAME employees, older than the same cutoff.
      const mirror = await db.activity.deleteMany({
        where: {
          employeeId: { in: employeeIds },
          timestamp: { lt: cutoff },
          title: { in: [...BREAK_TITLES] },
        },
      });
      mirrorPurged += mirror.count;
      const del = await db.breakSession.deleteMany({ where: { id: { in: ids } } });
      purged += del.count;
      if (stale.length < limit) break;
    }
    result.breakSessions = purged;
    result.breakActivityRows = mirrorPurged;
  }

  const repDays = await resolveRetentionDays(orgId, 'report_retention_days');
  if (repDays > 0) {
    const stale = await db.report.findMany({
      where: { organizationId: orgId, createdAt: { lt: retentionCutoff(repDays, now) } },
      take: limit,
      select: { id: true, filePath: true },
    });
    if (stale.length > 0) {
      result.reports = await purgeFileRows(orgId, stale, result, 'report', 'legacy', (ids) => db.report.deleteMany({ where: { id: { in: ids } } }));
    }
  }

  const aiDays = await resolveRetentionDays(orgId, 'ai_insight_retention_days');
  if (aiDays > 0) {
    const del = await db.aiInsight.deleteMany({
      where: { organizationId: orgId, createdAt: { lt: retentionCutoff(aiDays, now) } },
    });
    result.aiInsights = del.count;
    // Phase 5: per-call AI usage metering rows follow the same window (0 = keep
    // forever, consistent with the other AI-derived records). Metering rows are
    // strictly org-scoped and carry no secrets/payloads.
    const usageDel = await db.aiUsage.deleteMany({
      where: { organizationId: orgId, createdAt: { lt: retentionCutoff(aiDays, now) } },
    });
    result.aiUsage = usageDel.count;
  }

  // Sentiment records are AI-derived workforce insights: they follow the same
  // ai_insight_retention_days window as other AI insights (0 = keep forever).
  if (aiDays > 0) {
    const del = await db.sentimentRecord.deleteMany({
      where: { organizationId: orgId, createdAt: { lt: retentionCutoff(aiDays, now) } },
    });
    result.sentimentRecords = del.count;
  }

  // Compliance records: anonymize, never delete.
  const auditDays = await resolveRetentionDays(orgId, 'audit_log_retention_days');
  if (auditDays > 0) {
    const upd = await db.auditLog.updateMany({
      where: { organizationId: orgId, createdAt: { lt: retentionCutoff(auditDays, now) } },
      data: { userId: null, ipAddress: null },
    });
    result.auditLogsAnonymized = upd.count;
  }

  const consentLogDays = await resolveRetentionDays(orgId, 'consent_log_retention_days');
  if (consentLogDays > 0) {
    const upd = await db.consentLog.updateMany({
      where: { organizationId: orgId, createdAt: { lt: retentionCutoff(consentLogDays, now) } },
      data: { anonymizedAt: now, performedBy: null, ipAddress: null, description: '[redacted per retention policy]' },
    });
    result.consentLogsAnonymized = upd.count;
  }

  // USB device events: org-scoped purge past usb_event_retention_days
  // (default 0 = never purge). Same pure "older than cutoff" predicate as
  // every other retention step — idempotent and concurrency-safe.
  const usbDays = await resolveRetentionDays(orgId, 'usb_event_retention_days');
  if (usbDays > 0) {
    const del = await db.usbEvent.deleteMany({
      where: { organizationId: orgId, createdAt: { lt: retentionCutoff(usbDays, now) } },
    });
    result.usbEvents = del.count;
  }

  // Policy violations: org-scoped purge past policy_violation_retention_days
  // (default 0 = keep forever — security-relevant records, admins opt in).
  const violationDays = await resolveRetentionDays(orgId, 'policy_violation_retention_days');
  if (violationDays > 0) {
    const del = await db.policyViolation.deleteMany({
      where: { organizationId: orgId, createdAt: { lt: retentionCutoff(violationDays, now) } },
    });
    result.policyViolations = del.count;
  }

  // Notifications (N-4): only READ/ARCHIVED rows are purged past the org's
  // notification_retention_days. UNREAD notifications are never deleted — a
  // user must not lose an unread alert to a retention sweep. Bounded batches.
  const notifDays = await resolveRetentionDays(orgId, 'notification_retention_days');
  if (notifDays > 0) {
    const cutoff = retentionCutoff(notifDays, now);
    let purged = 0;
    // Repeated bounded batches so one org's retention never issues a single
    // unbounded delete.
    for (;;) {
      const stale = await db.notification.findMany({
        where: {
          organizationId: orgId,
          status: { in: ['read', 'archived'] },
          createdAt: { lt: cutoff },
        },
        take: limit,
        select: { id: true },
      });
      if (stale.length === 0) break;
      const del = await db.notification.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
      purged += del.count;
      if (stale.length < limit) break;
    }
    result.notifications = purged;
  }

  // Alerts (N-4): only RESOLVED/ARCHIVED alerts are purged past the org's
  // alert_retention_days. PENDING/ACKNOWLEDGED (active) alerts are never
  // deleted — an unresolved incident must not disappear. Bounded batches.
  const alertDays = await resolveRetentionDays(orgId, 'alert_retention_days');
  if (alertDays > 0) {
    const cutoff = retentionCutoff(alertDays, now);
    let purged = 0;
    for (;;) {
      const stale = await db.alert.findMany({
        where: {
          organizationId: orgId,
          status: { in: ['resolved', 'archived'] },
          createdAt: { lt: cutoff },
        },
        take: limit,
        select: { id: true },
      });
      if (stale.length === 0) break;
      const del = await db.alert.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
      purged += del.count;
      if (stale.length < limit) break;
    }
    result.alerts = purged;
  }

  // Audio recordings & transcriptions: use screenshot_retention_days as the
  // default window (audio is a closely related capture artifact). Older
  // completed or failed recordings are purged; in-progress recordings are
  // never deleted. Physical audio files are removed through the storage driver
  // before the DB row — a file that cannot be deleted keeps its row.
  const audioDays = await resolveRetentionDays(orgId, 'screenshot_retention_days');
  if (audioDays > 0) {
    const staleAudio = await db.audioRecording.findMany({
      where: {
        organizationId: orgId,
        status: { in: ['completed', 'failed'] },
        createdAt: { lt: retentionCutoff(audioDays, now) },
      },
      take: limit,
      select: { id: true, filePath: true },
    });
    if (staleAudio.length > 0) {
      const removableIds: string[] = [];
      for (const row of staleAudio) {
        if (!row.filePath) {
          removableIds.push(row.id);
          continue;
        }
        try {
          await removeArtifactByPath(orgId, row.filePath, 'legacy');
          removableIds.push(row.id);
        } catch {
          result.audioFileErrors.push(`audio ${row.id} (${row.filePath})`);
        }
      }
      if (removableIds.length > 0) {
        // Transcriptions are cascade-deleted with the recording.
        const del = await db.audioRecording.deleteMany({ where: { id: { in: removableIds } } });
        result.audioRecordings = del.count;
      }
    }
  }

  return result;
}

/**
 * Runs retention for every active organization, isolating failures so one
 * org's problem never blocks the others. Per-org errors are surfaced in
 * result.errors for observability (and cause the job to be marked failed),
 * but all remaining orgs are still processed.
 *
 * After the per-org pass, the global screenshot orphan sweep runs once: it
 * removes physical files with no matching Screenshot row (e.g. files left by
 * a crashed upload, a failed write-then-transaction, or a device-cascade
 * delete). It is bounded and age-guarded — never touches a file younger than
 * 15 minutes, so in-flight uploads are never misidentified.
 */
export async function runRetention(limit = 500): Promise<RetentionResult> {
  const orgs = await db.organization.findMany({ select: { id: true } });
  const total: RetentionResult = { ...EMPTY };
  for (const org of orgs) {
    try {
      mergeInto(total, await runRetentionForOrg(org.id, new Date(), limit));
    } catch (error) {
      total.errors.push(`org ${org.id}: ${String(error)}`);
      console.error(`[retention] organization ${org.id} failed, continuing:`, error);
    }
  }

  try {
    const orphan = await sweepOrphanScreenshotFiles();
    total.orphanScreenshotsRemoved = orphan.removed;
    total.errors.push(...orphan.errors);
  } catch (error) {
    total.errors.push(`orphan-sweep: ${String(error)}`);
    console.error('[retention] orphan screenshot sweep failed:', error);
  }

  return total;
}

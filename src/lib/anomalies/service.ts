/**
 * Org-scoped anomaly detection orchestration — shared by the on-demand
 * route (`POST /api/anomalies/detect`) and the scheduled job (F-1).
 *
 * - Tenant isolation: employees, activities, dedupe and writes are all
 *   scoped to the single organization passed in — never global.
 * - Batching: two window queries total (recent 7d + baseline 23d), no N+1.
 * - Dedupe (F-14): rows carry a deterministic unique `dedupeKey`
 *   (org:employee:type:utcDay); the unique index enforces it under
 *   concurrency and P2002 conflicts are treated as duplicates, not errors.
 * - The org's `ai_anomaly_detection` setting is honored here (fail closed).
 * - High/critical detections auto-create an Alert (preserved behavior).
 * - One AuditLog per run that created anomalies (F-24) — bounded volume.
 */
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getOrgSetting } from '@/lib/jobs/settings';
import { createOrgAlert, createOrgNotification } from '@/lib/notifications/service';
import { detectAnomaliesForEmployees, type DetectedAnomaly } from './detect';
import { safeTimezone } from './time';
import { parseHHMM } from './time';
import { anomalyDedupeKey } from './constants';

const RECENT_DAYS = 7;
const BASELINE_WINDOW_DAYS = 30; // baseline = [30d ago, 7d ago)

export type RunAnomalyDetectionResult =
  | { status: 'disabled'; reason: string }
  | {
      status: 'ok';
      scannedEmployees: number;
      detected: number;
      skipped: number;
      createdIds: string[];
      skippedReasons: string[];
      orgId: string;
    };

export interface RunAnomalyDetectionOptions {
  orgId: string;
  /** Restrict the run to one employee (route-level single-target runs). */
  employeeId?: string;
  /** Injected clock for deterministic tests. */
  now?: Date;
}

interface ActivityRow {
  employeeId: string;
  timestamp: Date;
  duration: number;
  category: string | null;
  type: string | null;
}

async function loadOrgContext(orgId: string) {
  const org = await db.organization.findUnique({ where: { id: orgId }, select: { id: true, timezone: true } });
  if (!org) return null;
  const [workStartRaw, workEndRaw] = await Promise.all([
    getOrgSetting(orgId, 'work_start_time', '09:00'),
    getOrgSetting(orgId, 'work_end_time', '18:00'),
  ]);
  return {
    timezone: safeTimezone(org.timezone),
    workStartMinutes: parseHHMM(workStartRaw) ?? 9 * 60,
    workEndMinutes: parseHHMM(workEndRaw) ?? 18 * 60,
  };
}

/**
 * Persist one detected anomaly + optional alert/notification inside a
 * transaction. Exported as a test seam (deterministic, transactional).
 */
export async function persistAnomaly(
  a: DetectedAnomaly,
  orgId: string,
  dedupeKey: string
): Promise<{ created: boolean; anomalyId: string }> {
  try {
    return await db.$transaction(async (tx) => {
      const created = await tx.anomaly.create({
        data: {
          type: a.type,
          severity: a.severity,
          status: 'detected',
          title: a.title,
          description: a.description,
          score: a.score,
          confidence: a.confidence,
          employeeId: a.employeeId,
          deviceId: a.deviceId || null,
          metadata: JSON.stringify(a.metadata),
          dedupeKey,
          organizationId: orgId,
        },
      });

      if (a.severity === 'critical' || a.severity === 'high') {
        // N-10/N-5: high/critical detections create an Alert AND a Notification
        // (matching the agent-reported path). Both carry structured employee
        // linkage; the notification follows the deep-link convention.
        await createOrgAlert(tx, {
          title: `Anomaly: ${a.title}`,
          description: a.description,
          type: 'security',
          severity: a.severity === 'critical' ? 'critical' : 'error',
          status: 'pending',
          source: 'auto-detection',
          metadata: { anomalyId: created.id, anomalyType: a.type },
          employeeId: a.employeeId,
          deviceId: a.deviceId || null,
          organizationId: orgId,
        });

        await createOrgNotification(tx, {
          title: `Anomaly Detected: ${a.title}`,
          message: `${a.description.substring(0, 100)}`,
          type: 'anomaly_detected',
          priority: a.severity === 'critical' ? 'critical' : 'high',
          status: 'unread',
          actionUrl: '/anomalies',
          entityType: 'anomaly',
          entityId: created.id,
          employeeId: a.employeeId,
          deviceId: a.deviceId || null,
          organizationId: orgId,
        });
      }

      return { created: true, anomalyId: created.id };
    });
  } catch (error) {
    // F-14: a concurrent run inserted the same dedupe key — this is a
    // duplicate, not a failure.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { created: false, anomalyId: '' };
    }
    throw error;
  }
}

export async function runAnomalyDetection(options: RunAnomalyDetectionOptions): Promise<RunAnomalyDetectionResult> {
  const { orgId, employeeId } = options;
  const now = options.now ?? new Date();

  const ctx = await loadOrgContext(orgId);
  if (!ctx) return { status: 'disabled', reason: 'organization not found' };

  const enabled = (await getOrgSetting(orgId, 'ai_anomaly_detection', 'true')) === 'true';
  if (!enabled) return { status: 'disabled', reason: 'ai_anomaly_detection setting is disabled' };

  // Tenant-scoped target employees.
  const employees = await db.employee.findMany({
    where: {
      status: 'active',
      organizationId: orgId,
      ...(employeeId ? { id: employeeId } : {}),
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      devices: { where: { status: { not: 'offline' } }, select: { id: true }, orderBy: { updatedAt: 'desc' }, take: 1 },
    },
  });

  const employeeIds = employees.map((e) => e.id);
  const deviceByEmployee = new Map(employees.map((e) => [e.id, e.devices[0]?.id]));

  // F-6: the activity WINDOWS are instant arithmetic (now - N days) so the
  // load boundary never depends on the server's local clock. The ENGINE then
  // re-buckets every row by the ORG timezone's day key — day membership,
  // "today", work hours and history are all org-tz; the load window is just
  // a retrieval bound and needs no timezone of its own.
  const sevenDaysAgo = new Date(now.getTime() - RECENT_DAYS * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - BASELINE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // Batch 1: activities in the last 7 days. Batch 2: baseline window.
  const [recentActivities, baselineActivities] = employeeIds.length
    ? await Promise.all([
        db.activity.findMany({
          where: { employeeId: { in: employeeIds }, timestamp: { gte: sevenDaysAgo } },
          select: { employeeId: true, timestamp: true, duration: true, category: true, type: true },
        }),
        db.activity.findMany({
          where: { employeeId: { in: employeeIds }, timestamp: { gte: thirtyDaysAgo, lt: sevenDaysAgo } },
          select: { employeeId: true, timestamp: true, duration: true, category: true, type: true },
        }),
      ])
    : [[], []];

  const recentByEmployee = new Map<string, ActivityRow[]>();
  const baselineByEmployee = new Map<string, ActivityRow[]>();
  for (const a of recentActivities) {
    const list = recentByEmployee.get(a.employeeId) ?? [];
    list.push(a);
    recentByEmployee.set(a.employeeId, list);
  }
  for (const a of baselineActivities) {
    const list = baselineByEmployee.get(a.employeeId) ?? [];
    list.push(a);
    baselineByEmployee.set(a.employeeId, list);
  }

  const engineInputs = employees.map((emp) => ({
    employee: { id: emp.id, firstName: emp.firstName, lastName: emp.lastName },
    recent: (recentByEmployee.get(emp.id) ?? []) as ActivityRow[],
    baseline: (baselineByEmployee.get(emp.id) ?? []) as ActivityRow[],
    deviceId: deviceByEmployee.get(emp.id),
  }));

  const { anomalies, skippedReasons } = detectAnomaliesForEmployees(engineInputs, {
    timezone: ctx.timezone,
    workStartMinutes: ctx.workStartMinutes,
    workEndMinutes: ctx.workEndMinutes,
    now,
  });

  // F-14 dedupe: pre-check what already exists for today's bucket, then let
  // the unique index catch any concurrent race.
  const candidateKeys = anomalies.map((a) => anomalyDedupeKey(orgId, a.employeeId, a.type, now));
  const existing = candidateKeys.length
    ? await db.anomaly.findMany({
        where: { dedupeKey: { in: candidateKeys } },
        select: { dedupeKey: true },
      })
    : [];
  const existingKeys = new Set(existing.map((e) => e.dedupeKey));

  const createdIds: string[] = [];
  let skipped = 0;
  for (let i = 0; i < anomalies.length; i++) {
    const a = anomalies[i];
    const key = candidateKeys[i];
    if (existingKeys.has(key)) {
      skipped += 1;
      continue;
    }
    const result = await persistAnomaly(a, orgId, key);
    if (result.created) createdIds.push(result.anomalyId);
    else skipped += 1;
  }

  // F-24: one audit entry per run that created anomalies (bounded volume).
  if (createdIds.length > 0) {
    await db.auditLog.create({
      data: {
        action: 'detect',
        resource: 'anomaly',
        description: `Anomaly detection run created ${createdIds.length} anomalies (${anomalies.map((a) => a.type).join(', ') || 'none'})`,
        organizationId: orgId,
      },
    });
  }

  return {
    status: 'ok',
    scannedEmployees: employees.length,
    detected: createdIds.length,
    skipped,
    createdIds,
    skippedReasons,
    orgId,
  };
}

/** Load the org's work-hour window (minutes since midnight) for callers that
 *  need the configuration outside a full detection run (e.g. tests). */
export async function resolveOrgWorkWindow(orgId: string): Promise<{ start: number; end: number; timezone: string }> {
  const ctx = await loadOrgContext(orgId);
  return { start: ctx?.workStartMinutes ?? 9 * 60, end: ctx?.workEndMinutes ?? 18 * 60, timezone: ctx?.timezone ?? 'UTC' };
}

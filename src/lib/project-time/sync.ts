/**
 * Project Time Sync — automatic Activity → TimeEntry synchronization.
 *
 * Turns REAL, database-backed agent Activity into automatically-tracked
 * project time (TimeEntry rows with source = ACTIVITY_AUTO). Design rules:
 *
 * 1. Attribution is membership-based and NEVER guessed:
 *    - An ADMIN-SELECTED active tracking project (Employee.activeTrackingProjectId)
 *      takes precedence when it is still VALID at sync time (same org, active
 *      membership with leftAt IS NULL, project not cancelled). This resolves
 *      the ambiguous multi-membership case without guessing.
 *    - Otherwise an activity is attributed only when its employee has EXACTLY
 *      ONE active membership (ProjectMember.leftAt IS NULL) whose organization
 *      matches both the employee and the project.
 *    - Zero memberships, multiple active memberships WITHOUT an explicit
 *      selection, a stale/invalid explicit selection, an org mismatch, or a
 *      deactivated employee → the activity is skipped (no fabricated time).
 *    A stale explicit selection NEVER falls back to the exactly-one rule —
 *    silently re-attributing behind the admin's back would be a guess.
 * 2. Duration is the agent-reported Activity.duration (authoritative). Only
 *    `application`/`website` types count as working time; `idle` is excluded.
 * 3. Aggregation is per (employee, project, local-day) bucket. TimeEntry is a
 *    single ACTIVITY_AUTO row per bucket, rewritten from the accumulated
 *    seconds — never one row per activity event.
 * 4. Idempotency: the ProjectTimeSync (employeeId, projectId, date) unique
 *    key plus a transactional global cursor (ProjectTimeSyncCursor) mean the
 *    same activity can never be double-counted, even across retries.
 * 5. Guards: activity_tracking consent must be active at sync time; archived
 *    (cancelled) projects never receive auto time; leftAt memberships never
 *    receive time.
 * 6. No backfill: on first ever run the cursor is initialized to "now" — only
 *    activity ingested AFTER the feature is enabled is ever tracked.
 *
 * This module is pure business logic (no sockets, no React) so it is
 * unit/integration-testable from the repo root.
 */
import { db } from '@/lib/db';
import { getConsentState } from '@/lib/consent';
import { localDayKey, safeTimezone } from '@/lib/timezone';

export const ACTIVITY_AUTO_SOURCE = 'ACTIVITY_AUTO';
export const GLOBAL_CURSOR_ID = 'global';
export const ELIGIBLE_ACTIVITY_TYPES = ['application', 'website'] as const;
export const DEFAULT_BATCH_SIZE = 500;
export const MAX_SYNC_BATCHES_PER_RUN = 20;
/** Ingestion already caps Activity.duration at 24h — mirror that bound here. */
export const MAX_ACTIVITY_DURATION_SECONDS = 86400;

/** One (employee, project, day) accumulation bucket. */
export interface SyncBucket {
  employeeId: string;
  projectId: string;
  /** UTC midnight of the organization-local calendar day. */
  date: Date;
  organizationId: string;
  seconds: number;
  lastActivityAt: Date;
}

export interface SyncRunResult {
  /** True when this run only initialized the cursor (no backfill, nothing processed). */
  initialized: boolean;
  batches: number;
  /** Newest Activity.createdAt absorbed by the last processed batch (null when idle). */
  advancedTo: Date | null;
  activitiesScanned: number;
  activitiesAttributed: number;
  skippedNoMembership: number;
  skippedAmbiguousMembership: number;
  skippedStaleActiveProject: number;
  skippedEmployeeInactive: number;
  skippedOrgMismatch: number;
  skippedNoConsent: number;
  skippedArchivedProject: number;
  skippedInvalidDuration: number;
  secondsAttributed: number;
  buckets: number;
  timeEntriesCreated: number;
  timeEntriesUpdated: number;
  auditWritten: boolean;
}

const EMPTY_RESULT: SyncRunResult = {
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

/** Round seconds to 2-decimal hours (matches the manual entry precision). */
export function secondsToHours(seconds: number): number {
  return Math.round(seconds / 36) / 100;
}

interface RawActivity {
  id: string;
  employeeId: string;
  type: string;
  duration: number;
  timestamp: Date;
  createdAt: Date;
}

interface ActiveMembership {
  employeeId: string;
  projectId: string;
  organizationId: string;
  projectStatus: string;
  /** Defense in depth: the membership must point at a project in the SAME org. */
  projectOrgId: string;
}

/**
 * Read the global cursor. Creates it at `now` when missing (the no-backfill
 * default: nothing ingested before the first run is ever converted).
 * Returns null when the cursor was just initialized (caller processes nothing).
 */
async function getOrInitCursor(now: Date): Promise<Date | null> {
  const existing = await db.projectTimeSyncCursor.findUnique({ where: { id: GLOBAL_CURSOR_ID } });
  if (existing) return existing.lastProcessedAt;
  await db.projectTimeSyncCursor.create({
    data: { id: GLOBAL_CURSOR_ID, lastProcessedAt: now },
  });
  return null;
}

/**
 * Load every active membership for a set of employees. An employee may appear
 * multiple times (one row per active project). Includes the project status so
 * archived projects can be excluded at attribution time.
 */
async function loadActiveMemberships(employeeIds: string[]): Promise<ActiveMembership[]> {
  if (employeeIds.length === 0) return [];
  const rows = await db.projectMember.findMany({
    where: { employeeId: { in: employeeIds }, leftAt: null },
    select: {
      employeeId: true,
      organizationId: true,
      project: { select: { id: true, status: true, organizationId: true } },
    },
  });
  return rows.map((r) => ({
    employeeId: r.employeeId,
    projectId: r.project.id,
    organizationId: r.organizationId,
    projectStatus: r.project.status,
    projectOrgId: r.project.organizationId,
  }));
}

/**
 * Process one batch of unsynchronized activities (createdAt > cursor), bounded
 * by `batchSize`, and commit buckets + cursor in a single transaction.
 */
async function processBatch(since: Date, now: Date, batchSize: number): Promise<SyncRunResult> {
  const result: SyncRunResult = { ...EMPTY_RESULT };

  const activities = (await db.activity.findMany({
    where: {
      createdAt: { gt: since },
      type: { in: [...ELIGIBLE_ACTIVITY_TYPES] },
    },
    orderBy: { createdAt: 'asc' },
    take: batchSize,
    select: { id: true, employeeId: true, type: true, duration: true, timestamp: true, createdAt: true },
  })) as RawActivity[];

  if (activities.length === 0) return result;
  result.activitiesScanned = activities.length;

  // Newest ingestion timestamp in this batch — the cursor advances past EVERY
  // fetched row (attributed or not) so skipped rows are never re-read forever.
  const batchMaxCreatedAt = activities[activities.length - 1].createdAt;

  const employeeIds = [...new Set(activities.map((a) => a.employeeId))];
  const employees = await db.employee.findMany({
    where: { id: { in: employeeIds } },
    select: {
      id: true,
      organizationId: true,
      status: true,
      activeTrackingProjectId: true,
    },
  });
  // One batched fetch covers org + status + the admin-selected active project
  // — no per-activity query, no N+1.
  const employeeById = new Map(employees.map((e) => [e.id, e]));
  const employeeOrg = new Map(employees.map((e) => [e.id, e.organizationId]));

  const orgIds = [...new Set(employees.map((e) => e.organizationId))];
  const orgs = await db.organization.findMany({
    where: { id: { in: orgIds } },
    select: { id: true, timezone: true },
  });
  const orgTimezone = new Map(orgs.map((o) => [o.id, safeTimezone(o.timezone)]));

  const memberships = await loadActiveMemberships(employeeIds);
  const membershipsByEmployee = new Map<string, ActiveMembership[]>();
  for (const m of memberships) {
    const list = membershipsByEmployee.get(m.employeeId) ?? [];
    list.push(m);
    membershipsByEmployee.set(m.employeeId, list);
  }

  // Consent: batch per employee (activity_tracking must be active AT SYNC TIME).
  const consentOk = new Map<string, boolean>();
  for (const e of employees) {
    const state = await getConsentState(e.id, e.organizationId, ['activity_tracking']);
    consentOk.set(e.id, state.activity_tracking === true);
  }

  const buckets = new Map<string, SyncBucket>();

  for (const act of activities) {
    const orgId = employeeOrg.get(act.employeeId);
    if (!orgId) {
      result.skippedNoMembership += 1; // orphan activity — cannot scope
      continue;
    }
    const emp = employeeById.get(act.employeeId);
    if (emp && emp.status !== 'active') {
      // Deactivated/archived employee → never new automatic project time.
      result.skippedEmployeeInactive += 1;
      continue;
    }
    if (!(consentOk.get(act.employeeId) ?? false)) {
      result.skippedNoConsent += 1;
      continue;
    }
    if (!Number.isFinite(act.duration) || act.duration <= 0 || act.duration > MAX_ACTIVITY_DURATION_SECONDS) {
      result.skippedInvalidDuration += 1;
      continue;
    }

    const active = membershipsByEmployee.get(act.employeeId) ?? [];
    let member: ActiveMembership | undefined;
    // ADMIN-SELECTED active project takes precedence — and resolves the
    // ambiguous multi-membership case without guessing. It is only honored
    // when still valid at sync time (found in the ACTIVE membership list;
    // org + cancelled checks below run for it like any other membership).
    if (emp?.activeTrackingProjectId) {
      member = active.find((m) => m.projectId === emp.activeTrackingProjectId);
    }
    if (!member) {
      if (emp?.activeTrackingProjectId) {
        // Explicit selection present but stale/invalid (removed, leftAt set,
        // org mismatch, or project gone). NEVER guess — no automatic time.
        result.skippedStaleActiveProject += 1;
        continue;
      }
      // No explicit selection: exactly ONE active membership is the only
      // unambiguous context. Zero → skip. More than one → skip (never guess).
      if (active.length === 0) {
        result.skippedNoMembership += 1;
        continue;
      }
      if (active.length > 1) {
        result.skippedAmbiguousMembership += 1;
        continue;
      }
      member = active[0];
    }
    // Defense in depth: membership + employee + project must share one org.
    if (member.organizationId !== orgId || member.projectOrgId !== orgId) {
      result.skippedOrgMismatch += 1;
      continue;
    }
    // Archived projects never receive automatic time (even when explicitly
    // selected — the selection is stale and must not guess elsewhere).
    if (member.projectStatus === 'cancelled') {
      result.skippedArchivedProject += 1;
      continue;
    }

    // Bucket on the ORGANIZATION-LOCAL calendar day of the activity timestamp.
    const dayKey = localDayKey(act.timestamp, orgTimezone.get(orgId) ?? 'UTC');
    const date = new Date(`${dayKey}T00:00:00.000Z`);
    const key = `${act.employeeId}|${member.projectId}|${dayKey}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.seconds += act.duration;
      if (act.timestamp > existing.lastActivityAt) existing.lastActivityAt = act.timestamp;
    } else {
      buckets.set(key, {
        employeeId: act.employeeId,
        projectId: member.projectId,
        date,
        organizationId: orgId,
        seconds: act.duration,
        lastActivityAt: act.timestamp,
      });
    }
    result.activitiesAttributed += 1;
    result.secondsAttributed += act.duration;
  }

  // Always expose where the cursor landed so the caller can advance locally
  // without an extra query — even when every row was skipped, the cursor still
  // moves past the batch (skipped rows must never be re-read forever).
  result.advancedTo = batchMaxCreatedAt;

  if (buckets.size === 0) {
    await db.projectTimeSyncCursor.upsert({
      where: { id: GLOBAL_CURSOR_ID },
      create: { id: GLOBAL_CURSOR_ID, lastProcessedAt: batchMaxCreatedAt },
      update: { lastProcessedAt: batchMaxCreatedAt },
    });
    return result;
  }

  await db.$transaction(async (tx) => {
    for (const bucket of buckets.values()) {
      const existingSync = await tx.projectTimeSync.findUnique({
        where: { employeeId_projectId_date: { employeeId: bucket.employeeId, projectId: bucket.projectId, date: bucket.date } },
      });
      const newSeconds = (existingSync?.seconds ?? 0) + bucket.seconds;
      const lastActivityAt =
        existingSync && existingSync.lastActivityAt && existingSync.lastActivityAt > bucket.lastActivityAt
          ? existingSync.lastActivityAt
          : bucket.lastActivityAt;

      if (existingSync) {
        await tx.projectTimeSync.update({
          where: { id: existingSync.id },
          data: { seconds: newSeconds, lastActivityAt },
        });
      } else {
        await tx.projectTimeSync.create({
          data: {
            employeeId: bucket.employeeId,
            projectId: bucket.projectId,
            date: bucket.date,
            seconds: newSeconds,
            lastActivityAt,
            organizationId: bucket.organizationId,
          },
        });
      }

      // The single ACTIVITY_AUTO TimeEntry for this (employee, project, day).
      const hours = secondsToHours(newSeconds);
      const entry = await tx.timeEntry.findFirst({
        where: {
          employeeId: bucket.employeeId,
          projectId: bucket.projectId,
          date: bucket.date,
          source: ACTIVITY_AUTO_SOURCE,
        },
        select: { id: true },
      });
      if (entry) {
        await tx.timeEntry.update({
          where: { id: entry.id },
          data: { hours, updatedAt: new Date() },
        });
        result.timeEntriesUpdated += 1;
      } else {
        await tx.timeEntry.create({
          data: {
            employeeId: bucket.employeeId,
            projectId: bucket.projectId,
            date: bucket.date,
            hours,
            source: ACTIVITY_AUTO_SOURCE,
            billable: true,
            category: null,
            description: 'Automatically tracked from agent activity',
            organizationId: bucket.organizationId,
          },
        });
        result.timeEntriesCreated += 1;
      }
    }

    // Advance the global cursor past the whole batch (transactional with the
    // bucket writes — a crash mid-commit can never skip or double-process).
    await tx.projectTimeSyncCursor.upsert({
      where: { id: GLOBAL_CURSOR_ID },
      create: { id: GLOBAL_CURSOR_ID, lastProcessedAt: batchMaxCreatedAt },
      update: { lastProcessedAt: batchMaxCreatedAt },
    });
  });

  result.buckets = buckets.size;
  return result;
}

/**
 * Run the sync: process every unsynchronized activity in bounded batches.
 *
 * @param opts.now   injectable clock (tests)
 * @param opts.batchSize  rows per batch
 * @param opts.maxBatches upper bound per invocation (safety valve)
 */
export async function runProjectTimeSync(
  opts: { now?: Date; batchSize?: number; maxBatches?: number } = {}
): Promise<SyncRunResult> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? MAX_SYNC_BATCHES_PER_RUN;

  const result: SyncRunResult = { ...EMPTY_RESULT };

  const cursor = await getOrInitCursor(now);
  if (cursor === null) {
    result.initialized = true;
    return result; // first ever run: cursor set to now, no backfill
  }

  let since = cursor;
  for (let i = 0; i < maxBatches; i++) {
    const batch = await processBatch(since, now, batchSize);
    result.batches += 1;
    result.advancedTo = batch.advancedTo ?? result.advancedTo;
    result.activitiesScanned += batch.activitiesScanned;
    result.activitiesAttributed += batch.activitiesAttributed;
    result.skippedNoMembership += batch.skippedNoMembership;
    result.skippedAmbiguousMembership += batch.skippedAmbiguousMembership;
    result.skippedStaleActiveProject += batch.skippedStaleActiveProject;
    result.skippedEmployeeInactive += batch.skippedEmployeeInactive;
    result.skippedOrgMismatch += batch.skippedOrgMismatch;
    result.skippedNoConsent += batch.skippedNoConsent;
    result.skippedArchivedProject += batch.skippedArchivedProject;
    result.skippedInvalidDuration += batch.skippedInvalidDuration;
    result.secondsAttributed += batch.secondsAttributed;
    result.buckets += batch.buckets;
    result.timeEntriesCreated += batch.timeEntriesCreated;
    result.timeEntriesUpdated += batch.timeEntriesUpdated;

    // Drained the backlog (or nothing to do) → stop. Otherwise continue from
    // where this batch ended so the next batch reads strictly newer rows.
    if (batch.activitiesScanned < batchSize || !batch.advancedTo) break;
    since = batch.advancedTo;
  }

  // One audit summary row per run that actually produced time (keeps the
  // audit trail readable — never one row per activity).
  if (result.buckets > 0) {
    await db.auditLog.create({
      data: {
        action: 'create',
        resource: 'time_entry',
        description:
          `Automatic project-time sync: ${result.activitiesAttributed} activity events → ` +
          `${result.timeEntriesCreated} created / ${result.timeEntriesUpdated} updated auto time entry(ies) ` +
          `(${secondsToHours(result.secondsAttributed)}h across ${result.buckets} employee/project/day bucket(s))`,
        userId: null,
        organizationId: null,
      },
    });
    result.auditWritten = true;
  }

  return result;
}

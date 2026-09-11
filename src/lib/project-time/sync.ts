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
 *    key plus a per-org transactional cursor mean the same activity can never
 *    be double-counted, even across retries.
 * 5. Guards: activity_tracking consent must be active at sync time; archived
 *    (cancelled) projects never receive auto time; leftAt memberships never
 *    receive time.
 * 6. No backfill: on first ever run the cursor is initialized to "now" — only
 *    activity ingested AFTER the feature is enabled is ever tracked.
 *
 * ORGANIZATION CUTOVER: Activity, Employee, ProjectMember, Project,
 * ProjectTimeSync and TimeEntry are org-owned (copied to the org's own DB at
 * activation), so each org is processed with its OWN client resolved via
 * getPrismaForOrg — never one shared scan across tenants, and never the
 * platform DB after cutover. Each org's sync cursor lives in the same DB as
 * its org-owned rows (the org DB after activation; the platform DB otherwise,
 * where it IS the legacy global cursor row) so the cursor advance is atomic
 * with the bucket writes. The platform global cursor row remains the
 * first-ever-run no-backfill boundary and the seed for per-org cursors.
 *
 * This module is pure business logic (no sockets, no React) so it is
 * unit/integration-testable from the repo root.
 */
import type { PrismaClient } from '@prisma/client';
import { db } from '@/lib/db';
import { getPrismaForOrg } from '@/lib/org-db';
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
 * Read the platform global cursor. Creates it at `now` when missing (the
 * no-backfill default: nothing ingested before the first run is ever
 * converted). Returns null when the cursor was just initialized (caller
 * processes nothing). Platform-owned control-plane row — stays on `db`.
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
 * Org-local cursor: lives in the SAME database as the org's own rows (the org
 * DB after activation — atomic with the bucket writes; the platform DB
 * otherwise, where it IS the legacy global cursor row). Seeded once from the
 * platform global cursor so an org that activates mid-flight keeps the exact
 * no-backfill / already-processed boundary; orgs activated after their rows
 * were copied pick up every copied row because those rows sit AFTER the seed.
 */
async function getOrgCursor(orgId: string, orgData: PrismaClient, now: Date): Promise<Date> {
  const existing = await orgData.projectTimeSyncCursor.findUnique({ where: { id: GLOBAL_CURSOR_ID } });
  if (existing) return existing.lastProcessedAt;
  const legacy = await db.projectTimeSyncCursor.findUnique({ where: { id: GLOBAL_CURSOR_ID } });
  const seed = legacy ? legacy.lastProcessedAt : now;
  await orgData.projectTimeSyncCursor.create({
    data: { id: GLOBAL_CURSOR_ID, lastProcessedAt: seed },
  });
  return seed;
}

/**
 * Load every active membership for a set of employees. An employee may appear
 * multiple times (one row per active project). Includes the project status so
 * archived projects can be excluded at attribution time.
 */
async function loadActiveMemberships(employeeIds: string[], data: PrismaClient): Promise<ActiveMembership[]> {
  if (employeeIds.length === 0) return [];
  const rows = await data.projectMember.findMany({
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
 * Process one bounded batch of unsynchronized activities for ONE organization
 * (createdAt > cursor, org-scoped through the employee relation), attribute
 * them, and commit buckets + the org cursor in a SINGLE transaction on the
 * org's own client. Returns the result chunk + the cursor position to advance
 * to (null when the org had nothing pending).
 */
async function processOrgBatch(
  orgId: string,
  orgData: PrismaClient,
  since: Date,
  now: Date,
  batchSize: number
): Promise<{ result: SyncRunResult; advancedTo: Date | null }> {
  const result: SyncRunResult = { ...EMPTY_RESULT };

  // Org-scoped: only THIS org's activities, strictly newer than the cursor.
  const activities = (await orgData.activity.findMany({
    where: {
      createdAt: { gt: since },
      type: { in: [...ELIGIBLE_ACTIVITY_TYPES] },
      employee: { organizationId: orgId },
    },
    orderBy: { createdAt: 'asc' },
    take: batchSize,
    select: { id: true, employeeId: true, type: true, duration: true, timestamp: true, createdAt: true },
  })) as RawActivity[];

  if (activities.length === 0) return { result, advancedTo: null };
  result.activitiesScanned = activities.length;

  // Newest ingestion timestamp in this batch — the org cursor advances past
  // EVERY fetched row (attributed or not) so skipped rows are never re-read.
  const batchMaxCreatedAt = activities[activities.length - 1].createdAt;

  const employeeIds = [...new Set(activities.map((a) => a.employeeId))];
  const employees = await orgData.employee.findMany({
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

  const orgTz = safeTimezone((await db.organization.findUnique({ where: { id: orgId }, select: { timezone: true } }))?.timezone ?? 'UTC');

  const memberships = await loadActiveMemberships(employeeIds, orgData);
  const membershipsByEmployee = new Map<string, ActiveMembership[]>();
  for (const m of memberships) {
    const list = membershipsByEmployee.get(m.employeeId) ?? [];
    list.push(m);
    membershipsByEmployee.set(m.employeeId, list);
  }

  // Consent: batch per employee (activity_tracking must be active AT SYNC TIME).
  const consentOk = new Map<string, boolean>();
  for (const e of employees) {
    const state = await getConsentState(e.id, e.organizationId, ['activity_tracking'], orgData);
    consentOk.set(e.id, state.activity_tracking === true);
  }

  const buckets = new Map<string, SyncBucket>();

  for (const act of activities) {
    const actOrgId = employeeOrg.get(act.employeeId);
    if (!actOrgId || actOrgId !== orgId) {
      result.skippedNoMembership += 1; // orphan/foreign activity — cannot scope
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
    const dayKey = localDayKey(act.timestamp, orgTz);
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

  // Always expose where the cursor landed — even when every row was skipped,
  // the cursor still moves past the batch (skipped rows are never re-read).
  result.advancedTo = batchMaxCreatedAt;

  if (buckets.size === 0) {
    await orgData.projectTimeSyncCursor.upsert({
      where: { id: GLOBAL_CURSOR_ID },
      create: { id: GLOBAL_CURSOR_ID, lastProcessedAt: batchMaxCreatedAt },
      update: { lastProcessedAt: batchMaxCreatedAt },
    });
    return { result, advancedTo: batchMaxCreatedAt };
  }

  // Org tables + org cursor advance in ONE transaction on the org's own DB:
  // a crash mid-commit can never skip or double-process this org's rows.
  await orgData.$transaction(async (tx) => {
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

    // Advance the org cursor past the whole batch (transactional with the
    // bucket writes — a crash mid-commit can never skip or double-process).
    await tx.projectTimeSyncCursor.upsert({
      where: { id: GLOBAL_CURSOR_ID },
      create: { id: GLOBAL_CURSOR_ID, lastProcessedAt: batchMaxCreatedAt },
      update: { lastProcessedAt: batchMaxCreatedAt },
    });
  });

  result.buckets = buckets.size;
  return { result, advancedTo: batchMaxCreatedAt };
}

/**
 * Run the sync: process every unsynchronized activity in bounded batches,
 * per organization (each org resolves its own client via getPrismaForOrg).
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

  // Platform enumerates the org set; each org's operational rows are read and
  // written through THAT org's own client (never shared, never platform).
  const orgs = await db.organization.findMany({ where: { status: 'active' }, select: { id: true } });
  let totalBatches = 0;

  for (const org of orgs) {
    if (totalBatches >= maxBatches) break;
    const orgData = (await getPrismaForOrg(org.id)).client;
    const orgCursor = await getOrgCursor(org.id, orgData, now);

    let since = orgCursor;
    for (let i = 0; i < maxBatches - totalBatches; i++) {
      const batch = await processOrgBatch(org.id, orgData, since, now, batchSize);
      // Only batches that actually fetched rows consume the bounded budget —
      // an org with nothing pending must not starve later orgs in the loop.
      if (batch.advancedTo) {
        result.batches += 1;
        totalBatches += 1;
        result.advancedTo = batch.advancedTo;
        result.activitiesScanned += batch.result.activitiesScanned;
        result.activitiesAttributed += batch.result.activitiesAttributed;
        result.skippedNoMembership += batch.result.skippedNoMembership;
        result.skippedAmbiguousMembership += batch.result.skippedAmbiguousMembership;
        result.skippedStaleActiveProject += batch.result.skippedStaleActiveProject;
        result.skippedEmployeeInactive += batch.result.skippedEmployeeInactive;
        result.skippedOrgMismatch += batch.result.skippedOrgMismatch;
        result.skippedNoConsent += batch.result.skippedNoConsent;
        result.skippedArchivedProject += batch.result.skippedArchivedProject;
        result.skippedInvalidDuration += batch.result.skippedInvalidDuration;
        result.secondsAttributed += batch.result.secondsAttributed;
        result.buckets += batch.result.buckets;
        result.timeEntriesCreated += batch.result.timeEntriesCreated;
        result.timeEntriesUpdated += batch.result.timeEntriesUpdated;
      }
      // Drained this org's backlog (or nothing to do) → next org. Otherwise
      // continue from where this batch ended so the next batch reads strictly
      // newer rows.
      if (!batch.advancedTo || batch.result.activitiesScanned < batchSize) break;
      since = batch.advancedTo;
    }
  }

  // One audit summary row per run that actually produced time (keeps the
  // audit trail readable — never one row per activity). Organization-less
  // platform-level row — stays on the platform DB by design.
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
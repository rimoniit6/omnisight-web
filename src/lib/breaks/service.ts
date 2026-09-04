// OmniSight — Canonical Break Lifecycle Service.
//
// SINGLE SOURCE OF TRUTH for break/privacy-mode state. Every entry point
// (admin force-toggle, agent POST /api/agent/break, self-service
// POST /api/self/break-status, statistics, reports, retention) must go
// through this module — break lifecycle logic is NEVER duplicated in routes.
//
// State model:
//   - A break is an OPEN `BreakSession` row (endedAt IS NULL). At most ONE
//     open break per employee is enforced by the DB-level partial unique
//     index `BreakSession_one_active_per_employee` (see migration
//     20260816113703_add_break_session) — concurrent starts cannot create
//     duplicates: the loser's transaction rolls back on the unique violation
//     and the caller receives the winner's session.
//   - The legacy `Activity` mirror rows ("Break Mode Started/Ended …") are
//     written in the SAME transaction so existing consumers (realtime poll,
//     event stats, reports, activity timelines) keep working unchanged.
//     BreakSession is the canonical state; Activity rows are the event stream.
//   - Every mutation writes an `AuditLog` row with the authenticated actor
//     (never client-supplied) and a JSON `metadata` payload carrying
//     source / actor / employeeId / deviceId.
//
// Tenant safety: identity (organizationId, employeeId, deviceId) is always
// supplied by the CALLER from verified server context (session / agent
// token). This service never accepts or trusts client-supplied identity.

import { db } from '@/lib/db';
import type { Prisma } from '@prisma/client';

// ─── Break event titles (legacy Activity mirror) ───────────────────────────
// Consumers that filter by title (reports, live-updates, event-stats) must
// use BREAK_TITLES so every source (admin/self-service/agent) is covered.
export const BREAK_START_TITLES = [
  'Break Mode Started',
  'Break Mode Started by Admin',
  'Break Mode Started by Employee',
] as const;

export const BREAK_END_TITLES = [
  'Break Mode Ended',
  'Break Mode Ended by Admin',
  'Break Mode Ended by Employee',
] as const;

export const BREAK_TITLES = [...BREAK_START_TITLES, ...BREAK_END_TITLES] as const;

const START_TITLE: Record<BreakSource, string> = {
  admin: 'Break Mode Started by Admin',
  self_service: 'Break Mode Started by Employee',
  agent: 'Break Mode Started',
};

const END_TITLE: Record<BreakSource, string> = {
  admin: 'Break Mode Ended by Admin',
  self_service: 'Break Mode Ended by Employee',
  agent: 'Break Mode Ended',
};

export type BreakSource = 'admin' | 'self_service' | 'agent';

export type BreakEndReason =
  | 'admin_ended'
  | 'employee_ended'
  | 'agent_ended'
  | 'superseded'; // an overlapping start closed a stale open row

export interface BreakActor {
  source: BreakSource;
  /** Authenticated actor id: AppUser id (admin/self-service) or device id (agent). */
  actor: string | null;
  /** Optional client IP for the audit metadata (never trusted for identity). */
  ipAddress?: string | null;
}

export interface StartBreakInput extends BreakActor {
  organizationId: string;
  employeeId: string;
  deviceId?: string | null;
  now?: Date;
}

export interface EndBreakInput extends BreakActor {
  employeeId: string;
  deviceId?: string | null;
  now?: Date;
}

export interface BreakSessionRow {
  id: string;
  organizationId: string;
  employeeId: string;
  deviceId: string | null;
  startedAt: Date;
  endedAt: Date | null;
  endReason: string | null;
  source: string;
  startedBy: string | null;
  endedBy: string | null;
}

type DbTx = Prisma.TransactionClient;

/** The employee's current open break, or null. */
export async function getCurrentBreak(
  employeeId: string,
  tx: DbTx = db
): Promise<BreakSessionRow | null> {
  return tx.breakSession.findFirst({
    where: { employeeId, endedAt: null },
    orderBy: { startedAt: 'desc' },
  });
}

/** True when the employee currently has an open break. */
export async function isOnBreak(employeeId: string, tx: DbTx = db): Promise<boolean> {
  const session = await getCurrentBreak(employeeId, tx);
  return session !== null;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'P2002'
  );
}

function auditPayload(
  input: BreakActor,
  employeeId: string,
  deviceId: string | null
): Prisma.InputJsonValue {
  return {
    source: input.source,
    actor: input.actor,
    employeeId,
    deviceId,
    ipAddress: input.ipAddress ?? null,
  } as Prisma.InputJsonValue;
}

/**
 * Start a break. Idempotent: an already-active break returns the existing
 * session (`action: 'already_active'`) without creating duplicates or
 * touching the open row. Concurrency-safe: the partial unique index makes a
 * simultaneous start roll back and resolve to the winner's session.
 *
 * Writes (single transaction): BreakSession + Activity mirror + AuditLog.
 */
export async function startBreak(
  input: StartBreakInput
): Promise<{ session: BreakSessionRow; action: 'started' | 'already_active' }> {
  const now = input.now ?? new Date();
  try {
    return await db.$transaction(async (tx) => {
      const existing = await getCurrentBreak(input.employeeId, tx);
      if (existing) {
        return { session: existing, action: 'already_active' as const };
      }
      // Belt & braces: close any stale open row (the unique index would also
      // block a duplicate insert — this makes the intent explicit and gives a
      // deterministic `superseded` audit trail for repaired legacy state).
      await tx.breakSession.updateMany({
        where: { employeeId: input.employeeId, endedAt: null },
        data: { endedAt: now, endReason: 'superseded' },
      });

      const session = await tx.breakSession.create({
        data: {
          organizationId: input.organizationId,
          employeeId: input.employeeId,
          deviceId: input.deviceId ?? null,
          startedAt: now,
          endedAt: null,
          endReason: null,
          source: input.source,
          startedBy: input.actor ?? null,
          endedBy: null,
        },
      });

      await tx.activity.create({
        data: {
          type: 'idle',
          title: START_TITLE[input.source],
          applicationName: null,
          url: null,
          category: 'idle',
          duration: 0,
          employeeId: input.employeeId,
          deviceId: input.deviceId ?? null,
          // Phase 1 Step 10: direct tenant ownership (server-derived input).
          organizationId: input.organizationId,
          timestamp: now,
          createdAt: now,
        },
      });

      // Audit contract (unchanged from the pre-existing toggle route):
      // resource 'employee', resourceId = employee id, description containing
      // lowercase "break mode" (consumers/tests match on these). Actor is
      // added in userId (never client-supplied — it comes from the verified
      // session/agent context) plus a JSON metadata payload.
      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'employee',
          resourceId: input.employeeId,
          description: `break mode started (source: ${input.source}).`,
          userId: input.source === 'agent' ? null : input.actor,
          organizationId: input.organizationId,
          metadata: JSON.stringify(auditPayload(input, input.employeeId, input.deviceId ?? null)),
        },
      });

      return { session, action: 'started' as const };
    });
  } catch (err) {
    // Concurrent start committed first — the unique index rejected ours and
    // rolled the transaction back (no orphan Activity/AuditLog). Resolve to
    // the winner's session (idempotent outcome).
    if (isUniqueViolation(err)) {
      const winner = await getCurrentBreak(input.employeeId);
      if (winner) return { session: winner, action: 'already_active' };
    }
    throw err;
  }
}

/**
 * End the employee's current break. Idempotent: ending with no open break is
 * a successful no-op (`action: 'no_active_break'`). Concurrent ends: the
 * conditional `updateMany` matches zero rows for the loser → no-op.
 *
 * Writes (single transaction): BreakSession close + Activity mirror + AuditLog.
 */
export async function endBreak(
  input: EndBreakInput
): Promise<{ session: BreakSessionRow | null; action: 'ended' | 'no_active_break' }> {
  const now = input.now ?? new Date();
  return db.$transaction(async (tx) => {
    const open = await getCurrentBreak(input.employeeId, tx);
    if (!open) {
      return { session: null, action: 'no_active_break' as const };
    }

    const endReason: BreakEndReason =
      input.source === 'admin'
        ? 'admin_ended'
        : input.source === 'self_service'
          ? 'employee_ended'
          : 'agent_ended';

    const updated = await tx.breakSession.updateMany({
      where: { id: open.id, endedAt: null },
      data: { endedAt: now, endReason, endedBy: input.actor ?? null },
    });
    if (updated.count === 0) {
      // Raced with another end — treat as no-op (idempotent).
      return { session: null, action: 'no_active_break' as const };
    }

    await tx.activity.create({
      data: {
        type: 'idle',
        title: END_TITLE[input.source],
        applicationName: null,
        url: null,
        category: 'idle',
        duration: 0,
        employeeId: input.employeeId,
        deviceId: input.deviceId ?? null,
        // Phase 1 Step 10: direct tenant ownership (from the open session row).
        organizationId: open.organizationId,
        timestamp: now,
        createdAt: now,
      },
    });

    await tx.auditLog.create({
      data: {
        action: 'update',
        resource: 'employee',
        resourceId: input.employeeId,
        description: `break mode ended (source: ${input.source}).`,
        userId: input.source === 'agent' ? null : input.actor,
        organizationId: open.organizationId,
        metadata: JSON.stringify(auditPayload(input, input.employeeId, input.deviceId ?? null)),
      },
    });

    return { session: { ...open, endedAt: now, endReason, endedBy: input.actor ?? null }, action: 'ended' as const };
  });
}

// ─── Duration helpers (shared by status / summary / history / reports) ─────

export interface SessionWithDuration extends BreakSessionRow {
  /** Seconds of this session that fall inside [dayStart, dayEnd]. */
  durationSeconds: number;
}

/**
 * Seconds of one session inside the window [dayStart, dayEnd], clamped to the
 * session's own start/end. An open session is measured to `now` (bounded by
 * dayEnd). Never negative.
 */
export function sessionDurationSeconds(
  session: Pick<BreakSessionRow, 'startedAt' | 'endedAt'>,
  dayStart: Date,
  dayEnd: Date,
  now: Date = new Date()
): number {
  const start = Math.max(session.startedAt.getTime(), dayStart.getTime());
  const end = Math.min(
    session.endedAt ? session.endedAt.getTime() : now.getTime(),
    dayEnd.getTime()
  );
  const ms = end - start;
  return ms > 0 ? ms / 1000 : 0;
}

/** Sum of all sessions' durations inside the window, in seconds. */
export function totalBreakSecondsInDay(
  sessions: Array<Pick<BreakSessionRow, 'startedAt' | 'endedAt'>>,
  dayStart: Date,
  dayEnd: Date,
  now: Date = new Date()
): number {
  return sessions.reduce(
    (sum, s) => sum + sessionDurationSeconds(s, dayStart, dayEnd, now),
    0
  );
}

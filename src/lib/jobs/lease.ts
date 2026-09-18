// OmniSight — JobRun lease primitives (claim/release), shared by every
// scheduled job AND long-running HTTP-triggered work that must never
// double-execute across processes (multi-pod / cluster deployments).
//
// Extracted from src/lib/jobs/run.ts so that callers which only need the
// lease (e.g. the sentiment analyze route, demo simulator) do not have to
// import the whole job graph. run.ts re-exports these for backward
// compatibility — existing import sites are unaffected.

import { db } from '@/lib/db';

/** Default lease: 5 minutes — long enough for a scheduler tick, short enough that a crashed worker unblocks quickly. */
export const JOB_LEASE_MS = 5 * 60 * 1000;

/**
 * Run all scheduled jobs under crash-safe JobRun leases... (docstring lives
 * with the caller.) Claims the named job atomically: a single UPDATE that
 * only matches when the job is NOT owned (not running, or its lease has
 * lapsed). Concurrent workers serialize on the row lock — exactly one UPDATE
 * matches, the rest see the freshly written `running` status and match zero
 * rows. (The previous check-then-upsert had a TOCTOU race: two simultaneous
 * workers could both claim the same job.)
 *
 * `leaseMs` lets long-running callers take a LONGER lease than the default —
 * e.g. the sentiment analyze route can legitimately run 10+ minutes with AI
 * enabled, and a 5-minute lease would let a second worker start mid-run.
 */
export async function claimJob(job: string, leaseMs: number = JOB_LEASE_MS): Promise<boolean> {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);

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

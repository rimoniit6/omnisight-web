// OmniSight — rate-limit counter sweep.
//
// The shared PostgreSQL rate limiter (src/lib/rate-limit.ts) stores one row
// per active key in `RateLimitCounter`. Rows are kept only as long as the key
// is active (the atomic upsert refreshes `updatedAt` on every request), so
// this sweep deletes rows untouched for well past the longest window (5
// minutes) — 3 hours is a generous margin that keeps the table bounded by
// *active* keys without ever removing a live bucket. Lease-guarded like every
// other job; exactly one worker deletes per round.
import { db } from '@/lib/db';

export interface RateLimitSweepResult {
  countersRemoved: number;
}

export async function sweepStaleRateLimitCounters(): Promise<RateLimitSweepResult> {
  const removed = await db.$executeRaw`
    DELETE FROM "RateLimitCounter"
    WHERE "updatedAt" < now() - interval '3 hours'
  `;
  return { countersRemoved: removed };
}

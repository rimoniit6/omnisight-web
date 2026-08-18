// OmniSight — live-updates mini-service: poll cursor advance logic.
//
// This module is deliberately pure (no socket, no db) so the cursor semantics
// can be unit-tested from the repo root, mirroring activity-events.ts /
// presence.ts.
//
// WHY this exists (duplicate live-event bug):
//   pollOnce() originally advanced `cursor = new Date()` BEFORE running the DB
//   queries. Any row committed after that capture but before the query
//   executes satisfies `createdAt > since` and is broadcast — yet its
//   `createdAt` is also strictly greater than the captured cursor, so the NEXT
//   round (since = captured cursor) re-fetches and re-broadcasts the SAME row.
//   The client then received two `activity-ping` payloads with the same
//   primary-key id, which React surfaced as duplicate `key` warnings in the
//   Dashboard live ticker (and doubled entries in the Live Feed).
//
//   The fix: capture `now` before the queries (preserving the original
//   no-loss property — anything committed after `now` is still eligible next
//   round), but raise the cursor AFTER the queries to the newest timestamp of
//   every event row this round actually processed. Every already-broadcast
//   row then lies at or before the new cursor, so `createdAt > cursor` can
//   only ever return rows the clients have not seen yet.

/** A row whose timestamp contributed to the poll (createdAt / capturedAt / updatedAt). */
export interface ProcessedRow {
  ts: number | Date | null | undefined;
}

/**
 * Compute the cursor to use for the NEXT poll round.
 *
 * @param now       `new Date()` captured BEFORE the round's queries ran.
 * @param processed every row the round's queries returned, with its timestamp.
 * @returns max(now, newest processed timestamp) — never earlier than `now`, so
 *          a slow round can never replay rows it already saw.
 */
export function nextPollCursor(now: Date, processed: ProcessedRow[]): Date {
  let ms = now.getTime();
  for (const row of processed) {
    const t = row.ts instanceof Date ? row.ts.getTime() : typeof row.ts === 'number' ? row.ts : Number.NaN;
    if (Number.isFinite(t) && t > ms) ms = t;
  }
  return new Date(ms);
}

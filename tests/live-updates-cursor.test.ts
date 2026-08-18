/**
 * Live-updates poll cursor advance (mini-services/live-updates/poll-cursor.ts).
 *
 * Regression contract for the duplicate live-event bug that caused the
 * Dashboard duplicate-key warning:
 *
 * The old pollOnce() did `cursor = new Date()` BEFORE running its queries. A
 * row committed after that capture but before the query executes satisfies
 * `createdAt > since` and is broadcast — and because its `createdAt` is also
 * greater than the captured cursor, the NEXT round re-fetches and re-broadcasts
 * the SAME row (same primary-key id → two `activity-ping` payloads → duplicate
 * React keys in the ticker).
 *
 * `nextPollCursor(now, processed)` closes that gap: the cursor is raised past
 * the newest row this round actually processed, so `createdAt > cursor` can
 * only ever return unseen rows. These tests pin that property.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextPollCursor } from '../mini-services/live-updates/poll-cursor';

// The exact double-broadcast window: a row committed after the pre-query
// `now` capture (t=2000) but before the query executes (t=2500).
const CAPTURE = new Date(2000);
const GAP_ROW = new Date(2100); // committed in (now, query-execution] → picked up this round

test('cursor advances past the newest processed row (closes the double-broadcast gap)', () => {
  const cursor = nextPollCursor(CAPTURE, [{ ts: GAP_ROW }]);
  assert.equal(cursor.getTime(), GAP_ROW.getTime());
  // Next round's `since` = GAP_ROW → `createdAt > since` excludes the already
  // broadcast row. This is the exact assertion that failed before the fix.
  assert.ok(GAP_ROW.getTime() > CAPTURE.getTime(), 'precondition: gap row committed after capture');
  assert.ok(GAP_ROW.getTime() <= cursor.getTime(), 'gap row must NOT satisfy the next round predicate');
});

test('cursor never moves backwards below `now` (no-loss property preserved)', () => {
  // A round with nothing processed must keep `now` as the cursor — anything
  // committed after `now` stays eligible for the next round (never lost).
  const cursor = nextPollCursor(CAPTURE, []);
  assert.equal(cursor.getTime(), CAPTURE.getTime());
  // Even if a processed row has a timestamp BEFORE `now` (clock skew between
  // row timestamps), the cursor must not regress below the capture instant.
  const skewed = nextPollCursor(CAPTURE, [{ ts: new Date(500) }]);
  assert.equal(skewed.getTime(), CAPTURE.getTime());
});

test('cursor is monotonic across consecutive rounds (nothing replays, nothing is lost)', () => {
  // Round 1 processes row A (t=2100); round 2 processes row B (t=3000).
  const c1 = nextPollCursor(CAPTURE, [{ ts: GAP_ROW }]);
  const c2 = nextPollCursor(c1, [{ ts: new Date(3000) }]);
  assert.ok(c2.getTime() > c1.getTime(), 'cursor only ever advances');
  // A row already processed in round 1 (t=2100) must not be fetched again in
  // round 2's window (since = c1 = 2100, predicate createdAt > 2100).
  assert.ok(GAP_ROW.getTime() <= c1.getTime());
  // A row committed after round 1 but before round 2's query (t=2500) IS
  // still eligible in round 2 — the no-loss property.
  const later = new Date(2500);
  assert.ok(later.getTime() > c1.getTime() && later.getTime() <= c2.getTime());
});

test('newest of many processed rows wins (take-limited polls still covered)', () => {
  const cursor = nextPollCursor(CAPTURE, [
    { ts: new Date(1500) },
    { ts: GAP_ROW },
    { ts: new Date(2200) },
  ]);
  assert.equal(cursor.getTime(), 2200);
});

test('malformed / missing timestamps are ignored', () => {
  const cursor = nextPollCursor(CAPTURE, [
    { ts: null },
    { ts: undefined },
    { ts: 'not-a-date' as unknown as Date },
    { ts: Number.NaN },
  ]);
  assert.equal(cursor.getTime(), CAPTURE.getTime(), 'no valid ts → cursor stays at `now`');
});

test('number timestamps are accepted alongside Date timestamps', () => {
  const cursor = nextPollCursor(CAPTURE, [{ ts: 2300 }]);
  assert.equal(cursor.getTime(), 2300);
});

/**
 * Dashboard live-ticker idempotent insertion (src/lib/live-ticker.ts).
 *
 * Regression contract for the duplicate-key warning
 * (`Encountered two children with the same key, <activity-id>`) in
 * dashboard-page.tsx's `tickerItems.map((item) => <div key={item.id} ...>)`:
 *   - Unique ticker items pass through untouched (nothing is ever lost).
 *   - A repeated WebSocket delivery of the SAME logical event (same stable id)
 *     replaces the older entry instead of appending a duplicate.
 *   - Ordering stays correct: the incoming event lands first, remaining items
 *     keep their relative order.
 *   - The strip stays bounded (max length) exactly as before.
 *   - Items without a stable identity are never treated as duplicates, so a
 *     legitimate distinct item can never be removed by an id collision.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushUnique } from '../src/lib/live-ticker';

interface Ping {
  id: string;
  employeeName: string;
}

const idOf = (e: Ping) => e.id;
const MAX = 3;

const DUP_ID = 'cmsuboi9r0083fi7chotd3aw8'; // the id observed in the reported warning

test('unique ticker items render unchanged (no false dedup)', () => {
  const a: Ping = { id: 'evt-1', employeeName: 'Alice' };
  const b: Ping = { id: 'evt-2', employeeName: 'Bob' };
  const out = pushUnique(pushUnique([], a, MAX, idOf), b, MAX, idOf);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((e) => e.id), ['evt-2', 'evt-1'], 'newest first, both kept');
  // No two children would share a key.
  assert.equal(new Set(out.map((e) => e.id)).size, out.length);
});

test('repeated WebSocket event (same id) REPLACES the earlier entry — never duplicates', () => {
  // Same logical activity delivered twice with two payload objects (the
  // server re-broadcast scenario: same DB primary key, fresh payload).
  const first: Ping = { id: DUP_ID, employeeName: 'Alice' };
  const second: Ping = { id: DUP_ID, employeeName: 'Alice' };
  const third: Ping = { id: 'evt-2', employeeName: 'Bob' };

  const out = pushUnique(pushUnique(pushUnique([], first, MAX, idOf), second, MAX, idOf), third, MAX, idOf);
  // Three deliveries, two logical events — the duplicate must collapse to ONE.
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((e) => e.id),
    ['evt-2', DUP_ID],
    'duplicate id appears exactly ONCE; ordering = newest first'
  );
  assert.equal(new Set(out.map((e) => e.id)).size, out.length, 'no duplicate keys');
});

test('the NEWEST payload wins when the same id is delivered twice (latest content preserved)', () => {
  const stale: Ping = { id: DUP_ID, employeeName: 'Old Name' };
  const fresh: Ping = { id: DUP_ID, employeeName: 'New Name' };
  const out = pushUnique(pushUnique([], stale, MAX, idOf), fresh, MAX, idOf);
  assert.equal(out.length, 1);
  assert.equal(out[0].employeeName, 'New Name', 'incoming (newest) payload is kept');
});

test('ordering remains correct after deduplication (incoming first, others stable)', () => {
  let list: Ping[] = [];
  const events: Ping[] = [
    { id: 'a', employeeName: 'A' },
    { id: 'b', employeeName: 'B' },
    { id: 'c', employeeName: 'C' },
  ];
  for (const ev of events) list = pushUnique(list, ev, MAX, idOf);
  assert.deepEqual(list.map((e) => e.id), ['c', 'b', 'a'], 'newest first, relative order kept');

  // Re-deliver 'b' — it must move to the front and NOT appear twice.
  list = pushUnique(list, { id: 'b', employeeName: 'B2' }, MAX, idOf);
  assert.deepEqual(list.map((e) => e.id), ['b', 'c', 'a'], 're-delivered id moves to front, no copy');
  assert.equal(list[0].employeeName, 'B2');
});

test('strip stays bounded at max (cap preserved from the old .slice(0, 3))', () => {
  let list: Ping[] = [];
  for (let i = 1; i <= 6; i++) {
    list = pushUnique(list, { id: `evt-${i}`, employeeName: `E${i}` }, MAX, idOf);
  }
  assert.equal(list.length, MAX);
  assert.deepEqual(list.map((e) => e.id), ['evt-6', 'evt-5', 'evt-4'], 'newest MAX kept, oldest evicted');
});

test('entries without a stable identity are never deduplicated away', () => {
  // LiveEventLog-style entries without a source id: keyOf returns undefined,
  // so every entry must survive regardless of content.
  const noIdOf = (e: Ping) => (e.id.startsWith('no-id-') ? undefined : e.id);
  let list: Ping[] = [];
  const a = { id: 'no-id-1', employeeName: 'A' };
  const b = { id: 'no-id-2', employeeName: 'B' };
  list = pushUnique(list, a, MAX, noIdOf);
  list = pushUnique(list, b, MAX, noIdOf);
  assert.equal(list.length, 2, 'undefined identity never treated as a duplicate');

  // Mixed: a stable-id item still dedupes normally alongside them.
  const stable = { id: 's-1', employeeName: 'S' };
  list = pushUnique(list, stable, MAX, noIdOf);
  list = pushUnique(list, { id: 's-1', employeeName: 'S2' }, MAX, noIdOf);
  assert.equal(list.length, 3, 'stable-id duplicate replaced; undefined-id entries untouched');
  assert.equal(list[0].employeeName, 'S2');
});

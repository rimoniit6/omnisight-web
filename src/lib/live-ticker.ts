// OmniSight — live-ticker (Dashboard "Live Activity" strip) helpers.
//
// Pure, dependency-free, unit-testable from the repo root.
//
// The ticker is fed by the WebSocket `activity-ping` stream (`lastActivity`).
// Live streams can deliver the same logical event more than once — a server
// broadcast retry, a reconnect race, or (historically) the live-updates poll
// cursor re-broadcasting a row. Prepending blindly then produces two entries
// with the same primary-key `id`, which React surfaces as duplicate `key`
// warnings. `pushUnique` makes insertion idempotent: an incoming event
// REPLACES any existing entry with the same identity (the incoming one is
// always the newest), preserves relative order, and keeps the strip bounded.

/**
 * Prepend `item` to `list`, replacing any existing element with the same key
 * (as returned by `keyOf`), then cap the length at `max`.
 *
 * - Order: the incoming item always lands first; untouched items keep their
 *   relative order.
 * - Identity: `keyOf` — for the live ticker that is the event's stable id
 *   (the DB primary key for activity rows), which is globally unique, so two
 *   entries sharing it ARE the same logical event and the older one is
 *   dropped.
 * - Safety: when `keyOf` returns `undefined` (item has no stable identity)
 *   the item is never treated as a duplicate, so it can never cause a
 *   legitimate sibling to be removed.
 */
export function pushUnique<T>(
  list: T[],
  item: T,
  max: number,
  keyOf: (t: T) => string | undefined
): T[] {
  const key = keyOf(item);
  const rest = key === undefined ? list : list.filter((existing) => keyOf(existing) !== key);
  return [item, ...rest].slice(0, max);
}

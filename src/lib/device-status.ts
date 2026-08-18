import { effectiveLiveStatus } from './presence';

/**
 * Effective device status — lazy stale-offline evaluation, unified with the
 * centralized presence semantics (src/lib/presence.ts).
 *
 * The agent marks its device `online` on every heartbeat and never sends an
 * explicit offline signal. If the agent stops, `lastHeartbeat` goes stale and
 * the device must be treated as OFFLINE rather than showing "online" forever.
 *
 * Read paths (device list / summary / dashboard counts / webcam device
 * status) compute the effective status from heartbeat freshness so every
 * "is this device online right now?" decision agrees with the presence API
 * and the realtime events. Lifecycle statuses (maintenance/inactive/retired)
 * are admin-pinned and rendered verbatim. The stored `status` column is
 * never mutated — this is a pure read-side view.
 */

/** Number of consecutive missed heartbeats before a device is considered offline. */
export const STALE_OFFLINE_MISSED_BEATS = 3;

/** Floor in ms so an unusually fast heartbeat cadence can never flip too eagerly. */
export const STALE_OFFLINE_MIN_MS = 90_000; // 90s

/**
 * Stale threshold for an org: 3× its heartbeat interval (default 60s → 180s),
 * floored at 90s. The org cadence is server-configured and clamped to
 * [10, 600]s by resolveHeartbeatInterval.
 *
 * Kept exported for compatibility; real-time presence decisions use the
 * centralized EMPLOYEE_ONLINE_THRESHOLD_MS via effectiveDeviceStatus below.
 */
export function staleOfflineMs(heartbeatIntervalSec: number): number {
  return Math.max(STALE_OFFLINE_MIN_MS, STALE_OFFLINE_MISSED_BEATS * heartbeatIntervalSec * 1000);
}

/**
 * Effective status for display — single source of truth with presence.
 *
 * Lifecycle statuses (maintenance/inactive/retired) are returned verbatim.
 * Everything else is decided by heartbeat freshness against the centralized
 * EMPLOYEE_ONLINE_THRESHOLD_MS: a fresh heartbeat reads 'online', a stale or
 * missing one reads 'offline'.
 *
 * The optional thresholdMs/now parameters are retained for call-site
 * compatibility; thresholdMs is ignored (the centralized constant applies).
 */
export function effectiveDeviceStatus(
  status: string,
  lastHeartbeat: Date | null,
  _thresholdMs?: number,
  now?: number
): string {
  return effectiveLiveStatus(status, lastHeartbeat, now !== undefined ? new Date(now) : undefined);
}

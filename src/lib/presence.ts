// OmniSight — Global Employee Live Presence (server-authoritative).
//
// Presence semantics (single source of truth):
//
//   An employee is ONLINE when at least one of their devices has a
//   lastHeartbeat within EMPLOYEE_ONLINE_THRESHOLD_MS of "now".
//
//   - Presence answers ONLY "is an authenticated Desktop Agent currently
//     communicating with the server?" It is NOT productivity, keyboard/mouse
//     activity, break state, or "active sometime today".
//   - ONLINE + IDLE and ONLINE + BREAK are both valid states as long as the
//     agent keeps heartbeating (heartbeat continues during pause/break; it
//     stops on agent quit, logout, token revocation and orphan recovery).
//   - Device.status is deliberately NOT used: it is a sticky device lifecycle
//     field that nothing reverts to 'offline' at runtime. lastHeartbeat is the
//     only real liveness evidence.
//
// The threshold is centralized here. The live-updates mini-service keeps an
// identical constant (it is a separate process and cannot import from src/),
// and both honour the same optional PRESENCE_ONLINE_THRESHOLD_MS override so
// the API snapshot and the realtime events can never disagree.

export const EMPLOYEE_ONLINE_THRESHOLD_MS = Number(
  process.env.PRESENCE_ONLINE_THRESHOLD_MS ?? 5 * 60 * 1000
);

export function isValidThreshold(ms: number): boolean {
  return Number.isFinite(ms) && ms >= 15_000; // never below 15s (sane floor)
}

/**
 * Lifecycle statuses an admin sets explicitly. These are NEVER derived from
 * heartbeats: a maintenance/inactive/retired device renders that status
 * verbatim regardless of liveness. All other statuses are treated as
 * runtime states decided by heartbeat freshness alone.
 */
export const LIFECYCLE_PINNED_STATUSES = ['maintenance', 'inactive', 'retired'] as const;

/** Per-device live status: pinned lifecycle verbatim, otherwise heartbeat freshness decides online/offline. */
export function effectiveLiveStatus(
  status: string,
  lastHeartbeat: Date | null,
  now: Date = new Date()
): string {
  if ((LIFECYCLE_PINNED_STATUSES as readonly string[]).includes(status)) return status;
  return isHeartbeatFresh(lastHeartbeat, now) ? 'online' : 'offline';
}

/** True when a single device heartbeat is fresh enough to count as online. */
export function isHeartbeatFresh(
  lastHeartbeat: Date | null,
  now: Date = new Date()
): boolean {
  if (!lastHeartbeat) return false;
  const age = now.getTime() - lastHeartbeat.getTime();
  return Number.isFinite(age) && age >= 0 && age <= EMPLOYEE_ONLINE_THRESHOLD_MS;
}

export interface PresenceDeviceRow {
  employeeId: string | null;
  lastHeartbeat: Date | null;
}

export interface EmployeePresence {
  online: boolean;
  lastSeenAt: string | null;
}

/**
 * Derive per-employee presence from a flat device list in one pass.
 * An employee is online when ANY of their devices has a fresh heartbeat;
 * lastSeenAt is the newest heartbeat across all of their devices.
 * Null/absent employee ids (unassigned devices) are ignored.
 */
export function deriveEmployeePresence(
  devices: PresenceDeviceRow[],
  now: Date = new Date()
): Map<string, EmployeePresence> {
  const byEmployee = new Map<string, EmployeePresence>();
  for (const dev of devices) {
    if (!dev.employeeId) continue;
    const entry = byEmployee.get(dev.employeeId) ?? { online: false, lastSeenAt: null };
    if (dev.lastHeartbeat) {
      const ts = dev.lastHeartbeat.getTime();
      if (entry.lastSeenAt === null || ts > new Date(entry.lastSeenAt).getTime()) {
        entry.lastSeenAt = dev.lastHeartbeat.toISOString();
      }
    }
    if (isHeartbeatFresh(dev.lastHeartbeat, now)) entry.online = true;
    byEmployee.set(dev.employeeId, entry);
  }
  return byEmployee;
}

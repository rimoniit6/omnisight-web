// OmniSight — live-updates mini-service: employee presence derivation.
//
// This module is deliberately pure (no socket, no db) so the transition logic
// can be unit-tested from the repo root. The poll loop feeds it device
// snapshots and broadcasts the returned transition events.
//
// Semantics (must stay identical to src/lib/presence.ts):
//   employee ONLINE  ⇔  ANY of their devices has lastHeartbeat within
//                       EMPLOYEE_ONLINE_THRESHOLD_MS of now.
//   Presence = authenticated agent currently communicating with the server.
//   Device.status is NOT used (sticky lifecycle field, never reverted).
//
// The threshold mirrors src/lib/presence.ts; both honor the same optional
// PRESENCE_ONLINE_THRESHOLD_MS override so the snapshot API and the realtime
// stream can never disagree. This process cannot import from src/, hence the
// deliberate copy.

export const EMPLOYEE_ONLINE_THRESHOLD_MS = Number(
  process.env.PRESENCE_ONLINE_THRESHOLD_MS ?? 5 * 60 * 1000
);

/** Mirrors src/lib/presence.ts — admin-pinned lifecycle statuses, never derived from heartbeats. */
export const LIFECYCLE_PINNED_STATUSES = ['maintenance', 'inactive', 'retired'] as const;

export interface DeviceSnapshot {
  employeeId: string | null;
  organizationId: string;
  lastHeartbeat: Date | null;
  employeeName: string | null;
}

export interface PresenceEntry {
  online: boolean;
  /** Epoch ms of the newest heartbeat across the employee's devices. */
  lastHeartbeat: number;
  orgId: string;
  name: string;
}

export type PresenceMap = Map<string, PresenceEntry>;

export interface PresenceEvent {
  employeeId: string;
  employeeName: string;
  online: boolean;
  /** ISO of the newest observed heartbeat (lastSeenAt) — even when offline. */
  lastSeenAt: string;
  organizationId: string;
  timestamp: string;
}

function toEvent(employeeId: string, entry: PresenceEntry, now: Date): PresenceEvent {
  return {
    employeeId,
    employeeName: entry.name,
    online: entry.online,
    lastSeenAt: new Date(entry.lastHeartbeat).toISOString(),
    organizationId: entry.orgId,
    timestamp: now.toISOString(),
  };
}

/** Warm the map from a full snapshot WITHOUT emitting (initial state only). */
export function warmPresenceMap(
  map: PresenceMap,
  devices: DeviceSnapshot[],
  now: Date = new Date()
): void {
  const nowMs = now.getTime();
  for (const dev of devices) {
    if (!dev.employeeId || !dev.lastHeartbeat) continue;
    const beatMs = dev.lastHeartbeat.getTime();
    const prev = map.get(dev.employeeId);
    const lastHeartbeat = prev ? Math.max(prev.lastHeartbeat, beatMs) : beatMs;
    map.set(dev.employeeId, {
      online: nowMs - lastHeartbeat <= EMPLOYEE_ONLINE_THRESHOLD_MS,
      lastHeartbeat,
      orgId: dev.organizationId || prev?.orgId || '',
      name: dev.employeeName || prev?.name || '',
    });
  }
}

/**
 * Update the map from a poll's changed devices and return transition events.
 *
 * - Only meaningful ONLINE↔OFFLINE transitions produce events (a fresh
 *   heartbeat for an already-online employee is NOT an event — no spam).
 * - The offline sweep runs in the same in-memory pass (no DB writes, no
 *   per-employee timers): an employee whose newest heartbeat has gone stale
 *   flips to OFFLINE even though no new device row arrives.
 */
export function derivePresenceEvents(
  map: PresenceMap,
  devices: DeviceSnapshot[],
  now: Date = new Date()
): PresenceEvent[] {
  const events: PresenceEvent[] = [];
  const nowMs = now.getTime();

  for (const dev of devices) {
    if (!dev.employeeId || !dev.lastHeartbeat) continue;
    const beatMs = dev.lastHeartbeat.getTime();
    const prev = map.get(dev.employeeId);
    const lastHeartbeat = prev ? Math.max(prev.lastHeartbeat, beatMs) : beatMs;
    const online = nowMs - lastHeartbeat <= EMPLOYEE_ONLINE_THRESHOLD_MS;
    const entry: PresenceEntry = {
      online,
      lastHeartbeat,
      orgId: dev.organizationId || prev?.orgId || '',
      name: dev.employeeName || prev?.name || '',
    };
    map.set(dev.employeeId, entry);
    // Emit on transition only (undefined → online/offline counts as one).
    if (!prev || prev.online !== online) {
      events.push(toEvent(dev.employeeId, entry, now));
    }
  }

  // Offline sweep — catches employees whose heartbeats simply stopped.
  for (const [employeeId, entry] of map) {
    if (entry.online && nowMs - entry.lastHeartbeat > EMPLOYEE_ONLINE_THRESHOLD_MS) {
      entry.online = false;
      events.push(toEvent(employeeId, { ...entry, online: false }, now));
    }
  }

  return events;
}

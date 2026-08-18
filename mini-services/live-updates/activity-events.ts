// OmniSight — live-updates mini-service: activity-ping payload builder.
//
// This module is deliberately pure (no socket, no db) so the payload contract
// can be unit-tested from the repo root. The poll loop feeds it activity rows
// (already persisted) and the service broadcasts the returned payloads.
//
// Privacy contract:
//   - Website events expose ONLY the normalized bare domain. The server
//     already persisted Activity.url as domain-only at ingestion (see
//     src/lib/domain.ts); the raw/full URL never reaches the WebSocket layer.
//   - Defense in depth: the emitted value is re-validated as a bare hostname
//     here (lowercased, scheme/path/query/fragment/userinfo/port rejected).
//     Anything that does not look like a bare domain is dropped rather than
//     risk leaking a URL onto the wire.
//   - Non-website rows never carry activityUrl (null).
//   - The payload carries NO organization id — org scoping is applied by the
//     service when it broadcasts into the employee's `org:<id>` room, and the
//     organization always comes from the authenticated session, never the
//     client.

export interface ActivityPingPayload {
  id: string;
  employeeId: string;
  employeeName: string;
  department: string;
  activityType: string;
  activityTitle: string;
  /** Normalized bare domain for website rows; null otherwise/unavailable. */
  activityUrl: string | null;
  category: string;
  duration: number;
  timestamp: string;
}

// Bare hostname only: lowercase letters/digits/hyphens/dots, no scheme, path,
// query, fragment, userinfo, or port. Mirrors what src/lib/domain.ts persists.
const BARE_DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** True only for a safe, domain-only value that may be broadcast. */
export function isBareDomain(value: string | null | undefined): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 253 &&
    BARE_DOMAIN_RE.test(value)
  );
}

export interface ActivityRowLike {
  id: string;
  type: string | null;
  title: string | null;
  applicationName: string | null;
  url: string | null;
  category: string | null;
  duration: number | null;
  createdAt: Date;
}

export interface ActivityEmployeeLike {
  id: string;
  firstName: string | null;
  lastName: string | null;
  departmentId: string | null;
}

/**
 * Build the activity-ping WebSocket payload for one persisted activity row.
 *
 * `activityUrl` is set ONLY for `type === 'website'` rows whose stored `url`
 * is a bare domain (after lowering). A stored value that could be anything
 * else — a full URL, uppercase, empty, malformed — is dropped (null), so a
 * URL can never reach Live Monitor even if a legacy/rogue row sneaks in.
 */
export function buildActivityPing(
  a: ActivityRowLike,
  employee: ActivityEmployeeLike,
  departmentName: string
): ActivityPingPayload {
  const isWebsite = a.type === 'website';
  const lowered = a.url ? a.url.trim().toLowerCase() : null;
  const activityUrl = isWebsite && isBareDomain(lowered) ? lowered : null;
  return {
    id: a.id,
    employeeId: employee.id,
    employeeName: `${employee.firstName ?? ''} ${employee.lastName ?? ''}`.trim() || 'Unknown',
    department: departmentName || 'Unassigned',
    activityType: a.type || 'application',
    activityTitle: a.title || a.applicationName || 'Activity',
    activityUrl,
    category: a.category || 'neutral',
    duration: a.duration ?? 0,
    timestamp: a.createdAt.toISOString(),
  };
}

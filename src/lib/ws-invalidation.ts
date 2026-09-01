// OmniSight — centralized WebSocket event → React Query invalidation mapping.
//
// Single source of truth for which queries a realtime event refreshes. Pure
// and dependency-free so the mapping is unit-testable from the repo root and
// the providers only execute the returned keys.
//
// Targeting rules:
//   - Employee-scoped events (employee-presence / device-status / activity-ping)
//     invalidate ONLY the affected employee's queries via a prefix match on the
//     employee id — the global invalidation of other tenants' data never
//     happens, and an unopened details page is only marked stale, never fetched.
//   - Global aggregates (dashboard, feeds) are invalidated as before; they are
//     cheap list/aggregate queries and every realtime event legitimately
//     affects them.

/**
 * Query keys invalidated by an `employee-presence` transition for one employee.
 *
 * A heartbeat-driven ONLINE→OFFLINE (or the reverse) changes the live status
 * shown by EVERY global view — the devices list/table, the device summary
 * counts, the dashboard online count and the employee's details page. Before
 * this mapping existed, a presence transition only refreshed the employee
 * details query, so the Devices tab and Dashboard kept showing the stale
 * sticky `status` (green forever) after an agent stopped. Same target set as
 * device-status changes, since both events mean "liveness changed".
 */
export function employeePresenceInvalidation(employeeId: string): string[][] {
  return [
    ['devices'],
    ['device-summary'],
    ['device-chart-data'],
    ['dashboard'],
    ['break-status'],
    ['break-summary'],
    ['event-stats'],
    ['employee-details', employeeId],
  ];
}

/** Query keys invalidated by a `device-status` change for one employee. */
export function deviceStatusInvalidation(employeeId: string): string[][] {
  return [
    ['devices'],
    ['device-summary'],
    ['device-chart-data'],
    ['dashboard'],
    ['break-status'],
    ['break-summary'],
    ['event-stats'],
    ['employee-details', employeeId],
  ];
}

/** Query keys invalidated by an `activity-ping` for one employee. */
export function activityPingInvalidation(employeeId: string): string[][] {
  return [
    ['dashboard'],
    ['activities'],
    ['activities-daily'],
    ['event-stats'],
    ['employee-details', employeeId],
    ['employee-activities', employeeId],
  ];
}

/**
 * Query keys invalidated by a `project-time-update` (an automatically tracked
 * TimeEntry was created/updated by the sync engine).
 *
 * Only the affected project's queries (any filter/pagination variant, matched
 * by prefix) and the affected employee's employee-projects list are refreshed
 * — never the whole application. Project list queries keyed with the projectId
 * prefix ['project-detail', id] / ['project-time-entries', id] /
 * ['project-members', id] are prefix-matched by TanStack Query, so the filter
 * variants invalidate together.
 */
export function projectTimeUpdateInvalidation(projectId: string, employeeId: string): string[][] {
  return [
    ['projects'],
    ['project-detail', projectId],
    ['project-time-entries', projectId],
    ['project-members', projectId],
    ['employee-projects', employeeId],
  ];
}

/**
 * Query keys invalidated by a `device-claim` transition (a claim was created,
 * approved, rejected, revoked, cancelled, or expired).
 *
 * The Agent Approvals page list is prefix-matched on 'device-claims', so every
 * filter/search/pagination variant refreshes together; the sidebar pending
 * badge (['device-claims', 'badge-count']) and the global aggregates refresh
 * too. This is what lets an admin keep the approvals page open and see the
 * queue update in real time instead of polling.
 */
export function deviceClaimInvalidation(): string[][] {
  return [
    ['device-claims'],
    ['dashboard'],
    ['event-stats'],
  ];
}

/**
 * Query keys invalidated by an `anomaly` event (a new anomaly was detected
 * or reported). Prefix-matching on 'anomalies' refreshes every list/filter/
 * pagination variant on the Anomalies page; the dashboard is refreshed too
 * because it surfaces anomaly counts in its analytics signals.
 */
export function anomalyInvalidation(): string[][] {
  return [
    ['anomalies'],
    ['anomaly-detail'],
    ['dashboard'],
  ];
}

/**
 * Query keys invalidated by an `app-policy` event (an app whitelist/blacklist
 * entry was created or deactivated). Prefix-matching on 'app-list' refreshes
 * every filter/search/pagination variant of the Policies page list.
 */
export function appPolicyInvalidation(): string[][] {
  return [['app-list']];
}

/**
 * Query keys invalidated by a `policy-violation` event (the agent blocked a
 * process against a blacklist policy). Refreshes the violations list and the
 * app-list page (its enforcement/status surface).
 */
export function policyViolationInvalidation(): string[][] {
  return [['policy-violations'], ['app-list']];
}

/**
 * Query keys invalidated by a `usb-event` (a real USB insert/remove was
 * reported by an agent). Refreshes the USB events list — every filter variant
 * via prefix match.
 */
export function usbEventInvalidation(): string[][] {
  return [['usb-events']];
}

/**
 * Query keys invalidated by a `location-update` event (a new GPS fix arrived
 * for an employee). The LocationPanel refetches the employee's location API
 * to get the actual coordinates — coordinates are NEVER sent through the
 * WebSocket for privacy.
 */
export function locationUpdateInvalidation(employeeId: string): string[][] {
  return [
    ['employee-location', employeeId],
    ['tracking-status', employeeId],
  ];
}

/**
 * Query keys invalidated by an `alert-event` (a new org alert was created).
 * Refreshes the Alerts page list (every status/severity filter variant via
 * prefix match), the Security page's security-alert list, and the dashboard
 * (which surfaces the pending-alert count).
 */
export function alertEventInvalidation(): string[][] {
  return [
    ['alerts'],
    ['alert-count'],
    ['security-alerts'],
    ['dashboard'],
  ];
}
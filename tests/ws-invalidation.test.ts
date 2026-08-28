/**
 * Centralized WS → React Query invalidation mapping (src/lib/ws-invalidation.ts).
 *
 * Regression contract (Phase 2/3 hardening):
 *   - employee-presence / device-status / activity-ping events target the
 *     AFFECTED employee's queries via an id prefix — a foreign employee's
 *     cached queries must never be invalidated.
 *   - Prefix matching works for the real query keys used by
 *     employee-details-page.tsx: ['employee-details', employeeId, from, to]
 *     and ['employee-activities', employeeId, from, to].
 *   - No event produces an empty invalidation list (a mapping regression
 *     would silently stop live refresh).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  employeePresenceInvalidation,
  deviceStatusInvalidation,
  activityPingInvalidation,
  projectTimeUpdateInvalidation,
  deviceClaimInvalidation,
} from '../src/lib/ws-invalidation';

const EMP_A = 'emp-a';
const EMP_B = 'emp-b';

test('employee-presence invalidates global views + the affected employee\'s details query', () => {
  // A heartbeat-driven ONLINE→OFFLINE (or reverse) transition changes the
  // live status shown by every global view (devices table, device summary,
  // dashboard online count) — not just the employee details page. Before this
  // mapping existed, a stopped agent's sticky `status` stayed green on the
  // Devices tab and Dashboard because presence events only refreshed the
  // details query (the realtime refresh bug this test pins).
  const keys = employeePresenceInvalidation(EMP_A);
  assert.deepEqual(keys, [
    ['devices'],
    ['device-summary'],
    ['device-chart-data'],
    ['dashboard'],
    ['break-status'],
    ['break-summary'],
    ['event-stats'],
    ['employee-details', EMP_A],
  ]);
  assert.ok(keys.some((k) => k[0] === 'employee-details' && k[1] === EMP_A));
  // No other tenant's or employee's queries are ever invalidated.
  for (const key of keys) {
    assert.ok(!key.includes(EMP_B));
  }
});

test('device-status invalidates device/dashboard aggregates + affected employee details', () => {
  const keys = deviceStatusInvalidation(EMP_A);
  assert.deepEqual(keys, [
    ['devices'],
    ['device-summary'],
    ['device-chart-data'],
    ['dashboard'],
    ['break-status'],
    ['break-summary'],
    ['event-stats'],
    ['employee-details', EMP_A],
  ]);
  assert.ok(keys.some((k) => k[0] === 'employee-details' && k[1] === EMP_A));
});

test('activity-ping invalidates global aggregates + affected employee details and timeline', () => {
  const keys = activityPingInvalidation(EMP_A);
  assert.deepEqual(keys, [
    ['dashboard'],
    ['activities'],
    ['activities-daily'],
    ['event-stats'],
    ['employee-details', EMP_A],
    ['employee-activities', EMP_A],
  ]);
});

test('prefix match: invalidation keys hit the real parametrized query keys', () => {
  // The live query keys include date-range params — a prefix invalidation must
  // still match them.
  const realDetailsKey = ['employee-details', EMP_A, '2026-08-08T00:00:00.000Z', '2026-08-14T00:00:00.000Z'];
  const realActivitiesKey = ['employee-activities', EMP_A, '2026-08-08', '2026-08-14'];
  for (const key of deviceStatusInvalidation(EMP_A)) {
    if (key[0] === 'employee-details') {
      assert.deepEqual(realDetailsKey.slice(0, 2), key);
    }
  }
  for (const key of activityPingInvalidation(EMP_A)) {
    if (key[0] === 'employee-activities') {
      assert.deepEqual(realActivitiesKey.slice(0, 2), key);
    }
  }
});

test('project-time-update invalidates the affected project queries + employee project list', () => {
  const proj = 'proj-1';
  const keys = projectTimeUpdateInvalidation(proj, EMP_A);
  assert.deepEqual(keys, [
    ['projects'],
    ['project-detail', proj],
    ['project-time-entries', proj],
    ['project-members', proj],
    ['employee-projects', EMP_A],
  ]);
  // The parametrized project query keys (filters/pagination) must prefix-match.
  const realTimeEntriesKey = ['project-time-entries', proj, '2026-08-01', '2026-08-15', 'development', 'all', 1, 20];
  assert.deepEqual(realTimeEntriesKey.slice(0, 2), ['project-time-entries', proj]);
  // A different project is never invalidated.
  assert.ok(!keys.some((k) => k[1] === 'proj-other'));
});

test('no event type produces an empty invalidation list', () => {
  assert.ok(employeePresenceInvalidation(EMP_A).length > 0);
  assert.ok(deviceStatusInvalidation(EMP_A).length > 0);
  assert.ok(activityPingInvalidation(EMP_A).length > 0);
  assert.ok(projectTimeUpdateInvalidation('proj-1', EMP_A).length > 0);
  assert.ok(deviceClaimInvalidation().length > 0);
});

test('device-claim invalidates the approvals list, badge count and global aggregates', () => {
  const keys = deviceClaimInvalidation();
  assert.deepEqual(keys, [
    ['device-claims'],
    ['dashboard'],
    ['event-stats'],
  ]);
  // The real parametrized query keys of the approvals page (filter + search +
  // pagination variants) and the sidebar badge must prefix-match.
  const realListKey = ['device-claims', 'pending', '', 2];
  const realBadgeKey = ['device-claims', 'badge-count'];
  assert.deepEqual(realListKey.slice(0, 1), keys[0]);
  assert.deepEqual(realBadgeKey.slice(0, 1), keys[0]);
});

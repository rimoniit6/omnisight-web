/**
 * Unified device-status evaluation — lazy stale-offline, centralized on the
 * presence semantics (src/lib/presence.ts).
 *
 * Contract:
 *   - Lifecycle statuses (maintenance/inactive/retired) are admin-pinned and
 *     rendered verbatim regardless of heartbeat age.
 *   - Every other status is decided by heartbeat freshness against the
 *     centralized EMPLOYEE_ONLINE_THRESHOLD_MS: fresh → online, stale → offline,
 *     no heartbeat at all → offline (no liveness evidence).
 *   - effectiveDeviceStatus is read-side only: the stored status column is
 *     never mutated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveDeviceStatus, staleOfflineMs, STALE_OFFLINE_MISSED_BEATS } from '../src/lib/device-status';
import { effectiveLiveStatus, isHeartbeatFresh, EMPLOYEE_ONLINE_THRESHOLD_MS, LIFECYCLE_PINNED_STATUSES } from '../src/lib/presence';

test('staleOfflineMs keeps its documented cadence contract', () => {
  assert.equal(staleOfflineMs(60), 3 * 60 * 1000);
  assert.equal(staleOfflineMs(600), 3 * 600 * 1000);
  assert.equal(staleOfflineMs(10), 90_000);
  assert.equal(STALE_OFFLINE_MISSED_BEATS, 3);
});

test('status "online" with a fresh heartbeat reads online', () => {
  const now = Date.now();
  assert.equal(effectiveDeviceStatus('online', new Date(now - 30_000), 180_000, now), 'online');
});

test('status "online" with a stale heartbeat reads offline (read-side only)', () => {
  const now = Date.now();
  assert.equal(
    effectiveDeviceStatus('online', new Date(now - EMPLOYEE_ONLINE_THRESHOLD_MS - 1), 180_000, now),
    'offline'
  );
});

test('status "offline" with a fresh heartbeat reads online (heartbeat wins)', () => {
  const now = Date.now();
  assert.equal(effectiveDeviceStatus('offline', new Date(now - 10_000), 180_000, now), 'online');
});

test('null lastHeartbeat reads offline — no liveness evidence', () => {
  assert.equal(effectiveDeviceStatus('online', null, 180_000, Date.now()), 'offline');
  assert.equal(effectiveDeviceStatus('offline', null, 180_000, Date.now()), 'offline');
});

test('lifecycle statuses are pinned verbatim — never derived from heartbeats', () => {
  const now = Date.now();
  const stale = new Date(now - 999_000);
  const fresh = new Date(now - 1_000);
  for (const pinned of LIFECYCLE_PINNED_STATUSES) {
    assert.equal(effectiveDeviceStatus(pinned, stale, 180_000, now), pinned);
    assert.equal(effectiveDeviceStatus(pinned, fresh, 180_000, now), pinned);
    assert.equal(effectiveDeviceStatus(pinned, null, 180_000, now), pinned);
  }
});

test('boundary at exactly the presence threshold is still online', () => {
  const now = Date.now();
  const status = effectiveDeviceStatus('online', new Date(now - EMPLOYEE_ONLINE_THRESHOLD_MS), 180_000, now);
  assert.equal(status, 'online');
  assert.equal(isHeartbeatFresh(new Date(now - EMPLOYEE_ONLINE_THRESHOLD_MS), new Date(now)), true);
});

test('effectiveLiveStatus and effectiveDeviceStatus agree', () => {
  const now = new Date();
  const stale = new Date(now.getTime() - EMPLOYEE_ONLINE_THRESHOLD_MS - 60_000);
  assert.equal(effectiveLiveStatus('online', stale, now), effectiveDeviceStatus('online', stale, undefined, now.getTime()));
  assert.equal(effectiveLiveStatus('maintenance', null, now), 'maintenance');
  assert.equal(effectiveLiveStatus('online', null, now), 'offline');
});
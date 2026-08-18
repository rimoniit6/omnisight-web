/**
 * Webcam frame relay — consent/config gate unit tests (P3-02).
 *
 * The server re-validates `webcam_access` consent + `webcam_capture_enabled`
 * at least every 5s during a streaming session (src/lib/webcam-relay.ts
 * gateDue intervalMs = 5_000). These tests pin that interval semantics
 * deterministically with an injected clock:
 *   - no relay entry → gate is DUE (first frame re-checks)
 *   - within 5s of a successful gate → NOT due (no redundant DB lookups)
 *   - beyond 5s → DUE again (revocation takes effect at the next gate)
 *
 * Run: npx tsx --test tests/webcam-relay.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setLatestFrame,
  getLatestFrame,
  gateDue,
  markGateOk,
  clearSession,
  relaySessionCount,
  __FRAME_TTL_MS,
} from '../src/lib/webcam-relay';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

test('REL-01: unknown session → gate due (first frame always re-checks)', () => {
  assert.equal(gateDue('sess-none', 1_000_000), true);
});

test('REL-02: gate is NOT due within 5s of a successful re-check', () => {
  const t0 = 10_000_000;
  setLatestFrame('sess-gate', JPEG, t0);
  markGateOk('sess-gate', t0);
  // 4s later → within the 5s window → no re-check needed.
  assert.equal(gateDue('sess-gate', t0 + 4_000), false);
  // The comparison is strict `now - lastGateOkAt > intervalMs`: exactly at
  // the boundary is still NOT due; only beyond 5s is the gate due.
  assert.equal(gateDue('sess-gate', t0 + 5_000), false);
  assert.equal(gateDue('sess-gate', t0 + 5_001), true);
});

test('REL-03: gate becomes due again after 5s — revocation takes effect at the next gate', () => {
  const t0 = 20_000_000;
  setLatestFrame('sess-revoke', JPEG, t0);
  markGateOk('sess-revoke', t0);
  assert.equal(gateDue('sess-revoke', t0 + 2_000), false, 'recently-verified frames are not re-checked');
  assert.equal(gateDue('sess-revoke', t0 + 6_000), true, 'beyond 5s the gate is due again');
});

test('REL-04: clearSession drops the entry — frames stop flowing and gate goes due', () => {
  const t0 = 30_000_000;
  setLatestFrame('sess-clear', JPEG, t0);
  assert.equal(relaySessionCount() >= 1, true);
  assert.ok(getLatestFrame('sess-clear', t0), 'frame readable before clear');
  clearSession('sess-clear');
  assert.equal(getLatestFrame('sess-clear', t0 + 1), null, 'frame dropped after clear');
  assert.equal(gateDue('sess-clear', t0 + 1), true, 'cleared session re-checks on next frame');
});

test('REL-05: frames expire after the TTL (bounded memory, never persisted)', () => {
  const t0 = 40_000_000;
  setLatestFrame('sess-ttl', JPEG, t0);
  assert.ok(getLatestFrame('sess-ttl', t0 + __FRAME_TTL_MS - 1), 'fresh frame readable');
  assert.equal(getLatestFrame('sess-ttl', t0 + __FRAME_TTL_MS + 1), null, 'expired frame dropped');
});

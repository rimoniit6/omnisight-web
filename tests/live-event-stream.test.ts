/**
 * Live Event Stream — regression tests for new event types.
 *
 * Tests the sound policy covers tamper, policy-violation, and anomaly events.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSoundWorthy } from '../src/lib/sound-alert';
import type { LiveEventLog } from '../src/components/providers/websocket-provider';

function makeEvent(overrides: Partial<LiveEventLog> = {}): LiveEventLog {
  return {
    id: 'test-1',
    type: 'notification',
    title: 'Test',
    description: 'Test',
    timestamp: new Date().toISOString(),
    priority: 'medium',
    ...overrides,
  };
}

// ─── Policy Violation Sound Coverage ────────────────────────────────────────

describe('Policy violation sound coverage', () => {
  it('critical policy violation triggers sound', () => {
    assert.equal(isSoundWorthy(makeEvent({ type: 'policy-violation', priority: 'critical' })), true);
  });

  it('high policy violation triggers sound', () => {
    assert.equal(isSoundWorthy(makeEvent({ type: 'policy-violation', priority: 'high' })), true);
  });

  it('medium policy violation triggers sound', () => {
    assert.equal(isSoundWorthy(makeEvent({ type: 'policy-violation', priority: 'medium' })), true);
  });

  it('low policy violation does not trigger sound', () => {
    assert.equal(isSoundWorthy(makeEvent({ type: 'policy-violation', priority: 'low' })), false);
  });
});

// ─── Anomaly Sound Coverage ─────────────────────────────────────────────────

describe('Anomaly sound coverage', () => {
  it('critical anomaly triggers sound', () => {
    assert.equal(isSoundWorthy(makeEvent({ type: 'anomaly', priority: 'critical' })), true);
  });

  it('high anomaly triggers sound', () => {
    assert.equal(isSoundWorthy(makeEvent({ type: 'anomaly', priority: 'high' })), true);
  });

  it('medium anomaly triggers sound', () => {
    assert.equal(isSoundWorthy(makeEvent({ type: 'anomaly', priority: 'medium' })), true);
  });

  it('low anomaly does not trigger sound', () => {
    assert.equal(isSoundWorthy(makeEvent({ type: 'anomaly', priority: 'low' })), false);
  });
});

// ─── Tamper (via alert-event) Sound Coverage ────────────────────────────────

describe('Tamper (alert-event) sound coverage', () => {
  it('critical tamper alert triggers sound', () => {
    assert.equal(isSoundWorthy(makeEvent({ type: 'alert-event', priority: 'critical' })), true);
  });

  it('high tamper alert triggers sound', () => {
    assert.equal(isSoundWorthy(makeEvent({ type: 'alert-event', priority: 'high' })), true);
  });

  it('medium tamper alert triggers sound', () => {
    assert.equal(isSoundWorthy(makeEvent({ type: 'alert-event', priority: 'medium' })), true);
  });
});

// ─── Event Type Taxonomy ────────────────────────────────────────────────────

describe('LiveEventType taxonomy', () => {
  const validTypes = [
    'device-status', 'activity-ping', 'notification', 'break-status',
    'break-started', 'break-ended', 'screenshot', 'usb-event',
    'project-time-update', 'device-claim', 'alert-event', 'location-update',
    'policy-violation', 'anomaly',
  ] as const;

  it('all event types are sound-worthy when priority is not low', () => {
    for (const type of validTypes) {
      const event = makeEvent({ type, priority: 'high' });
      assert.equal(isSoundWorthy(event), true, `${type} with high priority should be sound-worthy`);
    }
  });

  it('no event type triggers sound when priority is low (except notification)', () => {
    for (const type of validTypes) {
      if (type === 'notification') continue; // notifications always sound
      const event = makeEvent({ type, priority: 'low' });
      assert.equal(isSoundWorthy(event), false, `${type} with low priority should not be sound-worthy`);
    }
  });
});

// ─── Sound Decision Pipeline with New Events ────────────────────────────────

describe('Sound pipeline with new event types', () => {
  let lastSoundedId: string | null = null;
  let lastSoundTime = 0;
  let soundEnabled = true;
  let audioUnlocked = true;

  function reset() {
    lastSoundedId = null;
    lastSoundTime = 0;
    soundEnabled = true;
    audioUnlocked = true;
  }

  function shouldPlaySound(event: LiveEventLog): boolean {
    if (event.id === lastSoundedId) return false;
    lastSoundedId = event.id;
    if (!soundEnabled) return false;
    if (!audioUnlocked) return false;
    if (!isSoundWorthy(event)) return false;
    const now = Date.now();
    if (event.priority !== 'critical' && now - lastSoundTime < 2000) return false;
    lastSoundTime = now;
    return true;
  }

  it('plays sound for critical policy violation', () => {
    reset();
    assert.equal(shouldPlaySound(makeEvent({ id: 'pv-1', type: 'policy-violation', priority: 'critical' })), true);
  });

  it('plays sound for critical anomaly', () => {
    reset();
    assert.equal(shouldPlaySound(makeEvent({ id: 'an-1', type: 'anomaly', priority: 'critical' })), true);
  });

  it('plays sound for high tamper alert', () => {
    reset();
    assert.equal(shouldPlaySound(makeEvent({ id: 'tamper-1', type: 'alert-event', priority: 'high' })), true);
  });

  it('deduplicates same policy-violation event', () => {
    reset();
    const event = makeEvent({ id: 'pv-dup', type: 'policy-violation', priority: 'critical' });
    assert.equal(shouldPlaySound(event), true);
    assert.equal(shouldPlaySound(event), false);
  });

  it('throttles non-critical policy violations', () => {
    reset();
    assert.equal(shouldPlaySound(makeEvent({ id: 'pv-t1', type: 'policy-violation', priority: 'high' })), true);
    assert.equal(shouldPlaySound(makeEvent({ id: 'pv-t2', type: 'policy-violation', priority: 'high' })), false);
  });

  it('critical policy violations bypass throttle', () => {
    reset();
    assert.equal(shouldPlaySound(makeEvent({ id: 'pv-c1', type: 'policy-violation', priority: 'critical' })), true);
    assert.equal(shouldPlaySound(makeEvent({ id: 'pv-c2', type: 'policy-violation', priority: 'critical' })), true);
  });
});

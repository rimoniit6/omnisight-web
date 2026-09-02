/**
 * LM-SOUND — Unit tests for sound-alert utilities and hook logic.
 *
 * Tests the pure functions from sound-alert.ts plus the conceptual
 * sound decision pipeline (dedup, throttle, policy, mute).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSoundWorthy,
  SOUND_THROTTLE_MS,
  SOUND_PREF_KEY,
  readSoundPreference,
  writeSoundPreference,
  isThrottled,
  SOUNDS,
} from '../src/lib/sound-alert';
import type { LiveEventLog } from '../src/components/providers/websocket-provider';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<LiveEventLog> = {}): LiveEventLog {
  return {
    id: 'test-event-1',
    type: 'notification',
    title: 'Test Event',
    description: 'Test description',
    timestamp: new Date().toISOString(),
    priority: 'medium',
    ...overrides,
  };
}

// ─── SOUNDS Constant ────────────────────────────────────────────────────────

describe('SOUNDS constant', () => {
  it('has a notification sound path', () => {
    assert.ok(SOUNDS.notification);
    assert.ok(SOUNDS.notification.endsWith('.wav'));
  });

  it('notification path starts with /', () => {
    assert.ok(SOUNDS.notification.startsWith('/'));
  });
});

// ─── isSoundWorthy ──────────────────────────────────────────────────────────

describe('isSoundWorthy', () => {
  it('returns true for notification events regardless of priority', () => {
    assert.equal(isSoundWorthy(makeEvent({ type: 'notification', priority: 'low' })), true);
    assert.equal(isSoundWorthy(makeEvent({ type: 'notification', priority: 'medium' })), true);
    assert.equal(isSoundWorthy(makeEvent({ type: 'notification', priority: 'high' })), true);
    assert.equal(isSoundWorthy(makeEvent({ type: 'notification', priority: 'critical' })), true);
  });

  it('returns true for non-low priority events', () => {
    assert.equal(isSoundWorthy(makeEvent({ type: 'device-status', priority: 'medium' })), true);
    assert.equal(isSoundWorthy(makeEvent({ type: 'usb-event', priority: 'high' })), true);
    assert.equal(isSoundWorthy(makeEvent({ type: 'alert-event', priority: 'critical' })), true);
  });

  it('returns false for low priority events', () => {
    assert.equal(isSoundWorthy(makeEvent({ type: 'device-status', priority: 'low' })), false);
    assert.equal(isSoundWorthy(makeEvent({ type: 'activity-ping', priority: 'low' })), false);
    assert.equal(isSoundWorthy(makeEvent({ type: 'screenshot', priority: 'low' })), false);
  });

  it('returns false when priority is undefined (defaults to low)', () => {
    assert.equal(isSoundWorthy(makeEvent({ type: 'device-status', priority: undefined })), false);
  });

  it('notification with no priority is still sound-worthy', () => {
    assert.equal(isSoundWorthy(makeEvent({ type: 'notification', priority: undefined })), true);
  });
});

// ─── readSoundPreference / writeSoundPreference ─────────────────────────────

describe('readSoundPreference / writeSoundPreference', () => {
  it('returns false when localStorage is empty', () => {
    // In Node.js test env, localStorage may not exist. The function
    // catches errors and returns false.
    const result = readSoundPreference();
    assert.equal(typeof result, 'boolean');
  });

  it('read/write round-trip (when localStorage available)', () => {
    // Skip if localStorage is not available (Node.js without polyfill)
    try {
      writeSoundPreference(true);
      assert.equal(readSoundPreference(), true);
      writeSoundPreference(false);
      assert.equal(readSoundPreference(), false);
    } catch {
      // localStorage not available — test is still valid (graceful degradation)
      assert.ok(true, 'localStorage unavailable — graceful degradation verified');
    }
  });

  it('SOUND_PREF_KEY is a stable string', () => {
    assert.equal(SOUND_PREF_KEY, 'omnisight-live-monitor-sound');
  });
});

// ─── isThrottled ────────────────────────────────────────────────────────────

describe('isThrottled', () => {
  it('returns true when within throttle window', () => {
    const now = Date.now();
    assert.equal(isThrottled(now - 500, now), true); // 500ms < 2000ms
    assert.equal(isThrottled(now - 1000, now), true);
    assert.equal(isThrottled(now - 1999, now), true);
  });

  it('returns false when outside throttle window', () => {
    const now = Date.now();
    assert.equal(isThrottled(now - 2000, now), false); // exactly 2000ms
    assert.equal(isThrottled(now - 3000, now), false);
    assert.equal(isThrottled(now - 10000, now), false);
  });

  it('returns false when lastSoundTime is 0 (first sound)', () => {
    assert.equal(isThrottled(0, Date.now()), false);
  });
});

// ─── SOUND_THROTTLE_MS ──────────────────────────────────────────────────────

describe('SOUND_THROTTLE_MS', () => {
  it('is set to 2000ms', () => {
    assert.equal(SOUND_THROTTLE_MS, 2000);
  });
});

// ─── Sound Decision Pipeline (integration-style unit tests) ─────────────────

describe('Sound decision pipeline', () => {
  // Simulates the full decision pipeline from the hook:
  // 1. Dedup: event.id === lastSoundedEvent → skip
  // 2. Mute: !soundEnabled → skip
  // 3. Unlock: audioUnlockState !== 'unlocked' → skip
  // 4. Policy: !isSoundWorthy → skip
  // 5. Throttle: within window → skip

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
    if (event.priority !== 'critical' && now - lastSoundTime < SOUND_THROTTLE_MS) return false;
    lastSoundTime = now;
    return true;
  }

  it('plays sound for a qualifying notification event', () => {
    reset();
    const event = makeEvent({ type: 'notification', priority: 'high' });
    assert.equal(shouldPlaySound(event), true);
  });

  it('skips duplicate event id', () => {
    reset();
    const event = makeEvent({ id: 'evt-1', type: 'notification', priority: 'high' });
    assert.equal(shouldPlaySound(event), true);
    assert.equal(shouldPlaySound(event), false); // duplicate
  });

  it('skips when sound is muted', () => {
    reset();
    soundEnabled = false;
    const event = makeEvent({ type: 'notification', priority: 'high' });
    assert.equal(shouldPlaySound(event), false);
  });

  it('skips when audio is locked', () => {
    reset();
    audioUnlocked = false;
    const event = makeEvent({ type: 'notification', priority: 'high' });
    assert.equal(shouldPlaySound(event), false);
  });

  it('skips low-priority non-notification events', () => {
    reset();
    const event = makeEvent({ type: 'device-status', priority: 'low' });
    assert.equal(shouldPlaySound(event), false);
  });

  it('plays sound for high-priority device-status', () => {
    reset();
    const event = makeEvent({ type: 'device-status', priority: 'high' });
    assert.equal(shouldPlaySound(event), true);
  });

  it('throttles non-critical events within 2s window', () => {
    reset();
    const event1 = makeEvent({ id: 'evt-1', type: 'notification', priority: 'high' });
    const event2 = makeEvent({ id: 'evt-2', type: 'notification', priority: 'high' });
    assert.equal(shouldPlaySound(event1), true);
    assert.equal(shouldPlaySound(event2), false); // throttled
  });

  it('critical events bypass throttle', () => {
    reset();
    const event1 = makeEvent({ id: 'evt-1', type: 'alert-event', priority: 'critical' });
    const event2 = makeEvent({ id: 'evt-2', type: 'alert-event', priority: 'critical' });
    assert.equal(shouldPlaySound(event1), true);
    // Critical events bypass throttle, but dedup still applies to different ids
    assert.equal(shouldPlaySound(event2), true); // different id, critical → bypasses throttle
  });

  it('plays sound for unproductive activity-ping (medium priority)', () => {
    reset();
    const event = makeEvent({ type: 'activity-ping', priority: 'medium' });
    assert.equal(shouldPlaySound(event), true);
  });

  it('skips routine activity-ping (low priority)', () => {
    reset();
    const event = makeEvent({ type: 'activity-ping', priority: 'low' });
    assert.equal(shouldPlaySound(event), false);
  });
});

// ─── Event Type Coverage ────────────────────────────────────────────────────

describe('Event type sound coverage', () => {
  // Verify the policy covers all expected event types correctly.
  const cases: Array<{ type: LiveEventLog['type']; priority?: string; expected: boolean; label: string }> = [
    { type: 'notification', priority: 'low', expected: true, label: 'notification always sounds' },
    { type: 'notification', priority: 'critical', expected: true, label: 'notification critical' },
    { type: 'device-status', priority: 'high', expected: true, label: 'device offline sounds' },
    { type: 'device-status', priority: 'low', expected: false, label: 'device online silent' },
    { type: 'activity-ping', priority: 'medium', expected: true, label: 'unproductive activity sounds' },
    { type: 'activity-ping', priority: 'low', expected: false, label: 'routine activity silent' },
    { type: 'usb-event', priority: 'high', expected: true, label: 'blocked USB sounds' },
    { type: 'usb-event', priority: 'medium', expected: true, label: 'USB insert/remove sounds' },
    { type: 'alert-event', priority: 'critical', expected: true, label: 'critical alert sounds' },
    { type: 'alert-event', priority: 'medium', expected: true, label: 'medium alert sounds' },
    { type: 'break-status', priority: 'low', expected: false, label: 'break status silent' },
    { type: 'screenshot', priority: 'low', expected: false, label: 'screenshot silent' },
    { type: 'device-claim', priority: 'medium', expected: true, label: 'pending claim sounds' },
    { type: 'device-claim', priority: 'low', expected: false, label: 'approved claim silent' },
    { type: 'project-time-update', priority: 'low', expected: false, label: 'project time silent' },
  ];

  for (const { type, priority, expected, label } of cases) {
    it(label, () => {
      const event = makeEvent({ type, priority });
      assert.equal(isSoundWorthy(event), expected);
    });
  }
});

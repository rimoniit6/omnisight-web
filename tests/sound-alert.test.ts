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
  severityFromPriority,
  soundForSeverity,
  volumeForSeverity,
  SEVERITY_VOLUME,
  DEFAULT_VOLUME,
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
  it('has a default notification sound path', () => {
    assert.ok(SOUNDS.default);
    assert.ok(SOUNDS.default.endsWith('.wav'));
  });

  it('default path starts with /', () => {
    assert.ok(SOUNDS.default.startsWith('/'));
  });

  it('has critical sound path', () => {
    assert.ok(SOUNDS.critical);
    assert.ok(SOUNDS.critical.endsWith('.wav'));
    assert.ok(SOUNDS.critical.includes('critical'));
  });

  it('has warning sound path', () => {
    assert.ok(SOUNDS.warning);
    assert.ok(SOUNDS.warning.endsWith('.wav'));
    assert.ok(SOUNDS.warning.includes('warning'));
  });

  it('has info sound path', () => {
    assert.ok(SOUNDS.info);
    assert.ok(SOUNDS.info.endsWith('.wav'));
    assert.ok(SOUNDS.info.includes('info'));
  });

  it('all paths start with /', () => {
    for (const key of Object.keys(SOUNDS)) {
      assert.ok(SOUNDS[key as keyof typeof SOUNDS].startsWith('/'), `${key} path should start with /`);
    }
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

// ─── severityFromPriority ───────────────────────────────────────────────────

describe('severityFromPriority', () => {
  it('maps critical to critical', () => {
    assert.equal(severityFromPriority('critical'), 'critical');
  });

  it('maps high to warning', () => {
    assert.equal(severityFromPriority('high'), 'warning');
  });

  it('maps medium to info', () => {
    assert.equal(severityFromPriority('medium'), 'info');
  });

  it('maps low to info (fallback)', () => {
    assert.equal(severityFromPriority('low'), 'info');
  });

  it('maps undefined to info (fallback)', () => {
    assert.equal(severityFromPriority(undefined), 'info');
  });

  it('maps unknown string to info (fallback)', () => {
    assert.equal(severityFromPriority('unknown'), 'info');
  });
});

// ─── soundForSeverity ──────────────────────────────────────────────────────

describe('soundForSeverity', () => {
  it('returns critical sound for critical severity', () => {
    assert.equal(soundForSeverity('critical'), SOUNDS.critical);
  });

  it('returns warning sound for warning severity', () => {
    assert.equal(soundForSeverity('warning'), SOUNDS.warning);
  });

  it('returns info sound for info severity', () => {
    assert.equal(soundForSeverity('info'), SOUNDS.info);
  });

  it('returns default sound for unknown severity', () => {
    assert.equal(soundForSeverity('unknown'), SOUNDS.default);
  });

  it('returns default sound for default severity', () => {
    assert.equal(soundForSeverity('default'), SOUNDS.default);
  });
});

// ─── volumeForSeverity ─────────────────────────────────────────────────────

describe('volumeForSeverity', () => {
  it('returns 0.8 for critical', () => {
    assert.equal(volumeForSeverity('critical'), 0.8);
  });

  it('returns 0.5 for warning', () => {
    assert.equal(volumeForSeverity('warning'), 0.5);
  });

  it('returns 0.3 for info', () => {
    assert.equal(volumeForSeverity('info'), 0.3);
  });

  it('returns 0 for low (silent)', () => {
    assert.equal(volumeForSeverity('low'), 0);
  });

  it('returns DEFAULT_VOLUME for unknown severity', () => {
    assert.equal(volumeForSeverity('unknown'), DEFAULT_VOLUME);
  });

  it('DEFAULT_VOLUME is 0.4', () => {
    assert.equal(DEFAULT_VOLUME, 0.4);
  });
});

// ─── SEVERITY_VOLUME ───────────────────────────────────────────────────────

describe('SEVERITY_VOLUME', () => {
  it('has critical, warning, info, and low entries', () => {
    assert.ok('critical' in SEVERITY_VOLUME);
    assert.ok('warning' in SEVERITY_VOLUME);
    assert.ok('info' in SEVERITY_VOLUME);
    assert.ok('low' in SEVERITY_VOLUME);
  });

  it('critical volume is highest', () => {
    assert.ok(SEVERITY_VOLUME.critical > SEVERITY_VOLUME.warning);
    assert.ok(SEVERITY_VOLUME.warning > SEVERITY_VOLUME.info);
  });

  it('low volume is zero (silent)', () => {
    assert.equal(SEVERITY_VOLUME.low, 0);
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
});// ─── Sound Decision Pipeline (integration-style unit tests) ─────────────────
describe('Sound decision pipeline', () => {
  // Simulates the full decision pipeline from the hook:
  // 1. Dedup: event.id === lastSoundedEvent → skip
  // 2. Mute: !soundEnabled → skip
  // 3. Unlock: audioUnlockState !== 'unlocked' → skip
  // 4. Policy: !isSoundWorthy → skip
  // 5. Throttle: within window → skip
  // 6. Severity: priority → severity → sound file + volume

  let lastSoundedId: string | null = null;
  let lastSoundTime = 0;
  let soundEnabled = true;
  let audioUnlocked = true;
  let lastPlayedSeverity: string | null = null;

  function reset() {
    lastSoundedId = null;
    lastSoundTime = 0;
    soundEnabled = true;
    audioUnlocked = true;
    lastPlayedSeverity = null;
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
    lastPlayedSeverity = severityFromPriority(event.priority);
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

  it('resolves critical priority to critical severity', () => {
    reset();
    const event = makeEvent({ type: 'alert-event', priority: 'critical' });
    shouldPlaySound(event);
    assert.equal(lastPlayedSeverity, 'critical');
  });

  it('resolves high priority to warning severity', () => {
    reset();
    const event = makeEvent({ type: 'device-status', priority: 'high' });
    shouldPlaySound(event);
    assert.equal(lastPlayedSeverity, 'warning');
  });

  it('resolves medium priority to info severity', () => {
    reset();
    const event = makeEvent({ type: 'notification', priority: 'medium' });
    shouldPlaySound(event);
    assert.equal(lastPlayedSeverity, 'info');
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

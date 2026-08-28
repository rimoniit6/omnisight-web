/**
 * Sound Alert utilities — unit tests (LM-SOUND).
 *
 * Covers:
 *   A. isSoundWorthy — event → audible mapping
 *   B. readSoundPreference / writeSoundPreference — localStorage round-trip
 *   C. SOUND_THROTTLE_MS — constant sanity
 *
 * Run: npx tsx --test tests/sound-alert.test.ts
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSoundWorthy,
  readSoundPreference,
  writeSoundPreference,
  SOUND_PREF_KEY,
  SOUND_THROTTLE_MS,
  SOUNDS,
} from '../src/lib/sound-alert';
import type { LiveEventLog } from '../src/components/providers/websocket-provider';

// ─── Helpers ───

function makeEvent(overrides: Partial<LiveEventLog> = {}): LiveEventLog {
  return {
    id: 'test-1',
    type: 'notification',
    title: 'Test',
    description: 'Test event',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ─── In-memory localStorage polyfill for Node.js ───

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string) { return this.store.get(key) ?? null; }
  setItem(key: string, value: string) { this.store.set(key, value); }
  removeItem(key: string) { this.store.delete(key); }
}

// ─── A. isSoundWorthy — event filtering ───

describe('isSoundWorthy', () => {
  test('notification events are always audible regardless of priority', () => {
    for (const priority of [undefined, 'low', 'medium', 'high', 'critical']) {
      assert.ok(
        isSoundWorthy(makeEvent({ type: 'notification', priority })),
        `notification with priority=${priority} should be sound-worthy`,
      );
    }
  });

  test('activity-ping with low priority is NOT sound-worthy (heartbeat)', () => {
    assert.equal(
      isSoundWorthy(makeEvent({ type: 'activity-ping', priority: 'low' })),
      false,
      'routine heartbeat should be silent',
    );
  });

  test('activity-ping with medium priority IS sound-worthy (unproductive work)', () => {
    assert.ok(
      isSoundWorthy(makeEvent({ type: 'activity-ping', priority: 'medium' })),
      'unproductive activity should be audible',
    );
  });

  test('device-status with high priority IS sound-worthy (device offline)', () => {
    assert.ok(
      isSoundWorthy(makeEvent({ type: 'device-status', priority: 'high' })),
      'device offline should be audible',
    );
  });

  test('device-status with low priority is NOT sound-worthy', () => {
    assert.equal(
      isSoundWorthy(makeEvent({ type: 'device-status', priority: 'low' })),
      false,
      'device online (low) should be silent',
    );
  });

  test('events without priority default to low and are NOT sound-worthy', () => {
    assert.equal(
      isSoundWorthy(makeEvent({ type: 'screenshot', priority: undefined })),
      false,
      'screenshot with no priority should be silent',
    );
  });

  test('usb-event with high priority IS sound-worthy (USB blocked)', () => {
    assert.ok(
      isSoundWorthy(makeEvent({ type: 'usb-event', priority: 'high' })),
      'blocked USB should be audible',
    );
  });

  test('alert-event with critical priority IS sound-worthy', () => {
    assert.ok(
      isSoundWorthy(makeEvent({ type: 'alert-event', priority: 'critical' })),
      'critical alert should be audible',
    );
  });

  test('break-status with low priority is NOT sound-worthy', () => {
    assert.equal(
      isSoundWorthy(makeEvent({ type: 'break-status', priority: 'low' })),
      false,
      'break start/end should be silent',
    );
  });
});

// ─── B. localStorage preference persistence ───

describe('readSoundPreference / writeSoundPreference', () => {
  const storage = new MemoryStorage();
  const originalLocalStorage = globalThis.localStorage;

  beforeEach(() => {
    // Inject in-memory polyfill for tests
    (globalThis as Record<string, unknown>).localStorage = storage as unknown as Storage;
    storage.removeItem(SOUND_PREF_KEY);
  });

  afterEach(() => {
    // Restore original if it existed
    if (originalLocalStorage !== undefined) {
      (globalThis as Record<string, unknown>).localStorage = originalLocalStorage;
    } else {
      delete (globalThis as Record<string, unknown>).localStorage;
    }
  });

  test('readSoundPreference returns false when no preference is stored', () => {
    assert.equal(readSoundPreference(), false, 'unset preference should default to false');
  });

  test('writeSoundPreference(true) persists and readSoundPreference returns true', () => {
    writeSoundPreference(true);
    assert.equal(readSoundPreference(), true, 'should read back true after writing true');
  });

  test('writeSoundPreference(false) persists and readSoundPreference returns false', () => {
    writeSoundPreference(true); // set first
    writeSoundPreference(false); // then override
    assert.equal(readSoundPreference(), false, 'should read back false after writing false');
  });

  test('writeSoundPreference toggles work correctly', () => {
    writeSoundPreference(false);
    assert.equal(readSoundPreference(), false);
    writeSoundPreference(true);
    assert.equal(readSoundPreference(), true);
    writeSoundPreference(false);
    assert.equal(readSoundPreference(), false);
  });

  test('readSoundPreference handles missing localStorage gracefully', () => {
    delete (globalThis as Record<string, unknown>).localStorage;
    assert.equal(readSoundPreference(), false, 'should return false when localStorage is unavailable');
  });

  test('writeSoundPreference handles missing localStorage gracefully', () => {
    delete (globalThis as Record<string, unknown>).localStorage;
    // Should not throw
    writeSoundPreference(true);
    writeSoundPreference(false);
  });
});

// ─── C. Constants sanity ───

describe('Sound constants', () => {
  test('SOUND_THROTTLE_MS is at least 1000ms (prevents sound spam)', () => {
    assert.ok(SOUND_THROTTLE_MS >= 1000, 'throttle should be at least 1 second');
  });

  test('SOUND_PREF_KEY is a non-empty string', () => {
    assert.ok(typeof SOUND_PREF_KEY === 'string' && SOUND_PREF_KEY.length > 0);
  });

  test('SOUNDS.notification points to a wav file in /public', () => {
    assert.ok(
      SOUNDS.notification.startsWith('/sounds/'),
      'should be a public path starting with /sounds/',
    );
    assert.ok(
      SOUNDS.notification.endsWith('.wav'),
      'should reference a WAV file',
    );
  });
});

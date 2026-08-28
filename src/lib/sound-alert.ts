/**
 * Sound Alert utilities (LM-SOUND)
 *
 * Extracted from live-monitor-page.tsx so the pure logic can be unit-tested
 * without a browser / React rendering context.
 */

import type { LiveEventLog } from '@/components/providers/websocket-provider';

// ─── Constants ───

export const SOUNDS = {
  notification: '/sounds/notification.wav',
} as const;

export const SOUND_PREF_KEY = 'omnisight-live-monitor-sound';

/** Non-critical events are throttled to one sound per window. */
export const SOUND_THROTTLE_MS = 2000;

// ─── Event Filtering ───

/**
 * LM-SOUND policy — which NEW events are audible:
 * - notification: always (an explicit alert; preserves the original behavior).
 * - activity-ping: only when NOT routine heartbeat activity (priority > low,
 *   i.e. unproductive work) — the high-frequency heartbeat stream stays silent.
 * - other types (device offline, blocked USB, agent registration, ...):
 *   audible only when priority >= medium (meaningful events).
 */
export function isSoundWorthy(event: LiveEventLog): boolean {
  if (event.type === 'notification') return true;
  return (event.priority || 'low') !== 'low';
}

// ─── Preference Persistence ───

/** Read persisted sound preference. Returns false when localStorage is
 *  unavailable or the key has never been written. */
export function readSoundPreference(): boolean {
  try {
    return localStorage.getItem(SOUND_PREF_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeSoundPreference(enabled: boolean): void {
  try {
    localStorage.setItem(SOUND_PREF_KEY, String(enabled));
  } catch {
    // storage full or private browsing — degrade silently
  }
}

// ─── Throttle Check ───

/** Returns true when enough time has passed since the last non-critical sound. */
export function isThrottled(lastSoundTime: number, now: number): boolean {
  return now - lastSoundTime < SOUND_THROTTLE_MS;
}

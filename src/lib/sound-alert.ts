/**
 * Sound Alert utilities (LM-SOUND)
 *
 * Extracted from live-monitor-page.tsx so the pure logic can be unit-tested
 * without a browser / React rendering context.
 */

import type { LiveEventLog } from '@/components/providers/websocket-provider';

// ─── Constants ───

/**
 * Severity-based sound map. Each severity level has a distinct audio cue:
 *   critical — urgent double-beep (880 Hz, high volume)
 *   warning  — single medium beep (660 Hz, normal volume)
 *   info     — soft low blip (440 Hz, low volume)
 *   default  — legacy fallback (the original notification sound)
 */
export const SOUNDS = {
  critical: '/sounds/critical.wav',
  warning: '/sounds/warning.wav',
  info: '/sounds/info.wav',
  default: '/sounds/notification.wav',
} as const;

/** Volume level per severity (0–1). */
export const SEVERITY_VOLUME: Record<string, number> = {
  critical: 0.8,
  warning: 0.5,
  info: 0.3,
  low: 0,
};

/** Fallback volume for unknown severities. */
export const DEFAULT_VOLUME = 0.4;

/**
 * Map an event's priority to a severity bucket for sound selection.
 * The mapping follows the existing OmniSight priority taxonomy:
 *   critical → critical sound
 *   high     → warning sound
 *   medium   → info sound
 *   low      → no sound (handled by isSoundWorthy)
 */
export function severityFromPriority(priority?: string): 'critical' | 'warning' | 'info' {
  switch (priority) {
    case 'critical': return 'critical';
    case 'high': return 'warning';
    case 'medium': return 'info';
    default: return 'info';
  }
}

/** Get the sound file path for a given severity. */
export function soundForSeverity(severity: string): string {
  if (severity in SOUNDS && severity !== 'default') {
    return SOUNDS[severity as keyof typeof SOUNDS];
  }
  return SOUNDS.default;
}

/** Get the volume for a given severity. */
export function volumeForSeverity(severity: string): number {
  return SEVERITY_VOLUME[severity] ?? DEFAULT_VOLUME;
}

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

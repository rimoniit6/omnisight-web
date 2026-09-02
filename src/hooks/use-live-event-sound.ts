/**
 * useLiveEventSound — LM-SOUND React Hook
 *
 * Encapsulates the full audio lifecycle for the Live Event Stream:
 *   - Singleton HTMLAudioElement (lazy-created, shared)
 *   - Browser autoplay gate handling (unlock via user gesture)
 *   - Mute/unmute with localStorage persistence
 *   - Sound policy (isSoundWorthy) + throttle
 *   - Deduplication via event ID
 *   - Cleanup on unmount
 *
 * Replaces the scattered audio logic that was inlined in live-monitor-page.tsx.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import {
  isSoundWorthy,
  SOUND_THROTTLE_MS,
  SOUNDS,
  readSoundPreference,
  writeSoundPreference,
  severityFromPriority,
  soundForSeverity,
  volumeForSeverity,
} from '@/lib/sound-alert';
import type { LiveEventLog } from '@/components/providers/websocket-provider';

// ─── Singleton Audio Element ─────────────────────────────────────────────────

let sharedAudio: HTMLAudioElement | null = null;

function getSharedAudio(): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null;
  if (!sharedAudio) {
    sharedAudio = new Audio(SOUNDS.default);
    sharedAudio.preload = 'auto';
  }
  return sharedAudio;
}

/**
 * Prepare the shared audio element for a specific severity level.
 * Swaps the src only when the severity changes to avoid unnecessary reloads.
 * Returns false if the audio element is unavailable.
 */
function prepareForSeverity(severity: string): boolean {
  const audio = getSharedAudio();
  if (!audio) return false;
  const targetSrc = soundForSeverity(severity);
  if (audio.src !== targetSrc && !audio.src.endsWith(targetSrc)) {
    audio.src = targetSrc;
    audio.load();
  }
  return true;
}

// ─── Unlock State Machine ────────────────────────────────────────────────────
// The browser blocks programmatic audio until the user has interacted with the
// page.  We model this as a 3-state machine:
//
//   locked  → (user clicks "Enable Sound") → unlocked
//   locked  → (play fails)                 → locked (stays)
//   unlocked → (play fails)                → locked (browser revoked)
//
// "unlocked" means we have proven that audio.play() succeeds inside a user
// gesture.  After that, subsequent programmatic plays should work until the
// tab is backgrounded or the browser revokes the permission.

export type AudioUnlockState = 'locked' | 'unlocked' | 'unsupported';

// ─── Hook ────────────────────────────────────────────────────────────────────

export interface UseLiveEventSoundReturn {
  /** Whether sound is enabled (user preference, persisted). */
  soundEnabled: boolean;
  /** Whether audio playback is proven to work (autoplay gate passed). */
  audioUnlockState: AudioUnlockState;
  /** Toggle sound on/off. When enabling, attempts to unlock audio. */
  toggleSound: () => void;
  /**
   * Call this for each NEW event entering the Live Event Stream.
   * Handles: sound-worthiness check, throttle, dedup, playback.
   * Returns true if sound was played.
   */
  onEvent: (event: LiveEventLog) => boolean;
  /** Whether the last unlock attempt succeeded. */
  isUnlocked: boolean;
}

export function useLiveEventSound(): UseLiveEventSoundReturn {
  const [soundEnabled, setSoundEnabled] = useState(readSoundPreference);
  const [audioUnlockState, setAudioUnlockState] = useState<AudioUnlockState>(
    typeof window === 'undefined' ? 'locked' : 'locked'
  );

  // Dedup: id of the newest event already considered for sound.
  const lastSoundedEventRef = useRef<string | null>(null);
  // Throttle: wall-clock time of the last non-critical sound.
  const lastSoundTimeRef = useRef(0);
  // Track mount state for cleanup.
  const mountedRef = useRef(true);

  // ── Persist preference ──
  useEffect(() => {
    writeSoundPreference(soundEnabled);
  }, [soundEnabled]);

  // ── Cleanup on unmount ──
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ── Play helper ──
  // Plays a severity-appropriate sound.  The severity is derived from the
  // event's priority via severityFromPriority() in the caller.
  const playSound = useCallback(async (severity: string): Promise<boolean> => {
    if (!prepareForSeverity(severity)) return false;
    const audio = getSharedAudio();
    if (!audio) return false;
    try {
      audio.volume = volumeForSeverity(severity);
      audio.currentTime = 0;
      await audio.play();
      return true;
    } catch (err) {
      // Autoplay blocked or audio unavailable.  In development, log a
      // diagnostic; in production stay silent to avoid console noise.
      if (process.env.NODE_ENV === 'development') {
        console.warn('[LiveEventSound] play() rejected', err);
      }
      // If we were previously unlocked, the browser may have revoked the
      // permission (e.g. tab backgrounded).  Downgrade to locked.
      if (mountedRef.current) {
        setAudioUnlockState('locked');
      }
      return false;
    }
  }, []);

  // ── Unlock (user gesture) ──
  const unlock = useCallback(async (): Promise<boolean> => {
    const audio = getSharedAudio();
    if (!audio) {
      if (mountedRef.current) setAudioUnlockState('unsupported');
      return false;
    }
    try {
      // Use the info sound for the unlock blip (soft, unobtrusive)
      prepareForSeverity('info');
      audio.volume = 0.3;
      audio.currentTime = 0;
      await audio.play();
      // Proof of playback — play a short blip then pause.
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          audio.pause();
          audio.currentTime = 0;
          resolve();
        }, 120);
      });
      if (mountedRef.current) setAudioUnlockState('unlocked');
      return true;
    } catch {
      if (mountedRef.current) setAudioUnlockState('locked');
      return false;
    }
  }, []);

  // ── Toggle ──
  const toggleSound = useCallback(() => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    if (next) {
      // Attempt unlock inside this click gesture.
      void unlock();
    } else {
      // Stop any in-flight sound immediately.
      const audio = getSharedAudio();
      if (audio) {
        audio.pause();
        audio.currentTime = 0;
      }
      if (mountedRef.current) setAudioUnlockState('locked');
    }
  }, [soundEnabled, unlock]);

  // ── Event handler ──
  const onEvent = useCallback(
    (event: LiveEventLog): boolean => {
      // Dedup: only consider each event id once.
      if (event.id === lastSoundedEventRef.current) return false;
      lastSoundedEventRef.current = event.id;

      // Gate: must be enabled, unlocked, and sound-worthy.
      if (!soundEnabled) return false;
      if (audioUnlockState !== 'unlocked') return false;
      if (!isSoundWorthy(event)) return false;

      // Throttle non-critical events.
      const now = Date.now();
      if (
        event.priority !== 'critical' &&
        now - lastSoundTimeRef.current < SOUND_THROTTLE_MS
      ) {
        return false;
      }

      lastSoundTimeRef.current = now;
      void playSound(severityFromPriority(event.priority));
      return true;
    },
    [soundEnabled, audioUnlockState, playSound]
  );

  return {
    soundEnabled,
    audioUnlockState,
    toggleSound,
    onEvent,
    isUnlocked: audioUnlockState === 'unlocked',
  };
}

// OmniSight — in-memory webcam frame relay (single-instance).
//
// PRIVACY/DESIGN CONTRACT:
//   - Only the LATEST frame per session is kept, in memory, with a TTL.
//   - Frames are NEVER written to disk, the database, logs, or analytics.
//   - Entries are bounded (max sessions + max frame bytes) and drop
//     automatically when a session ends or goes quiet.
//   - Single-instance limitation: the relay lives in process memory. This is
//     consistent with the existing self-hosted single-instance deployment
//     (Caddy proxies one Next instance; the rate limiter documents the same
//     constraint). A multi-instance deployment would need a shared store —
//     out of scope and documented, never silently assumed.

interface RelayEntry {
  /** Latest JPEG bytes. */
  frame: Buffer;
  at: number;
  /** Consent/config re-validation cache (server re-checks every 5s max). */
  lastGateOkAt: number;
}

const MAX_SESSIONS = 16;
const FRAME_TTL_MS = 60_000; // entry dropped after 60s without a new frame
const MAX_FRAME_BYTES = 1024 * 1024; // 1 MB per frame

const entries = new Map<string, RelayEntry>();

function sweep(now: number): void {
  if (entries.size < MAX_SESSIONS * 2) return;
  for (const [id, e] of entries) {
    if (now - e.at > FRAME_TTL_MS) entries.delete(id);
  }
}

export function setLatestFrame(sessionId: string, frame: Buffer, now = Date.now()): void {
  sweep(now);
  if (entries.size >= MAX_SESSIONS && !entries.has(sessionId)) {
    // Evict the stalest session to stay bounded.
    let oldest: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [id, e] of entries) {
      if (e.at < oldestAt) {
        oldestAt = e.at;
        oldest = id;
      }
    }
    if (oldest) entries.delete(oldest);
  }
  const existing = entries.get(sessionId);
  entries.set(sessionId, { frame, at: now, lastGateOkAt: existing?.lastGateOkAt ?? 0 });
}

export function getLatestFrame(sessionId: string, now = Date.now()): Buffer | null {
  const e = entries.get(sessionId);
  if (!e) return null;
  if (now - e.at > FRAME_TTL_MS) {
    entries.delete(sessionId);
    return null;
  }
  return e.frame;
}

/** Frame freshness timestamp (null when absent/expired). */
export function frameFreshness(sessionId: string, now = Date.now()): number | null {
  const e = entries.get(sessionId);
  if (!e) return null;
  if (now - e.at > FRAME_TTL_MS) {
    entries.delete(sessionId);
    return null;
  }
  return e.at;
}

/**
 * Consent/config re-validation gate. Returns true when the server has
 * re-verified consent+config within the last `intervalMs` for this session.
 * Every call beyond the interval triggers a re-check (handled by the caller);
 * this bounds DB lookups to ~1 per interval per session.
 */
export function gateDue(sessionId: string, now = Date.now(), intervalMs = 5_000): boolean {
  const e = entries.get(sessionId);
  if (!e) return true;
  return now - e.lastGateOkAt > intervalMs;
}

export function markGateOk(sessionId: string, now = Date.now()): void {
  const e = entries.get(sessionId);
  if (e) entries.set(sessionId, { ...e, lastGateOkAt: now });
}

/** Drop the session's frames when the session ends or expires. */
export function clearSession(sessionId: string): void {
  entries.delete(sessionId);
}

export function relaySessionCount(): number {
  return entries.size;
}

export const __MAX_FRAME_BYTES = MAX_FRAME_BYTES;
export const __FRAME_TTL_MS = FRAME_TTL_MS;

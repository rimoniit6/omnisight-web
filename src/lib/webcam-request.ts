// Webcam start-request timing contract (pure, unit-testable).
//
// The Admin webcam panel is operator-driven: clicking Start enqueues a
// webcam.start device command, then waits for the agent to open the camera
// (the agent polls commands every 10s). The wait must be BOUNDED — if the
// agent never opens the camera (command expired server-side, agent went
// offline mid-flight, camera error), the panel must surface an explicit error
// instead of staying on REQUESTING forever.
//
// The server expires commands after 120s (default in /api/device-commands).
// This module owns that bound so the UI and the server can never disagree.

export const REQUEST_TIMEOUT_MS = 150_000; // 120s command expiry + 30s grace

/**
 * Has the webcam start request exceeded its bound without a session?
 *
 * Returns true only while the request is still pending (no session appeared)
 * and the deadline has passed. Once a session exists the request is
 * considered fulfilled regardless of elapsed time.
 */
export function webcamRequestExpired(
  requestedAtMs: number,
  sessionAppeared: boolean,
  now: number = Date.now()
): boolean {
  if (sessionAppeared) return false;
  if (!Number.isFinite(requestedAtMs) || requestedAtMs <= 0) return false;
  return now - requestedAtMs > REQUEST_TIMEOUT_MS;
}

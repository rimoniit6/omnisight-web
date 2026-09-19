// Graceful shutdown primitive shared by the Next.js instrumentation scheduler
// (long-lived server process) and the `npm run jobs` CLI wrapper.
//
// Design:
//   - A process-global "draining" flag plus a registry of drainables (timers,
//     loops). On SIGTERM/SIGINT the process stops accepting NEW work: interval
//     ticks consult isDraining() and return early, then registered drainables
//     are stopped/awaited with a bounded timeout, and finally a caller-provided
//     onDrainComplete hook (prisma disconnect) runs before an optional force
//     exit.
//   - Crash-safe by construction: the job scheduler already runs every unit of
//     work under a JobRun lease with a 5-minute expiry, so a hard kill between
//     drain steps can never double-execute a job. Draining is best-effort
//     polish on top of that guarantee, not a correctness requirement.
//
// Edge-safe: this module has NO Node-only imports, so instrumentation.ts can
// import it without breaking the Edge runtime compile.
export interface Drainable {
  name: string;
  stop: () => void | Promise<void>;
}

const drainables = new Map<string, Drainable>();

// Mirror of `NodeJS.Signals` avoided here to stay Edge-safe.
export type ShutdownSignal = 'SIGTERM' | 'SIGINT';

let draining = false;

/** True once a shutdown signal arrived — loops must stop starting new work. */
export function isDraining(): boolean {
  return draining;
}

export function registerDrainable(drainable: Drainable): void {
  drainables.set(drainable.name, drainable);
}

export function deregisterDrainable(name: string): void {
  drainables.delete(name);
}

/**
 * Flip the draining flag and await every registered drainable's stop() under
 * a per-drainable timeout. Never throws. Returns per-drainable results.
 * Idempotent: subsequent calls return [] while already draining.
 */
export async function beginDrain(
  perDrainableTimeoutMs = 5000
): Promise<Array<{ name: string; ok: boolean }>> {
  if (draining) return [];
  draining = true;

  const results: Array<{ name: string; ok: boolean }> = [];
  for (const drainable of drainables.values()) {
    try {
      await Promise.race([
        Promise.resolve(drainable.stop()),
        new Promise<void>((resolve) => setTimeout(resolve, perDrainableTimeoutMs)),
      ]);
      results.push({ name: drainable.name, ok: true });
    } catch {
      results.push({ name: drainable.name, ok: false });
    }
  }
  return results;
}

let handlersInstalled = false;

export interface ShutdownHandlerOptions {
  /** Called after beginDrain() completes (e.g. prisma $disconnect). */
  onDrainComplete?: (results: Array<{ name: string; ok: boolean }>) => Promise<void> | void;
  /**
   * Force an orderly process exit this many ms after a signal, even if a
   * drainable is stuck. undefined disables the automatic exit. Default 8000.
   */
  exitAfterDrainMs?: number;
  /** Which signals to listen for. Defaults to SIGTERM + SIGINT. */
  signals?: ShutdownSignal[];
}

/**
 * Install idempotent SIGTERM/SIGINT handlers that drain then (optionally) exit.
 * Each signal is handled at most once; a second signal resumes default
 * behavior (immediate termination), which doubles as a force-kill escape hatch
 * for the operator.
 */
export function installShutdownHandlers(options: ShutdownHandlerOptions = {}): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  const {
    onDrainComplete,
    exitAfterDrainMs = 8000,
    signals = ['SIGTERM', 'SIGINT'],
  } = options;

  const onSignal = async () => {
    try {
      const results = await beginDrain();
      await onDrainComplete?.(results);
    } catch {
      // Drain must never crash the shutdown path.
    }
    if (exitAfterDrainMs !== undefined) {
      setTimeout(() => process.exit(0), exitAfterDrainMs).unref();
    }
  };

  for (const signal of signals) {
    process.once(signal, onSignal);
  }
}
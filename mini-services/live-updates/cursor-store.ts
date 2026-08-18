// OmniSight — live-updates mini-service: durable poll cursor storage.
//
// The poll cursor used to be an in-memory Date reset to `now` on every
// restart, silently dropping every event committed while the service was
// down. It is now persisted to SystemSetting (the global key-value table,
// already present in the schema — no migration needed) and restored on
// startup, mirroring the ProjectTimeSyncCursor pattern used by the project
// time-sync engine.
//
// Semantics are at-least-once:
//   - persistCursor runs AFTER a round's broadcasts; a crash in between only
//     ever replays those events on restart (clients dedupe by id and
//     reconcile from the API on reconnect);
//   - a crash before broadcasting never advances the cursor — nothing is lost;
//   - a failed round (DB outage) never persists — the old cursor is retried.
//
// This module is deliberately free of socket/server code so it can be
// unit-tested from the repo root with a throwaway database.

export const CURSOR_SETTING_KEY = 'live_updates.poll_cursor';

/** Minimal Prisma surface this module needs (injectable for tests). */
export interface CursorStore {
  systemSetting: {
    findUnique(args: { where: { key: string } }): Promise<{ value: string } | null>;
    upsert(args: {
      where: { key: string };
      create: { key: string; value: string };
      update: { value: string };
    }): Promise<unknown>;
  };
}

/**
 * Restore the persisted cursor. Falls back to `fallback()` (normally `now`)
 * when the row is missing or its value is not a valid ISO timestamp. Never
 * throws — a storage failure must not prevent the service from starting.
 */
export async function loadPersistedCursor(
  store: CursorStore,
  fallback: () => Date = () => new Date()
): Promise<Date> {
  try {
    const row = await store.systemSetting.findUnique({ where: { key: CURSOR_SETTING_KEY } });
    if (row) {
      const t = new Date(row.value);
      if (!isNaN(t.getTime())) return t;
    }
  } catch {
    /* fall through to the fallback */
  }
  return fallback();
}

/**
 * Persist the cursor after a successful poll round. Throws on failure so the
 * caller can log — the round itself has already been broadcast.
 */
export async function persistCursor(store: CursorStore, d: Date): Promise<void> {
  const value = d.toISOString();
  await store.systemSetting.upsert({
    where: { key: CURSOR_SETTING_KEY },
    create: { key: CURSOR_SETTING_KEY, value },
    update: { value },
  });
}

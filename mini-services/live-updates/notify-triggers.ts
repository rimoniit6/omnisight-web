// OmniSight — realtime wake-up triggers (R2: eliminate the 5s poll latency).
//
// The live-updates service polls PostgreSQL every 5 seconds. To deliver
// ingestion→Live-Monitor events in well under a second, every INSERT/UPDATE on
// the tables the poller broadcasts from fires `pg_notify('omnisight_events',
// <table>)`. The service LISTENs on that channel and wakes the poller
// immediately (debounced 250 ms) — the notify is a *wake signal only*; the
// poller still reads the database (source of truth) and broadcasts through the
// existing org-scoped, row-derived path, so authorization, ordering, dedupe
// and the durable cursor are completely unchanged.
//
// These triggers are created BOTH by the production migration
// (prisma/migrations/…_realtime_wakeup) AND idempotently at service boot
// (ensureNotifyTriggers) so the service is self-sufficient on any database
// state; a second boot or a migrated DB converges on the same DDL.
import type { PrismaClient } from '@prisma/client';

export const NOTIFY_CHANNEL = 'omnisight_events';

// Every table the poller broadcasts from (see pollOnce in index.ts). A change
// in any of them must wake the poller immediately. Waking for a table the
// poller skips is harmless (one extra poll round) — this list intentionally
// errs on the inclusive side.
export const BROADCAST_TABLES = [
  'Device',
  'Activity',
  'Notification',
  'Screenshot',
  'UsbEvent',
  'TimeEntry',
  'DeviceClaim',
  'Anomaly',
  'AppListEntry',
  'PolicyViolation',
  'Alert',
  'Guest',
  'LocationEvent',
] as const;

const TRIGGER_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION omnisight_notify_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('omnisight_events', TG_TABLE_NAME);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
`;

export function triggerNameFor(table: string): string {
  return `omnisight_notify_${table.toLowerCase()}`;
}

/**
 * Idempotently (re)create the wake-up triggers. Safe to call on every boot:
 * CREATE OR REPLACE FUNCTION + DROP/CREATE TRIGGER converge on the same DDL.
 */
export async function ensureNotifyTriggers(db: PrismaClient): Promise<string[]> {
  await db.$executeRawUnsafe(TRIGGER_FUNCTION_SQL);
  const created: string[] = [];
  for (const table of BROADCAST_TABLES) {
    const trigger = triggerNameFor(table);
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger}" ON "${table}"`);
    await db.$executeRawUnsafe(
      `CREATE TRIGGER "${trigger}" AFTER INSERT OR UPDATE ON "${table}" FOR EACH ROW EXECUTE FUNCTION omnisight_notify_event()`
    );
    created.push(trigger);
  }
  return created;
}

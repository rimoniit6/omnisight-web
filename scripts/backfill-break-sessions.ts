#!/usr/bin/env npx tsx
/**
 * One-time, IDEMPOTENT backfill: migrate LEGITIMATE historical break events
 * (paired "Break Mode Started/Ended [by Admin]" Activity rows) into the
 * canonical BreakSession table introduced by the production-hardening pass.
 *
 * Rules (no fabrication):
 *   - Only real Activity rows whose title is a known break START/END title
 *     are considered.
 *   - Per employee, events are paired chronologically: a Started opens a
 *     pending session; the next Ended closes it. A trailing Started with no
 *     Ended becomes an OPEN session (the employee was on break at migration
 *     time — matching what Break Monitor displayed).
 *   - Unpaired Ended rows (no preceding Started) are skipped (legacy noise).
 *   - Employees that ALREADY have any BreakSession row are skipped entirely
 *     (idempotent re-runs are no-ops).
 *   - source is derived from the title: "... by Admin" → 'admin', otherwise
 *     'agent' (legacy agent rows used the plain titles).
 *
 * The legacy Activity mirror rows are KEPT (they remain the event stream for
 * realtime/reports).
 *
 * Usage:  npx tsx scripts/backfill-break-sessions.ts
 *         DATABASE_URL=... npx tsx scripts/backfill-break-sessions.ts
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

const START_TITLES = new Set([
  'Break Mode Started',
  'Break Mode Started by Admin',
  'Break Mode Started by Employee',
]);
const END_TITLES = new Set([
  'Break Mode Ended',
  'Break Mode Ended by Admin',
  'Break Mode Ended by Employee',
]);

async function main(): Promise<void> {
  const employees = await db.employee.findMany({
    where: { breakSessions: { none: {} } }, // skip already-migrated employees
    select: { id: true, organizationId: true },
  });
  console.log(`[backfill] ${employees.length} employees have no BreakSession yet`);

  let created = 0;
  let openCreated = 0;
  let skippedUnpaired = 0;

  for (const emp of employees) {
    const events = await db.activity.findMany({
      where: {
        employeeId: emp.id,
        title: { in: [...START_TITLES, ...END_TITLES] },
      },
      orderBy: { timestamp: 'asc' },
      select: { title: true, timestamp: true, deviceId: true },
    });
    if (events.length === 0) continue;

    // Pair events chronologically.
    const sessions: Array<{
      startedAt: Date;
      endedAt: Date | null;
      deviceId: string | null;
      source: string;
    }> = [];
    let open: (typeof events)[number] | null = null;

    for (const ev of events) {
      if (START_TITLES.has(ev.title ?? '')) {
        if (open) {
          // Consecutive Started — close the previous as superseded (legacy
          // duplicate-start behavior, now impossible by design).
          sessions.push({
            startedAt: open.timestamp,
            endedAt: ev.timestamp,
            deviceId: open.deviceId,
            source: (open.title ?? '').includes('by Admin') ? 'admin' : 'agent',
          });
        }
        open = ev;
      } else if (END_TITLES.has(ev.title ?? '')) {
        if (open) {
          sessions.push({
            startedAt: open.timestamp,
            endedAt: ev.timestamp,
            deviceId: open.deviceId,
            source: (open.title ?? '').includes('by Admin') ? 'admin' : 'agent',
          });
          open = null;
        } else {
          skippedUnpaired += 1;
        }
      }
    }
    if (open) {
      sessions.push({
        startedAt: open.timestamp,
        endedAt: null,
        deviceId: open.deviceId,
        source: (open.title ?? '').includes('by Admin') ? 'admin' : 'agent',
      });
      openCreated += 1;
    }

    for (const s of sessions) {
      await db.breakSession.create({
        data: {
          organizationId: emp.organizationId,
          employeeId: emp.id,
          deviceId: s.deviceId,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          endReason: s.endedAt ? 'agent_ended' : null,
          source: s.source,
          startedBy: s.source === 'admin' ? 'legacy-backfill' : null,
          endedBy: s.source === 'admin' ? 'legacy-backfill' : null,
        },
      });
      created += 1;
    }
  }

  console.log(
    `[backfill] created ${created} BreakSession rows (${openCreated} still open), skipped ${skippedUnpaired} unpaired Ended events`
  );
  await db.$disconnect();
}

main().catch(async (err) => {
  console.error('[backfill] failed:', err);
  await db.$disconnect();
  process.exit(1);
});

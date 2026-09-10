// OmniSight — safe reconciliation/backfill of stale migration counters.
//
// WHY: the PRE-fix engine under-counted `recordsDone` (it only summed rows
// INSERTED by the current run; an idempotent resume over tables that were
// already complete returned 0 for them). A migration could therefore persist
// `ready_to_activate` together with `recordsDone < recordsTotal` — e.g. the
// live 1,481 / 1,491 row. The fix reconciles done to the verified destination
// set on every successful run; THIS module backfills rows that were written
// before the fix, and self-heals the derived state WITHOUT bypassing any guard.
//
// Guarantees:
//   • Only `ready_to_activate` DATABASE rows are eligible. queued/migrating/
//     verifying/failed/cancelled are rejected (409); `activated` is rejected —
//     a completed infrastructure switch is NEVER unwound by this mechanism.
//   • Already-consistent rows (`recordsDone === recordsTotal`) short-circuit as
//     a cheap no-op — no destination connection, no writes.
//   • present = ACTUAL org rows in the destination across every MIGRATION_TABLES
//     table — the SAME countSource/countDestinationRows criteria the engine's
//     verification uses. This is the real verification criterion, not a guess.
//   • done = min(recordsTotal, present). `recordsTotal` (the migration's own
//     snapshot denominator) is NEVER rewritten — the denominator always comes
//     from the run's snapshot (no hardcoding, no fabricated percentages).
//   • done === recordsTotal ⟹ verified complete: recordsDone/verifiedCount are
//     CORRECTED to the truthful value; status stays ready_to_activate (100%).
//   • done < recordsTotal ⟹ genuinely incomplete: status is REVOKED to failed
//     (errorStage 'verify') so the normal Retry Transfer flow re-copies with the
//     fixed engine. Activation remains fail-closed (ready → activated only).

import { db } from '@/lib/db';
import { decryptSecret } from '@/lib/crypto';
import { log } from '@/lib/logger';
import { buildDestinationDbClient, countDestinationRows, userSafeError } from './db-migrate';
import { MIGRATION_TABLES } from './plan';

export type ReconcileResult =
  | { ok: true; reconciled: boolean; status: string; recordsDone: number; recordsTotal: number }
  | { ok: false; status: number; error: string };

// In-process dedupe so concurrent status polls / admin actions don't fire the
// same heavy 38-table count simultaneously. Idempotent regardless (identical
// writes), this just avoids duplicate work.
const inFlight = new Set<string>();

async function audit(organizationId: string, action: string, resourceId: string, description: string): Promise<void> {
  await db.auditLog.create({
    data: { action, resource: 'infrastructure-migration', resourceId, description, organizationId },
  });
}

export async function reconcileMigrationCounters(migrationId: string): Promise<ReconcileResult> {
  const migration = await db.infrastructureMigration.findUnique({ where: { id: migrationId }, include: { request: true } });
  if (!migration) return { ok: false, status: 404, error: 'Migration not found' };

  // Fast path: trusteeship already consistent — no connection, no writes.
  if (migration.status === 'ready_to_activate' && migration.recordsDone === migration.recordsTotal) {
    return { ok: true, reconciled: false, status: 'ready_to_activate', recordsDone: migration.recordsDone, recordsTotal: migration.recordsTotal };
  }

  if (migration.status !== 'ready_to_activate') {
    return { ok: false, status: 409, error: `Only ready_to_activate migrations can be reconciled (current status: '${migration.status}').` };
  }
  if (migration.kind !== 'DATABASE') {
    return { ok: false, status: 409, error: 'Progress reconciliation applies to database migrations only.' };
  }

  if (inFlight.has(migrationId)) {
    return { ok: false, status: 409, error: 'Reconciliation is already running for this migration.' };
  }
  inFlight.add(migrationId);

  const request = migration.request;
  const spec = JSON.parse(request.configJson) as Record<string, unknown>;
  const password = request.dbPasswordEncrypted ? decryptSecret(request.dbPasswordEncrypted) : undefined;
  const destination = buildDestinationDbClient({
    host: String(spec.host ?? ''),
    port: typeof spec.port === 'number' ? spec.port : null,
    name: String(spec.name ?? ''),
    user: String(spec.user ?? ''),
    ssl: Boolean(spec.ssl),
    ...(password ? { password } : {}),
  });

  try {
    // Present = the org's ACTUAL verified rows in the destination right now.
    let present = 0;
    for (const t of MIGRATION_TABLES) {
      present += await countDestinationRows(destination, t.table, migration.organizationId);
    }
    const done = Math.min(migration.recordsTotal, present);
    const missing = migration.recordsTotal - done;

    if (missing <= 0) {
      // Genuinely complete: correct the counters to the truthful value and
      // keep ready_to_activate. 100% derives from real destination counts.
      await db.infrastructureMigration.update({
        where: { id: migration.id },
        data: { recordsDone: done, verifiedCount: done },
      });
      await audit(
        migration.organizationId,
        'migration_counters_reconciled',
        migration.id,
        `Progress counters reconciled against verified destination rows: ${done}/${migration.recordsTotal} — exactly the migration snapshot, ready to activate.`
      );
      log.info('migration.counters_reconciled', { migrationId, done, total: migration.recordsTotal });
      return { ok: true, reconciled: true, status: 'ready_to_activate', recordsDone: done, recordsTotal: migration.recordsTotal };
    }

    // Genuinely short: the ready claim is no longer provable — revoke it so the
    // normal Retry Transfer flow (failed → queued) re-copies with the fixed
    // engine. This REVERSES ready_to_activate using real counts; it is the
    // opposite of a blind status flip (activation stays untouched).
    await db.infrastructureMigration.update({
      where: { id: migration.id },
      data: {
        status: 'failed',
        errorStage: 'verify',
        recordsDone: done,
        finishedAt: new Date(),
        errorMessage: `Verification reconciliation: the destination holds ${done} of ${migration.recordsTotal} expected rows — ${missing} are missing, so the ready state was revoked. Your current infrastructure remains active. Retry the transfer to re-copy.`,
      },
    });
    await audit(
      migration.organizationId,
      'migration_state_revoked',
      migration.id,
      `Ready state revoked by reconciliation: destination holds ${done} of ${migration.recordsTotal} expected rows (${missing} missing). Migration is now failed and can be retried.`
    );
    log.warn('migration.state_revoked', { migrationId, done, total: migration.recordsTotal, missing });
    return { ok: true, reconciled: true, status: 'failed', recordsDone: done, recordsTotal: migration.recordsTotal };
  } catch (err) {
    log.error('migration.reconcile_failed', { migrationId, error: userSafeError(err) });
    return { ok: false, status: 502, error: `Progress reconciliation failed — the destination could not be verified. ${userSafeError(err)}` };
  } finally {
    inFlight.delete(migrationId);
    try { await destination.$disconnect(); } catch { /* ignore */ }
  }
}
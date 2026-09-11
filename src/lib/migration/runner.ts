// OmniSight — infrastructure data-migration state machine + background runner.
//
// States: queued → migrating → verifying → ready_to_activate → activated
//         queued → cancelled (request rejected/cancelled before start)
//         migrating|verifying → failed (retryable; active settings untouched)
//
// Concurrency: a single row per request (@@unique requestId). The claim is an
// atomic updateMany (queued|failed-with-lease-expired → migrating), so two
// workers can never run the same migration; a stale MIGRATING row (>15 min
// without progress) is requeued by the sweep — the copy itself is idempotent,
// so resume is safe. Activation is a separate, explicit Super Admin action and
// FAILS CLOSED unless the migration reached ready_to_activate.

import { db } from '@/lib/db';
import { decryptSecret } from '@/lib/crypto';
import { log } from '@/lib/logger';
import { applyDatabaseSwitch, applyStorageSwitch, revertDatabaseSwitch, revertStorageSwitch } from '@/lib/infra-connect';
import { getPrismaForOrg } from '@/lib/org-db';
import { getOrgStorage } from '@/lib/org-storage';
import { storage as platformStorage } from '@/lib/storage';
import { runDatabaseMigration, drainDatabaseCutover, verifyCutoverDestination, buildDestinationDbClient, userSafeError } from './db-migrate';
import type { TableProgressMap } from './plan';
import { runStorageMigration, drainStorageCutover } from './storage-migrate';

const STALE_MIGRATING_MS = 15 * 60 * 1000;

// An activation (cutover) is a bounded drain + verify. If it cannot settle the
// platform source after this many full passes, it FAILS and rolls the switch
// back instead of hanging forever.
const CUTOVER_MAX_DRAIN_PASSES = 50;
// After a verified snapshot copy, re-run the engine up to this many times to
// fold in rows that kept arriving DURING the transfer, before ready_to_activate.
// A `zeroDrift` pass (destination === source at the verification instant) stops
// the loop early. Live orgs converge across these bounded passes; the
// deterministic guarantee for anything still in flight lives in the cutover
// drain at activation, not here.
const MAX_RECONCILE_PASSES = 5;

export const MIGRATION_STATUSES = ['queued', 'migrating', 'reconciling', 'verifying', 'ready_to_activate', 'cutover', 'activated', 'failed', 'cancelled'] as const;
export type MigrationStatus = (typeof MIGRATION_STATUSES)[number];

/** Server-side transition table — invalid transitions are rejected, never coerced. */
export const MIGRATION_TRANSITIONS: Record<MigrationStatus, MigrationStatus[]> = {
  queued: ['migrating', 'cancelled'],
  migrating: ['reconciling', 'verifying', 'failed', 'queued'],
  // Reconciliation: initial copy is done; the engine is re-running to fold in
  // rows that arrived during the transfer. A zero-drift pass skips directly
  // to verifying.
  reconciling: ['verifying', 'failed', 'queued'],
  verifying: ['ready_to_activate', 'failed'],
  // ready → cutover begins the deterministic cutover (routing flip + drain).
  // A stranded 'cutover' row (worker died between flip and finalize) is
  // RESUMED by resumeStrandedCutovers / a re-invoked activation; it only
  // resolves to activated (verified) or failed (rolled back).
  ready_to_activate: ['activated', 'cutover'],
  cutover: ['activated', 'failed'],
  activated: [],
  failed: ['queued'],
  cancelled: [],
};

export function canTransitionMigration(from: string, to: MigrationStatus): boolean {
  return (MIGRATION_TRANSITIONS[from as MigrationStatus] ?? []).includes(to);
}

/**
 * A migration is only "verified complete" when its done counter reaches the
 * snapshot total. ready_to_activate MUST NOT coexist with done < total — the
 * copy/verification engine reconciles done to the verified destination set on
 * success, but every writer of the ready state also enforces this invariant
 * (defence-in-depth). No fabricated percentages: total is the run's own
 * snapshot; done must genuinely reach it.
 */
export function isVerifiedComplete(done: number, total: number): boolean {
  return total > 0 && done >= total;
}

async function audit(organizationId: string, action: string, resourceId: string, description: string): Promise<void> {
  await db.auditLog.create({
    data: { action, resource: 'infrastructure-migration', resourceId, description, organizationId },
  });
}

/** Create (or idempotently re-get) the QUEUED migration for an approved request. */
export async function queueMigrationForRequest(requestId: string): Promise<{ id: string; created: boolean }> {
  const request = await db.infrastructureChangeRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new Error('Change request not found');

  const existing = await db.infrastructureMigration.findUnique({ where: { requestId } });
  if (existing) {
    // Idempotent: an approval retry must not spawn a second migration.
    if (existing.status === 'cancelled') {
      const revived = await db.infrastructureMigration.update({ where: { id: existing.id }, data: { status: 'queued', errorStage: null, errorMessage: null, finishedAt: null } });
      await audit(request.organizationId, 'migration_queued', revived.id, `Migration re-queued for request #${request.requestNo} (${request.kind}) after approval retry`);
      return { id: revived.id, created: false };
    }
    return { id: existing.id, created: false };
  }

  let row: { id: string };
  let createdMine = false;
  try {
    row = await db.infrastructureMigration.create({
      data: { requestId, organizationId: request.organizationId, kind: request.kind, status: 'queued' },
    });
    createdMine = true;
  } catch (err) {
    // Two rapid starts (org-side "Transfer Data" + the approval that queued it)
    // can BOTH pass the findUnique above; the second create then trips the
    // requestId unique constraint. Recover the winner's row instead of turning
    // a normal double-click into a 500 ("Failed to start the data transfer").
    if ((err as { code?: string }).code !== 'P2002') throw err;
    const recovered = await db.infrastructureMigration.findUnique({ where: { requestId } });
    if (!recovered) throw err;
    row = recovered;
  }

  if (createdMine) {
    await audit(request.organizationId, 'migration_queued', row.id, `Data migration queued for request #${request.requestNo} (${request.kind})`);
  }
  return { id: row.id, created: createdMine };
}

/** Cancel a QUEUED (not yet started) migration — used by reject/cancel flows. */
export async function cancelQueuedMigration(requestId: string, reason: string): Promise<boolean> {
  const updated = await db.infrastructureMigration.updateMany({
    where: { requestId, status: 'queued' },
    data: { status: 'cancelled', errorMessage: reason.slice(0, 300), finishedAt: new Date() },
  });
  if (updated.count > 0) {
    const m = await db.infrastructureMigration.findUnique({ where: { requestId } });
    if (m) await audit(m.organizationId, 'migration_cancelled', m.id, `Queued migration cancelled before start: ${reason.slice(0, 200)}`);
  }
  return updated.count > 0;
}

/** True when the request's migration is actively running (unsafe to cancel). */
export async function isMigrationRunning(requestId: string): Promise<boolean> {
  const m = await db.infrastructureMigration.findUnique({ where: { requestId }, select: { status: true } });
  return m?.status === 'migrating' || m?.status === 'reconciling' || m?.status === 'verifying' || m?.status === 'cutover';
}

/**
 * Super Admin activates the migrated infrastructure via a DETERMINISTIC CUTOVER.
 *
 * Phases (per kind):
 *   1. BOUNDARY — one transaction records `cutoverAt` (server clock) and flips
 *      the org's runtime routing (applyDatabaseSwitch / applyStorageSwitch) to
 *      the destination. Atomically: a failure leaves the migration ready and
 *      the org untouched.
 *   2. DRAIN — after the flip the platform source stops accumulating org rows.
 *      Repeat per-table upsert sweeps until a full pass changes nothing, so
 *      every org-owned row/object created during the transfer is captured.
 *   3. VERIFY — destination ⊇ source for every org table (+ cross-tenant probe).
 *   4. FINALIZE — one transaction marks migration `activated` / request `active`.
 *
 * Any failure in 2–4 ROLLS THE SWITCH BACK (revertDatabaseSwitch /
 * revertStorageSwitch keeps the org's chosen config for retry) and revokes the
 * migration to `failed` (errorStage 'cutover') — the org never silently loses
 * its platform infrastructure, and never keeps half-routed writes.
 *
 * A stranded `cutover` row (worker died between the boundary and finalize) is
 * RESUMED here (boundary already recorded) or by resumeStrandedCutovers.
 */
export async function activateMigration(migrationId: string, actor: { id: string; email: string }): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const migration = await db.infrastructureMigration.findUnique({ where: { id: migrationId }, include: { request: true } });
  if (!migration) return { ok: false, status: 404, error: 'Migration not found' };

  const resuming = migration.status === 'cutover';
  if (!resuming && !canTransitionMigration(migration.status, 'cutover')) {
    return { ok: false, status: 409, error: `Migration is '${migration.status}' and cannot be activated` };
  }

  const request = migration.request;
  if (!['approved', 'active'].includes(request.status)) {
    return { ok: false, status: 409, error: `Change request is '${request.status}' and cannot be activated` };
  }

  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(request.configJson) as Record<string, unknown>;
  } catch {
    return { ok: false, status: 422, error: 'The change request snapshot is malformed' };
  }

  const result =
    request.kind === 'DATABASE'
      ? await executeDatabaseCutover(migration, request, spec, actor)
      : await executeStorageCutover(migration, request, spec, actor);

  if (!result.ok) {
    return { ok: false, status: 502, error: result.error };
  }
  return { ok: true };
}

/** Heartbeat so a long drain cannot be mistaken for a dead worker mid-run. */
async function touchMigration(id: string): Promise<void> {
  await db.infrastructureMigration.update({ where: { id }, data: {} }).catch(() => {});
}

async function rollbackCutover(
  id: string,
  orgId: string,
  requestId: string,
  kind: 'DATABASE' | 'STORAGE',
  reason: string,
  actor: { id: string; email: string }
): Promise<void> {
  await db.$transaction(async (tx) => {
    if (kind === 'DATABASE') {
      await revertDatabaseSwitch(tx, orgId);
    } else {
      await revertStorageSwitch(tx, orgId);
    }
    await tx.infrastructureMigration.update({
      where: { id },
      data: { status: 'failed', errorStage: 'cutover', errorMessage: reason.slice(0, 500), finishedAt: new Date() },
    });
    await tx.infrastructureChangeRequest.update({
      where: { id: requestId },
      data: { status: 'approved', errorMessage: `Cutover rolled back: ${reason.slice(0, 300)}` },
    });
    await tx.auditLog.create({
      data: {
        action: 'infrastructure_cutover_rolled_back',
        resource: 'infrastructure-migration',
        resourceId: id,
        description: `${actor.email} — the ${kind} cutover failed and the switch was rolled back: ${reason.slice(0, 240)}`,
        userId: actor.id,
        organizationId: orgId,
      },
    });
  });
}

async function executeDatabaseCutover(
  migration: { id: string; organizationId: string; status: string; kind: string },
  request: { id: string; requestNo: number; configJson: string; dbPasswordEncrypted: string | null },
  spec: Record<string, unknown>,
  actor: { id: string; email: string }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const orgId = migration.organizationId;
  const dbSpec = {
    host: String(spec.host ?? ''),
    port: typeof spec.port === 'number' ? spec.port : null,
    name: String(spec.name ?? ''),
    user: String(spec.user ?? ''),
    ssl: Boolean(spec.ssl),
    useOwnDb: spec.useOwnDb !== false,
    ...(request.dbPasswordEncrypted ? { password: decryptSecret(request.dbPasswordEncrypted) } : {}),
  };

  // 1 ─ BOUNDARY: record cutoverAt + flip runtime routing, atomically.
  if (migration.status !== 'cutover') {
    try {
      await db.$transaction(async (tx) => {
        await tx.infrastructureMigration.update({
          where: { id: migration.id },
          data: { status: 'cutover', cutoverAt: new Date(), activatedAt: null, errorStage: null, errorMessage: null },
        });
        await applyDatabaseSwitch(tx, orgId, dbSpec);
      });
    } catch (err) {
      log.error('migration.cutover.boundary_failed', { migrationId: migration.id, error: userSafeError(err) });
      return { ok: false, error: `The cutover boundary could not be set — the routing flip rolled back atomically and nothing changed. ${userSafeError(err)}` };
    }
    log.info('migration.cutover.boundary', { migrationId: migration.id, orgId });
  }

  const destination = buildDestinationDbClient(dbSpec);
  try {
    // 2 ─ DRAIN to fixpoint (captures every row that reached the source before
    // the boundary; post-boundary rows land directly in the destination).
    const drain = await drainDatabaseCutover(destination, orgId, CUTOVER_MAX_DRAIN_PASSES);
    if (!drain.ok) throw new Error(drain.errorMessage ?? 'Cutover drain failed');
    await touchMigration(migration.id);
    // 3 ─ VERIFY source ⊆ destination + cross-tenant isolation.
    const verify = await verifyCutoverDestination(destination, orgId);
    if (!verify.ok) throw new Error(verify.reason);

    // 4 ─ FINALIZE atomically.
    const now = new Date();
    await db.$transaction(async (tx) => {
      await tx.infrastructureMigration.update({
        where: { id: migration.id },
        data: { status: 'activated', activatedAt: now, finishedAt: now, errorStage: null, errorMessage: null },
      });
      await tx.infrastructureChangeRequest.update({
        where: { id: request.id },
        data: { status: 'active', appliedAt: now, migratedAt: now, activatedAt: now, errorMessage: null },
      });
      await tx.auditLog.create({
        data: {
          action: 'infrastructure_activated',
          resource: 'infrastructure-migration',
          resourceId: migration.id,
          description: `${actor.email} cut over the DATABASE infrastructure at the deterministic boundary (request #${request.requestNo}); in-flight rows were drained and verified`,
          userId: actor.id,
          organizationId: orgId,
        },
      });
    });
    log.info('migration.cutover.completed', { migrationId: migration.id, orgId, passes: drain.passes });
    return { ok: true };
  } catch (err) {
    const reason = userSafeError(err);
    log.error('migration.cutover.failed', { migrationId: migration.id, error: reason });
    try {
      await rollbackCutover(migration.id, orgId, request.id, 'DATABASE', reason, actor);
    } catch (rollbackErr) {
      log.error('migration.cutover.rollback_failed', { migrationId: migration.id, error: userSafeError(rollbackErr) });
      return { ok: false, error: `Cutover failed AND its rollback could not be persisted — the org may still be routed at the destination. Manual review required. ${reason}` };
    }
    return { ok: false, error: `Cutover failed — the switch was rolled back and the platform infrastructure remains active. ${reason}` };
  } finally {
    try { await destination.$disconnect(); } catch { /* ignore */ }
  }
}

async function executeStorageCutover(
  migration: { id: string; organizationId: string; status: string; kind: string },
  request: { id: string; requestNo: number; configJson: string; storageKeyEncrypted: string | null },
  spec: Record<string, unknown>,
  actor: { id: string; email: string }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const orgId = migration.organizationId;
  const key = request.storageKeyEncrypted ? decryptSecret(request.storageKeyEncrypted) : undefined;
  if (!key) return { ok: false, error: 'The approved storage key is missing from the request — cutover not started.' };
  const driverKind = spec.driver === 'supabase' ? 'supabase' : 'local';
  const destination = { url: String(spec.url ?? ''), key };

  // 1 ─ BOUNDARY: capture the PRE-flip source driver, then flip atomically.
  let source: import('@/lib/storage/types').StorageDriver;
  let refsClient: import('@prisma/client').PrismaClient;
  if (migration.status !== 'cutover') {
    const sourceRes = await getOrgStorage(orgId);
    source = sourceRes.mode === 'org' ? sourceRes.driver : platformStorage();
    try {
      await db.$transaction(async (tx) => {
        await tx.infrastructureMigration.update({
          where: { id: migration.id },
          data: { status: 'cutover', cutoverAt: new Date(), activatedAt: null, errorStage: null, errorMessage: null },
        });
        await applyStorageSwitch(tx, orgId, {
          driver: driverKind,
          url: driverKind === 'supabase' ? String(spec.url ?? '') : null,
          ...(driverKind === 'supabase' && key ? { key } : {}),
        });
      });
    } catch (err) {
      log.error('migration.storage.cutover.boundary_failed', { migrationId: migration.id, error: userSafeError(err) });
      return { ok: false, error: `The storage cutover boundary could not be set — the routing flip rolled back atomically and nothing changed. ${userSafeError(err)}` };
    }
    const orgDb = await getPrismaForOrg(orgId);
    refsClient = orgDb.client;
    log.info('migration.storage.cutover.boundary', { migrationId: migration.id, orgId });
  } else {
    // Stranded resume: the pre-flip dedicated driver is gone from the process,
    // but for the standard platform→supabase case the platform pool IS the
    // reconstructible pre-boundary source. Reference rows come from the org's
    // CURRENT (already-flipped) data DB.
    source = platformStorage();
    const orgDb = await getPrismaForOrg(orgId);
    refsClient = orgDb.client;
  }

  try {
    // 2/3 ─ DRAIN to fixpoint + VERIFY (objects referenced by the org's rows now).
    const drain = await drainStorageCutover(orgId, source, destination, refsClient, { maxPasses: CUTOVER_MAX_DRAIN_PASSES });
    if (!drain.ok) throw new Error(drain.errorMessage ?? 'Storage cutover drain failed');
    await touchMigration(migration.id);

    // 4 ─ FINALIZE atomically.
    const now = new Date();
    await db.$transaction(async (tx) => {
      await tx.infrastructureMigration.update({
        where: { id: migration.id },
        data: { status: 'activated', activatedAt: now, finishedAt: now, errorStage: null, errorMessage: null },
      });
      await tx.infrastructureChangeRequest.update({
        where: { id: request.id },
        data: { status: 'active', appliedAt: now, migratedAt: now, activatedAt: now, errorMessage: null },
      });
      await tx.auditLog.create({
        data: {
          action: 'infrastructure_activated',
          resource: 'infrastructure-migration',
          resourceId: migration.id,
          description: `${actor.email} cut over the STORAGE infrastructure at the deterministic boundary (request #${request.requestNo}); in-flight objects were drained and verified`,
          userId: actor.id,
          organizationId: orgId,
        },
      });
    });
    log.info('migration.storage.cutover.completed', { migrationId: migration.id, orgId, passes: drain.passes });
    return { ok: true };
  } catch (err) {
    const reason = userSafeError(err);
    log.error('migration.storage.cutover.failed', { migrationId: migration.id, error: reason });
    try {
      await rollbackCutover(migration.id, orgId, request.id, 'STORAGE', reason, actor);
    } catch (rollbackErr) {
      log.error('migration.storage.cutover.rollback_failed', { migrationId: migration.id, error: userSafeError(rollbackErr) });
      return { ok: false, error: `Storage cutover failed AND its rollback could not be persisted — the org may still be routed at the destination. Manual review required. ${reason}` };
    }
    return { ok: false, error: `Storage cutover failed — the switch was rolled back and the platform storage pool remains active. ${reason}` };
  }
}

/**
 * Crash recovery for stranded CUTOVER rows: an activation that died between the
 * boundary flip and finalize leaves the org routed at the destination with no
 * terminal status. The job loop resumes it — draining and finalizing on success,
 * or rolling the switch back and revoking to `failed` on failure.
 */
export async function resumeStrandedCutovers(): Promise<void> {
  const stranded = await db.infrastructureMigration.findMany({
    where: { status: 'cutover', updatedAt: { lt: new Date(Date.now() - STALE_MIGRATING_MS) } },
    orderBy: { updatedAt: 'asc' },
    take: 1,
  });
  if (stranded.length === 0) return;
  const m = stranded[0];
  const request = await db.infrastructureChangeRequest.findUnique({ where: { id: m.requestId } });
  if (!request || !['approved', 'active'].includes(request.status)) {
    await db.infrastructureMigration.updateMany({
      where: { id: m.id, status: 'cutover' },
      data: { status: 'failed', errorStage: 'cutover', errorMessage: 'Cutover stranded and its change request is no longer approved', finishedAt: new Date() },
    });
    return;
  }
  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(request.configJson) as Record<string, unknown>;
  } catch {
    await db.infrastructureMigration.updateMany({
      where: { id: m.id, status: 'cutover' },
      data: { status: 'failed', errorStage: 'cutover', errorMessage: 'Cutover stranded and the change request snapshot is malformed', finishedAt: new Date() },
    });
    return;
  }
  const actor = { id: 'system', email: 'system@scheduler' };
  const result =
    m.kind === 'DATABASE'
      ? await executeDatabaseCutover(m, request, spec, actor)
      : await executeStorageCutover(m, request, spec, actor);
  if (!result.ok) {
    log.warn('migration.cutover.resume_failed', { migrationId: m.id, error: result.error });
  }
}

/** SA retry: failed/cancelled-mid-run migrations return to the queue. */
export async function retryMigration(migrationId: string, actor: { id: string; email: string }): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const migration = await db.infrastructureMigration.findUnique({ where: { id: migrationId }, include: { request: true } });
  if (!migration) return { ok: false, status: 404, error: 'Migration not found' };
  if (!canTransitionMigration(migration.status, 'queued')) {
    return { ok: false, status: 409, error: `Migration is '${migration.status}' and cannot be retried` };
  }
  await db.infrastructureMigration.update({
    where: { id: migration.id },
    data: { status: 'queued', errorStage: null, errorMessage: null, finishedAt: null },
  });
  await audit(migration.organizationId, 'migration_retried', migration.id, `${actor.email} re-queued the failed migration for request #${migration.request.requestNo}`);
  return { ok: true };
}

interface ClaimedMigration {
  id: string;
  organizationId: string;
  kind: string;
  requestId: string;
  recordsDone: number;
  tableProgress: TableProgressMap | null;
}

/**
 * Claim the next QUEUED migration atomically (or requeue a stale MIGRATING
 * row whose progress heartbeat lapsed — crash recovery). One worker wins.
 */
async function claimNext(): Promise<ClaimedMigration | null> {
  // 1) Requeue stale in-flight rows (lease lapsed → previous worker died).
  const staleCutoff = new Date(Date.now() - STALE_MIGRATING_MS);
  const stale = await db.infrastructureMigration.findMany({
    where: { status: { in: ['migrating', 'reconciling', 'verifying'] }, updatedAt: { lt: staleCutoff } },
    select: { id: true },
    take: 1,
  });
  if (stale.length > 0) {
    await db.infrastructureMigration.updateMany({
      where: { id: stale[0].id, status: { in: ['migrating', 'reconciling', 'verifying'] }, updatedAt: { lt: staleCutoff } },
      data: { status: 'queued', errorStage: null, errorMessage: null },
    });
    log.warn('migration.stale_requeued', { migrationId: stale[0].id });
  }

  // 2) Atomic claim of one QUEUED migration.
  const candidates = await db.infrastructureMigration.findMany({
    where: { status: 'queued' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
    take: 1,
  });
  if (candidates.length === 0) return null;
  const claimed = await db.infrastructureMigration.updateMany({
    where: { id: candidates[0].id, status: 'queued' },
    data: { status: 'migrating', startedAt: new Date(), errorStage: null, errorMessage: null },
  });
  if (claimed.count === 0) return null; // another worker won

  const m = await db.infrastructureMigration.findUnique({
    where: { id: candidates[0].id },
    select: { id: true, organizationId: true, kind: true, requestId: true, recordsDone: true, tableProgress: true },
  });
  if (!m) return null;
  return {
    id: m.id,
    organizationId: m.organizationId,
    kind: m.kind,
    requestId: m.requestId,
    recordsDone: m.recordsDone,
    tableProgress: m.tableProgress ? (JSON.parse(m.tableProgress) as TableProgressMap) : null,
  };
}

/**
 * Process at most one due migration. Called by the instrumentation loop
 * (crash-safe: the idempotent copy + stale-lease requeue make restarts safe).
 */
export async function runDueMigrations(): Promise<{ ran: boolean; migrationId?: string; outcome?: string }> {
  const claimed = await claimNext();
  if (!claimed) return { ran: false };

  const { id, organizationId, kind, requestId } = claimed;
  const request = await db.infrastructureChangeRequest.findUnique({ where: { id: requestId } });
  if (!request || !['approved', 'active'].includes(request.status)) {
    // Request no longer approved (rejected/cancelled/superseded) — cancel quietly.
    // 'active' is allowed: the catch-up migration for an org already running on
    // its own infrastructure (switched before real migration existed) copies the
    // org's data to the destination the org is already using; activation of an
    // active request is a harmless idempotent re-apply by a Super Admin.
    await db.infrastructureMigration.updateMany({
      where: { id, status: 'migrating' },
      data: { status: 'cancelled', errorMessage: 'Change request is no longer approved', finishedAt: new Date() },
    });
    return { ran: true, migrationId: id, outcome: 'cancelled' };
  }

  await audit(organizationId, 'migration_started', id, `Data migration started for request #${request.requestNo} (${kind})`);

  const progressPatch = async (patch: {
    recordsDone?: number; recordsTotal?: number;
    objectsDone?: number; objectsTotal?: number;
    bytesDone?: number; bytesTotal?: number;
    currentTable?: string; tableProgress?: TableProgressMap | null;
  }): Promise<void> => {
    await db.infrastructureMigration.update({
      where: { id },
      data: {
        ...(patch.recordsDone !== undefined ? { recordsDone: patch.recordsDone } : {}),
        ...(patch.recordsTotal !== undefined ? { recordsTotal: patch.recordsTotal } : {}),
        ...(patch.objectsDone !== undefined ? { objectsDone: patch.objectsDone } : {}),
        ...(patch.objectsTotal !== undefined ? { objectsTotal: patch.objectsTotal } : {}),
        ...(patch.bytesDone !== undefined ? { bytesDone: BigInt(patch.bytesDone) } : {}),
        ...(patch.bytesTotal !== undefined ? { bytesTotal: BigInt(patch.bytesTotal) } : {}),
        ...(patch.currentTable !== undefined ? { currentTable: patch.currentTable } : {}),
        ...(patch.tableProgress !== undefined ? { tableProgress: patch.tableProgress ? JSON.stringify(patch.tableProgress) : null } : {}),
      },
    }).catch(() => { /* row may have been cancelled mid-run; copy continues safely */ });
  };

  try {
    if (kind === 'DATABASE') {
      const spec = JSON.parse(request.configJson) as Record<string, unknown>;
      const password = request.dbPasswordEncrypted ? decryptSecret(request.dbPasswordEncrypted) : undefined;
      const parsedProgress: TableProgressMap = {};
      const runPass = () => runDatabaseMigration(
        organizationId,
        {
          host: String(spec.host ?? ''),
          port: typeof spec.port === 'number' ? spec.port : null,
          name: String(spec.name ?? ''),
          user: String(spec.user ?? ''),
          ssl: Boolean(spec.ssl),
          ...(password ? { password } : {}),
        },
        async (patch) => {
          if (patch.table) Object.assign(parsedProgress, { [patch.table]: parsedProgress[patch.table] ?? { done: 0, total: 0 } });
          if (patch.snapshot) Object.assign(parsedProgress, patch.snapshot);
          await progressPatch({
            recordsDone: patch.done, recordsTotal: patch.total, currentTable: patch.table,
            tableProgress: Object.keys(parsedProgress).length > 0 ? parsedProgress : undefined,
          });
        }
      );
      // Final reconciliation: rows keep arriving while the transfer runs, so
      // re-run the (idempotent) copy until a pass verifies a ZERO-DRIFT
      // destination (destination === source for every table at the verification
      // instant) or we exhaust the bounded pass budget. Whatever is still in
      // flight after that is captured deterministically by the cutover drain —
      // ready_to_activate never claims a hole-free transfer, only a verified,
      // loss-free snapshot boundary.
      let outcome = await runPass();
      // If the initial copy did not achieve zeroDrift (new rows arrived during
      // the transfer), enter the RECONCILING phase: re-run the (idempotent)
      // copy engine until a zero-drift pass or the bounded budget is exhausted.
      // The UI distinguishes this from the initial transfer via the
      // 'reconciling' status.
      if (!outcome.zeroDrift && outcome.ok) {
        await db.infrastructureMigration.update({ where: { id }, data: { status: 'reconciling' } });
      }
      for (let pass = 0; pass < MAX_RECONCILE_PASSES && outcome.ok && !outcome.zeroDrift; pass++) {
        outcome = await runPass();
      }
      if (!outcome.ok) {
        await db.infrastructureMigration.update({
          where: { id },
          data: {
            status: 'failed', errorStage: outcome.errorStage ?? 'migrate', errorMessage: outcome.errorMessage,
            recordsDone: outcome.recordsDone, recordsTotal: outcome.recordsTotal,
            tableProgress: JSON.stringify(outcome.tableProgress), finishedAt: new Date(),
          },
        });
        await audit(organizationId, 'migration_failed', id, `Data migration FAILED (${outcome.errorStage}): ${outcome.errorMessage} — existing infrastructure remains active`);
        return { ran: true, migrationId: id, outcome: 'failed' };
      }
      // verifying → ready_to_activate (counts already verified inside the engine)
      // State-machine invariant: ready_to_activate REQUIRES done === total
      // (verified complete). The engine guarantees it on success, but every
      // writer enforces it anyway — a ready row with under-counted progress is
      // a broken state, not an acceptable one.
      if (!isVerifiedComplete(outcome.recordsDone, outcome.recordsTotal)) {
        await db.infrastructureMigration.update({
          where: { id },
          data: {
            status: 'failed', errorStage: 'verify',
            errorMessage: `Verification could not confirm full completion (${outcome.recordsDone}/${outcome.recordsTotal}) — the migration was not marked ready. ${outcome.errorMessage ?? ''}`.trim(),
            recordsDone: outcome.recordsDone, recordsTotal: outcome.recordsTotal,
            tableProgress: JSON.stringify(outcome.tableProgress), finishedAt: new Date(),
          },
        });
        await audit(organizationId, 'migration_failed', id, `Data migration FAILED (verify): verified ${outcome.recordsDone} of ${outcome.recordsTotal} records — ready state withheld. Existing infrastructure remains active`);
        log.error('migration.ready_invariant_blocked', { migrationId: id, done: outcome.recordsDone, total: outcome.recordsTotal });
        return { ran: true, migrationId: id, outcome: 'failed' };
      }
      await db.infrastructureMigration.update({
        where: { id },
        data: {
          status: 'ready_to_activate', verifiedCount: outcome.recordsDone, verifiedAt: new Date(),
          recordsDone: outcome.recordsDone, recordsTotal: outcome.recordsTotal,
          tableProgress: JSON.stringify(outcome.tableProgress), finishedAt: new Date(),
        },
      });
      await audit(organizationId, 'migration_verified', id, `Data migration verified: ${outcome.recordsDone}/${outcome.recordsTotal} records across all org tables — ready to activate`);
      return { ran: true, migrationId: id, outcome: 'ready_to_activate' };
    }

    // ── STORAGE ──
    const spec = JSON.parse(request.configJson) as Record<string, unknown>;
    const key = request.storageKeyEncrypted ? decryptSecret(request.storageKeyEncrypted) : undefined;
    if (!key) throw new Error('The approved storage key is missing from the request');
    const runStoragePass = () => runStorageMigration(
      organizationId,
      { url: String(spec.url ?? ''), key },
      async (patch) => { await progressPatch(patch); }
    );
    let outcome = await runStoragePass();
    for (let pass = 0; pass < MAX_RECONCILE_PASSES && outcome.ok && !outcome.zeroDrift; pass++) {
      outcome = await runStoragePass();
    }
    if (!outcome.ok) {
      await db.infrastructureMigration.update({
        where: { id },
        data: {
          status: 'failed', errorStage: outcome.errorStage ?? 'storage', errorMessage: outcome.errorMessage,
          objectsDone: outcome.objectsDone, objectsTotal: outcome.objectsTotal,
          bytesDone: BigInt(outcome.bytesDone), bytesTotal: BigInt(outcome.bytesTotal), finishedAt: new Date(),
        },
      });
      await audit(organizationId, 'migration_failed', id, `Storage migration FAILED (${outcome.errorStage}): ${outcome.errorMessage} — existing infrastructure remains active`);
      return { ran: true, migrationId: id, outcome: 'failed' };
    }
    await db.infrastructureMigration.update({
      where: { id },
      data: {
        status: 'ready_to_activate', verifiedCount: outcome.objectsDone, verifiedAt: new Date(),
        objectsDone: outcome.objectsDone, objectsTotal: outcome.objectsTotal,
        bytesDone: BigInt(outcome.bytesDone), bytesTotal: BigInt(outcome.bytesTotal), finishedAt: new Date(),
      },
    });
    await audit(organizationId, 'migration_verified', id, `Storage migration verified: ${outcome.objectsDone}/${outcome.objectsTotal} objects (${outcome.bytesDone} bytes) — ready to activate`);
    return { ran: true, migrationId: id, outcome: 'ready_to_activate' };
  } catch (err) {
    await db.infrastructureMigration.updateMany({
      where: { id, status: { in: ['migrating', 'reconciling', 'verifying'] } },
      data: { status: 'failed', errorStage: 'migrate', errorMessage: userSafeError(err), finishedAt: new Date() },
    });
    await audit(organizationId, 'migration_failed', id, `Data migration FAILED: ${userSafeError(err)} — existing infrastructure remains active`);
    return { ran: true, migrationId: id, outcome: 'failed' };
  }
}

/** JobRun-lease wrapper for the instrumentation hourly/scheduled path. */
export async function runMigrationJob(): Promise<void> {
  // Process a bounded number per tick so one huge migration cannot starve others.
  for (let i = 0; i < 3; i++) {
    const r = await runDueMigrations();
    if (!r.ran) break;
  }
  // Crash recovery: finalize (or roll back) an activation that died between the
  // routing flip and the terminal state, so an org is never stranded half-routed.
  await resumeStrandedCutovers();
}

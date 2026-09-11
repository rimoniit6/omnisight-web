// OmniSight — real, org-scoped DATABASE data migration for approved
// infrastructure change requests.
//
// Copies the organization's rows from the platform database (shared `db`) to
// the approved destination (dedicated PrismaClient). Everything here is:
//   • Organization-scoped — every read is WHERE organizationId = <approved org>
//     and every write re-asserts the same organizationId (see assertOrg below).
//   • Idempotent / resumable — per table: if the destination already holds the
//     exact expected count for this org, the table is SKIPPED; otherwise the
//     org's partial rows in the destination are deleted and the table is
//     re-copied in whole. A crashed run therefore never duplicates rows.
//   • Truthful progress — recordsDone/recordsTotal and tableProgress are
//     updated from actual copied row counts, per batch, never simulated.
//   • Fail-safe — any failure marks the migration FAILED and leaves the org's
//     ACTIVE settings untouched (activation is a separate, explicit step).
//
// FULL-ORGANIZATION CUTOVER:
//   • zeroDrift on a successful run = source and destination had IDENTICAL
//     counts for every org table at the final verification instant. Live orgs
//     write continuously, so a run can succeed (loss-free, snapshot-verified)
//     with zeroDrift=false — the in-flight rows are captured deterministically
//     at activation by drainDatabaseCutover (below) AFTER the routing flip.
//   • drainDatabaseCutover repeatedly UPSERTs any org row still sitting in the
//     platform source into the destination until a full pass changes nothing.
//     Post-flip the source stops accumulating new rows, so the loop converges;
//     it then re-verifies counts + the cross-tenant isolation probe before the
//     runner marks the migration ACTIVATED.
//
// SECURITY: the destination client is built from the DECRYPTED password only
// for the connection; it is never logged or returned. Errors surfaced to the
// user are sanitized via sanitizeProbeErrorForLog-style redaction.

import { execFile } from 'child_process';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { db } from '@/lib/db';
import { log } from '@/lib/logger';
import { sanitizeProbeErrorForLog } from '@/lib/infra-connect';
import { MIGRATION_TABLES, type MigrationTable, type TableProgressMap } from './plan';

const BATCH_SIZE = 500;

/** Fail-closed org assertion: the org id must be a non-empty string and identical everywhere. */
function assertOrg(sourceOrgId: string, rowOrgId: unknown, destinationOrgId: string, table: string): void {
  if (!sourceOrgId || !destinationOrgId || sourceOrgId !== destinationOrgId) {
    throw new Error(`[${table}] organization isolation assertion failed (source=${sourceOrgId} destination=${destinationOrgId})`);
  }
  if (rowOrgId !== sourceOrgId) {
    throw new Error(`[${table}] row organizationId mismatch — refusing to copy cross-tenant data`);
  }
}

/**
 * Surface a migration error the way the operator can actually diagnose from.
 * Prisma wraps real failures in an invocation dump whose MEANING is at the
 * END (the `Error code:` marker), not the noisy head that repeats the source
 * snippet — so the tail is kept, never the 300-char head. URLs (which carry
 * the destination password) stay redacted. This is the exact text the status
 * card's "Reason:" line and the SA audit trail show.
 */
export function userSafeError(err: unknown): string {
  const raw = (err as Error)?.message ?? (typeof err === 'string' ? err : '');
  let chosen: string;
  const codeIdx = raw.lastIndexOf('Error code:');
  if (codeIdx >= 0) {
    const head = raw.slice(0, codeIdx).trim().split('\n').filter((l) => l.trim().length > 0).slice(-2).join(' ');
    chosen = `${head} — ${raw.slice(codeIdx, codeIdx + 80)}`.trim();
  } else {
    chosen = raw.trim().split('\n').filter((l) => l.trim().length > 0)[0] ?? raw;
  }
  if (!chosen) return 'Unknown destination failure';
  const sanitized = sanitizeProbeErrorForLog({ message: chosen });
  return sanitized.length > 0 ? sanitized : 'Unknown destination failure';
}

export interface DestinationConnectionSpec {
  host: string;
  port: number | null;
  name: string;
  user: string;
  password?: string;
  ssl: boolean;
}

/**
 * Build the destination connection string. For DATA COPY the client is pinned
 * to a SINGLE connection: the copy is strictly sequential, and a multi-socket
 * pool on a shared pooler (Supabase Supavisor session mode) keeps the idle
 * sockets lying around while one socket does the work — the pooler eventually
 * recycles them and the next statement lands on a dead socket, which surfaces
 * as P1017 "Server has closed the connection." and a generic start failure.
 * One continuously-used connection removes that failure mode entirely.
 */
export function buildDestinationConnectionString(spec: DestinationConnectionSpec, opts: { dataCopy?: boolean } = {}): string {
  const params: string[] = [];
  if (spec.ssl) params.push('sslmode=require');
  if (opts.dataCopy) {
    params.push('connection_limit=1');
    params.push('connect_timeout=10');
  }
  const qs = params.length > 0 ? `?${params.join('&')}` : '';
  return `postgresql://${encodeURIComponent(spec.user)}:${encodeURIComponent(spec.password ?? '')}@${spec.host}:${spec.port ?? 5432}/${spec.name}${qs}`;
}

/**
 * STEP 1 — Destination SCHEMA sync (before any data moves).
 *
 * Reuses the project's existing Prisma schema infrastructure: `prisma db push`
 * applies the FULL application schema (every model — not a hardcoded subset)
 * to the approved destination, exactly as it would to any fresh environment.
 * It is idempotent (already-in-sync destinations are left untouched) and must
 * succeed before org data is copied. An empty/legacy destination is brought up
 * to date automatically. It runs WITHOUT --accept-data-loss: push may only
 * CREATE/ADD — if the destination schema has diverged such that a push would
 * DROP or rewrite existing structures (i.e. destination data), the push
 * REFUSES and the migration fails safely with the old infrastructure still
 * active. Existing destination data can never be silently destroyed here.
 */
export async function syncDestinationSchema(spec: DestinationConnectionSpec): Promise<{ ok: true } | { ok: false; error: string }> {
  const schemaPath = path.join(process.cwd(), 'prisma', 'schema.prisma');
  const cliPath = path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js');
  const url = buildDestinationConnectionString(spec);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [cliPath, 'db', 'push', '--schema', schemaPath, '--skip-generate'],
        { env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url }, timeout: 120_000 },
        (err, _stdout, stderr) => (err ? reject(new Error(String(stderr || err.message))) : resolve())
      );
    });
    return { ok: true };
  } catch (err) {
    log.error('migration.schema.sync.failed', { error: userSafeError(err) });
    return { ok: false, error: userSafeError(err) };
  }
}

/** Build a dedicated destination client from a DbSpec (password already decrypted). */
export function buildDestinationDbClient(spec: DestinationConnectionSpec): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: buildDestinationConnectionString(spec, { dataCopy: true }) } },
    log: ['error'],
  });
}

/**
 * Verify the destination carries the expected schema: every org-owned table
 * must exist with an organizationId column. Missing/incompatible schema fails
 * SAFELY (before any data is written) and the destination is never activated.
 */
export async function verifyDestinationSchema(
  destination: PrismaClient,
  orgId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const tables = await destination.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
    const present = new Set(tables.map((t) => String(t.table_name)));
    const missing = MIGRATION_TABLES.map((t) => t.table).filter((t) => !present.has(t));
    if (missing.length > 0) {
      return { ok: false, error: `Destination schema is missing org-owned tables: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}` };
    }
    const orgCols = await destination.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'organizationId'`;
    const withOrg = new Set(orgCols.map((c) => String(c.table_name)));
    const noOrgCol = MIGRATION_TABLES.map((t) => t.table).filter((t) => withOrg.has(t) === false);
    if (noOrgCol.length > 0) {
      return { ok: false, error: `Destination tables missing organizationId column: ${noOrgCol.slice(0, 5).join(', ')}${noOrgCol.length > 5 ? '…' : ''}` };
    }
    void orgId;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: userSafeError(err) };
  }
}

interface CopyContext {
  sourceOrgId: string;
  destinationOrgId: string;
  onProgress: (patch: { table?: string; done?: number; total?: number; snapshot?: TableProgressMap }) => Promise<void>;
  tableProgress: TableProgressMap;
}

async function countSource(client: PrismaClient, t: MigrationTable, orgId: string): Promise<number> {
  const delegate = (client as unknown as Record<string, { count: (a: { where: Record<string, unknown> }) => Promise<number> }>);
  return delegate[t.model].count({ where: { organizationId: orgId } });
}

export async function countOrganizationData(orgId: string): Promise<
  Array<{ table: string; model: string; count: number }>
> {
  const counts: Array<{ table: string; model: string; count: number }> = [];
  for (const t of MIGRATION_TABLES) {
    counts.push({ table: t.table, model: t.model, count: await countSource(db, t, orgId) });
  }
  return counts;
}

async function countDestinationRows(destination: PrismaClient, table: string, orgId: string): Promise<number> {
  // Table names CANNOT be bind parameters in Postgres. They come ONLY from
  // the static MIGRATION_TABLES allowlist (never user input), so quoting the
  // identifier inline is safe; the orgId stays a bind parameter.
  assertAllowlistedTable(table);
  const rows = await destination.$queryRawUnsafe<Array<{ c: bigint }>>(
    `SELECT COUNT(*)::bigint AS c FROM "${table}" WHERE "organizationId" = $1`,
    orgId
  );
  return Number(rows[0]?.c ?? 0);
}
export { countDestinationRows };

/** Defence-in-depth: every dynamic identifier must be on the copy-plan allowlist. */
function assertAllowlistedTable(table: string): void {
  if (!MIGRATION_TABLES.some((t) => t.table === table)) {
    throw new Error(`Table '${table}' is not on the migration plan allowlist`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cutover drain — deterministic capture of in-flight org data at activation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Coerce a Prisma findMany row value into a safe `pg` SQL bind parameter.
 * Postgres cannot bind JS BigInt / plain objects directly, so bigints go as
 * strings and JSON columns as serialized documents (the destination schema is
 * the same Prisma schema, so the column types always match).
 */
function sqlParamValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v;
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

/**
 * Upsert one org row into the destination (row identity is the cuid primary
 * key). ON CONFLICT ("id") handles BOTH cases the cutover needs in one pass:
 *   • insert missing rows — rows that reached the platform source before the
 *     routing flip (the deterministic cutover boundary);
 *   • reconcile stale values — an in-flight pre-flip transaction that committed
 *     an UPDATE to the source after the flip must not be shadowed by the older
 *     destination copy.
 * Returns 1 when the row was inserted, 2 when it was updated, 0 when unchanged.
 * (Uses the `xmax = 0` trick: freshly inserted rows have a zeroed xmax; rows
 * touched by the DO UPDATE branch do not — the row count alone cannot tell
 * inserts from updates.)
 */
async function upsertDestinationRow(destination: PrismaClient, table: string, row: Record<string, unknown>): Promise<0 | 1 | 2> {
  assertAllowlistedTable(table);
  const keys = Object.keys(row);
  if (keys.length === 0) return 0;
  const cols = keys.map((k) => `"${k}"`).join(', ');
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  const updateCols = keys.filter((k) => k !== 'id').map((k) => `"${k}" = EXCLUDED."${k}"`).join(', ');
  const values = keys.map((k) => sqlParamValue(row[k]));
  if (!updateCols) {
    const changed = await destination.$executeRawUnsafe(
      `INSERT INTO "${table}" (${cols}) VALUES (${placeholders}) ON CONFLICT ("id") DO NOTHING`,
      ...values
    );
    return changed > 0 ? 1 : 0;
  }
  const rows = await destination.$queryRawUnsafe<Array<{ i: boolean }>>(
    `INSERT INTO "${table}" (${cols}) VALUES (${placeholders}) ON CONFLICT ("id") DO UPDATE SET ${updateCols} RETURNING (xmax = 0) AS i`,
    ...values
  );
  return rows[0]?.i === true ? 1 : 2;
}

export interface DrainTableResult {
  table: string;
  srcCount: number;
  dstCount: number;
  inserted: number;
  updated: number;
}

/**
 * Drain one table: sweep EVERY org row still held by the platform source and
 * upsert it into the destination. Never deletes destination rows — post-flip
 * writes must never be lost. Returns the per-table counts + how much changed
 * (inserted = rows that did not exist yet, updated = rows reconciled in place).
 */
export async function drainMissingTableRows(
  destination: PrismaClient,
  orgId: string,
  t: MigrationTable
): Promise<DrainTableResult> {
  assertAllowlistedTable(t.table);
  let inserted = 0;
  let updated = 0;
  // Re-read the live source count at the START of the sweep — rows that
  // existed at the previous pass but vanished (purged while in flight) are
  // simply absent; the destination is never rewound for them.
  const srcCount = await countSource(db, t, orgId);

  if (srcCount > 0) {
    let cursorId = '';
    while (true) {
      const delegate = (db as unknown as Record<string, { findMany: (a: Record<string, unknown>) => Promise<Array<Record<string, unknown>>> }>);
      const rows = await delegate[t.model].findMany({
        where: { organizationId: orgId, id: { gt: cursorId } },
        orderBy: [{ id: 'asc' }],
        take: BATCH_SIZE,
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        assertOrg(orgId, row.organizationId, orgId, t.table);
        const changed = await upsertDestinationRow(destination, t.table, row);
        if (changed === 1) inserted += 1;
        else if (changed === 2) updated += 1;
      }
      cursorId = String(rows[rows.length - 1].id);
    }
  }

  const dstCount = await countDestinationRows(destination, t.table, orgId);
  return { table: t.table, srcCount, dstCount, inserted, updated };
}

export interface DrainOutcome {
  ok: boolean;
  inserts: number;
  passes: number;
  tables: DrainTableResult[];
  errorStage?: 'migrate' | 'verify';
  errorMessage?: string;
}

/**
 * Cutover drain to fixpoint: after the routing flip the platform source stops
 * accumulating org rows (every new write lands in the destination), so repeating
 * per-table drains until one full pass changes nothing produces a destination
 * that is provably a superset of the source — nothing written before the cutover
 * boundary is missing. Fails (rollback) instead of looping forever when the
 * source keeps receiving writes.
 */
export async function drainDatabaseCutover(
  destination: PrismaClient,
  orgId: string,
  maxPasses: number = 50
): Promise<DrainOutcome> {
  let totalInserts = 0;
  let lastTableResults: DrainTableResult[] = [];
  for (let pass = 1; pass <= maxPasses; pass++) {
    let passInserts = 0;
    const tableResults: DrainTableResult[] = [];
    for (const t of MIGRATION_TABLES) {
      const r = await drainMissingTableRows(destination, orgId, t);
      // Destination superset check: if the destination somehow holds FEWER org
      // rows than the source right now, the copy could NOT have covered it.
      if (r.dstCount < r.srcCount) {
        return {
          ok: false, errorStage: 'migrate',
          errorMessage: `[${r.table}] cutover drain failed: destination holds ${r.dstCount} of ${r.srcCount} org rows — rollback required`,
          inserts: totalInserts, passes: pass, tables: lastTableResults,
        };
      }
      passInserts += r.inserted;
      tableResults.push(r);
    }
    lastTableResults = tableResults;
    if (passInserts === 0) {
      return { ok: true, inserts: totalInserts, passes: pass, tables: tableResults };
    }
    totalInserts += passInserts;
  }
  return {
    ok: false, errorStage: 'migrate',
    errorMessage: `Cutover drain did not converge after ${maxPasses} passes — the platform source kept receiving org writes. The switch was rolled back; retry activation.`,
    inserts: totalInserts, passes: maxPasses, tables: lastTableResults,
  };
}

/**
 * Post-drain final verification: every org table must hold at least as many rows
 * as the platform source (drain-to-fixpoint guarantees superset for the boundary,
 * this re-checks it at a later instant), and the destination must still hold
 * ZERO rows of any other organization (cross-tenant isolation invariant).
 */
export async function verifyCutoverDestination(
  destination: PrismaClient,
  orgId: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  for (const t of MIGRATION_TABLES) {
    const src = await countSource(db, t, orgId);
    const dst = await countDestinationRows(destination, t.table, orgId);
    if (dst < src) {
      return { ok: false, reason: `[${t.table}] post-cutover verification: destination ${dst} < platform source ${src} org rows` };
    }
  }
  let foreignRows = 0;
  for (const t of MIGRATION_TABLES) {
    const rows = await destination.$queryRawUnsafe<Array<{ others: bigint }>>(
      `SELECT COUNT(*)::bigint AS others FROM "${t.table}" WHERE "organizationId" <> $1`,
      orgId
    );
    foreignRows += Number(rows[0]?.others ?? 0);
  }
  if (foreignRows > 0) {
    return { ok: false, reason: 'Destination database contains rows belonging to other organizations — cutover refused (isolation invariant violated).' };
  }
  return { ok: true };
}

/**
 * Ensure the destination holds the ORGANIZATION ANCHOR row so org-owned
 * rows' `organizationId` FKs resolve. The anchor carries ONLY the org's
 * identity columns (id/name/slug/locale/status) — NEVER the platform
 * control-plane fields (subscription, license, seats, deployment mode),
 * which stay authoritative in the platform database. Idempotent: an existing
 * anchor (previous run) is left untouched.
 */
export async function ensureDestinationOrgAnchor(destination: PrismaClient, orgId: string): Promise<void> {
  const org = await db.organization.findUnique({
    where: { id: orgId },
    select: { id: true, name: true, slug: true, status: true, timezone: true, language: true, currency: true, createdAt: true, updatedAt: true },
  });
  if (!org) throw new Error('Organization not found in the platform database');
  await destination.$executeRawUnsafe(
    `INSERT INTO "Organization" ("id", "name", "slug", "status", "timezone", "language", "currency", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT ("id") DO NOTHING`,
    org.id, org.name, org.slug, org.status, org.timezone, org.language, org.currency, org.createdAt, org.updatedAt
  );
}

/** Copy one table org-scoped with resume semantics. Returns rows copied this run. */
async function copyTable(
  t: MigrationTable,
  ctx: CopyContext,
  source: PrismaClient,
  destination: PrismaClient,
  snapshotTotals: Map<string, number>
): Promise<number> {
  const orgId = ctx.sourceOrgId;
  assertOrg(orgId, orgId, ctx.destinationOrgId, t.table);

  const srcTotal = await countSource(source, t, orgId);
  // Snapshot for verification: rows created in the source AFTER this moment
  // (live system writes) are expected to remain platform-side until cutover.
  snapshotTotals.set(t.table, srcTotal);
  const dstExisting = await countDestinationRows(destination, t.table, orgId);

  ctx.tableProgress[t.table] = { done: dstExisting >= srcTotal ? srcTotal : dstExisting, total: srcTotal };
  await ctx.onProgress({ table: t.table, total: srcTotal });

  if (srcTotal === 0) {
    // Nothing to copy; ensure no stale partial rows linger in destination.
    if (dstExisting > 0) {
      assertAllowlistedTable(t.table);
      await destination.$executeRawUnsafe(`DELETE FROM "${t.table}" WHERE "organizationId" = $1`, orgId);
    }
    ctx.tableProgress[t.table] = { done: 0, total: 0 };
    await ctx.onProgress({ snapshot: { ...ctx.tableProgress } });
    return 0;
  }

  // Idempotent resume: complete table → skip; partial/dirty → org-scoped reset.
  if (dstExisting === srcTotal) {
    await ctx.onProgress({ snapshot: { ...ctx.tableProgress } });
    return 0;
  }
  if (dstExisting > 0) {
    assertAllowlistedTable(t.table);
    await destination.$executeRawUnsafe(`DELETE FROM "${t.table}" WHERE "organizationId" = $1`, orgId);
  }

  // Cursor pagination over the stable cuid primary key. Cuid ids are unique
  // and lexicographically stable, so `id > cursorId` sweeps the table in the
  // same total order across restarts. Copy order within a table does not
  // affect fidelity — FK integrity is guaranteed by MIGRATION_TABLES ordering
  // (referenced org-internal tables are copied before their dependents).
  let cursorId = '';
  let copied = 0;

  while (true) {
    const where: Record<string, unknown> = { organizationId: orgId, id: { gt: cursorId } };
    const delegate = (source as unknown as Record<string, { findMany: (a: Record<string, unknown>) => Promise<Array<Record<string, unknown>>> }>);
    const rows = await delegate[t.model].findMany({
      where,
      orderBy: [{ id: 'asc' }],
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      // Per-row isolation assertion before any write (fail-closed).
      assertOrg(orgId, row.organizationId, ctx.destinationOrgId, t.table);
    }
    // One multi-row INSERT per batch (a single round-trip instead of up to
    // BATCH_SIZE separate statements). FK integrity is untouched: org-internal
    // FK targets were copied in earlier MIGRATION_TABLES, and within-batch
    // self-references resolve atomically inside the single INSERT. Fewer round
    // trips also means the copy spends far less time open on the destination
    // link — the pooler-connection reset class of failures stops happening.
    const data = rows as Array<Record<string, unknown>>;
    await (destination as unknown as Record<string, { createMany: (a: { data: Array<Record<string, unknown>> }) => Promise<{ count: number }> }>)[t.model].createMany({ data });

    copied += rows.length;
    const last = rows[rows.length - 1];
    cursorId = String(last.id);
    ctx.tableProgress[t.table] = { done: dstExisting + copied, total: srcTotal };
    await ctx.onProgress({ done: dstExisting + copied, snapshot: { ...ctx.tableProgress } });
  }

  // The cursor sweeps the LIVE table, so rows created during the copy are
  // picked up too — finalCount can legitimately exceed the snapshot.
  const finalCount = await countDestinationRows(destination, t.table, orgId);
  if (finalCount < srcTotal) {
    throw new Error(`[${t.table}] copy incomplete: destination has ${finalCount} of ${srcTotal} org rows`);
  }
  ctx.tableProgress[t.table] = { done: finalCount, total: finalCount };
  await ctx.onProgress({ snapshot: { ...ctx.tableProgress } });
  return copied;
}

export interface DbMigrationOutcome {
  ok: boolean;
  errorStage?: 'migrate' | 'verify' | 'schema';
  errorMessage?: string;
  recordsDone: number;
  recordsTotal: number;
  tableProgress: TableProgressMap;
  /**
   * True when the destination equals the source for EVERY org table at the
   * instant the final verification ran (a deterministic, zero-drift boundary).
   * Live orgs keep writing, so a loss-free snapshot can legitimately complete
   * with zeroDrift=false — the in-flight gap is closed deterministically by
   * drainDatabaseCutover at activation, not by this flag.
   */
  zeroDrift: boolean;
}

/**
 * Run the org-scoped database migration. Throws nothing — every failure is
 * returned as a structured outcome so the runner can persist it verbatim.
 */
export async function runDatabaseMigration(
  orgId: string,
  spec: { host: string; port: number | null; name: string; user: string; password?: string; ssl: boolean },
  onProgress: (patch: { table?: string; done?: number; total?: number; snapshot?: TableProgressMap }) => Promise<void>
): Promise<DbMigrationOutcome> {
  const destination = buildDestinationDbClient(spec);
  const tableProgress: TableProgressMap = {};
  const snapshotTotals = new Map<string, number>();
  let recordsTotal = 0;
  let recordsDone = 0;

  try {
    // STEP 1: bring the destination schema up to date (full Prisma schema).
    const sync = await syncDestinationSchema(spec);
    if (!sync.ok) {
      return { ok: false, errorStage: 'schema', errorMessage: `Destination schema could not be synchronized: ${sync.error}`, recordsDone, recordsTotal, tableProgress, zeroDrift: false };
    }
    // STEP 2: confirm the synced schema actually matches the migration plan
    // (defence-in-depth: never copy into tables the plan does not recognize).
    const schema = await verifyDestinationSchema(destination, orgId);
    if (!schema.ok) {
      return { ok: false, errorStage: 'schema', errorMessage: schema.error, recordsDone, recordsTotal, tableProgress, zeroDrift: false };
    }

    const ctx: CopyContext = { sourceOrgId: orgId, destinationOrgId: orgId, onProgress, tableProgress };

    // The destination must know WHICH organization these rows belong to.
    await ensureDestinationOrgAnchor(destination, orgId);

    // Pre-count totals for truthful percentages.
    for (const t of MIGRATION_TABLES) {
      const c = await countSource(db, t, orgId);
      recordsTotal += c;
    }
    await onProgress({ total: recordsTotal });

    for (const t of MIGRATION_TABLES) {
      await onProgress({ table: t.table });
      const copied = await copyTable(t, ctx, db, destination, snapshotTotals);
      recordsDone += copied;
    }

    // ── Verification: counts + cross-tenant probe ──
    // Snapshot-aware: on a live system rows may be written to the source
    // AFTER a table's copy snapshot (e.g. audit/activity streams). Those rows
    // stay platform-side until activation — the copy is complete iff the
    // destination holds at least the snapshot total. When the source has not
    // drifted, counts must match exactly.
    let presentTotal = 0;
    let zeroDrift = true;
    for (const t of MIGRATION_TABLES) {
      const src = await countSource(db, t, orgId);
      const dst = await countDestinationRows(destination, t.table, orgId);
      const planned = snapshotTotals.get(t.table) ?? src;
      if (dst < planned || (src === planned && dst !== src)) {
        return {
          ok: false, errorStage: 'verify',
          errorMessage: `[${t.table}] verification failed: source ${src} vs destination ${dst} rows for this organization`,
          recordsDone, recordsTotal, tableProgress, zeroDrift: false,
        };
      }
      if (src !== dst) zeroDrift = false;
      // Every verified table contributes its CONFIRMED destination rows. This
      // is the count the migration can truthfully report as "done".
      presentTotal += dst;
    }

    // Reconcile the reported progress with what was actually VERIFIED in the
    // destination. `recordsDone` so far only counts rows INSERTED by THIS run;
    // an idempotent resume over tables that were already complete (copied by a
    // previous run) inserts 0 for them — under-counting rows that ARE present
    // and verified. The verified destination set is the source of truth:
    //   done = min(snapshot total, present). During the run the source may
    // gain rows (copied as a bonus) → present exceeds the snapshot and we
    // report the full snapshot as done (100%). If the source SHRANK mid-run
    // (rows deleted platform-side), present is smaller and the card honestly
    // reflects that the deleted rows no longer exist anywhere.
    recordsDone = Math.min(recordsTotal, presentTotal);

    // Cross-tenant probe: the destination must contain ZERO rows belonging to
    // any OTHER organization across ALL org-owned tables (isolation invariant).
    // NULL organizationId rows (platform-level AuditLog entries) are ignored —
    // they are not another organization's data.
    let foreignRows = 0;
    for (const t of MIGRATION_TABLES) {
      const rows = await destination.$queryRawUnsafe<Array<{ others: bigint }>>(
        `SELECT COUNT(*)::bigint AS others FROM "${t.table}" WHERE "organizationId" <> $1`,
        orgId
      );
      foreignRows += Number(rows[0]?.others ?? 0);
    }    if (foreignRows > 0) {
      return {
        ok: false, errorStage: 'verify',
        errorMessage: 'Destination database contains rows belonging to other organizations — activation refused (isolation invariant violated).',
        recordsDone, recordsTotal, tableProgress, zeroDrift: false,
      };
    }

    return { ok: true, recordsDone, recordsTotal, tableProgress, zeroDrift };
  } catch (err) {
    log.error('migration.db.failed', { error: userSafeError(err) });
    return { ok: false, errorStage: 'migrate', errorMessage: userSafeError(err), recordsDone, recordsTotal, tableProgress, zeroDrift: false };
  } finally {
    try { await destination.$disconnect(); } catch { /* ignore */ }
  }
}

/**
 * Test/seed helper: copy an organization's data to a destination database
 * identified by a full connection URL. This is a simplified entry point that
 * reuses the same copyTable pipeline (idempotent, org-scoped, isolation-
 * asserted) as runDatabaseMigration, but without the migration-runner state
 * machine. Used by integration tests to seed an org's own DB before asserting
 * runtime routing through getPrismaForOrg.
 *
 * The destination schema must already be synced (prisma db push) — this
 * function only moves data. Returns true on success, false on failure.
 */
export async function copyOrgToDestination(orgId: string, destinationUrl: string): Promise<boolean> {
  const destination = new PrismaClient({
    datasources: { db: { url: destinationUrl } },
    log: ['error'],
  });
  try {
    const ctx: CopyContext = {
      sourceOrgId: orgId,
      destinationOrgId: orgId,
      onProgress: async () => {},
      tableProgress: {},
    };
    const snapshotTotals = new Map<string, number>();
    await ensureDestinationOrgAnchor(destination, orgId);
    for (const t of MIGRATION_TABLES) {
      await copyTable(t, ctx, db, destination, snapshotTotals);
    }
    return true;
  } catch (err) {
    log.error('migration.db.copyOrgToDestination.failed', { error: userSafeError(err) });
    return false;
  } finally {
    try { await destination.$disconnect(); } catch { /* ignore */ }
  }
}

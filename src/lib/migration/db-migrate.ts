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
/**
 * SQLSTATE → short operator-facing label. PostgreSQL failures carry a 5-char
 * SQLSTATE that states exactly WHAT failed; the old userSafeError dropped it
 * and kept only the noisy `Invalid \`prisma.$executeRawUnsafe()\` invocation:`
 * header, which is why a destination failure surfaced as an unactionable reason.
 */
const PG_SQLSTATE_LABELS: Record<string, string> = {
  '23505': 'unique constraint violation',
  '23502': 'not-null constraint violation',
  '23503': 'foreign-key constraint violation',
  '23514': 'check constraint violation',
  '42703': 'undefined column',
  '42P01': 'undefined table',
  '42501': 'insufficient privilege',
  '28P01': 'password authentication failed',
  '3D000': 'database does not exist',
  '08006': 'connection failure',
  '08003': 'connection does not exist',
  '08001': 'could not establish connection',
  '53300': 'too many connections',
  '57014': 'query cancelled (timeout)',
  '40001': 'serialization failure',
  '40P01': 'deadlock detected',
};

function pgSqlstateLabel(code: string): string {
  if (PG_SQLSTATE_LABELS[code]) return PG_SQLSTATE_LABELS[code];
  if (code.startsWith('08')) return 'connection failure';
  if (code.startsWith('42')) return 'undefined object / permission error';
  if (code.startsWith('23')) return 'constraint violation';
  if (code.startsWith('53')) return 'resource limit exceeded';
  if (code.startsWith('57')) return 'operation aborted';
  return '';
}

/**
 * Recover the real PostgreSQL cause from a Prisma error. Two shapes matter:
 *   • PrismaClientKnownRequestError P2010 (raw query) — the SQLSTATE and the
 *     one-line driver sentence live in `meta.code` / `meta.message`;
 *   • PrismaClientUnknownRequestError — the driver line is embedded in the
 *     message body after the invocation header.
 * Returns null when there is no recognizable PostgreSQL cause (the caller then
 * keeps the legacy `Error code:` handling), so this only ever ADDS detail.
 */
function extractPgCause(err: unknown): { code: string; message: string } | null {
  const e = (err ?? {}) as { meta?: unknown; message?: unknown };
  const meta = (e.meta ?? {}) as { code?: unknown; message?: unknown };
  const metaCode = typeof meta.code === 'string' && /^[0-9A-Z]{5}$/.test(meta.code) ? meta.code : '';
  const metaMessage = typeof meta.message === 'string' ? meta.message.trim() : '';
  if (metaCode && metaMessage) return { code: metaCode, message: metaMessage };

  const raw = typeof e.message === 'string' ? e.message : typeof err === 'string' ? err : '';
  if (!raw) return null;
  const code = raw.match(/\bCode:\s*[`"']?([0-9A-Z]{5})[`"']?/)?.[1] ?? '';
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) =>
      /(duplicate key value|violates .*constraint|does not exist|permission denied|password authentication failed|too many connections|connection (refused|reset|closed)|timeout|canceling statement|deadlock)/i.test(
        l
      )
    );
  if (!code && !line) return null;
  return { code, message: line ?? '' };
}

/**
 * Surface a migration error the way the operator can actually diagnose from.
 * Priority:
 *   1. The structured PostgreSQL cause (SQLSTATE-labelled one-liner) — this is
 *      what the previous implementation threw away on Prisma raw-query errors.
 *   2. The legacy `Error code:` tail (Prisma's MEANING is at the END, not the
 *      noisy head that repeats the source snippet).
 *   3. The first NON-HEADER message line.
 * URLs (which carry the destination password) stay redacted. This is the exact
 * text the status card's "Reason:" line and the SA audit trail show.
 */
export function userSafeError(err: unknown): string {
  const cause = extractPgCause(err);
  if (cause && (cause.code || cause.message)) {
    const label = cause.code ? pgSqlstateLabel(cause.code) : '';
    const head = [label, cause.code ? `(${cause.code})` : ''].filter(Boolean).join(' ');
    const composed = head && cause.message ? `${head}: ${cause.message}` : head || cause.message;
    const sanitizedCause = composed ? sanitizeProbeErrorForLog({ message: composed }) : '';
    if (sanitizedCause) return sanitizedCause;
  }

  const raw = (err as Error)?.message ?? (typeof err === 'string' ? err : '');
  let chosen: string;
  const codeIdx = raw.lastIndexOf('Error code:');
  if (codeIdx >= 0) {
    const head = raw.slice(0, codeIdx).trim().split('\n').filter((l) => l.trim().length > 0).slice(-2).join(' ');
    chosen = `${head} — ${raw.slice(codeIdx, codeIdx + 80)}`.trim();
  } else {
    const lines = raw.trim().split('\n').filter((l) => l.trim().length > 0);
    chosen = lines.find((l) => !/^Invalid `prisma\.[A-Za-z]+\(\)` invocation:?$/.test(l.trim())) ?? lines[0] ?? raw;
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

// ─── Schema-sync diagnostics (verified forensic finding RC-2) ────────────────
// The Prisma CLI writes INFORMATIONAL lines — notably
// "Environment variables loaded from .env" — to STDERR on every invocation
// (via @prisma/debug's console.warn logger). The old implementation rejected
// on `String(stderr)` and took the first non-empty line, so the banner was
// always surfaced as the failure reason and the REAL error (which Prisma puts
// on stdout + the final stderr lines) was invisible.

/** Bound for the schema-sync child process. Named constant (Phase 8) — the
 *  push must complete within a minute on a healthy network; a longer budget
 *  would leave a hung CLI blocking the runner lease. Documented, single place. */
export const SCHEMA_SYNC_TIMEOUT_MS = 120_000;

/** Informational Prisma/Node CLI lines that must NEVER be shown as the error. */
const SCHEMA_SYNC_INFO_LINE_PATTERNS: RegExp[] = [
  /^Environment variables loaded from \./,
  /^Environment variables loaded$/,
  /^prisma:tryLoadEnv/,
  /^\s*$/, // blank lines
];

/**
 * Extract the MEANINGFUL failure text from a failed schema-sync run.
 * (Phase 7/9) Combines stdout + stderr, drops informational banners, and
 * redacts anything that could carry credentials. Never returns the `.env`
 * banner. Priority, best → last:
 *   1. the schema-DRIFT refusal block — the "require data loss" OBJECT LIST
 *      (which tables/columns/enums a forced sync would drop) PLUS its
 *      actionable `Error:` tail, kept verbatim so the operator sees exactly
 *      what would be destroyed;
 *   2. the Prisma `Error code: Pxxxx` marker (like userSafeError);
 *   3. a PostgreSQL text error / P-code line;
 *   4. the final non-empty line;
 *   5. the provided fallback.
 */
export function extractSchemaSyncError(parts: { stdout: string; stderr: string; fallback?: string }): string {
  const meaningful = (stream: string): string[] =>
    stream
      .split(/\r?\n/)
      .filter((line) => !SCHEMA_SYNC_INFO_LINE_PATTERNS.some((re) => re.test(line)))
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  // Prisma writes the failure banner + real error to stdout; the invocation
  // context (command, snippet) can land on either stream. Search stdout first
  // — stderr holds the informational banner.
  const candidates = [...meaningful(parts.stdout), ...meaningful(parts.stderr)];
  const joined = candidates.join('\n');
  let chosen: string;

  // Priority 1 — schema-drift refusal. `prisma db push` (or any diff) that
  // would rewrite existing structures prints "The following changes require
  // data loss:" followed by the per-object bullet list, then the actionable
  // `Error:` tail. Keep the OBJECT LIST (the operator-facing diagnosis) and
  // append the tail so the message stays actionable. Bounded so a pathological
  // payload can never flood the status card.
  const driftIdx = candidates.findIndex((l) => /\bdata loss\b/i.test(l));
  if (driftIdx >= 0) {
    const tailStart = candidates.slice(driftIdx).findIndex((l) => l.startsWith('Error:'));
    const blockLines =
      (tailStart >= 0 ? candidates.slice(driftIdx, driftIdx + tailStart) : candidates.slice(driftIdx)).slice(0, 30).join(' ');
    const errorTail =
      tailStart >= 0 ? candidates.slice(driftIdx + tailStart, driftIdx + tailStart + 2).join(' ') : '';
    chosen = errorTail ? `${blockLines} — ${errorTail}` : blockLines;
  } else {
    const codeIdx = joined.lastIndexOf('Error code:');
    if (codeIdx >= 0) {
      const head = candidates.filter((l) => l.indexOf('Error code:') < 0 && l !== joined.slice(codeIdx).split('\n')[0]).slice(-1)[0] ?? '';
      chosen = `${head} — ${joined.slice(codeIdx, codeIdx + 120)}`.trim();
    } else {
      // Prefer a real error line over a Prisma status line.
      chosen =
        candidates.find((l) => /\bP[1-5]\d{3}\b/.test(l)) ??
        candidates.find((l) => /error|failed|denied|timed? ?out|refused|does not exist|drift|data loss/i.test(l)) ??
        candidates[candidates.length - 1] ??
        '';
    }
  }
  if (!chosen) return parts.fallback?.trim() || 'The schema synchronization failed without a diagnosable error message.';

  // The drift CRITICAL block is already line-count-bounded (max 30 + 2 lines),
  // so the 300-char cap of sanitizeProbeErrorForLog would truncate a long
  // object list before its actionable `Error:` tail — redact-only here keeps
  // the whole diagnosis while still scrubbing any connection URL.
  const sanitized =
    driftIdx >= 0
      ? chosen.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, '[REDACTED_URL]')
      : sanitizeProbeErrorForLog({ message: chosen });
  return sanitized.length > 0 ? sanitized : 'The schema synchronization failed without a diagnosable error message.';
}

/** Classify an execFile-level failure (spawn error / timeout / signal). */
function describeExecFailure(err: NodeJS.ErrnoException & { killed?: boolean; signal?: string }): string | null {
  if (err.killed) {
    return `Destination schema synchronization timed out after ${Math.round(SCHEMA_SYNC_TIMEOUT_MS / 1000)} seconds.`;
  }
  if (err.signal) return `The schema synchronization process was terminated by signal ${err.signal}.`;
  if (err.code && typeof err.code === 'string' && /^E[A-Z]+$/.test(err.code)) {
    return `The schema synchronization process could not be started (${err.code}).`;
  }
  return null;
}
// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — Destination SCHEMA preparation (classify → additive creation only).
// ─────────────────────────────────────────────────────────────────────────────
//
// REPLACES the old `prisma db push` of the FULL schema (the root cause of the
// surfaced production error). Pushing the whole schema — including tables the
// customer DB must not carry — onto an EARLIER-generation destination always
// produced a data-loss diff and push (correctly, never run with
// --accept-data-loss) REFUSED with:
//   "Error: Use the --accept-data-loss flag to ignore the data loss warnings"
//
// The destination schema is now CLASSIFIED first, then handled per class:
//   • EMPTY              → create ONLY the migration-plan tables plus the
//                          reduced Organization ANCHOR (never the full
//                          platform model set), derived statement-by-statement
//                          from the real Prisma schema via `prisma migrate
//                          diff` — no DROP/ALTER/truncate anywhere.
//   • CURRENT_OMNISIGHT  → no-op success. A destination that already carries
//                          the plan schema (a previous run, or a full build
//                          left over by the old push) is accepted untouched.
//   • LEGACY_OMNISIGHT   → CONTROLLED UPGRADE: the audited obsolete Self-
//                          Hosted/PRIVATE structures are removed ONLY when
//                          proven data-free (fail-closed preconditions), then
//                          the schema additively converges to the migration
//                          plan. If legacy data IS present, the upgrade is
//                          REFUSED with the offending records NAMED — nothing
//                          is modified, no data is deleted, Managed
//                          infrastructure stays active, and the run is
//                          retryable after an operator resolves the destination.
//   • FOREIGN_OR_UNKNOWN → REFUSED (fail closed — there is no policy for a
//                          non-empty database OmniSight cannot identify).
//
// All creation happens inside ONE interactive transaction: a partial failure
// rolls EVERYTHING back, leaving the destination exactly as empty as before so
// the run stays retryable. Nothing in this step can destroy existing data.

/** The project's own Prisma schema — the single source of truth for DDL. */
const DESTINATION_SCHEMA_PATH = path.join(process.cwd(), 'prisma', 'schema.prisma');
/** Prisma CLI entrypoint (used for the offline `migrate diff` compiler). */
const PRISMA_CLI_PATH = path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js');

/** The Organization identity columns the destination is permitted to carry —
 *  the migration's ANCHOR, never the platform control-plane fields (logo,
 *  subscription, license, plan, deployment mode, …). Must match
 *  ensureDestinationOrgAnchor exactly. */
export const ORGANIZATION_ANCHOR_COLUMNS = [
  'id', 'name', 'slug', 'status', 'timezone', 'language', 'currency', 'createdAt', 'updatedAt',
] as const;

/**
 * Legacy fingerprints of the EARLIER OmniSight generation — things it created
 * that the CURRENT schema dropped. Presence classifies a destination as
 * LEGACY_OMNISIGHT (see classifyDestinationSchema).
 *
 * REMOVAL POLICY (Phase 3/6 legacy-cleanup): the legacy objects below carry
 * ZERO current business data by design:
 *   • LicenseKey rows were legacy self-hosted license GRANTS (an architecture
 *     that no longer exists — no issuance path, no consumer); their removal is
 *     a no-op for MANAGED/CUSTOMER_DB operation.
 *   • Organization.licenseKeyId was the optional "current license" POINTER;
 *     when null it references nothing at all.
 *   • Plan.isSelfHosted was a plan-catalog flag; plans without it are just
 *     MANAGED/CUSTOMER_DB plans.
 *   • DeploymentMode='PRIVATE' was a service model that no current code path
 *     accepts (validators only admit MANAGED | CUSTOMER_DB).
 * Only fingerprints listed here may be cleaned by upgradeLegacyDestination —
 * and ONLY while they are data-free (see LEGACY_GUARDS + upgradeLegacyDestination).
 */
const LEGACY_OMNISIGHT_TABLES = ['Guest', 'AgentRegistration', 'AgentBuild', 'LicenseKey'];
const LEGACY_OMNISIGHT_COLUMNS: ReadonlyArray<[table: string, column: string, context: string]> = [
  ['Employee', 'guestId', 'guest tracking was removed from employees'],
  ['Organization', 'licenseKeyId', 'self-hosted license keys were removed'],
  ['Plan', 'isSelfHosted', 'the self-hosted plan flag was removed'],
];

/** Legacy fingerprints OUTSIDE the controlled-upgrade cleanup scope: older
 *  structures the upgrade does NOT know how to interpret, so their presence
 *  REFUSES the upgrade outright (fail closed — an operator must review them).
 *  Only the four audited Self-Hosted/PRIVATE artifacts are ever cleaned. */
const OUT_OF_SCOPE_LEGACY_TABLES = LEGACY_OMNISIGHT_TABLES.filter((t) => t !== 'LicenseKey');
const OUT_OF_SCOPE_LEGACY_COLUMNS = LEGACY_OMNISIGHT_COLUMNS.filter(
  ([table, column]) =>
    !(table === 'Organization' && column === 'licenseKeyId') && !(table === 'Plan' && column === 'isSelfHosted'),
);

export type DestinationSchemaClass =
  | { kind: 'EMPTY' }
  | { kind: 'CURRENT_OMNISIGHT' }
  | { kind: 'LEGACY_OMNISIGHT'; conflicts: string[] }
  | { kind: 'FOREIGN_OR_UNKNOWN'; reason: string };

interface SchemaInventory {
  /** BASE TABLE names in the destination's `public` schema. */
  tables: Set<string>;
  /** table → column names. */
  columns: Map<string, Set<string>>;
  /** Values of the `DeploymentMode` enum if it exists. */
  deploymentModeValues: Set<string>;
}

/** Read-only report of the destination's PUBLIC schema (BASE TABLEs, their
 *  columns, and the DeploymentMode enum labels). No statement mutates anything. */
async function inventoryDestinationSchema(destination: PrismaClient): Promise<SchemaInventory> {
  const tables = await destination.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
  const allColumns = await destination.$queryRaw<Array<{ table_name: string; column_name: string }>>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public'`;
  const enumValues = await destination.$queryRaw<Array<{ enumlabel: string }>>`
    SELECT e.enumlabel FROM pg_catalog.pg_enum e
    JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'DeploymentMode'`;
  const columns = new Map<string, Set<string>>();
  for (const c of allColumns) {
    const set = columns.get(c.table_name) ?? new Set<string>();
    set.add(c.column_name);
    columns.set(c.table_name, set);
  }
  return {
    tables: new Set(tables.map((t) => String(t.table_name))),
    columns,
    deploymentModeValues: new Set(enumValues.map((e) => String(e.enumlabel))),
  };
}

/**
 * Classify the destination's existing schema (read-only) into one of four
 * buckets. The ordering is deliberate: legacy fingerprints are checked BEFORE
 * completeness so an older build is never mistaken for "current".
 */
export async function classifyDestinationSchema(destination: PrismaClient): Promise<DestinationSchemaClass> {
  const inventory = await inventoryDestinationSchema(destination);
  if (inventory.tables.size === 0) return { kind: 'EMPTY' };

  const conflicts: string[] = [];
  for (const table of LEGACY_OMNISIGHT_TABLES) {
    if (inventory.tables.has(table)) conflicts.push(`table "${table}" (removed in the current schema)`);
  }
  for (const [table, column, context] of LEGACY_OMNISIGHT_COLUMNS) {
    if (inventory.columns.get(table)?.has(column)) conflicts.push(`column "${table}.${column}" (${context})`);
  }
  if (inventory.deploymentModeValues.has('PRIVATE')) {
    conflicts.push(`enum value "DeploymentMode" = 'PRIVATE' (self-hosted mode was removed)`);
  }
  if (conflicts.length > 0) return { kind: 'LEGACY_OMNISIGHT', conflicts };

  const expected = new Set<string>([...MIGRATION_TABLES.map((t) => t.table), 'Organization']);
  const missing = [...expected].filter((t) => !inventory.tables.has(t));
  if (missing.length > 0) {
    const list = missing.slice(0, 6).join(', ');
    return {
      kind: 'FOREIGN_OR_UNKNOWN',
      reason: `not an empty database, not the current OmniSight schema, and not a recognizable older OmniSight build — expected tables missing: ${list}${missing.length > 6 ? '…' : ''}`,
    };
  }
  const missingAnchor = ORGANIZATION_ANCHOR_COLUMNS.filter((c) => !inventory.columns.get('Organization')?.has(c));
  if (missingAnchor.length > 0) {
    return {
      kind: 'FOREIGN_OR_UNKNOWN',
      reason: `the Organization table is incompatible — missing anchor columns: ${missingAnchor.join(', ')}`,
    };
  }
  return { kind: 'CURRENT_OMNISIGHT' };
}

// ── Additive schema-script generation (pure — derived from the real schema) ──

interface SchemaStatement {
  kind: 'enum' | 'table' | 'index' | 'fk';
  /** CREATE TYPE name / CREATE TABLE name / INDEX ON table / FK ALTER TABLE target. */
  subject: string;
  /** FK REFERENCES table (fk statements only). */
  referenced?: string;
  /** Trimmed CREATE TABLE body lines (table statements only). */
  body: string[];
  /** The original statement text (without the diff's `--` header comment). */
  sql: string;
}

/** Parse `prisma migrate diff` output into typed statements. Unrecognized
 *  sections (e.g. `-- CreateSchema`) are dropped. */
export function parseDiffScript(script: string): SchemaStatement[] {
  const statements: SchemaStatement[] = [];
  let header: 'CreateEnum' | 'CreateTable' | 'CreateIndex' | 'CreateUniqueIndex' | 'AddForeignKey' | null = null;
  const buffer: string[] = [];
  const flush = (): void => {
    if (header && buffer.length > 0) {
      const sql = buffer.join('\n').trim();
      if (header === 'CreateEnum') {
        const m = sql.match(/CREATE TYPE "([^"]+)" AS ENUM/);
        if (m) statements.push({ kind: 'enum', subject: m[1], body: [], sql });
      } else if (header === 'CreateTable') {
        const m = sql.match(/CREATE TABLE "([^"]+)"/);
        if (m) statements.push({ kind: 'table', subject: m[1], body: buffer.map((l) => l.trim()), sql });
      } else if (header === 'CreateIndex' || header === 'CreateUniqueIndex') {
        const m = sql.match(/ON "([^"]+)"/);
        if (m) statements.push({ kind: 'index', subject: m[1], body: [], sql });
      } else if (header === 'AddForeignKey') {
        const target = sql.match(/ALTER TABLE "([^"]+)" ADD CONSTRAINT/);
        const referenced = sql.match(/REFERENCES "([^"]+)"/);
        if (target && referenced) {
          statements.push({ kind: 'fk', subject: target[1], referenced: referenced[1], body: [], sql });
        }
      }
    }
    buffer.length = 0;
    header = null;
  };
  for (const line of script.split(/\r?\n/)) {
    const section = line.match(/^-- (CreateSchema|CreateEnum|CreateTable|CreateIndex|CreateUniqueIndex|AddForeignKey)\s*$/);
    if (section) {
      flush();
      if (section[1] !== 'CreateSchema') header = section[1] as Exclude<typeof header, null>;
      continue;
    }
    if (header) buffer.push(line);
  }
  flush();
  return statements;
}

/** Keep only the anchor columns (ORGANIZATION_ANCHOR_COLUMNS) plus the primary
 *  key from the real full-model CREATE TABLE — the destination gets the
 *  identity anchor built directly from the Prisma schema definition, with no
 *  control-plane columns or defaults. */
export function reduceOrganizationTable(stmt: SchemaStatement): string {
  const lines = ['CREATE TABLE "Organization" ('];
  const seen = new Set<string>();
  const allowed = ORGANIZATION_ANCHOR_COLUMNS as readonly string[];
  for (const line of stmt.body) {
    const column = line.match(/^"([A-Za-z][A-Za-z0-9]*)"/)?.[1];
    if (column) {
      if (allowed.includes(column) && !seen.has(column)) {
        lines.push(line.endsWith(',') ? line : `${line},`);
        seen.add(column);
      }
    } else if (/^CONSTRAINT "Organization_pkey"/.test(line)) {
      lines.push(line);
    }
  }
  lines.push(');');
  return lines.join('\n');
}

/**
 * Reduce a full `prisma migrate diff` script to EXACTLY what the destination
 * needs: CREATE TABLE for every migration-plan table plus a reduced
 * Organization anchor, the indexes and foreign keys that stay INSIDE that set,
 * and only the enums those tables actually use. Everything else (platform /
 * control-plane tables, their FKs, their enums) is dropped. Pure — no I/O. */
export function subsetDestinationSchemaSql(script: string): string {
  const allowed = new Set<string>([...MIGRATION_TABLES.map((t) => t.table), 'Organization']);
  const statements = parseDiffScript(script);

  // Enum subset: only the enums referenced by a KEPT table's columns.
  // The reduced Organization body is scanned (not the full model) so an enum
  // used ONLY by a dropped control-plane column (e.g. deploymentMode) is not
  // carried over.
  const usedEnums = new Set<string>();
  for (const stmt of statements) {
    if (stmt.kind !== 'table' || !allowed.has(stmt.subject)) continue;
    const body =
      stmt.subject === 'Organization' ? reduceOrganizationTable(stmt).split(/\r?\n/) : stmt.body;
    for (const line of body) {
      const m = line.match(/^"[^"]+" "([^"]+)" (NOT )?NULL/);
      if (m) usedEnums.add(m[1]);
    }
  }

  const parts: string[] = [];
  for (const stmt of statements) {
    if (stmt.kind === 'enum') {
      if (usedEnums.has(stmt.subject)) parts.push(stmt.sql);
    } else if (stmt.kind === 'table') {
      if (stmt.subject === 'Organization') parts.push(reduceOrganizationTable(stmt));
      else if (allowed.has(stmt.subject)) parts.push(stmt.sql);
    } else if (stmt.kind === 'index') {
      if (!allowed.has(stmt.subject)) continue;
      // Organization indexes are kept only when they reference ANCHOR columns —
      // the reduced table no longer carries e.g. `subscriptionId`, so an index
      // on it would fail to apply.
      if (stmt.subject === 'Organization') {
        const m = stmt.sql.match(/ON "Organization"\(([^)]*)\)/);
        const cols = m
          ? m[1].split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
          : [];
        if (cols.every((c) => (ORGANIZATION_ANCHOR_COLUMNS as readonly string[]).includes(c))) {
          parts.push(stmt.sql);
        }
      } else {
        parts.push(stmt.sql);
      }
    } else if (stmt.kind === 'fk') {
      // Keep a foreign key only when BOTH ends are created here (org-internal
      // references). Any reference to a platform table is dropped.
      if (allowed.has(stmt.subject) && stmt.referenced !== undefined && allowed.has(stmt.referenced)) {
        parts.push(stmt.sql);
      }
    }
  }
  return parts.join('\n\n');
}

/** Run the offline `prisma migrate diff` compiler against the project's own
 *  Prisma schema (single source of truth — never a hand-maintained copy). No
 *  database connection is made, so no destination credentials are involved. */
export async function runMigrateDiffScript(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      [PRISMA_CLI_PATH, 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', DESTINATION_SCHEMA_PATH, '--script'],
      { timeout: SCHEMA_SYNC_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (!err) {
          resolve(String(stdout ?? ''));
          return;
        }
        const execErr = err as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals };
        const description = describeExecFailure(execErr) ?? `The destination schema compiler failed (${String(execErr.code ?? 'unknown')}).`;
        log.error('migration.schema.diff.failed', {
          exitCode: typeof execErr.code === 'number' ? execErr.code : null,
          error: extractSchemaSyncError({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), fallback: description }),
        });
        reject(new Error(description));
      }
    );
  });
}

/** Generate the additive destination-schema script (see subsetDestinationSchemaSql). */
export async function generateDestinationSchemaSql(): Promise<string> {
  return subsetDestinationSchemaSql(await runMigrateDiffScript());
}

/** Break a generated script into its individual `;`-terminated statements. */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const line of sql.split(/\r?\n/)) {
    current += line;
    if (line.trimEnd().endsWith(';')) {
      if (current.trim().length > 0) out.push(current);
      current = '';
    } else {
      current += '\n';
    }
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}

/** Apply the generated DDL to the destination inside ONE interactive
 *  transaction: any failure rolls EVERYTHING back, so a failed creation leaves
 *  the destination exactly as empty as before and the run stays retryable. */
export async function applyDestinationSchema(destination: PrismaClient, sql: string): Promise<void> {
  const statements = splitSqlStatements(sql);
  await destination.$transaction(
    async (tx) => {
      for (const statement of statements) {
        await tx.$executeRawUnsafe(statement);
      }
    },
    { maxWait: 60_000, timeout: SCHEMA_SYNC_TIMEOUT_MS },
  );
}

/**
 * PRECONDITIONS for the controlled legacy upgrade (upgradeLegacyDestination).
 * Every guard is a table/column + a value that MUST be data-free before the
 * corresponding obsolete object may be removed. Each guard names exactly what
 * the legacy object meant so the failure message stays actionable if a future
 * database violates the expectation. When data IS present, the upgrade refuses
 * and an operator must decide — never silent data loss.
 */
const LEGACY_GUARDS: ReadonlyArray<{
  table: string;
  column: string;
  describe: (count: number) => string;
}> = [
  {
    table: 'LicenseKey',
    column: 'id',
    describe: (n) => `legacy table "LicenseKey" still holds ${n} license-key row(s) — legacy license grants must be reviewed by an operator before removal`,
  },
  {
    table: 'Organization',
    column: 'licenseKeyId',
    describe: (n) => `${n} organization(s) still point at a license key via "Organization.licenseKeyId" — re-point or clear them deliberately first`,
  },
  {
    table: 'Plan',
    column: 'isSelfHosted',
    describe: (n) => `${n} plan(s) are flagged self-hosted — confirm no subscription depends on a self-hosted plan before removal`,
  },
];

/** Count rows that a legacy-object removal would affect (0 = safe to remove).
 *  Missing objects count as 0 — every guard is idempotent by construction. */
async function countLegacyGuardRows(destination: PrismaClient, table: string, column: string): Promise<number> {
  try {
    if (table === 'LicenseKey') {
      const rows = await destination.$queryRaw<Array<{ c: bigint }>>`SELECT COUNT(*)::bigint AS c FROM "LicenseKey"`;
      return Number(rows[0]?.c ?? 0);
    }
    if (table === 'Organization' && column === 'licenseKeyId') {
      const rows = await destination.$queryRaw<Array<{ c: bigint }>>`SELECT COUNT(*)::bigint AS c FROM "Organization" WHERE "licenseKeyId" IS NOT NULL`;
      return Number(rows[0]?.c ?? 0);
    }
    if (table === 'Plan' && column === 'isSelfHosted') {
      const rows = await destination.$queryRaw<Array<{ c: bigint }>>`SELECT COUNT(*)::bigint AS c FROM "Plan" WHERE "isSelfHosted" = true`;
      return Number(rows[0]?.c ?? 0);
    }
    return 0;
  } catch {
    // The object may not exist at all (already removed / different shape).
    return 0;
  }
}

/**
 * Build the ADDITIVE completion script for a legacy destination that is being
 * upgraded: only what is actually MISSING from the destination relative to the
 * current migration-plan schema, derived from the same `prisma migrate diff`
 * single source of truth.
 *
 * Why not simply re-run the EMPTY-path script? A legacy destination already
 * carries most plan tables (plus their types/indexes), so a naive re-run would
 * collide (duplicate table/type/index) — and it would MISS column drift on
 * existing tables (an older build's Screenshot lacks columns the current
 * schema added), which would later break the data copy. This builder:
 *   • emits CREATE TYPE only for enums the destination lacks;
 *   • emits CREATE TABLE only for plan tables the destination lacks
 *     (Organization anchor included when absent — never altered when present);
 *   • emits ADD COLUMN for plan-table columns the destination lacks
 *     (definitions taken verbatim from the current schema; enum-typed columns
 *     first ensure their type exists);
 *   • emits CREATE INDEX / FK only when the SUBJECT table is being created
 *     now (pre-existing tables keep their original indexes/constraints — the
 *     data copy needs only the primary key, which always exists).
 * Purely additive — no DROP/ALTER-of-existing ever appears in the output.
 */
async function buildLegacyAdditiveCompletion(destination: PrismaClient): Promise<string> {
  const script = await runMigrateDiffScript();
  const statements = parseDiffScript(script);
  const allowed = new Set<string>([...MIGRATION_TABLES.map((t) => t.table), 'Organization']);

  // Destination inventory (read-only).
  const tableRows = await destination.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
  const tables = new Set(tableRows.map((r) => String(r.table_name)));
  const columnRows = await destination.$queryRaw<Array<{ table_name: string; column_name: string }>>`
    SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`;
  const columns = new Map<string, Set<string>>();
  for (const c of columnRows) {
    const set = columns.get(String(c.table_name)) ?? new Set<string>();
    set.add(String(c.column_name));
    columns.set(String(c.table_name), set);
  }
  const typeRows = await destination.$queryRaw<Array<{ typname: string }>>`
    SELECT t.typname FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON t.typnamespace = n.oid WHERE n.nspname = 'public'`;
  const types = new Set(typeRows.map((r) => String(r.typname)));

  const parts: string[] = [];

  // Enums actually used by the migration-plan tables (+ the reduced anchor) —
  // the same contract as subsetDestinationSchemaSql: platform-only enums are
  // NOT carried into the destination (SSC-4).
  const usedEnums = new Set<string>();
  for (const stmt of statements) {
    if (stmt.kind !== 'table' || !allowed.has(stmt.subject)) continue;
    const body = stmt.subject === 'Organization' ? reduceOrganizationTable(stmt).split(/\r?\n/) : stmt.body;
    for (const line of body) {
      const m = line.match(/^"[^"]+" "([^"]+)" (NOT )?NULL/);
      if (m) usedEnums.add(m[1]);
    }
  }

  // 1. Missing enum types (needed both by fresh tables and ADD COLUMNs).
  for (const stmt of statements) {
    if (stmt.kind === 'enum' && usedEnums.has(stmt.subject) && !types.has(stmt.subject)) {
      parts.push(stmt.sql);
      types.add(stmt.subject);
    }
  }

  // 2. Missing plan tables / missing columns on existing plan tables.
  for (const stmt of statements) {
    if (stmt.kind !== 'table' || !allowed.has(stmt.subject)) continue;
    if (!tables.has(stmt.subject)) {
      parts.push(stmt.subject === 'Organization' ? reduceOrganizationTable(stmt) : stmt.sql);
      continue;
    }
    if (stmt.subject === 'Organization') continue; // the anchor is never altered
    const have = columns.get(stmt.subject) ?? new Set<string>();
    for (const line of stmt.body) {
      const m = line.match(/^"([A-Za-z][A-Za-z0-9_]*)"/);
      if (!m || have.has(m[1])) continue;
      const def = line.trim().replace(/,$/, '');
      // An enum-typed column requires its type to exist first.
      const tm = def.match(/^"[^"]+" "([^"]+)"/);
      if (tm && usedEnums.has(tm[1]) && !types.has(tm[1])) {
        const enumStmt = statements.find((s) => s.kind === 'enum' && s.subject === tm[1]);
        if (enumStmt) {
          parts.push(enumStmt.sql);
          types.add(tm[1]);
        }
      }
      parts.push(`ALTER TABLE "${stmt.subject}" ADD COLUMN ${def};`);
    }
  }

  // 3. Indexes / FKs — added only when their SUBJECT table is being created
  //  now: a brand-new table is empty, so an FK to an EXISTING plan table
  //  always validates, and indexes on it cannot collide. Pre-existing tables
  //  keep their original indexes/constraints untouched. Platform tables
  //  (e.g. Subscription) are never created here, so their constraints are
  //  never emitted even when they reference a plan table.
  for (const stmt of statements) {
    if (stmt.kind === 'index' && !tables.has(stmt.subject) && allowed.has(stmt.subject)) {
      parts.push(stmt.sql);
    }
    if (
      stmt.kind === 'fk' &&
      !tables.has(stmt.subject) &&
      allowed.has(stmt.subject) &&
      stmt.referenced !== undefined &&
      allowed.has(stmt.referenced)
    ) {
      parts.push(stmt.sql);
    }
  }

  return parts.join('\n\n');
}

/**
 * Controlled LEGACY destination upgrade (Phase 3/6): removes ONLY the obsolete
 * Self-Hosted/PRIVATE structures that carry no current business data, then
 * lets the normal additive completion run so a legacy `db push`-created
 * database (which has NO `_prisma_migrations` history) converges to the
 * migration-plan schema.
 *
 * Safety contract — this function is fail-closed on every axis:
 *   1. AUDIT (read-only): verifies the destination is not EMPTY and re-checks
 *      the LEGACY classification itself.
 *   2. GUARDS: for every removable object, counts the rows its removal would
 *      affect. ANY nonzero count REFUSES the whole upgrade (nothing removed,
 *      message names what an operator must review) — obsolete structures are
 *      only removed when PROVEN data-free.
 *   3. ADDITIVE script built FIRST (read-only): the destination is inventoried
 *      and the missing-schema script (enums/tables/columns/indexes/FKs the
 *      destination lacks) is derived from the same source of truth BEFORE any
 *      write happens. A failure here refuses with NOTHING modified.
 *   4. ATOMIC apply: cleanup + additive completion run inside ONE interactive
 *      transaction — `IF EXISTS` DROPs of exactly the four audited obsolete
 *      objects + the PRIVATE enum value (type swap, mirroring
 *      prisma/migrations/20260916000000_remove_private_deployment_mode —
 *      column defaults are dropped/re-added around the swap), then the
 *      additive statements. Any failure rolls EVERYTHING back, so the
 *      destination can never be left half-upgraded (and therefore
 *      unclassifiable/non-retryable).
 *   5. VERIFY: re-runs the classifier; must land on CURRENT_OMNISIGHT with all
 *      migration-plan tables present, else the failure is reported verbatim.
 *
 * IDEMPOTENT: every statement is IF EXISTS / additive; running it twice (or
 * on a destination that was already upgraded) is a no-op-safe re-run.
 */
async function upgradeLegacyDestination(
  destination: PrismaClient,
  legacy: { kind: 'LEGACY_OMNISIGHT'; conflicts: string[] }
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    // 1. Re-audit right before acting (never trust a stale classification).
    const cls = await classifyDestinationSchema(destination);
    if (cls.kind === 'CURRENT_OMNISIGHT') return { ok: true };
    if (cls.kind === 'FOREIGN_OR_UNKNOWN') {
      return {
        ok: false,
        error: `Destination database changed state while the legacy upgrade was starting: ${cls.reason}. Nothing was modified — resolve the destination state first.`,
      };
    }
    // EMPTY or LEGACY: both proceed below (cleanup only applies to LEGACY;
    // EMPTY simply skips straight to the additive completion).

    // 2a. Out-of-scope legacy fingerprints → REFUSE before touching anything.
    //     The controlled cleanup only covers the four audited Self-Hosted/
    //     PRIVATE artifacts; ANY other legacy structure (Guest, agent build
    //     tracking, …) means this database is an older generation the upgrade
    //     does not fully understand — never partially modify it.
    if (cls.kind === 'LEGACY_OMNISIGHT') {
      const inventory = await inventoryDestinationSchema(destination);
      const outOfScope: string[] = [];
      for (const table of OUT_OF_SCOPE_LEGACY_TABLES) {
        if (inventory.tables.has(table)) outOfScope.push(`table "${table}"`);
      }
      for (const [table, column] of OUT_OF_SCOPE_LEGACY_COLUMNS) {
        if (inventory.columns.get(table)?.has(column)) outOfScope.push(`column "${table}.${column}"`);
      }
      if (outOfScope.length > 0) {
        log.warn('migration.schema.legacy.out-of-scope', { outOfScope });
        return {
          ok: false,
          error: `Destination database is an EARLIER OmniSight generation whose legacy schema contains structures outside the controlled upgrade scope: ${outOfScope.join(', ')}. Detected legacy artifacts: ${cls.conflicts.join('; ')}. Nothing was modified — the existing data is intact. This destination requires a controlled legacy conversion reviewed by an operator, or a fresh empty Customer DB.`,
        };
      }
    }

    // 2. Guards — refuse unless every obsolete object is PROVEN data-free.
    const blockers: string[] = [];
    for (const guard of LEGACY_GUARDS) {
      const count = await countLegacyGuardRows(destination, guard.table, guard.column);
      if (count > 0) blockers.push(guard.describe(count));
    }
    if (blockers.length > 0) {
      log.warn('migration.schema.legacy.blocked', { blockers });
      return {
        ok: false,
        error: `Destination database is an EARLIER OmniSight generation whose legacy objects still carry data: ${blockers.join('; ')}. Nothing was modified — the existing data is intact. This destination requires a controlled legacy conversion (review the listed legacy records first), or configure a fresh empty Customer DB instead.`,
      };
    }

    // 3. Transactional removal of the audited obsolete structures.
    let privateOrphaned = 0;
    try {
      const rows = await destination.$queryRaw<Array<{ c: bigint }>>`
        SELECT COUNT(*)::bigint AS c FROM "Organization" WHERE "deploymentMode" = 'PRIVATE'`;
      privateOrphaned = Number(rows[0]?.c ?? 0);
    } catch {
      privateOrphaned = 0; // Organization absent (EMPTY re-audit race) — nothing to convert
    }
    if (privateOrphaned > 0) {
      return {
        ok: false,
        error: `Destination has ${privateOrphaned} organization(s) still in the retired PRIVATE deployment mode. Nothing was modified — convert them explicitly before upgrading this database.`,
      };
    }

    // The legacy DB may predate some of the enum's columns entirely (it was
    // `db push`-created by an older generation), so the type swap must be built
    // from the ACTUAL columns using the enum, discovered from pg_catalog —
    // never a hardcoded table list.
    const enumColumns = await destination.$queryRaw<
      Array<{ table_name: string; column_name: string; default_expr: string | null }>
    >`
      SELECT c.relname AS "table_name", a.attname AS "column_name",
             pg_get_expr(d.adbin, d.adrelid) AS "default_expr"
      FROM pg_attribute a
      JOIN pg_class c ON a.attrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND a.atttypid = '"DeploymentMode"'::regtype
        AND a.attnum > 0 AND NOT a.attisdropped`;

    await destination.$transaction(
      async (tx) => {
        // Organization.licenseKeyId — FK, unique index, then column.
        await tx.$executeRawUnsafe(`ALTER TABLE "Organization" DROP CONSTRAINT IF EXISTS "Organization_licenseKeyId_fkey"`);
        await tx.$executeRawUnsafe(`DROP INDEX IF EXISTS "Organization_licenseKeyId_key"`);
        await tx.$executeRawUnsafe(`ALTER TABLE "Organization" DROP COLUMN IF EXISTS "licenseKeyId"`);
        // LicenseKey table (its own indexes drop with it).
        await tx.$executeRawUnsafe(`DROP INDEX IF EXISTS "LicenseKey_key_key"`);
        await tx.$executeRawUnsafe(`DROP INDEX IF EXISTS "LicenseKey_organizationId_idx"`);
        await tx.$executeRawUnsafe(`DROP INDEX IF EXISTS "LicenseKey_planId_idx"`);
        await tx.$executeRawUnsafe(`DROP INDEX IF EXISTS "LicenseKey_isActive_idx"`);
        await tx.$executeRawUnsafe(`DROP INDEX IF EXISTS "LicenseKey_validUntil_idx"`);
        await tx.$executeRawUnsafe(`DROP TABLE IF EXISTS "LicenseKey"`);
        // Plan.isSelfHosted flag.
        await tx.$executeRawUnsafe(`ALTER TABLE "Plan" DROP COLUMN IF EXISTS "isSelfHosted"`);
        // DeploymentMode.PRIVATE — enum type swap (PG15 cannot ALTER TYPE DROP
        // VALUE). Column DEFAULTs are literals of the OLD enum type and cannot
        // be cast automatically between two distinct enum types, so each
        // discovered default is dropped before the column type change and
        // re-added afterwards (only the audited schema default 'MANAGED' is
        // ever restored). Statements reference only columns proven to exist.
        for (const col of enumColumns) {
          if (col.default_expr !== null) {
            await tx.$executeRawUnsafe(`ALTER TABLE "${col.table_name}" ALTER COLUMN "${col.column_name}" DROP DEFAULT`);
          }
        }
        await tx.$executeRawUnsafe(`ALTER TYPE "DeploymentMode" RENAME TO "DeploymentMode_legacy"`);
        await tx.$executeRawUnsafe(`CREATE TYPE "DeploymentMode" AS ENUM ('MANAGED', 'CUSTOMER_DB')`);
        for (const col of enumColumns) {
          await tx.$executeRawUnsafe(`ALTER TABLE "${col.table_name}" ALTER COLUMN "${col.column_name}" TYPE "DeploymentMode" USING "${col.column_name}"::text::"DeploymentMode"`);
        }
        for (const col of enumColumns) {
          // Restore only the known schema default (Organization → 'MANAGED').
          if (col.default_expr !== null && col.default_expr.includes('MANAGED')) {
            await tx.$executeRawUnsafe(`ALTER TABLE "${col.table_name}" ALTER COLUMN "${col.column_name}" SET DEFAULT 'MANAGED'`);
          }
        }
        await tx.$executeRawUnsafe(`DROP TYPE "DeploymentMode_legacy"`);

        // Additive completion — SAME transaction, so a failure in any missing-
        // schema statement rolls the ENTIRE upgrade (cleanup included) back:
        // the destination can never be left half-upgraded and unclassifiable.
        const script = await buildLegacyAdditiveCompletion(tx as unknown as PrismaClient);
        const statements = splitSqlStatements(script);
        for (const statement of statements) {
          await tx.$executeRawUnsafe(statement);
        }
      },
      { maxWait: 60_000, timeout: SCHEMA_SYNC_TIMEOUT_MS },
    );
    log.info('migration.schema.legacy.cleaned', { conflicts: legacy.conflicts });

    // 5. Verify — the destination must now classify as CURRENT.
    const after = await classifyDestinationSchema(destination);
    if (after.kind !== 'CURRENT_OMNISIGHT') {
      const reason = 'reason' in after ? after.reason : `unexpected classification ${after.kind}`;
      return {
        ok: false,
        error: `Legacy cleanup finished but the destination schema did not converge: ${reason}. The legacy upgrade is transactional per statement group — resolve the remaining difference and re-run.`,
      };
    }
    log.info('migration.schema.legacy.upgraded');
    return { ok: true };
  } catch (err) {
    log.error('migration.schema.legacy.upgrade.failed', { error: userSafeError(err) });
    return { ok: false, error: `The controlled legacy-database upgrade failed and nothing further was changed: ${userSafeError(err)}` };
  }
}

/**
 * STEP 1 — Prepare the destination schema for the data copy:
 *   • EMPTY   → create the plan tables + Organization anchor (additive, atomic);
 *   • CURRENT → success, nothing modified;
 *   • LEGACY  → CONTROLLED UPGRADE: the audited obsolete Self-Hosted/PRIVATE
 *     structures (LicenseKey, Organization.licenseKeyId, Plan.isSelfHosted,
 *     DeploymentMode='PRIVATE') are removed ONLY when proven data-free
 *     (fail-closed guards), then the schema additively converges to the
 *     migration plan. If any legacy object still carries data, the upgrade
 *     REFUSES with an explicit operator-action message and nothing is modified.
 *   • FOREIGN → REFUSED, nothing modified, the conflicting objects named.
 * Only ADD is ever performed outside the audited legacy cleanup — existing
 * objects are never dropped or altered, and no destination data is ever
 * destroyed.
 */
export async function prepareDestinationSchema(destination: PrismaClient): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const cls = await classifyDestinationSchema(destination);
    if (cls.kind === 'CURRENT_OMNISIGHT') return { ok: true };
    if (cls.kind === 'EMPTY') {
      const script = await generateDestinationSchemaSql();
      await applyDestinationSchema(destination, script);
      return { ok: true };
    }
    if (cls.kind === 'LEGACY_OMNISIGHT') {
      return upgradeLegacyDestination(destination, cls);
    }
    return {
      ok: false,
      error: `Destination schema could not be classified: ${cls.reason}. Refusing to modify an unrecognized database — nothing was touched.`,
    };
  } catch (err) {
    log.error('migration.schema.prep.failed', { error: userSafeError(err) });
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

/** Bounded identity read of the destination's Organization rows (no tenant content). */
interface DestinationOrgIdentity {
  id: string;
  slug: string | null;
}

/** Actionable, secret-free refusal for a destination that cannot be anchored. */
function destinationAnchorRefusal(orgId: string, detail: string): string {
  return (
    `Destination database is not eligible for this organization: ${detail}. ` +
    `A dedicated destination must be empty of organizations before the transfer, or already anchored to exactly this organization (id ${orgId}). ` +
    `Reconcile the destination "Organization" rows (a different org, a duplicate slug, or leftover rows) and retry. Nothing was written.`
  );
}

/**
 * Ensure the destination holds the ORGANIZATION ANCHOR row so org-owned
 * rows' `organizationId` FKs resolve. The anchor carries ONLY the org's
 * identity columns (id/name/slug/locale/status) — NEVER the platform
 * control-plane fields (subscription, license, seats, deployment mode),
 * which stay authoritative in the platform database. Idempotent: an existing
 * anchor (previous run) is left untouched.
 *
 * FAIL-CLOSED: a dedicated destination must hold NOTHING but this one
 * organization. The old implementation blindly ran
 * `INSERT ... ON CONFLICT ("id") DO NOTHING`, which only covers the PRIMARY KEY:
 * a destination already holding a DIFFERENT organization id but the SAME unique
 * slug threw a bare SQLSTATE 23505 — masked as
 * "Invalid `prisma.$executeRawUnsafe()` invocation:" — and failed the whole
 * transfer at the migrate stage. A NOT NULL column absent from the legacy anchor
 * failed the same opaque way (23502). We now INSPECT the destination first and
 * refuse with an actionable reason instead of writing anything.
 */
export async function ensureDestinationOrgAnchor(destination: PrismaClient, orgId: string): Promise<void> {
  const org = await db.organization.findUnique({
    where: { id: orgId },
    select: { id: true, name: true, slug: true, status: true, timezone: true, language: true, currency: true, createdAt: true, updatedAt: true },
  });
  if (!org) throw new Error('Organization not found in the platform database');

  const existing = await destination.$queryRawUnsafe<DestinationOrgIdentity[]>(
    `SELECT "id", "slug" FROM "Organization" ORDER BY "id" ASC LIMIT 50`
  );

  if (existing.length > 1) {
    throw new Error(destinationAnchorRefusal(orgId, `the destination already holds ${existing.length} organization rows`));
  }
  if (existing.length === 1) {
    const only = existing[0];
    if (only.id !== orgId) {
      throw new Error(
        destinationAnchorRefusal(
          orgId,
          `the destination already holds a different organization (id ${only.id}${only.slug ? `, slug "${only.slug}"` : ''})`
        )
      );
    }
    if ((only.slug ?? null) !== (org.slug ?? null)) {
      throw new Error(
        destinationAnchorRefusal(
          orgId,
          `the destination organization has a conflicting identity slug ("${only.slug ?? ''}" vs platform "${org.slug ?? ''}")`
        )
      );
    }
    return; // Idempotent: the exact, matching anchor is already present — left untouched.
  }

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
    // STEP 1: prepare the destination schema — classify it (empty / current
    // OmniSight / legacy OmniSight / unknown) and, for an EMPTY destination,
    // create ONLY the migration-plan tables plus the Organization anchor.
    // Existing objects are never dropped or altered; legacy/unknown
    // destinations are refused with the conflicting objects named, untouched.
    const prepare = await prepareDestinationSchema(destination);
    if (!prepare.ok) {
      return { ok: false, errorStage: 'schema', errorMessage: `Destination schema could not be synchronized: ${prepare.error}`, recordsDone, recordsTotal, tableProgress, zeroDrift: false };
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
 * The destination schema must already exist (e.g. created by
 * prepareDestinationSchema or a full schema push) — this function only moves
 * data. Returns true on success, false on failure.
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

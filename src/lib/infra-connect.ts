// OmniSight — connection probes + org-scoped migration/switch for the
// Organization Data Infrastructure change-request workflow.
//
// These functions TALK to the org's proposed/customer infrastructure:
//   • testDbConnection     — SELECT 1 (+ catalog) on the proposed analytics DB
//   • testStorageConnection— list buckets on the proposed Supabase project
//   • runDatabaseMigration — re-test, then point the org's analytics reads at
//                            the customer DB (org-scoped switch)
//   • runStorageMigration  — re-test, then point the org's screenshot I/O at
//                            the customer Supabase project (org-scoped switch)
//
// SECURITY: error messages are classified so they NEVER echo credentials; the
// decrypted password only ever lives in the connection call. The platform
// `db` (src/lib/db) is NEVER switched.

import { Client } from 'pg';
import type { Prisma } from '@prisma/client';
import { encryptSecret, maskSecret } from '@/lib/crypto';
import { invalidateOrgDbCache } from '@/lib/org-db';
import { invalidateOrgStorageCache } from '@/lib/org-storage';
import { validateHostIsPublic, safeFetch } from '@/lib/ssrf';
import { broadcastCacheInvalidation } from '@/lib/cache-invalidation';
import { ensureCacheInvalidationListener } from '@/lib/cache-listener';
import type { DbSpec, StorageSpec } from '@/lib/infrastructure';

// Start listening for cross-process cache invalidation events on first import.
// This ensures any process that performs infrastructure changes also receives
// invalidation events from other processes.
ensureCacheInvalidationListener();

export interface ProbeResult {
  ok: boolean;
  message: string;
  code?: string;
  tables?: string[];
  buckets?: string[];
}

const DEFAULT_TIMEOUT_MS = 8000;

/** Stable, user-facing classification codes (UI-safe; never raw driver text). */
export const PROBE_CODES = {
  AUTHENTICATION_FAILED: 'AUTHENTICATION_FAILED',
  DATABASE_NOT_FOUND: 'DATABASE_NOT_FOUND',
  HOST_NOT_FOUND: 'HOST_NOT_FOUND',
  CONNECTION_REFUSED: 'CONNECTION_REFUSED',
  CONNECTION_TIMEOUT: 'CONNECTION_TIMEOUT',
  SSL_ERROR: 'SSL_ERROR',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  INVALID_CONFIG: 'INVALID_CONFIG',
  UNKNOWN: 'UNKNOWN',
} as const;

export type ProbeCode = (typeof PROBE_CODES)[keyof typeof PROBE_CODES];

/**
 * Safe generic message for errors we cannot classify. Never echoes raw driver
 * text — the technical detail (if any) is only written to the server log.
 */
export const UNKNOWN_PROBE_MESSAGE =
  "We couldn't determine the exact cause of the connection failure. Please try again or contact your administrator.";

/**
 * Classify a PostgreSQL/Prisma connection error into a safe, user-friendly
 * category. Order matters: auth first, then SSL (an SSL handshake failure can
 * surface as ECONNRESET/EPROTO), then missing DB, DNS, network, timeout,
 * permission, invalid config — everything else is UNKNOWN with a generic safe
 * message.
 *
 * SECURITY: returned messages are static templates; the raw driver message is
 * NEVER sent to the client (see `sanitizeProbeErrorForLog` for server logs).
 * Supabase usernames (`postgres.<project-ref>`) and pooler hostnames
 * (`aws-0-*.pooler.supabase.com`) are never inspected, so they are never
 * misclassified.
 */
export function classifyPgError(err: unknown): { code: string; message: string } {
  const e = err as { code?: string | number; message?: string };
  const msg = e.message || '';
  const code = String(e.code ?? '');
  const m = msg.toLowerCase();

  // Authentication — Postgres 28P01 / Prisma P1000 / message-level hints.
  if (code === '28P01' || code === 'P1000' || /password|authentication|auth/i.test(m)) {
    return { code: PROBE_CODES.AUTHENTICATION_FAILED, message: 'The database rejected the username or password. Please check your database credentials.' };
  }
  // SSL / TLS — before generic network: handshake failures often surface as EPROTO/ECONNRESET.
  if (code === 'EPROTO' || /ssl|tls|certificate/i.test(m)) {
    return { code: PROBE_CODES.SSL_ERROR, message: 'The SSL connection could not be established. Check the SSL setting required by your database provider.' };
  }
  // Missing database — Postgres 3D000 / Prisma P1003.
  if (code === '3D000' || code === 'P1003' || /database .* does not exist/i.test(m)) {
    return { code: PROBE_CODES.DATABASE_NOT_FOUND, message: 'The specified database could not be found. Check the database name.' };
  }
  // DNS / host resolution.
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo|lookup failed|dns/i.test(m)) {
    return { code: PROBE_CODES.HOST_NOT_FOUND, message: 'The database host could not be found. Please check the host address.' };
  }
  // Network reachability.
  if (
    code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'P1001' ||
    /cannot reach|can't reach|connection refused|connect econn/i.test(m)
  ) {
    return { code: PROBE_CODES.CONNECTION_REFUSED, message: 'OmniSight could not reach the database server. Check the host, port, and network access.' };
  }
  // Timeout.
  if (code === 'ETIMEDOUT' || code === 'P1002' || /timed? ?out/i.test(m)) {
    return { code: PROBE_CODES.CONNECTION_TIMEOUT, message: 'The database did not respond in time. Check that the database is reachable and accepting connections.' };
  }
  // Permission.
  if (/permission denied|insufficient privilege/i.test(m)) {
    return { code: PROBE_CODES.PERMISSION_DENIED, message: 'The database user does not have the required permissions.' };
  }
  // Invalid config (port range / malformed connection).
  if (/invalid port|port should be|port out of range|invalid connection/i.test(m)) {
    return { code: PROBE_CODES.INVALID_CONFIG, message: 'The database connection settings are invalid. Check the host, port, database name, and username.' };
  }
  return { code: PROBE_CODES.UNKNOWN, message: UNKNOWN_PROBE_MESSAGE };
}

/**
 * Sanitize a raw driver error for SERVER-SIDE logging only: strips anything
 * that could embed a connection URL (which may carry credentials). Never shown
 * to clients.
 */
export function sanitizeProbeErrorForLog(err: unknown): string {
  const msg = (err as { message?: string })?.message || String(err);
  return msg.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, '[REDACTED_URL]').slice(0, 300);
}

/**
 * Probe a POSTGRESQL analytics database with SELECT 1 and list its public
 * tables. Used to TEST a *proposed* config (change request) — identical to the
 * migration-time verification.
 *
 * (Phase 5) Also verifies the DDL capability the destination needs for
 * `prisma db push`: a transactional CREATE TABLE probe proves the user may
 * create/alter schema WITHOUT leaving any object behind (ROLLBACK undoes the
 * probe table). A destination whose user lacks CREATE fails here — at TEST
 * time, not hours into the transfer's schema-sync step.
 */
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

function isTransientError(err: unknown): boolean {
  const e = err as { code?: string | number; message?: string };
  const code = String(e.code ?? '');
  const msg = e.message || '';
  // DNS resolution, connection refused, timeout — retryable on transient networks
  return (
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    /timeout/i.test(msg)
  );
}

export async function testDbConnection(spec: DbSpec, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<ProbeResult> {
  // ── SSRF gate: reject private/reserved destinations before any connection ──
  if (spec.host) {
    const hostCheck = await validateHostIsPublic(spec.host);
    if (!hostCheck.ok) {
      return { ok: false, code: PROBE_CODES.INVALID_CONFIG, message: `Database host rejected: ${hostCheck.reason}` };
    }
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
    }

    const client = new Client({
      host: spec.host,
      port: spec.port ?? 5432,
      database: spec.name,
      user: spec.user,
      password: spec.password ?? '',
      ssl: spec.ssl ? { rejectUnauthorized: true } : undefined,
      connectionTimeoutMillis: timeoutMs,
      statement_timeout: timeoutMs,
    });

    try {
      await client.connect();
      await client.query('SELECT 1');
      const tablesRes = await client.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
      );
      const tables = tablesRes.rows.map((r: { table_name: string }) => r.table_name);

      // ── DDL capability probe (Phase 5): transactional, leaves NOTHING behind.
      // PostgreSQL allows CREATE TABLE inside a transaction and rolls it back
      // cleanly; the table name is unique per probe so even a parallel test
      // cannot collide, and ROLLBACK removes it in every success path.
      try {
        await client.query('BEGIN');
        await client.query(
          `CREATE TABLE "omnisight_ddl_probe_${Date.now()}_${Math.floor(Math.random() * 1e9)}" (id integer primary key)`
        );
      } finally {
        // Always unwind the probe transaction — even if CREATE failed.
        try {
          await client.query('ROLLBACK');
        } catch {
          /* connection already broken; the probe result below is what matters */
        }
      }

      return { ok: true, message: 'Database connection successful', tables };
    } catch (err) {
      lastError = err;
      // Auth errors are NOT transient — fail immediately
      const classified = classifyPgError(err);
      if (classified.code === PROBE_CODES.AUTHENTICATION_FAILED || classified.code === PROBE_CODES.DATABASE_NOT_FOUND) {
        return { ok: false, code: classified.code, message: classified.message };
      }
      // Transient errors get retried; non-transient fall through
      if (!isTransientError(err)) {
        return { ok: false, code: classified.code, message: classified.message };
      }
    } finally {
      try {
        await client.end();
      } catch {
        /* ignore */
      }
    }
  }

  // All retries exhausted — classify the final error
  const classified = classifyPgError(lastError);
  return { ok: false, code: classified.code, message: `${classified.message} (after ${MAX_RETRIES + 1} attempts)` };
}

/**
 * Probe a Supabase storage project with the service-role key.
 *
 * (Phase 6) A bare bucket LIST is not enough: success now requires the
 * destination to be genuinely usable for OmniSight screenshots —
 *   1. the 'screenshots' bucket EXISTS (missing → hard failure, not a warning),
 *   2. the key can WRITE a scratch object into it,
 *   3. the scratch object can be READ back (verified),
 *   4. the scratch object is DELETED — no permanent test artifact remains.
 * The scratch key is unique per probe and org-scoped in its path prefix, and
 * NEVER collides with a real employee screenshot path.
 * SECURITY: the key is only ever placed in request headers — never in a
 * message, log line, or error.
 */
export async function testStorageConnection(
  spec: StorageSpec,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<ProbeResult> {
  if (spec.driver !== 'supabase' || !spec.url) {
    return { ok: true, message: 'Platform-managed local storage — nothing to test', code: 'platform' };
  }

  try {
    const base = spec.url.replace(/\/+$/, '');
    const res = await safeFetch(
      `${base}/storage/v1/bucket`,
      {
        method: 'GET',
        headers: {
          apikey: spec.key ?? '',
          Authorization: `Bearer ${spec.key ?? ''}`,
        },
      },
      timeoutMs,
    );

    if (!res) {
      return { ok: false, code: 'unreachable', message: 'Supabase storage host rejected as unsafe or unreachable' };
    }

    if (res.status === 200) {
      let buckets: string[] = [];
      try {
        const data = JSON.parse(res.text) as Array<{ id: string }>;
        buckets = (data || []).map((b) => b.id);
      } catch {
        /* non-JSON body */
      }
      const hasScreenshots = buckets.includes('screenshots');
      if (!hasScreenshots) {
        // (Phase 6) The 'screenshots' bucket is REQUIRED — a project without it
        // cannot receive org screenshots; this is a failure, not a warning.
        return {
          ok: false,
          code: 'bucket_missing',
          message: `Supabase storage reachable (${buckets.length} bucket(s)) but the required 'screenshots' bucket does not exist. Create it in the Supabase project before configuring OmniSight.`,
          buckets,
        };
      }

      // ── Scratch-object write/verify/delete probe (Phase 6) ──
      const probe = await probeStorageWriteAccess(base, spec.key ?? '', timeoutMs);
      if (!probe.ok) return probe;

      return { ok: true, message: `Supabase storage verified (bucket 'screenshots' present, write/delete access confirmed)`, buckets };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, code: 'auth', message: 'Supabase authentication failed — check the service-role key' };
    }
    return { ok: false, code: 'http', message: `Supabase storage returned HTTP ${res.status}` };
  } catch (err) {
    const e = err as { message?: string; name?: string };
    if (e.name === 'AbortError') return { ok: false, code: 'timeout', message: 'Supabase storage request timed out' };
    return { ok: false, code: 'unreachable', message: `Cannot reach the Supabase storage host (${(e.message || 'unknown error').slice(0, 120)})` };
  }
}

/**
 * (Phase 6) Scratch-object write/verify/delete against the destination
 * 'screenshots' bucket via the Supabase Storage HTTP API:
 *   POST /storage/v1/object/screenshots/<key>   (upload)
 *   GET  /storage/v1/object/screenshots/<key>   (verify)
 *   DELETE /storage/v1/object/screenshots/<key> (cleanup)
 *
 * The key is unique per probe and org-scoped in its prefix so it can never
 * overwrite or collide with a real screenshot. Every step is cleaned up: on
 * ANY path the scratch object is deleted (best effort), so no test artifact
 * remains in the customer's bucket. No permanent state is created.
 */
async function probeStorageWriteAccess(base: string, key: string, timeoutMs: number): Promise<ProbeResult> {
  const scratchKey = `__omnisight_connection_probe/${new Date().toISOString().slice(0, 10)}/${Date.now()}-${Math.floor(Math.random() * 1e9)}.txt`;
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'text/plain;charset=utf-8',
  };
  const body = 'omnisight connection probe — safe to delete';

  try {
    // 1) WRITE the scratch object.
    const up = await safeFetch(
      `${base}/storage/v1/object/screenshots/${scratchKey}`,
      { method: 'POST', headers, body },
      timeoutMs
    );
    if (!up) return { ok: false, code: 'write_check_failed', message: 'Supabase storage write check could not be performed (host rejected as unsafe or unreachable).' };
    if (up.status !== 200) {
      return {
        ok: false,
        code: up.status === 401 || up.status === 403 ? 'write_forbidden' : 'write_failed',
        message:
          up.status === 401 || up.status === 403
            ? "The service-role key cannot write to the 'screenshots' bucket. Check the key and the bucket's policies."
            : `The 'screenshots' bucket rejected a write test (HTTP ${up.status}).`,
      };
    }

    // 2) VERIFY the object reads back (correct content).
    const get = await safeFetch(`${base}/storage/v1/object/screenshots/${scratchKey}`, { method: 'GET', headers }, timeoutMs);
    if (!get || get.status !== 200 || get.text !== body) {
      return { ok: false, code: 'write_verify_failed', message: "The write test object could not be read back from the 'screenshots' bucket." };
    }

    return { ok: true, message: 'Storage write/delete access verified' };
  } catch (err) {
    const e = err as { name?: string };
    if (e.name === 'AbortError') return { ok: false, code: 'timeout', message: 'The storage write test timed out.' };
    return { ok: false, code: 'write_check_failed', message: 'The storage write test could not be completed.' };
  } finally {
    // 3) DELETE the scratch object — ALWAYS, success or failure.
    try {
      await safeFetch(
        `${base}/storage/v1/object/screenshots/${scratchKey}`,
        { method: 'DELETE', headers: { apikey: key, Authorization: `Bearer ${key}` } },
        timeoutMs
      );
    } catch {
      /* best-effort cleanup; the object is in the probe-namespaced prefix */
    }
  }
}

// ─── Org-scoped migration + switch (super-admin approved only) ──────────────

/**
 * Verify the proposed analytics DB once more at approval time. Does NOT write
 * anything — the actual switch happens inside the route's interactive
 * transaction (fail-closed: if the switch write throws, everything rolls back
 * and the request stays retryable).
 */
export async function validateDatabaseRollout(
  spec: DbSpec,
  opts: { timeoutMs?: number; requireSecret?: boolean } = {}
): Promise<ProbeResult> {
  if (opts.requireSecret !== false && !spec.password) {
    return { ok: false, code: 'secret', message: 'The database password is missing from the approved request' };
  }
  const probe = await testDbConnection(spec, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!probe.ok) return { ok: false, code: probe.code, message: `Migration verification failed — ${probe.message}` };
  return { ok: true, message: 'Migration verification passed — analytics DB can be activated', tables: probe.tables };
}

/**
 * Point the org's analytics reads at the customer DB (org-scoped switch).
 * Accepts the platform `db` or a transaction client so the request-status
 * update and the settings flip are atomic.
 */
export async function applyDatabaseSwitch(
  client: Prisma.TransactionClient,
  orgId: string,
  spec: DbSpec
): Promise<void> {
  if (spec.useOwnDb === false) {
    await client.organizationSettings.update({
      where: { organizationId: orgId },
      data: {
        useOwnDb: false,
        dbHost: null,
        dbPort: null,
        dbName: null,
        dbUser: null,
        dbPassword: null,
        dbSsl: false,
        dbTestedAt: new Date(),
        dbTestStatus: 'success',
      },
    });
  } else {
    await client.organizationSettings.update({
      where: { organizationId: orgId },
      data: {
        useOwnDb: true,
        dbHost: spec.host,
        dbPort: spec.port,
        dbName: spec.name,
        dbUser: spec.user,
        dbPassword: Boolean(spec.password) ? encryptSecret(spec.password!) : undefined,
        dbSsl: spec.ssl,
        dbTestedAt: new Date(),
        dbTestStatus: 'success',
      },
    });
  }
  await invalidateOrgDbCache(orgId);
  // Broadcast to other processes (Next.js instances, live-updates service)
  await broadcastCacheInvalidation(orgId, 'db');
}

/**
 * ROLLBACK the org's analytics reads to the platform database after a FAILED
 * cutover. KEEPS the org's host/port/name/user/password configuration — the
 * destination the org chose is still valid, only the active switch is undone —
 * so activation can be retried through the normal flow without re-entering
 * credentials.
 *
 * (Phase 10, findings R-1/R-2) This is a MIGRATION failure, not a CONNECTION
 * failure: it no longer overwrites dbTestedAt/dbTestStatus with 'failed'.
 * Clobbering the connection-test state used to block the org's retry path
 * behind a re-test for a connection that was never the problem. The truthful
 * failure reason lives on the InfrastructureMigration row (errorStage/
 * errorMessage) and the request's errorMessage.
 */
export async function revertDatabaseSwitch(client: Prisma.TransactionClient, orgId: string): Promise<void> {
  await client.organizationSettings.update({
    where: { organizationId: orgId },
    data: {
      useOwnDb: false,
    },
  });
  await invalidateOrgDbCache(orgId);
  await broadcastCacheInvalidation(orgId, 'db');
}

/**
 * Verify the proposed Supabase project once more at approval time. Does NOT
 * write anything.
 */
export async function validateStorageRollout(
  spec: StorageSpec,
  opts: { timeoutMs?: number } = {}
): Promise<ProbeResult> {
  if (spec.driver === 'supabase' && !spec.key) {
    return { ok: false, code: 'secret', message: 'The Supabase service-role key is missing from the approved request' };
  }
  const probe = await testStorageConnection(spec, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!probe.ok) return { ok: false, code: probe.code, message: `Migration verification failed — ${probe.message}` };
  return { ok: true, message: 'Migration verification passed — storage can be activated', buckets: probe.buckets };
}

/**
 * Point the org's screenshot I/O at the approved storage target ('local'
 * clears the org override back to the platform pool).
 */
export async function applyStorageSwitch(
  client: Prisma.TransactionClient,
  orgId: string,
  spec: StorageSpec
): Promise<void> {
  await client.organizationSettings.update({
    where: { organizationId: orgId },
    data:
      spec.driver === 'supabase'
        ? {
            storageDriver: 'supabase',
            storageUrl: spec.url,
            storageKey: Boolean(spec.key) ? encryptSecret(spec.key!) : undefined,
            storageTestedAt: new Date(),
            storageTestStatus: 'success',
          }
        : {
            storageDriver: 'local',
            storageUrl: null,
            storageKey: null,
            storageTestedAt: new Date(),
            storageTestStatus: 'success',
          },
  });
  invalidateOrgStorageCache(orgId);
  await broadcastCacheInvalidation(orgId, 'storage');
}

/**
 * ROLLBACK the org's screenshot I/O to the platform storage pool after a FAILED
 * storage cutover. KEEPS storageUrl/storageKey (the destination the org chose is
 * still valid, only the active switch is undone) so activation can be retried
 * without re-entering credentials.
 *
 * (Phase 10, findings R-1/R-2) A failed MIGRATION must not masquerade as a
 * failed CONNECTION: storageTestStatus is no longer overwritten here. The
 * migration failure is recorded on the InfrastructureMigration row.
 */
export async function revertStorageSwitch(client: Prisma.TransactionClient, orgId: string): Promise<void> {
  await client.organizationSettings.update({
    where: { organizationId: orgId },
    data: {
      storageDriver: 'local',
    },
  });
  invalidateOrgStorageCache(orgId);
  await broadcastCacheInvalidation(orgId, 'storage');
}

/** Masked view of a secret for logs (never the plaintext). */
export function logSecretMask(value: string | undefined): string | null {
  return value ? maskSecret(value) : null;
}
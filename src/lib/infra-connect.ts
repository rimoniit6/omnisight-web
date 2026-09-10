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
import type { DbSpec, StorageSpec } from '@/lib/infrastructure';

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
      ssl: spec.ssl ? { rejectUnauthorized: false } : undefined,
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
 * Probe a Supabase storage project by listing its buckets with the
 * service-role key. 'local' driver always reports ok (platform-managed).
 * NEVER includes the key in messages.
 */
export async function testStorageConnection(
  spec: StorageSpec,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<ProbeResult> {
  if (spec.driver !== 'supabase' || !spec.url) {
    return { ok: true, message: 'Platform-managed local storage — nothing to test', code: 'platform' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const base = spec.url.replace(/\/+$/, '');
    const res = await fetch(`${base}/storage/v1/bucket`, {
      method: 'GET',
      headers: {
        apikey: spec.key ?? '',
        Authorization: `Bearer ${spec.key ?? ''}`,
      },
      signal: controller.signal,
    });

    if (res.status === 200) {
      let buckets: string[] = [];
      try {
        const data = (await res.json()) as Array<{ id: string }>;
        buckets = (data || []).map((b) => b.id);
      } catch {
        /* non-JSON body */
      }
      const hasScreenshots = buckets.includes('screenshots');
      const message = hasScreenshots
        ? `Supabase storage reachable (${buckets.length} bucket(s), 'screenshots' bucket present)`
        : `Supabase storage reachable (${buckets.length} bucket(s)) — no 'screenshots' bucket found; create one for org rollout`;
      return { ok: true, message, buckets };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, code: 'auth', message: 'Supabase authentication failed — check the service-role key' };
    }
    return { ok: false, code: 'http', message: `Supabase storage returned HTTP ${res.status}` };
  } catch (err) {
    const e = err as { message?: string; name?: string };
    if (e.name === 'AbortError') return { ok: false, code: 'timeout', message: 'Supabase storage request timed out' };
    return { ok: false, code: 'unreachable', message: `Cannot reach the Supabase storage host (${(e.message || 'unknown error').slice(0, 120)})` };
  } finally {
    clearTimeout(timer);
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
}

/**
 * ROLLBACK the org's analytics reads to the platform database after a FAILED
 * cutover. Unlike applyDatabaseSwitch({useOwnDb:false}) this KEEPS the org's
 * host/port/name/user/password configuration — the destination the org chose
 * is still valid, only the active switch is undone — so activation can be
 * retried through the normal flow without re-entering credentials. The failed
 * test-status is persisted so the UI surfaces why the org is back on platform.
 */
export async function revertDatabaseSwitch(client: Prisma.TransactionClient, orgId: string): Promise<void> {
  await client.organizationSettings.update({
    where: { organizationId: orgId },
    data: {
      useOwnDb: false,
      dbTestedAt: new Date(),
      dbTestStatus: 'failed',
    },
  });
  await invalidateOrgDbCache(orgId);
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
}

/**
 * ROLLBACK the org's screenshot I/O to the platform storage pool after a FAILED
 * storage cutover. KEEPS storageUrl/storageKey (the destination the org chose is
 * still valid, only the active switch is undone) so activation can be retried
 * without re-entering credentials; marks the test status failed so the UI
 * surfaces why the org is back on the platform pool.
 */
export async function revertStorageSwitch(client: Prisma.TransactionClient, orgId: string): Promise<void> {
  await client.organizationSettings.update({
    where: { organizationId: orgId },
    data: {
      storageDriver: 'local',
      storageTestedAt: new Date(),
      storageTestStatus: 'failed',
    },
  });
  invalidateOrgStorageCache(orgId);
}

/** Masked view of a secret for logs (never the plaintext). */
export function logSecretMask(value: string | undefined): string | null {
  return value ? maskSecret(value) : null;
}
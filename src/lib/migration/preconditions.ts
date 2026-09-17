// OmniSight — server-side PRECONDITIONS for starting an organization data
// migration ("Transfer Organization Data").
//
// Verified forensic root cause RC-1: the transfer gate used to read
// OrganizationSettings.dbTestStatus / storageTestStatus — fields that only
// become 'success' at CUTOVER time (applyDatabaseSwitch / applyStorageSwitch)
// — so a freshly configured org could never pass the gate while the UI showed
// "Connection verified". The authoritative evidence instead lives on the
// InfrastructureChangeRequest row (lastTestStatus + lastTestedAt +
// lastTestConfigFingerprint), written by the connection-test routes.
//
// This module is the ONE place that decides whether a request may start a
// migration. Every check is server-side and DB-driven; the client cannot
// assert success (Phase 2), evidence must be fresh (Phase 3), and the
// destination is revalidated live before any copy begins (Phase 4).
//
// SECURITY: no secret ever enters a returned error or a log line — errors are
// user-safe templates; raw probes are sanitized via the existing helpers.

import { db } from '@/lib/db';
import { decryptSecret } from '@/lib/crypto';
import { log } from '@/lib/logger';
import {
  configFingerprint,
  dbConfigFingerprintInput,
  storageConfigFingerprintInput,
  type InfraKind,
} from '@/lib/infrastructure';
import {
  isTestEvidenceFresh,
  testEvidenceExpiryReason,
  testEvidenceMismatchReason,
} from '@/lib/infrastructure-state';
import { validateDatabaseRollout, validateStorageRollout } from '@/lib/infra-connect';

export interface RequestPreconditionInput {
  id: string;
  kind: string;
  status: string;
  requestNo: number;
  configJson: string;
  dbPasswordEncrypted: string | null;
  storageKeyEncrypted: string | null;
  lastTestStatus: string | null;
  lastTestMessage: string | null;
  lastTestedAt: Date | null;
  lastTestConfigFingerprint: string | null;
}

export type PreconditionResult =
  | { ok: true }
  | { ok: false; status: number; error: string; needsRetest?: boolean };

/**
 * Recompute the request config's fingerprint from its immutable snapshot.
 * Exported for the org-side request views (UI mirrors the gate's state machine
 * from the same persisted evidence — never from client-held flags).
 */
export async function computeRequestConfigFingerprint(kind: string, configJson: string): Promise<string | null> {
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(configJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  return requestConfigFingerprint(kind, cfg);
}

/** Recompute the request config's fingerprint from its parsed snapshot. */
async function requestConfigFingerprint(kind: string, cfg: Record<string, unknown>): Promise<string | null> {
  try {
    if (kind === 'DATABASE') {
      if (cfg.useOwnDb === false) return null; // disable request — no config to test
      return await configFingerprint(
        dbConfigFingerprintInput({
          host: String(cfg.host ?? ''),
          port: typeof cfg.port === 'number' ? cfg.port : null,
          name: String(cfg.name ?? ''),
          user: String(cfg.user ?? ''),
          ssl: Boolean(cfg.ssl),
          useOwnDb: true,
        })
      );
    }
    const driver = cfg.driver === 'supabase' ? 'supabase' : 'local';
    if (driver === 'local') return null;
    return await configFingerprint(storageConfigFingerprintInput({ driver, url: String(cfg.url ?? '') }));
  } catch {
    return null;
  }
}

/**
 * Evidence gate (Phases 1–3): the request must carry a SUCCESSFUL test result
 * for the EXACT configuration in its snapshot, recorded within the TTL.
 * Returns a user-safe, actionable error on every blocked path.
 */
export async function checkRequestTestEvidence(request: RequestPreconditionInput): Promise<PreconditionResult> {
  const kind = request.kind as InfraKind;
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(request.configJson) as Record<string, unknown>;
  } catch {
    return { ok: false, status: 422, error: 'The change request snapshot is malformed — resubmit the configuration.' };
  }

  // A request that disables the dedicated infra needs no destination test.
  const isDisable = (kind === 'DATABASE' && cfg.useOwnDb === false) || (kind === 'STORAGE' && cfg.driver !== 'supabase');
  if (isDisable) return { ok: true };

  // The tested config must be the SAME config the request will migrate to.
  const expectedFingerprint = await requestConfigFingerprint(request.kind, cfg);
  if (!expectedFingerprint) {
    return { ok: false, status: 422, error: 'The change request snapshot has no testable destination configuration — resubmit the configuration.' };
  }
  if (!request.lastTestConfigFingerprint) {
    // Requests submitted through the current flow always bind evidence to the
    // config. Missing fingerprint = legacy request → require a re-test.
    return {
      ok: false, status: 422, needsRetest: true,
      error: testEvidenceMismatchReason(),
    };
  }
  if (request.lastTestConfigFingerprint !== expectedFingerprint) {
    return { ok: false, status: 422, needsRetest: true, error: testEvidenceMismatchReason() };
  }
  if (request.lastTestStatus !== 'success') {
    return {
      ok: false, status: 422, needsRetest: true,
      error: request.lastTestMessage
        ? `The last connection test for this configuration failed: ${request.lastTestMessage}`
        : 'This configuration has not been successfully tested yet. Test the connection before transferring data.',
    };
  }
  if (!isTestEvidenceFresh(request.lastTestedAt)) {
    return { ok: false, status: 422, needsRetest: true, error: testEvidenceExpiryReason() };
  }
  return { ok: true };
}

/**
 * Live revalidation (Phase 4): before any migration work starts, probe the
 * destination ONE more time with the request's decrypted secret. This is the
 * same authoritative probe the Super Admin approval runs — never a client
 * claim. SSRF protection runs inside testDbConnection / safeFetch.
 */
export async function revalidateDestination(request: RequestPreconditionInput): Promise<PreconditionResult> {
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(request.configJson) as Record<string, unknown>;
  } catch {
    return { ok: false, status: 422, error: 'The change request snapshot is malformed — resubmit the configuration.' };
  }

  try {
    if (request.kind === 'DATABASE') {
      if (cfg.useOwnDb === false) return { ok: true }; // disable — nothing to probe
      const password = request.dbPasswordEncrypted ? decryptSecret(request.dbPasswordEncrypted) : undefined;
      const probe = await validateDatabaseRollout({
        host: String(cfg.host ?? ''),
        port: typeof cfg.port === 'number' ? cfg.port : null,
        name: String(cfg.name ?? ''),
        user: String(cfg.user ?? ''),
        ssl: Boolean(cfg.ssl),
        useOwnDb: true,
        ...(password ? { password } : {}),
      });
      if (!probe.ok) {
        return { ok: false, status: 422, needsRetest: true, error: probe.message };
      }
      return { ok: true };
    }
    const driver = cfg.driver === 'supabase' ? 'supabase' : 'local';
    if (driver === 'local') return { ok: true };
    const key = request.storageKeyEncrypted ? decryptSecret(request.storageKeyEncrypted) : undefined;
    const probe = await validateStorageRollout({ driver, url: String(cfg.url ?? ''), ...(key ? { key } : {}) });
    if (!probe.ok) {
      return { ok: false, status: 422, needsRetest: true, error: probe.message };
    }
    return { ok: true };
  } catch (err) {
    // Never leak probe internals (may embed driver text); classify upstream.
    log.warn('migration.preconditions.revalidate_failed', { requestId: request.id, kind: request.kind, error: String((err as Error)?.name ?? 'error') });
    return { ok: false, status: 502, error: 'The destination could not be validated. Check the connection and try again.' };
  }
}

/**
 * Full gate for one request: evidence first (cheap, DB-only), then a live
 * probe of the destination. The probe result is NOT persisted as new test
 * evidence — it is a pre-flight re-validation; the copy itself re-verifies.
 */
export async function checkMigrationPreconditions(request: RequestPreconditionInput): Promise<PreconditionResult> {
  const evidence = await checkRequestTestEvidence(request);
  if (!evidence.ok) return evidence;
  return revalidateDestination(request);
}

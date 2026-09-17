// OmniSight — infrastructure connection-test EVIDENCE state (single source of
// truth).
//
// The transfer gate used to read OrganizationSettings.dbTestStatus /
// storageTestStatus — fields that only become 'success' at CUTOVER time — so a
// freshly configured org could never pass the gate (verified forensic finding
// RC-1). The authoritative test evidence instead lives on the
// InfrastructureChangeRequest row (lastTestStatus / lastTestedAt /
// lastTestConfigFingerprint), written by the connection-test routes.
//
// Everything in this module is PURE (no DB, no network) so the same state
// machine can be enforced server-side and mirrored in the UI without drift.

import { dbConfigFingerprintInput, storageConfigFingerprintInput, configFingerprint } from '@/lib/infrastructure';

// ─── Test-evidence freshness (Phase 3) ───────────────────────────────────────
// One constant; every consumer derives from this (no duplicated TTLs).
// 7 days: connection credentials/network paths change rarely, but stale
// evidence must not silently authorize a multi-hour data migration.
export const INFRA_TEST_EVIDENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const INFRA_TEST_EVIDENCE_TTL_DAYS = 7;

export type ConnectionTestStatus = 'success' | 'failed' | 'not-run';

/** The test-evidence fields carried by an InfrastructureChangeRequest row. */
export interface RequestTestEvidence {
  lastTestStatus: string | null;
  lastTestMessage: string | null;
  lastTestedAt: Date | string | null;
  lastTestConfigFingerprint: string | null;
}

/**
 * Build the evidence patch a successful/failed PROPOSED-config test should
 * persist on the matching open request. The fingerprint is recomputed
 * SERVER-SIDE from the config that was actually probed — a client can never
 * assert success for a config the server did not test (Phase 2).
 */
export async function buildRequestTestEvidence(
  result: { ok: boolean; message: string },
  config: { kind: 'DATABASE'; host: string; port: number | null; name: string; user: string; ssl: boolean; useOwnDb?: boolean }
    | { kind: 'STORAGE'; driver: string; url: string | null }
): Promise<RequestTestEvidence> {
  const fingerprint =
    config.kind === 'DATABASE'
      ? await configFingerprint(dbConfigFingerprintInput(config))
      : await configFingerprint(storageConfigFingerprintInput(config));
  return {
    lastTestStatus: result.ok ? 'success' : 'failed',
    lastTestMessage: result.message,
    lastTestedAt: new Date(),
    lastTestConfigFingerprint: fingerprint,
  };
}

/**
 * True when the evidence was recorded within the freshness window.
 * Accepts Date or ISO string (API view) so both layers share one rule.
 * Evidence stamped in the FUTURE (clock skew / tampering) is never fresh.
 */
export function isTestEvidenceFresh(lastTestedAt: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (!lastTestedAt) return false;
  const t = lastTestedAt instanceof Date ? lastTestedAt.getTime() : Date.parse(lastTestedAt);
  if (!Number.isFinite(t)) return false;
  const age = now.getTime() - t;
  return age >= 0 && age <= INFRA_TEST_EVIDENCE_TTL_MS;
}

/** Human-facing reason when evidence is stale/missing (used by gate + UI). */
export function testEvidenceExpiryReason(): string {
  return `The connection test for this configuration is older than ${INFRA_TEST_EVIDENCE_TTL_DAYS} days. Please test the connection again before transferring data.`;
}

/** Reason when the tested config does not match the request's config. */
export function testEvidenceMismatchReason(): string {
  return 'The configuration has changed since the last connection test. Please test the connection again before transferring data.';
}

// ─── Org-side connection state machine (mirrored in the UI) ─────────────────

export type OrgConnectionState =
  | 'not_configured'      // no destination configured on the request/config
  | 'untested'            // configured, never tested
  | 'testing'             // (client-only transient; server never reports this)
  | 'verified'            // tested OK, config matches, evidence fresh
  | 'test_expired'        // tested OK, but older than the TTL
  | 'config_changed'      // tested OK, but for a DIFFERENT config
  | 'test_failed';        // last test attempt failed

/**
 * Derive the connection state for ONE kind from the request's test evidence
 * and the config it applies to. `configFingerprint` is the server-recomputed
 * fingerprint of the config being evaluated (from the request snapshot).
 *
 * Rules (mirrors the transfer gate exactly):
 *   • no success evidence          → untested / test_failed
 *   • success + fingerprint absent → verified (legacy evidence recorded before
 *     fingerprints existed; the gate separately requires a fingerprint for
 *     requests created after this change)
 *   • success + fingerprint match  → verified | test_expired (by age)
 *   • success + fingerprint differ → config_changed
 */
export function deriveConnectionState(evidence: {
  lastTestStatus: string | null;
  lastTestedAt: Date | string | null;
  lastTestConfigFingerprint: string | null;
}, configFingerprint: string | null): OrgConnectionState {
  if (evidence.lastTestStatus === 'failed') return 'test_failed';
  if (evidence.lastTestStatus !== 'success') return 'untested';
  if (!evidence.lastTestConfigFingerprint) {
    // Success recorded without a bound fingerprint (legacy rows) — trust the
    // status but not the binding; age still applies.
    return isTestEvidenceFresh(evidence.lastTestedAt) ? 'verified' : 'test_expired';
  }
  if (configFingerprint && evidence.lastTestConfigFingerprint !== configFingerprint) {
    return 'config_changed';
  }
  return isTestEvidenceFresh(evidence.lastTestedAt) ? 'verified' : 'test_expired';
}

/** Short UI label for a connection state. */
export function connectionStateLabel(state: OrgConnectionState): string {
  switch (state) {
    case 'verified': return 'Connection verified';
    case 'test_expired': return 'Test expired — re-test required';
    case 'config_changed': return 'Configuration changed — re-test required';
    case 'test_failed': return 'Validation failed';
    case 'testing': return 'Testing…';
    case 'untested': return 'Not tested';
    case 'not_configured': return 'Not configured';
  }
}

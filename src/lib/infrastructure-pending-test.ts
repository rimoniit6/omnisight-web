// OmniSight — org-scoped PENDING connection-test evidence.
//
// The transfer gate requires fingerprint-bound, fresh test evidence on the
// EXACT InfrastructureChangeRequest being migrated (RC-1). A test that runs
// BEFORE the request exists (Test Connection → then submit) therefore used to
// leave nothing behind: the evidence was discarded because
// findOpenChangeRequest() returned null, and a request created by an older
// runtime stayed untested and un-migratable.
//
// This module persists that pre-submit test result as PENDING evidence on the
// organization (one row per kind). It is a cache of a real, server-derived
// probe result — never a client claim:
//   • only non-secret metadata is stored (status/message/timestamp/fingerprint);
//   • the fingerprint is the same server-computed hash the request stores;
//   • selection below requires a SUCCESS for the EXACT submitted config that is
//     still inside the shared freshness window.
//
// It deliberately does NOT replace the authoritative live probe at submit time:
// the submit routes still probe the destination with the just-provided secret,
// and the migration gate still reads the request's own evidence. This only
// ensures a genuine pre-submit test is bound to the request instead of lost.

import { db } from '@/lib/db';
import { isTestEvidenceFresh, type RequestTestEvidence } from '@/lib/infrastructure-state';

export type InfraPendingKind = 'DATABASE' | 'STORAGE';

/** The pending-test row shape (org-scoped; secrets are never stored here). */
export interface PendingTestEvidence {
  lastTestStatus: string | null;
  lastTestMessage: string | null;
  lastTestedAt: Date | null;
  lastTestConfigFingerprint: string | null;
}

/** Persist the latest PROPOSED-config test result for (org, kind). Upsert:
 *  one row per organization+kind, so a re-test replaces the previous result. */
export async function recordPendingTestEvidence(
  organizationId: string,
  kind: InfraPendingKind,
  evidence: RequestTestEvidence
): Promise<void> {
  const data = {
    lastTestStatus: evidence.lastTestStatus,
    lastTestMessage: evidence.lastTestMessage,
    lastTestedAt: evidence.lastTestedAt ? new Date(evidence.lastTestedAt) : null,
    lastTestConfigFingerprint: evidence.lastTestConfigFingerprint,
  };
  await db.infrastructurePendingTest.upsert({
    where: { organizationId_kind: { organizationId, kind } },
    create: { organizationId, kind, ...data },
    update: data,
  });
}

/** Read the pending evidence for (org, kind), or null when none exists. */
export async function loadPendingTestEvidence(
  organizationId: string,
  kind: InfraPendingKind
): Promise<PendingTestEvidence | null> {
  const row = await db.infrastructurePendingTest.findUnique({
    where: { organizationId_kind: { organizationId, kind } },
  });
  if (!row) return null;
  return {
    lastTestStatus: row.lastTestStatus,
    lastTestMessage: row.lastTestMessage,
    lastTestedAt: row.lastTestedAt,
    lastTestConfigFingerprint: row.lastTestConfigFingerprint,
  };
}

/**
 * Pure selection rule. A pending test may be bound to a submitted request ONLY
 * when ALL of the following hold:
 *   • it recorded a SUCCESS (a failed/never-run test is never bindable);
 *   • it carries a fingerprint (legacy evidence without one is never trusted);
 *   • the fingerprint EQUALS the server-recomputed fingerprint of the config
 *     being submitted (a changed config invalidates the old test);
 *   • it is still inside the shared freshness window (future stamps are never
 *     fresh — see isTestEvidenceFresh).
 * Returns null on any other path, so the caller falls back to requiring a
 * fresh test rather than binding stale/foreign evidence.
 */
export function selectBindablePendingEvidence(
  pending: PendingTestEvidence | null,
  expectedFingerprint: string | null,
  now: Date = new Date()
): RequestTestEvidence | null {
  if (!pending || !expectedFingerprint) return null;
  if (pending.lastTestStatus !== 'success') return null;
  if (!pending.lastTestConfigFingerprint) return null;
  if (pending.lastTestConfigFingerprint !== expectedFingerprint) return null;
  if (!isTestEvidenceFresh(pending.lastTestedAt, now)) return null;
  return {
    lastTestStatus: pending.lastTestStatus,
    lastTestMessage: pending.lastTestMessage,
    lastTestedAt: pending.lastTestedAt,
    lastTestConfigFingerprint: pending.lastTestConfigFingerprint,
  };
}

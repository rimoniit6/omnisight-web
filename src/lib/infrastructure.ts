// OmniSight — Organization Data Infrastructure change-request workflow
// (Part 18 compliance). Org Admins NEVER write the active analytics DB /
// storage configuration directly; every such change is a change request that a
// Super Admin approves, and only then is it migrated + activated.
//
//   draft -> submitted -> approved -> applied -> active
//     \-> cancelled      \-> rejected      (switch applied)
//
// Since real data migration exists, 'approved' now means "migration queued":
// the background runner copies the org's data to the destination, verification
// gates activation, and a separate explicit Super Admin action activates the
// new infrastructure. Approval NEVER switches settings by itself.
//
// A newer request for the same (organizationId, kind) supersedes any earlier
// OPEN request (draft / submitted / approved-with-error) the moment it is
// submitted. Submitted requests are IMMUTABLE — edits are rejected with 409.
//
// Secrets (dbPassword / supabase service-role key) are encrypted at rest via
// src/lib/crypto.ts (AES-256-GCM) and are NEVER returned in plaintext and
// NEVER logged; every serialized view exposes only a passwordLast4 / hasKey
// flag.

import { db } from '@/lib/db';
import { encryptSecret, decryptSecretWithMeta, isEncryptedSecret } from '@/lib/crypto';

export const INFRA_KINDS = ['DATABASE', 'STORAGE'] as const;
export type InfraKind = (typeof INFRA_KINDS)[number];

export const INFRA_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'applied',
  'active',
  'rejected',
  'cancelled',
  'superseded',
] as const;
export type InfraStatus = (typeof INFRA_STATUSES)[number];

// Statuses that are still "in flight" and therefore subject to supersede.
export const OPEN_STATUSES: InfraStatus[] = ['draft', 'submitted', 'approved'];

// Statuses an org admin may still edit / update the draft for.
export const DRAFTABLE_STATUSES: InfraStatus[] = ['draft', 'submitted'];

// A retryable approval is 'approved' with an errorMessage (the first migration
// attempt failed; the switch was NOT applied). SA may approve again.
export function isRetryableApproval(status: string, errorMessage: string | null): boolean {
  return status === 'approved' && Boolean(errorMessage);
}

// Part 18 state machine.
export const STATE_TRANSITIONS: Record<InfraStatus, InfraStatus[]> = {
  draft: ['submitted', 'cancelled'],
  submitted: ['approved', 'rejected', 'cancelled'],
  approved: ['applied', 'cancelled', 'approved'], // 'approved' = retry after failed migration
  applied: ['active'],
  active: [],
  rejected: [],
  cancelled: [],
  superseded: [],
};

export function canTransition(from: string, to: string): boolean {
  return (STATE_TRANSITIONS[from as InfraStatus] ?? []).includes(to as InfraStatus);
}

// ─── Config fingerprint (proves the tested config matches the submitted one) ─

/**
 * Deterministic hash of the config fields that affect connectivity.
 * Used to prove the Org Admin tested the exact config they're submitting.
 * Returns a short hex string (first 16 chars of SHA-256).
 */
export async function configFingerprint(config: Record<string, unknown>): Promise<string> {
  const ordered = JSON.stringify(config, Object.keys(config).sort());
  const encoder = new TextEncoder();
  const data = encoder.encode(ordered);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/**
 * Build the fingerprint input for a DATABASE config (excludes password).
 */
export function dbConfigFingerprintInput(cfg: { host: string; port: number | null; name: string; user: string; ssl: boolean; useOwnDb?: boolean }): Record<string, unknown> {
  return { host: cfg.host, port: cfg.port, name: cfg.name, user: cfg.user, ssl: cfg.ssl, useOwnDb: cfg.useOwnDb ?? true };
}

/**
 * Build the fingerprint input for a STORAGE config (excludes secret key).
 */
export function storageConfigFingerprintInput(cfg: { driver: string; url: string | null }): Record<string, unknown> {
  return { driver: cfg.driver, url: cfg.url };
}

// ─── Config validation ───────────────────────────────────────────────────────

export interface DbConfig {
  host: string;
  port: number | null;
  name: string;
  user: string;
  ssl: boolean;
}
export interface DbSpec extends DbConfig {
  password?: string; // plaintext ONLY when a caller just received it / is testing
  useOwnDb?: boolean; // false = disable the dedicated analytics DB entirely
}

export interface StorageConfig {
  driver: 'local' | 'supabase';
  url: string | null;
}
export interface StorageSpec extends StorageConfig {
  key?: string; // plaintext service-role key, provided only at submit/test time
}

const KEEP_MARKERS = new Set(['••••••', 'keep', 'unchanged']);

export function isKeepMarker(v: string): boolean {
  return KEEP_MARKERS.has(v);
}

export function validateDbConfig(body: Record<string, unknown>): { ok: true; config: DbSpec } | { ok: false; error: string } {
  const useOwnDb = body.useOwnDb !== false;
  const host = typeof body.dbHost === 'string' ? body.dbHost.trim() : '';
  const name = typeof body.dbName === 'string' ? body.dbName.trim() : '';
  const user = typeof body.dbUser === 'string' ? body.dbUser.trim() : '';
  const ssl = body.dbSsl === true;
  const rawPort = body.dbPort === undefined || body.dbPort === null || body.dbPort === '' ? null : Number(body.dbPort);
  const password = typeof body.dbPassword === 'string' && body.dbPassword !== '' && !isKeepMarker(body.dbPassword)
    ? body.dbPassword
    : undefined;

  if (!useOwnDb) {
    // Turning the dedicated DB OFF is a change request too (kind DATABASE,
    // 'disabled' config) — but we still validate that nothing half-set is kept.
    return { ok: true, config: { host, port: null, name, user, ssl, password } };
  }
  if (!host || !name || !user) return { ok: false, error: 'Host, database name and user are required when using your own DB' };
  if (rawPort !== null && (Number.isNaN(rawPort) || rawPort < 1 || rawPort > 65535)) {
    return { ok: false, error: 'Invalid port' };
  }
  return { ok: true, config: { host, port: rawPort, name, user, ssl, password } };
}

export function validateStorageConfig(body: Record<string, unknown>): { ok: true; config: StorageSpec } | { ok: false; error: string } {
  const driver = body.storageDriver === 'supabase' ? 'supabase' : 'local';
  const url = typeof body.storageUrl === 'string' ? body.storageUrl.trim() : null;
  const key = typeof body.storageKey === 'string' && body.storageKey !== '' && !isKeepMarker(body.storageKey)
    ? body.storageKey
    : undefined;

  if (driver === 'supabase') {
    if (!url || !/^https:\/\//i.test(url)) {
      return { ok: false, error: 'A valid https:// Supabase project URL is required for the supabase driver' };
    }
    if (!key) return { ok: false, error: 'The Supabase service-role key is required for the supabase driver' };
  }
  return { ok: true, config: { driver, url: driver === 'supabase' ? url : null, key: driver === 'supabase' ? key : undefined } };
}

// ─── Serialization (SECURITY: never returns plaintext secrets) ─────────────

export interface ChangeRequestSerialized {
  id: string;
  organizationId: string;
  kind: InfraKind;
  requestNo: number;
  status: InfraStatus;
  config: Record<string, unknown>; // non-secret snapshot (parsed configJson)
  hasSecret: boolean;
  secretLast4: string | null;
  lastTestStatus: string | null;
  lastTestMessage: string | null;
  lastTestedAt: string | null;
  requestedById: string;
  requestedByEmail: string;
  requestedAt: string;
  approvedById: string | null;
  approvedByEmail: string | null;
  approvedAt: string | null;
  approvalNote: string | null;
  rejectedById: string | null;
  rejectedByEmail: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  cancelledById: string | null;
  cancelledByEmail: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  supersededByRequestNo: number | null;
  supersededAt: string | null;
  migratedAt: string | null;
  appliedAt: string | null;
  activatedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export function serializeChangeRequest(r: {
  id: string;
  organizationId: string;
  kind: string;
  requestNo: number;
  status: string;
  configJson: string;
  dbPasswordEncrypted: string | null;
  storageKeyEncrypted: string | null;
  lastTestStatus: string | null;
  lastTestMessage: string | null;
  lastTestedAt: Date | null;
  requestedById: string;
  requestedByEmail: string;
  requestedAt: Date;
  approvedById: string | null;
  approvedByEmail: string | null;
  approvedAt: Date | null;
  approvalNote: string | null;
  rejectedById: string | null;
  rejectedByEmail: string | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  cancelledById: string | null;
  cancelledByEmail: string | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  supersededByRequestNo: number | null;
  supersededAt: Date | null;
  migratedAt: Date | null;
  appliedAt: Date | null;
  activatedAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ChangeRequestSerialized {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(r.configJson || '{}');
  } catch {
    config = { unparsable: true };
  }

  const envelope = r.dbPasswordEncrypted || r.storageKeyEncrypted;
  let secretLast4: string | null = null;
  if (envelope && isEncryptedSecret(envelope)) {
    const plain = decryptSecretWithMeta(envelope).plaintext;
    secretLast4 = plain ? plain.slice(-4) : null;
  }

  return {
    id: r.id,
    organizationId: r.organizationId,
    kind: r.kind as InfraKind,
    requestNo: r.requestNo,
    status: r.status as InfraStatus,
    config,
    hasSecret: Boolean(envelope),
    secretLast4,
    lastTestStatus: r.lastTestStatus,
    lastTestMessage: r.lastTestMessage,
    lastTestedAt: r.lastTestedAt ? r.lastTestedAt.toISOString() : null,
    requestedById: r.requestedById,
    requestedByEmail: r.requestedByEmail,
    requestedAt: r.requestedAt.toISOString(),
    approvedById: r.approvedById,
    approvedByEmail: r.approvedByEmail,
    approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
    approvalNote: r.approvalNote,
    rejectedById: r.rejectedById,
    rejectedByEmail: r.rejectedByEmail,
    rejectedAt: r.rejectedAt ? r.rejectedAt.toISOString() : null,
    rejectionReason: r.rejectionReason,
    cancelledById: r.cancelledById,
    cancelledByEmail: r.cancelledByEmail,
    cancelledAt: r.cancelledAt ? r.cancelledAt.toISOString() : null,
    cancellationReason: r.cancellationReason,
    supersededByRequestNo: r.supersededByRequestNo,
    supersededAt: r.supersededAt ? r.supersededAt.toISOString() : null,
    migratedAt: r.migratedAt ? r.migratedAt.toISOString() : null,
    appliedAt: r.appliedAt ? r.appliedAt.toISOString() : null,
    activatedAt: r.activatedAt ? r.activatedAt.toISOString() : null,
    errorMessage: r.errorMessage,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// ─── Request lifecycle helpers ──────────────────────────────────────────────

export async function nextRequestNo(organizationId: string, kind: InfraKind): Promise<number> {
  const latest = await db.infrastructureChangeRequest.findFirst({
    where: { organizationId, kind },
    orderBy: { requestNo: 'desc' },
    select: { requestNo: true },
  });
  return (latest?.requestNo ?? 0) + 1;
}

export async function findOpenChangeRequest(organizationId: string, kind: InfraKind) {
  return db.infrastructureChangeRequest.findFirst({
    where: {
      organizationId,
      kind,
      status: { in: [...OPEN_STATUSES] },
    },
    orderBy: { requestNo: 'desc' },
  });
}

/**
 * Find the CURRENT (non-superseded, latest) request for an org + kind.
 */
export async function findActiveOrLateRequest(organizationId: string, kind: InfraKind) {
  return db.infrastructureChangeRequest.findFirst({
    where: { organizationId, kind, status: { not: 'superseded' } },
    orderBy: { requestNo: 'desc' },
  });
}

/**
 * Create (or return) the open change request for an org + kind.
 *
 * When a NEW request for the same kind is submitted, any earlier OPEN request
 * becomes 'superseded' (a full version trail). The submitted snapshot is
 * immutable: callers must not mutate an existing non-draft request.
 *
 * Config JSON carries ONLY non-secret fields; the password / service-role key
 * travels in dbPasswordEncrypted / storageKeyEncrypted (encrypted at rest).
 */
export async function submitChangeRequest(params: {
  organizationId: string;
  kind: InfraKind;
  actor: { id: string; email: string };
  configJson: string;
  password?: string;
  storageKey?: string;
  testStatus?: string | null;
  testMessage?: string | null;
}): Promise<{ request: Awaited<ReturnType<typeof db.infrastructureChangeRequest.create>>; superseded: number }> {
  const { organizationId, kind, actor, configJson, password, storageKey, testStatus, testMessage } = params;

  const requestNo = await nextRequestNo(organizationId, kind);

  // Supersede any earlier open request of the same kind (draft/submitted/approved).
  const superseded = await db.infrastructureChangeRequest.updateMany({
    where: { organizationId, kind, status: { in: [...OPEN_STATUSES] } },
    data: { status: 'superseded', supersededByRequestNo: requestNo, supersededAt: new Date() },
  });

  const request = await db.infrastructureChangeRequest.create({
    data: {
      organizationId,
      kind,
      requestNo,
      status: 'submitted',
      configJson,
      dbPasswordEncrypted: kind === 'DATABASE' && password ? encryptSecret(password) : null,
      storageKeyEncrypted: kind === 'STORAGE' && storageKey ? encryptSecret(storageKey) : null,
      lastTestStatus: testStatus ?? null,
      lastTestMessage: testMessage ?? null,
      lastTestedAt: testStatus ? new Date() : null,
      requestedById: actor.id,
      requestedByEmail: actor.email,
    },
  });

  return { request, superseded: superseded.count };
}

/**
 * Full version trail for an org + kind, newest first (SA queue / org history).
 */
export async function listOrgChangeRequests(organizationId: string, kind: InfraKind, take = 50) {
  return db.infrastructureChangeRequest.findMany({
    where: { organizationId, kind },
    orderBy: [{ requestNo: 'desc' }, { createdAt: 'desc' }],
    take,
  });
}

/**
 * Cancel an org's OPEN change request (submitted, or approved-with-error) —
 * the ONLY state a change request can be cancelled from. Drafts are never
 * stored. Writes the audit trail snapshot onto the row.
 */
export async function cancelOpenChangeRequest(params: {
  organizationId: string;
  kind: InfraKind;
  actor: { id: string; email: string };
  reason?: string;
}): Promise<{ cancelled: boolean; reason: string }> {
  const { organizationId, kind, actor, reason } = params;
  const open = await findOpenChangeRequest(organizationId, kind);
  if (!open) return { cancelled: false, reason: 'No pending change request to cancel' };

  const target = open.status === 'submitted' || isRetryableApproval(open.status, open.errorMessage)
    ? 'cancelled'
    : null;
  if (!target) {
    return { cancelled: false, reason: `This change request is in '${open.status}' and cannot be cancelled` };
  }

  await db.infrastructureChangeRequest.update({
    where: { id: open.id },
    data: {
      status: 'cancelled',
      cancelledById: actor.id,
      cancelledByEmail: actor.email,
      cancelledAt: new Date(),
      cancellationReason: reason ?? null,
    },
  });

  // If a data migration was queued for this request and has NOT started, mark
  // it cancelled too (nothing to roll back — it never ran). A migration that
  // is already migrating/verifying is left alone: it is unsafe to cancel
  // mid-copy, and its completion no longer affects the (cancelled) request —
  // runDueMigrations cancels it atomically when it sees the request is no
  // longer approved. Activated migrations cannot exist here (only an approved
  // request can be cancelled; 'active' is terminal and not open).
  try {
    const { cancelQueuedMigration } = await import('@/lib/migration/runner');
    await cancelQueuedMigration(open.id, `Change request #${open.requestNo} cancelled`);
  } catch {
    // Migration module unavailable or transient DB error — the runner's
    // request-status re-check still cancels it on the next pass (fail-safe).
  }

  return { cancelled: true, reason: reason ?? '' };
}

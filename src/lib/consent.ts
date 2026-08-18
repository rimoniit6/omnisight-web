import { db } from '@/lib/db';
import type { Prisma } from '@prisma/client';

export const CONSENT_TYPES = [
  'monitoring',
  'screenshot',
  'activity_tracking',
  'keystroke',
  'usb_monitoring',
  'webcam_access',
  'location',
  'email_monitoring',
] as const;

export type ConsentType = (typeof CONSENT_TYPES)[number];

export const CONSENT_STATUSES = ['pending', 'granted', 'denied', 'revoked', 'expired'] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

export const POLICY_STATUSES = ['draft', 'published', 'archived'] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];

/** Hard cap for consent notes — prevents unbounded client-supplied blobs. */
export const MAX_CONSENT_NOTES_LENGTH = 500;

export function isValidConsentType(type: string): type is ConsentType {
  return CONSENT_TYPES.includes(type as ConsentType);
}

export function isValidConsentStatus(status: string): status is ConsentStatus {
  return CONSENT_STATUSES.includes(status as ConsentStatus);
}

/**
 * State machine — legal transitions per status. 'expired' is reserved for the
 * background processor; 'granted' <-> 'denied' flows must pass through the
 * transition service so every change is version-aware and audited.
 */
export const CONSENT_TRANSITIONS: Record<ConsentStatus, ConsentStatus[]> = {
  pending: ['granted', 'denied', 'revoked', 'expired'],
  granted: ['revoked', 'denied', 'expired'],
  denied: ['granted', 'revoked', 'pending'],
  revoked: ['granted'],
  expired: ['granted'],
};

export function canTransition(from: ConsentStatus, to: ConsentStatus): boolean {
  if (from === to) return true;
  return CONSENT_TRANSITIONS[from]?.includes(to) ?? false;
}

// ==================== Policy helpers ====================

export function getPublishedPolicy(orgId: string, consentType: string) {
  return db.consentPolicy.findFirst({
    where: { organizationId: orgId, consentType, status: 'published' },
    orderBy: { effectiveAt: 'desc' },
  });
}

export function nextPolicyVersion(versions: string[]): string {
  let max = 0;
  for (const v of versions) {
    const n = parseInt((v || '').replace(/^v/i, ''), 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return `v${max + 1}`;
}

const POLICY_TEXT: Record<string, { title: string; content: string }> = {
  monitoring: {
    title: 'Employee Monitoring & Activity Collection Policy',
    content:
      'This organization collects work-related activity data through the OmniSight Desktop Agent for workforce productivity, operational visibility, security and reporting. Covered data includes: application/activity tracking, activity duration, active/idle state, productivity metrics, work session information, and the device association of the activity. Data collection is consent-gated: the OmniSight Desktop Agent only records activity while the required monitoring consent is active for the employee. Collected data is used for workforce reporting, security investigations and operational visibility; it is accessible only to authorized administrators and is never sold to third parties. Employees are informed through this policy and the agent interface that monitoring is active while consent is granted. Retention is governed by the organization retention configuration where supported.'
  },
  screenshot: {
    title: 'Screenshot Monitoring Policy',
    content:
      'Screenshots may be captured by the OmniSight Desktop Agent only when the organization monitoring configuration enables screenshot capture and the employee holds an active screenshot consent. Screenshots are captured periodically according to the configured frequency — capture is not continuous and is not guaranteed on every interval. Purpose: verifying work activity and supporting incident review. Access is limited to authorized administrators; screenshots are stored securely and are never displayed in employee-facing views. Retention follows the organization retention configuration where supported, and screenshots are deleted when their retention period expires or when an administrator deletes them. Employees are aware that screenshot capture is active through the agent interface while consent is granted. Break/privacy controls are subject to availability in the deployed Agent version and organization configuration.'
  },
  activity_tracking: {
    title: 'Website & Application Monitoring Policy',
    content:
      'The OmniSight Desktop Agent monitors application usage and — where the organization configuration enables website tracking — website/domain usage during work activity. Purpose: productivity measurement, operational visibility and security. Privacy boundary: website tracking stores ONLY bare lowercase domain names (for example github.com) in a privacy-preserving form — full URLs, page paths, query strings, fragments and credentials never leave the device and are never stored. Application and domain usage is categorized as productive, neutral or unproductive for reporting. Data minimization: only the data needed for the stated purposes is collected. Access is restricted to authorized administrators, data is never sold, and retention follows the organization retention configuration where supported.'
  },
  keystroke: {
    title: 'Keystroke Logging Policy',
    content:
      'Keystroke logging is only enabled when the organization configuration enables it and the employee holds an active keystroke consent. Captured keystroke data is used exclusively for security incident investigation and is never used to collect passwords or payment details. Access is limited to authorized administrators for authorized investigations, and retention follows the organization retention configuration where supported. Availability of this feature is subject to the deployed Agent version and organization configuration.'
  },
  usb_monitoring: {
    title: 'USB Device Monitoring Policy',
    content:
      'USB device insert/remove events are recorded where the organization configuration enables USB monitoring, to protect against data exfiltration. File access metadata may be captured, but file contents are never read without a formal security review. Availability of USB monitoring is subject to the deployed Agent version and organization configuration; where not implemented in the deployed Agent, no USB data is collected.'
  },
  webcam_access: {
    title: 'Webcam Access Policy',
    content:
      'Webcam access is optional and only enabled after explicit consent where the organization configuration enables it. Video is never recorded continuously; capture is limited to security incidents and scheduled check-ins. Availability of webcam access is subject to the deployed Agent version and organization configuration.'
  },
  location: {
    title: 'Location Tracking Policy',
    content:
      'Device location is tracked during work hours where the organization configuration enables location tracking for field-based roles. Location history is retained per the organization retention configuration where supported and is visible only to authorized administrators. Availability of location tracking is subject to the deployed Agent version and organization configuration.'
  },
  email_monitoring: {
    title: 'Email Monitoring Policy',
    content:
      'Work email activity (send/receive metadata) may be monitored for compliance and security where the organization configuration enables it. Message content is only reviewed during investigations authorized by management. Availability of email monitoring is subject to the deployed Agent version and organization configuration.'
  },
};

export function defaultPolicyText(consentType: string): { title: string; content: string } {
  return (
    POLICY_TEXT[consentType] ?? {
      title: `${consentType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} Policy`,
      content: `This policy describes how ${consentType.replace(/_/g, ' ')} data is collected, used and retained. Your consent can be withdrawn at any time.`,
    }
  );
}

// ==================== Enforcement ====================

type DbTx = Prisma.TransactionClient;

/**
 * Server-side consent enforcement. Returns true only when the employee holds
 * a currently valid consent: status 'granted', expiry window not lapsed, AND
 * the consented policy version matches the organization's current published
 * policy. If no policy is published the check FAILS CLOSED — the employee
 * must re-consent to the active policy before monitoring resumes.
 */
export async function hasActiveConsent(employeeId: string, type: string): Promise<boolean> {
  const consent = await db.consent.findFirst({
    where: { employeeId, consentType: type },
    select: {
      status: true,
      expiresAt: true,
      consentVersion: true,
      policyId: true,
      organizationId: true,
    },
  });
  if (!consent || consent.status !== 'granted') return false;
  if (consent.expiresAt && consent.expiresAt < new Date()) return false;

  if (consent.policyId) {
    const policy = await db.consentPolicy.findUnique({
      where: { id: consent.policyId },
      select: { status: true, version: true, organizationId: true },
    });
    // Fail closed: policy deleted, archived, withdrawn, or (defense in depth)
    // bound to a different organization than the consent => consent inert.
    if (!policy || policy.status !== 'published') return false;
    if (policy.organizationId !== consent.organizationId) return false;
    return policy.version === consent.consentVersion;
  }

  // Legacy consent without a linked policy: must match the current published
  // version, otherwise the employee must re-consent to the new policy.
  const published = await getPublishedPolicy(consent.organizationId, type);
  if (!published) return false;
  return published.version === consent.consentVersion;
}

// ==================== Audit logging ====================

export function logConsent(
  tx: DbTx,
  consentId: string,
  action: string,
  description: string,
  performedBy: string | null,
  organizationId: string,
  ipAddress?: string | null
) {
  return tx.consentLog.create({
    data: { consentId, action, description, performedBy, organizationId, ipAddress: ipAddress ?? null },
  });
}

// ==================== Transition service ====================

export interface TransitionContext {
  performedBy: string; // employee name/email or 'system'
  ipAddress?: string | null;
  userId?: string | null; // AppUser id for the main AuditLog
  notes?: string | null;
  /** Force a specific policy version when granting (defaults to current published). */
  policy?: { id: string; version: string } | null;
  /** Set to false to skip the main AuditLog row (e.g. bulk/self actions) — default true. */
  writeAuditLog?: boolean;
  /** Override the ConsentLog action label (e.g. self-revoke -> 'revoked' vs 'admin_revoked'). */
  action?: string;
}

const LOG_ACTION: Record<string, Record<string, string>> = {
  pending: { granted: 'granted', denied: 'denied', revoked: 'revoked', expired: 'expired' },
  granted: { revoked: 'admin_revoked', denied: 'denied', expired: 'expired' },
  denied: { granted: 'admin_granted', revoked: 'revoked', pending: 'requested' },
  revoked: { granted: 're_consented' },
  expired: { granted: 're_consented' },
};

/**
 * Single audited state-transition path for consent records. Every route
 * (admin, self-portal, bulk, processor) must go through here so the state
 * machine, policy versioning and audit trail stay consistent.
 *
 * CONCURRENCY: the write is an optimistic conditional update
 *   UPDATE Consent SET ... WHERE id = ? AND status = <expected>
 * so two simultaneous transitions cannot overwrite each other — the second
 * one matches zero rows and throws a 409-style conflict WITHOUT writing any
 * audit event. Idempotent repeats of the same transition (same state, same
 * policy version) are successful no-ops that add no duplicate audit events.
 */
export async function applyConsentTransition(
  tx: DbTx,
  consent: { id: string; status: ConsentStatus; consentType: string; organizationId: string },
  to: ConsentStatus,
  ctx: TransitionContext
) {
  if (!canTransition(consent.status, to)) {
    throw new Error(`Invalid consent transition: ${consent.status} -> ${to}`);
  }

  // Notes are capped once, centrally, so the stored value and the audit log
  // description never diverge.
  const notes =
    ctx.notes === undefined || ctx.notes === null ? null : ctx.notes.slice(0, MAX_CONSENT_NOTES_LENGTH);

  // Scalar-only payload. updateMany cannot express relation connects, so the
  // policy binding is written directly to the policyId / consentVersion
  // columns — that requires the Unchecked input type, which exposes the
  // relation-scalar policyId (the checked UpdateManyMutationInput omits it).
  const data: Prisma.ConsentUncheckedUpdateManyInput = {
    status: to,
    notes: notes ?? undefined,
  };
  let boundPolicy: { id: string; version: string } | null = null;
  if (to === 'granted') {
    data.grantedAt = new Date();
    data.revokedAt = null;
    data.expiredAt = null;
    // Re-consent grants a fresh window: clear any stale expiry so a previously
    // expired consent does not remain blocked by an outdated expiresAt.
    data.expiresAt = null;
    // Granting always binds to the current published policy version. The
    // lookup runs on the SAME transaction client (`tx`) — never the top-level
    // `db`. On a single-connection pool (Supabase transaction pooler with
    // connection_limit=1) a nested top-level query inside an interactive
    // transaction would self-deadlock waiting for the connection the
    // transaction already holds.
    const policy =
      ctx.policy ??
      (await tx.consentPolicy.findFirst({
        where: { organizationId: consent.organizationId, consentType: consent.consentType, status: 'published' },
        orderBy: { effectiveAt: 'desc' },
      }));
    if (!policy) {
      throw new Error('No published policy for this consent type');
    }
    boundPolicy = { id: policy.id, version: policy.version };
    data.policyId = policy.id;
    data.consentVersion = policy.version;
  }
  if (to === 'revoked' || to === 'denied') {
    data.revokedAt = new Date();
  }
  if (to === 'expired') {
    data.expiredAt = new Date();
  }

  // Same-state idempotency: repeating an operation that would not change any
  // meaningful state is a successful no-op with no duplicate audit event.
  // (granted -> granted with a DIFFERENT policy version is a real re-consent
  // and falls through to the write.)
  if (consent.status === to) {
    if (to === 'granted' && boundPolicy) {
      const current = await tx.consent.findUnique({
        where: { id: consent.id },
        select: { policyId: true, consentVersion: true },
      });
      if (current && current.policyId === boundPolicy.id && current.consentVersion === boundPolicy.version) {
        return tx.consent.findUniqueOrThrow({ where: { id: consent.id } });
      }
    } else {
      return tx.consent.findUniqueOrThrow({ where: { id: consent.id } });
    }
  }

  // Optimistic concurrency guard at the write boundary.
  const result = await tx.consent.updateMany({
    where: { id: consent.id, status: consent.status },
    data,
  });
  if (result.count === 0) {
    throw new Error(
      'Invalid consent transition: consent was modified concurrently. Refresh and retry.'
    );
  }

  const updated = await tx.consent.findUnique({ where: { id: consent.id } });
  if (!updated) {
    throw new Error('Consent not found after transition');
  }

  const action = ctx.action ?? LOG_ACTION[consent.status]?.[to] ?? to;
  await logConsent(
    tx,
    consent.id,
    action,
    `Consent for ${consent.consentType} ${consent.status} -> ${to}${notes ? ` (${notes})` : ''}`,
    ctx.performedBy,
    consent.organizationId,
    ctx.ipAddress
  );

  if (ctx.writeAuditLog !== false && ctx.userId) {
    await tx.auditLog.create({
      data: {
        action: 'update',
        resource: 'consent',
        resourceId: consent.id,
        description: `Consent ${consent.consentType} for employee ${updated.employeeId} changed to ${to}`,
        userId: ctx.userId,
        organizationId: consent.organizationId,
      },
    });
  }

  return updated;
}

// ==================== Batched enforcement ====================

/**
 * Batch evaluation of consent state for several consent types in a bounded
 * query pattern (TWO queries regardless of type count), preserving the exact
 * semantics of hasActiveConsent:
 *   consent exists + granted + not expired + current published policy exists
 *   + the consented record is bound to the CURRENT published policy (same id)
 *   + consent version matches the current published version.
 *
 * Because the publish flow archives the previous policy, comparing the bound
 * policyId against the current published policy's id reproduces every
 * hasActiveConsent decision, including the defense-in-depth rule that a
 * consent must not be satisfiable by another organization's policy (a foreign
 * policy id never equals this org's current published id).
 *
 * Used by the agent consent endpoint to avoid the previous N+1 (up to 16)
 * lookups per poll.
 */
export async function getConsentState(
  employeeId: string,
  organizationId: string,
  types: string[]
): Promise<Record<string, boolean>> {
  const now = new Date();
  const [consents, policies] = await Promise.all([
    db.consent.findMany({
      where: { employeeId, consentType: { in: types } },
      select: {
        consentType: true,
        status: true,
        expiresAt: true,
        consentVersion: true,
        policyId: true,
        organizationId: true,
      },
    }),
    // One row per type: the newest published policy (publish archives the old).
    db.consentPolicy.findMany({
      where: { organizationId, consentType: { in: types }, status: 'published' },
      orderBy: { effectiveAt: 'desc' },
      select: { id: true, consentType: true, version: true },
    }),
  ]);

  // Last published wins per type (same rule as getPublishedPolicy).
  const currentPolicyByType = new Map<string, { id: string; version: string }>();
  for (const p of policies) {
    if (!currentPolicyByType.has(p.consentType)) currentPolicyByType.set(p.consentType, p);
  }
  const consentByType = new Map(consents.map((c) => [c.consentType, c]));

  const result: Record<string, boolean> = {};
  for (const t of types) {
    const c = consentByType.get(t);
    if (!c) {
      result[t] = false; // no consent -> fail closed
      continue;
    }
    if (c.status !== 'granted') {
      result[t] = false; // pending / denied / revoked / expired
      continue;
    }
    if (c.expiresAt && c.expiresAt < now) {
      result[t] = false; // lazy expiration
      continue;
    }
    const current = currentPolicyByType.get(t);
    if (!current) {
      result[t] = false; // no published policy -> fail closed
      continue;
    }
    // Bound to the CURRENT published policy record AND the current version.
    // A consent bound to an archived/older policy (id or version differs)
    // requires re-consent. A consent bound to another organization's policy
    // can never match this org's current published id -> defense in depth.
    const boundToCurrent = c.policyId ? c.policyId === current.id : true;
    result[t] = boundToCurrent && c.consentVersion === current.version;
  }
  return result;
}

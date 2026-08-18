/**
 * Canonical Anomaly Detection constants — the single source of truth for
 * anomaly type/severity/status values and validation. All anomaly API routes,
 * the detection engine and the scheduler job derive from here so the contract
 * can never drift between layers.
 */

// ─── Types ─────────────────────────────────────────────────────────────────
// `unusual_login` is a legacy persisted key that actually means "off-hours
// activity" (its rule counts application activity outside the org's working
// window). The key is kept for database/API compatibility; the UI displays
// the honest label "Off-Hours Activity" (see UI TYPE_CONFIG mapping).
export const ANOMALY_TYPES = [
  'productivity_drop',
  'excessive_idle',
  'unusual_login',
  'rapid_app_switch',
  'overtime_work',
  'policy_breach',
  'unusual_screenshot',
  'low_activity_spike',
  // Server-authoritative telemetry-interruption signal (device-integrity
  // job): an approved, actively-monitored device that stopped heartbeating.
  // Deliberately NOT labeled "tampered" — a silent device has legitimate
  // causes (shutdown, sleep, network) and the admin judges.
  'device_missing',
] as const;

export type AnomalyType = (typeof ANOMALY_TYPES)[number];

// Types the rule engine can actually produce today. The remaining types are
// supported (manual creation / agent reporting / legacy seed data) but are
// NOT auto-detected — the UI reference panel says so explicitly.
export const AUTO_DETECTED_TYPES: readonly AnomalyType[] = [
  'productivity_drop',
  'excessive_idle',
  'unusual_login',
  'low_activity_spike',
];

export const ANOMALY_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type AnomalySeverity = (typeof ANOMALY_SEVERITIES)[number];

export const ANOMALY_STATUSES = ['detected', 'investigating', 'resolved', 'false_positive'] as const;
export type AnomalyStatus = (typeof ANOMALY_STATUSES)[number];

export function isValidAnomalyType(value: unknown): value is AnomalyType {
  return typeof value === 'string' && (ANOMALY_TYPES as readonly string[]).includes(value);
}

export function isValidAnomalySeverity(value: unknown): value is AnomalySeverity {
  return typeof value === 'string' && (ANOMALY_SEVERITIES as readonly string[]).includes(value);
}

export function isValidAnomalyStatus(value: unknown): value is AnomalyStatus {
  return typeof value === 'string' && (ANOMALY_STATUSES as readonly string[]).includes(value);
}

// ─── Score / confidence bounds ─────────────────────────────────────────────
export const ANOMALY_SCORE_MIN = 0;
export const ANOMALY_SCORE_MAX = 100;
export const ANOMALY_CONFIDENCE_MIN = 0;
export const ANOMALY_CONFIDENCE_MAX = 1;

/** True when `score` is a finite number within [0, 100]. */
export function isValidAnomalyScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= ANOMALY_SCORE_MIN && value <= ANOMALY_SCORE_MAX;
}

/** True when `confidence` is a finite number within [0, 1]. */
export function isValidAnomalyConfidence(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= ANOMALY_CONFIDENCE_MIN &&
    value <= ANOMALY_CONFIDENCE_MAX
  );
}

// ─── Metadata bound (F-16) ─────────────────────────────────────────────────
// Anomaly metadata is a JSON string with no schema-level bound. To keep
// records bounded, every API boundary validates the serialized size before
// persisting (reject with 4xx). The detection engine's own metadata is
// bounded by construction (fixed keys + a capped 7-entry history array).
export const ANOMALY_METADATA_MAX_BYTES = 8192;

/**
 * Serialize a metadata object to the stored JSON string, enforcing the size
 * cap. Returns null when `metadata` is null/undefined (stored as NULL).
 * Throws MetadataTooLargeError (→ 422 at the API boundary) when the payload
 * exceeds ANOMALY_METADATA_MAX_BYTES.
 */
export class MetadataTooLargeError extends Error {
  constructor() {
    super(`Anomaly metadata must not exceed ${ANOMALY_METADATA_MAX_BYTES} bytes`);
    this.name = 'MetadataTooLargeError';
  }
}

export function stringifyAnomalyMetadata(
  metadata: Record<string, unknown> | null | undefined
): string | null {
  if (metadata === null || metadata === undefined) return null;
  const serialized = JSON.stringify(metadata);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > ANOMALY_METADATA_MAX_BYTES) {
    throw new MetadataTooLargeError();
  }
  return serialized;
}

// ─── Dedupe key (F-14) ─────────────────────────────────────────────────────
// DB-safe duplicate suppression. The key is deterministic:
//   `${organizationId}:${employeeId}:${type}:${utcDayBucket}`
// and is stored on the row under a UNIQUE index, so two concurrent detection
// runs (or agent reports) for the same org + employee + type on the same UTC
// day cannot both insert — the second insert violates the constraint and is
// treated as a duplicate (skipped), never a 500.
//
// Semantics note: the pre-hardening code deduplicated against OPEN anomalies
// created in the trailing 24 hours. The unique-key day bucket is the closest
// DB-enforceable equivalent (rolling-24h cannot be expressed as a unique
// index); the window is one UTC day. Re-triggering is preserved: resolving or
// false-positiving a record clears its dedupeKey, and the next UTC day starts
// a fresh bucket.
export function anomalyDedupeKey(organizationId: string, employeeId: string, type: string, at: Date): string {
  const day = at.toISOString().split('T')[0];
  return `${organizationId}:${employeeId}:${type}:${day}`;
}

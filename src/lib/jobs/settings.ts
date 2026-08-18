import { db } from '@/lib/db';

/**
 * Org-scoped retention configuration. Values resolve in order:
 * OrganizationSetting -> built-in default (NO global SystemSetting fallback —
 * retention is organization policy, never cross-tenant).
 * A value of 0 means "never purge" (compliance records default to keep).
 */
export const RETENTION_KEYS = {
  screenshot_retention_days: 30,
  activity_retention_days: 90,
  report_retention_days: 0,
  ai_insight_retention_days: 0,
  audit_log_retention_days: 0,
  consent_log_retention_days: 0,
  // USB events + policy violations: 0 = never purge (default), admins opt in.
  usb_event_retention_days: 0,
  policy_violation_retention_days: 0,
  // Notification/Alert retention (N-4): 0 = never purge (default).
  // Notifications purge read/archived rows; Alerts purge resolved/archived
  // rows — active (pending/acknowledged) records are never deleted.
  notification_retention_days: 0,
  alert_retention_days: 0,
  // Break/privacy history (BreakSession rows): 0 = keep forever (default).
  // Only ENDED sessions are purged past this window; an ACTIVE break is
  // never deleted by retention. The legacy "Break Mode …" Activity mirror
  // rows follow the same window (and are EXCLUDED from the generic
  // activity_retention_days purge so generic telemetry cleanup can never
  // silently destroy break history).
  break_session_retention_days: 0,
} as const;

export type RetentionKey = keyof typeof RETENTION_KEYS;

// ─── Typed org-scoped monitoring registry (single source of truth) ─────────
// Every monitoring key the desktop agent consumes is defined HERE with its
// value type + validation metadata. The admin API, the agent config route and
// the settings UI all derive from this registry — validation rules live in one
// place and can never drift between routes.
//
// S-1 / MON-1 fix: these values are stored ONLY in OrganizationSetting (never
// in the global SystemSetting). getOrgSetting() has no SystemSetting fallback
// for monitoring keys, so Org A's configuration can never bleed into Org B.

export type MonitoringValueType = 'boolean' | 'number' | 'time';

export interface MonitoringKeyDef {
  type: MonitoringValueType;
  default: boolean | number | string;
  /** Numeric bounds (only for type: 'number'). */
  min?: number;
  max?: number;
}

export const MIN_HEARTBEAT_INTERVAL = 10;
export const MAX_HEARTBEAT_INTERVAL = 600;

export const MONITORING_KEYS = {
  /** Seconds between agent heartbeats. Clamped to [10, 600] server-side. */
  heartbeat_interval: { type: 'number', default: 60, min: MIN_HEARTBEAT_INTERVAL, max: MAX_HEARTBEAT_INTERVAL },
  screenshot_enabled: { type: 'boolean', default: true },
  /** Minutes between screenshots. */
  screenshot_frequency: { type: 'number', default: 10, min: 1, max: 180 },
  app_tracking: { type: 'boolean', default: true },
  website_tracking: { type: 'boolean', default: true },
  idle_detection: { type: 'boolean', default: true },
  /** Minutes of inactivity before the agent reports idle. */
  idle_timeout: { type: 'number', default: 5, min: 1, max: 120 },
  working_hours_only: { type: 'boolean', default: true },
  /** HH:MM in the organization's timezone (24h). */
  work_start_time: { type: 'time', default: '09:00' },
  /** HH:MM in the organization's timezone (24h). */
  work_end_time: { type: 'time', default: '18:00' },
  // F-04: ai_anomaly_detection is a SERVER-SIDE AI-analysis setting (Admin
  // panel anomaly job) — deliberately NOT an agent flag. The agent config
  // route omits it and the AgentConfig type has no field, so this registry
  // entry is the single definition and nothing else may expose it to agents.
  ai_anomaly_detection: { type: 'boolean', default: true },
  // ── Telemetry expansion (fail-closed defaults) ───────────────────────────
  // All three new monitoring flags default to FALSE: a freshly-created org
  // (or a stored-value corruption) must never silently enable a sensitive
  // capability. The agent additionally gates each collector on the matching
  // consent type AND its own capability, so config alone can never enable a
  // feature (feature_enabled = config AND consent AND capability).
  location_tracking: { type: 'boolean', default: false },
  keystroke_logging_enabled: { type: 'boolean', default: false },
  webcam_capture_enabled: { type: 'boolean', default: false },
  // Agent-native (extension-free) BEST_EFFORT website source. Defaults false —
  // never silently enabled. When true, the agent samples the foreground
  // browser window (no CDP, no full URLs — normalized domain only) and feeds
  // the SAME Activity pipeline as the extension. Gated agent-side on
  // activity_tracking consent + website_tracking config, exactly like every
  // other collector.
  website_native_tracking: { type: 'boolean', default: false },
  // ── Policy Management (fail-closed defaults) ─────────────────────────────
  // USB monitoring: when true AND the employee holds active usb_monitoring
  // consent AND the agent has the native capability, the agent reports USB
  // device insert/remove events. Defaults false — never silently enabled.
  usb_monitoring: { type: 'boolean', default: false },
  // App policy enforcement: when true the agent actively monitors running
  // processes against the org's whitelist/blacklist and reports violations.
  // Defaults false — the agent NEVER enforces until an admin opts in.
  app_policy_enforcement: { type: 'boolean', default: false },
  // Whether a blocked application is TERMINATED (true) or only reported
  // (false, default). Termination is destructive — it requires the explicit
  // org opt-in on top of app_policy_enforcement.
  app_policy_terminate: { type: 'boolean', default: false },
} as const satisfies Record<string, MonitoringKeyDef>;

export type MonitoringKey = keyof typeof MONITORING_KEYS;

/** Stored (string) → typed value used by resolvers and the agent config. */
export type MonitoringValue = boolean | number | string;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Strict whole-number parse for monitoring values (rejects floats/hex/NaN).
 * Accepts both JSON numbers (120) and numeric strings ("120") so programmatic
 * API clients and the admin UI are handled identically.
 */
export function parseWholeNumber(raw: unknown): number | null {
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw < 0) return null;
    return raw;
  }
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

export type MonitoringValidation =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * Central typed validation for a monitoring key — used by PUT
 * /api/settings/monitoring AND by the resolver (a corrupt stored value falls
 * back to the deterministic default instead of reaching the agent).
 */
export function validateMonitoringValue(
  key: MonitoringKey,
  raw: unknown
): MonitoringValidation {
  const def = MONITORING_KEYS[key];
  switch (def.type) {
    case 'boolean': {
      const t = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
      if (t === true || t === 'true') return { ok: true, value: 'true' };
      if (t === false || t === 'false') return { ok: true, value: 'false' };
      return { ok: false, error: `${key} must be a boolean (true or false)` };
    }
    case 'number': {
      const n = parseWholeNumber(raw);
      if (n === null) {
        return { ok: false, error: `${key} must be a whole number` };
      }
      if ((def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max)) {
        return { ok: false, error: `${key} must be between ${def.min} and ${def.max}` };
      }
      return { ok: true, value: String(n) };
    }
    case 'time': {
      const t = typeof raw === 'string' ? raw.trim() : '';
      if (!TIME_RE.test(t)) {
        return { ok: false, error: `${key} must be a 24-hour time in HH:MM format` };
      }
      return { ok: true, value: t };
    }
  }
}

/**
 * Strongly-typed resolved shape of the full monitoring registry.
 * `boolean` keys resolve to boolean, `number` keys to number, `time` keys
 * to string — so consumers (agent config, dashboard, admin API) never have
 * to narrow a union at every read site.
 */
type MonitoringValueFor<K extends MonitoringKey> =
  (typeof MONITORING_KEYS)[K]['type'] extends 'boolean' ? boolean :
  (typeof MONITORING_KEYS)[K]['type'] extends 'number' ? number : string;

export type ResolvedMonitoring = { [K in MonitoringKey]: MonitoringValueFor<K> };

/** Coerce a validated stored string into its typed value. */
export function coerceMonitoringValue<K extends MonitoringKey>(
  key: K,
  value: string
): ResolvedMonitoring[K] {
  const def = MONITORING_KEYS[key];
  if (def.type === 'boolean') return (value === 'true') as ResolvedMonitoring[K];
  if (def.type === 'number') {
    const n = parseWholeNumber(value);
    return (n !== null ? n : def.default) as ResolvedMonitoring[K];
  }
  return value as ResolvedMonitoring[K]; // time
}

/**
 * Org-scoped setting lookup.
 *
 * Resolution is OrganizationSetting -> provided fallback. There is NO
 * fallback to the global SystemSetting: org-scoped policy (monitoring,
 * retention) must never read cross-tenant values. Global application-level
 * settings (branding, AI provider) remain in SystemSetting and are read by
 * their own dedicated consumers.
 */
export async function getOrgSetting(
  orgId: string,
  key: string,
  fallback: string | number
): Promise<string> {
  const orgSetting = await db.organizationSetting.findUnique({
    where: { organizationId_key: { organizationId: orgId, key } },
  });
  return orgSetting ? orgSetting.value : String(fallback);
}

/**
 * Load the FULL typed monitoring configuration for an organization from
 * OrganizationSetting, applying deterministic defaults for missing or invalid
 * values. Never reads global SystemSetting for monitoring keys.
 */
export async function resolveOrgMonitoring(
  orgId: string
): Promise<ResolvedMonitoring> {
  const rows = await db.organizationSetting.findMany({
    where: { organizationId: orgId, key: { in: Object.keys(MONITORING_KEYS) } },
  });
  const stored = new Map(rows.map((r) => [r.key, r.value]));

  const out = {} as Record<MonitoringKey, MonitoringValue>;
  for (const key of Object.keys(MONITORING_KEYS) as MonitoringKey[]) {
    const def = MONITORING_KEYS[key];
    const raw = stored.get(key);
    if (raw === undefined) {
      out[key] = def.default;
      continue;
    }
    const validated = validateMonitoringValue(key, raw);
    out[key] = validated.ok ? coerceMonitoringValue(key, validated.value) : def.default;
  }
  return out as ResolvedMonitoring;
}

/**
 * Resolve the org's heartbeat interval with validation + clamping. Invalid or
 * missing values fall back to the default (60s) — the agent never receives a
 * malformed cadence that could cause a tight poll loop.
 */
export async function resolveHeartbeatInterval(orgId: string): Promise<number> {
  const raw = await getOrgSetting(orgId, 'heartbeat_interval', MONITORING_KEYS.heartbeat_interval.default);
  const n = parseWholeNumber(raw);
  if (n === null) return MONITORING_KEYS.heartbeat_interval.default as number;
  return Math.min(MAX_HEARTBEAT_INTERVAL, Math.max(MIN_HEARTBEAT_INTERVAL, n));
}

export async function resolveRetentionDays(orgId: string, key: RetentionKey): Promise<number> {
  const raw = await getOrgSetting(orgId, key, RETENTION_KEYS[key]);
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return RETENTION_KEYS[key];
  return n;
}

export function retentionCutoff(days: number, now = new Date()): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

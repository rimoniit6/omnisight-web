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

export type MonitoringValueType = 'boolean' | 'number' | 'time' | 'text';

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
  // Tamper detection: when true the agent monitors its own integrity
  // (config changes, repeated restarts) and reports tamper events to the
  // server. Defaults true — the feature is implemented and safe.
  tamper_detection: { type: 'boolean', default: true },
  // App policy enforcement: when true the agent actively monitors running
  // processes against the org's whitelist/blacklist and reports violations.
  // Defaults false — the agent NEVER enforces until an admin opts in.
  app_policy_enforcement: { type: 'boolean', default: false },
  // Whether a blocked application is TERMINATED (true) or only reported
  // (false, default). Termination is destructive — it requires the explicit
  // org opt-in on top of app_policy_enforcement.
  app_policy_terminate: { type: 'boolean', default: false },
  // ── Server-side reliability & capability settings (Phase 1) ──────────────
  // The two keys below are SERVER-ONLY org settings: they never reach the
  // Desktop Agent runtime contract (GET /api/agent/config selects explicit
  // fields from resolveOrgMonitoring, so additions here are automatically
  // excluded from agent payloads) and the admin UI renders them apart from
  // the agent-facing list. They live in this registry so they share the
  // typed validation, the GET/PUT /api/settings/monitoring surface, the
  // OrganizationSetting storage and the org-isolation guarantees of every
  // other key — no separate flag system is invented.
  //
  // activity_dedupe (default OFF — safe rollout): when enabled, activity
  // uploads that carry a batchId are deduplicated through
  // ActivityBatchReceipt (one receipt per organization+employee+batchId,
  // written in the same transaction as the rows). When disabled, ingestion
  // keeps today's exact behavior and receipts are never consulted.
  activity_dedupe: { type: 'boolean', default: false },
  // agent_min_version (optional, INFORMATIONAL): an org-declared semantic
  // version floor (e.g. "1.2.0") for FUTURE capability gating. Nothing
  // enforces it in Phase 1 — older agents are never rejected. Empty/unset =
  // no floor. Stored as free text via the registry's 'text' type.
  agent_min_version: { type: 'text', default: '' },
  // ── Phase 3: server-authoritative classification (default OFF) ───────────
  // When enabled, the server re-classifies every ingested application/website
  // activity row: org CategoryRules first (ordered precedence), then the
  // default heuristic mirror of the agent's local categorizers for unmatched
  // rows. The agent's category becomes a hint. When disabled (default),
  // ingestion keeps today's exact behavior (agent category allowlisted and
  // stored as-is). SERVER-SIDE ONLY — never sent to the Desktop Agent (the
  // agent config route selects explicit fields, so registry additions here
  // are automatically excluded from agent payloads).
  server_classification: { type: 'boolean', default: false },
  // ── Phase 5: server-side alert rules (default OFF — fail closed) ─────────
  // Master switch for the alert-rule engine: when enabled, the org's ENABLED
  // AlertRules are evaluated by the lease-guarded alert_rule_evaluation job
  // over real telemetry and firings create Alerts (+ Notifications via the
  // existing service). When disabled (default) rules are NEVER evaluated.
  // SERVER-SIDE ONLY — never sent to the Desktop Agent.
  alert_rules_enabled: { type: 'boolean', default: false },
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
    case 'text': {
      if (typeof raw !== 'string') {
        return { ok: false, error: `${key} must be a string` };
      }
      const t = raw.trim();
      if (t.length > 64) {
        return { ok: false, error: `${key} must be 64 characters or fewer` };
      }
      // Empty string is allowed (means "unset" for optional text settings).
      if (t !== '' && !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(t)) {
        return {
          ok: false,
          error: `${key} must be a plain version or identifier (letters, digits, . _ + -), e.g. 1.2.0`,
        };
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
  return value as ResolvedMonitoring[K]; // time / text
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

/**
 * Resolve the org's retention window for a data class.
 *
 * Resolution order (highest precedence first):
 *   1. An explicit OrganizationSetting row for `key` (admin override).
 *   2. For the SCREENSHOT class, the org's ACTIVE subscription plan
 *      `retentionDays` (SaaS "1-year data retention": Free=90d, Pro/Business
 *      =365d, 0 = keep forever). Applies only when the plan defines a value
 *      (retentionDays > 0) and the org has not set an explicit override.
 *   3. The static registry default (RETENTION_KEYS[key]).
 *
 * A value of 0 means "never purge". This lets the EXISTING retention_cleanup
 * job enforce plan-based screenshot retention without a parallel scheduler.
 * All non-screenshot retention classes keep their existing registry defaults.
 */
export async function resolveRetentionDays(orgId: string, key: RetentionKey): Promise<number> {
  // 1) Explicit org override (check the row directly so we can detect
  //    "absent" and defer to the plan fallback below).
  const rawRow = await db.organizationSetting.findUnique({
    where: { organizationId_key: { organizationId: orgId, key } },
  });
  if (rawRow) {
    const n = parseInt(rawRow.value, 10);
    return Number.isNaN(n) || n < 0 ? RETENTION_KEYS[key] : n;
  }

  // 2) Plan-driven fallback — screenshots only, and only when the org holds an
  //    ACTIVE subscription whose plan declares a retention window.
  if (key === 'screenshot_retention_days') {
    const sub = await db.subscription.findFirst({
      where: {
        organizationId: orgId,
        status: 'ACTIVE',
        OR: [{ endDate: null }, { endDate: { gt: new Date() } }],
      },
      include: { plan: { select: { retentionDays: true } } },
      orderBy: { createdAt: 'desc' },
    });
    if (sub && sub.plan && sub.plan.retentionDays > 0) {
      return sub.plan.retentionDays;
    }
  }

  // 3) Registry default.
  return RETENTION_KEYS[key];
}

// ─── Server-side reliability flags (Phase 1) ───────────────────────────────
// ACTIVITY_DEDUPE is a SERVER-ONLY reliability feature. The key is defined in
// MONITORING_KEYS above (so it shares the typed registry, the
// /api/settings/monitoring surface and the org-isolation guarantees), but it
// is never shipped to agents (the agent config route selects explicit fields)
// and the admin UI renders it in the server-side section.
//
// Safe-rollout semantics: default FALSE. When disabled, the activity route
// keeps today's exact ingestion behavior and never consults receipts (a
// batchId sent by a new agent is ignored). When enabled for an org, uploads
// carrying a batchId are deduplicated through ActivityBatchReceipt — one
// receipt per (organization, employee, batchId), written in the SAME
// transaction as the activity rows.
export const SERVER_CLASSIFICATION_SETTING_KEY = 'server_classification' as const;

export const ACTIVITY_DEDUPE_SETTING_KEY = 'activity_dedupe' as const;

// ─── Phase 5: alert-rule engine master switch (default OFF — fail closed) ──
// The evaluation job refuses to run for an org unless this is explicitly
// 'true'; a corrupt/missing stored value resolves to the safe default.
export const ALERT_RULES_ENABLED_SETTING_KEY = 'alert_rules_enabled' as const;

export async function resolveAlertRulesEnabled(orgId: string): Promise<boolean> {
  return (await getOrgSetting(orgId, ALERT_RULES_ENABLED_SETTING_KEY, 'false')) === 'true';
}

// Cheap single-row read that mirrors the registry default (false) exactly;
// resolveOrgMonitoring() offers the fully-typed alternative when a caller
// already needs the whole org configuration.
export async function resolveActivityDedupeEnabled(orgId: string): Promise<boolean> {
  return (await getOrgSetting(orgId, ACTIVITY_DEDUPE_SETTING_KEY, 'false')) === 'true';
}

// ─── Phase 3: server-authoritative classification flag ─────────────────────
// Default OFF — enabling is a deliberate, per-org opt-in. When ON, the
// activity route loads the org's enabled CategoryRules and re-classifies
// application/website rows before insert (rules → default heuristic). When
// OFF (or corrupt stored value → default), ingestion is byte-for-byte today's
// behavior and CategoryRule rows are never consulted.
export async function resolveServerClassificationEnabled(orgId: string): Promise<boolean> {
  return (await getOrgSetting(orgId, SERVER_CLASSIFICATION_SETTING_KEY, 'false')) === 'true';
}

// ─── Optional agent capability floor (Phase 1 — informational) ─────────────
// agent_min_version is an OPTIONAL org-scoped marker for FUTURE capability
// gating (also defined in MONITORING_KEYS as a 'text' key; admin-settable via
// the monitoring settings UI/API). It is deliberately NOT enforced anywhere
// in Phase 1: no endpoint rejects an older agent, and nothing compares
// versions yet. Adding a gate before a feature actually needs a newer
// collector would break the "no forced upgrade" guarantee, so the value
// exists for future additive negotiation only.
//
// Where the agent version is obtained: the agent reports `agentVersion` on
// POST /api/agent/discover and it is stored on Device.agentVersion (the
// per-device record). Where it will be compared (future): any phase that
// needs a newer collector compares the device's stored agentVersion against
// this floor at ingestion/config time. Unset or blank = no floor (every
// agent passes). Older agents keep working unchanged.
export const AGENT_MIN_VERSION_SETTING_KEY = 'agent_min_version' as const;

export async function resolveAgentMinVersion(orgId: string): Promise<string | null> {
  const raw = (await getOrgSetting(orgId, AGENT_MIN_VERSION_SETTING_KEY, '')).trim();
  return raw.length > 0 ? raw : null;
}

export function retentionCutoff(days: number, now = new Date()): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

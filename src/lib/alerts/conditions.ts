/**
 * OmniSight — AlertRule condition registry (Phase 5).
 *
 * Each AlertRule is ONE STRUCTURED condition type from this registry, evaluated
 * by the lease-guarded alert-rule job over REAL existing telemetry. There is
 * deliberately NO code execution, regex, SQL or arbitrary expression in any
 * condition — params are plain numeric bounds validated against this registry
 * at the API boundary and re-validated at evaluation time (a corrupt stored
 * row can never crash the job).
 *
 * Condition types (each backed by an existing data source):
 *  - device_offline           → Device.lastHeartbeat older than N minutes
 *                               (org device, employee-linked + active
 *                               monitoring consent — mirrors the device-
 *                               integrity criteria but with a configurable
 *                               threshold and an explicit Alert).
 *  - excessive_idle           → employee's idle minutes TODAY (org-local)
 *                               ≥ N (Activity idle rows).
 *  - excessive_unproductive   → employee's unproductive minutes TODAY
 *                               (org-local) ≥ N (Phase 3 category verdict).
 *  - outside_hours_activity   → ≥ N application activities TODAY (org-local)
 *                               recorded OUTSIDE the org work window.
 */

export const ALERT_RULE_CONDITION_TYPES = [
  'device_offline',
  'excessive_idle',
  'excessive_unproductive',
  'outside_hours_activity',
] as const;

export type AlertRuleConditionType = (typeof ALERT_RULE_CONDITION_TYPES)[number];

export interface ConditionParamDef {
  /** JSON key on the stored params object. */
  key: string;
  /** Minimum value (inclusive). */
  min: number;
  /** Maximum value (inclusive). */
  max: number;
  /** Default when the param is absent/invalid. */
  default: number;
  /** Human unit shown in the UI, e.g. 'minutes'. */
  unit: string;
}

export interface ConditionDef {
  value: AlertRuleConditionType;
  label: string;
  /** Short helper text for the admin UI (never implies agent behavior). */
  helper: string;
  /** Params this condition accepts (currently every condition is a single
   *  threshold — kept as an array so a future condition can carry two). */
  params: ConditionParamDef[];
}

export const MAX_RULES_PER_ORG = 50;
export const MAX_RULE_NAME_LENGTH = 120;
export const MAX_PARAMS_JSON_BYTES = 1024;
/** Cooldown bounds in minutes (5 min … 7 days). */
export const MIN_COOLDOWN_MINUTES = 5;
export const MAX_COOLDOWN_MINUTES = 10080;

export const ALERT_RULE_CONDITION_REGISTRY: readonly ConditionDef[] = [
  {
    value: 'device_offline',
    label: 'Device Offline',
    helper:
      'Fires when a monitored device stops reporting (heartbeat older than the threshold). Requires an active employee with monitoring consent — a consent-revoked device going silent is expected, not an alert.',
    params: [{ key: 'thresholdMinutes', min: 5, max: 1440, default: 15, unit: 'min' }],
  },
  {
    value: 'excessive_idle',
    label: 'Excessive Idle Time',
    helper:
      'Fires when an employee accumulates at least the threshold of idle time TODAY (organization timezone). Idle comes from the agent\u2019s inactivity detector — it is never fabricated from gaps.',
    params: [{ key: 'thresholdMinutes', min: 5, max: 1440, default: 120, unit: 'min' }],
  },
  {
    value: 'excessive_unproductive',
    label: 'Excessive Unproductive Time',
    helper:
      'Fires when an employee accumulates at least the threshold of unproductive time TODAY (organization timezone), using the server-authoritative classification verdict.',
    params: [{ key: 'thresholdMinutes', min: 5, max: 1440, default: 120, unit: 'min' }],
  },
  {
    value: 'outside_hours_activity',
    label: 'Off-Hours Activity',
    helper:
      'Fires when an employee records at least the threshold of application activities TODAY outside the organization\u2019s working-hours window.',
    params: [{ key: 'thresholdCount', min: 1, max: 1000, default: 5, unit: 'events' }],
  },
];

export function isAlertRuleConditionType(value: unknown): value is AlertRuleConditionType {
  return typeof value === 'string' && (ALERT_RULE_CONDITION_TYPES as readonly string[]).includes(value);
}

export function conditionDefFor(value: AlertRuleConditionType): ConditionDef | null {
  return ALERT_RULE_CONDITION_REGISTRY.find((c) => c.value === value) ?? null;
}

/**
 * Resolve a stored params JSON string against a condition's registry schema:
 * each known param is read, coerced to a whole number, clamped to its
 * [min, max] bounds and defaulted when missing/invalid. Unknown keys are
 * dropped. NEVER throws — a corrupt stored row resolves to safe defaults so
 * the evaluation job can never crash on admin data.
 */
export function resolveConditionParams(
  conditionType: AlertRuleConditionType,
  storedParams: string | null | undefined
): Record<string, number> {
  const def = conditionDefFor(conditionType);
  if (!def) return {};
  let raw: Record<string, unknown> = {};
  if (storedParams) {
    try {
      const parsed = JSON.parse(storedParams) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      raw = {}; // corrupt JSON → defaults
    }
  }
  const out: Record<string, number> = {};
  for (const param of def.params) {
    const v = raw[param.key];
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : Number.NaN;
    const valid = Number.isFinite(n) && Number.isInteger(n);
    out[param.key] = valid ? Math.min(param.max, Math.max(param.min, n)) : param.default;
  }
  return out;
}

/** Whole-number clamp helper used by the API validation (mirrors the bounds). */
export function clampParam(param: ConditionParamDef, raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    return raw >= param.min && raw <= param.max ? raw : null;
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    return n >= param.min && n <= param.max ? n : null;
  }
  return null;
}

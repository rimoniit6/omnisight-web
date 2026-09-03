/**
 * OmniSight — AlertRule admin input validation (Phase 5).
 * Strict: malformed values are rejected (422 convention), never coerced.
 * Rules are org-scoped from the verified session; `organizationId` is never
 * accepted from the client. Conditions are STRUCTURED types from the registry
 * — no arbitrary code/expressions reach the evaluator.
 */

import {
  ALERT_RULE_CONDITION_REGISTRY,
  isAlertRuleConditionType,
  conditionDefFor,
  clampParam,
  MAX_RULE_NAME_LENGTH,
  MAX_PARAMS_JSON_BYTES,
  MIN_COOLDOWN_MINUTES,
  MAX_COOLDOWN_MINUTES,
  type AlertRuleConditionType,
} from './conditions';
import { isAlertSeverity } from '@/lib/notifications/constants';

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

export interface AlertRuleInput {
  name: string;
  conditionType: AlertRuleConditionType;
  params: string; // canonical JSON string (bounded, validated per condition)
  severity: string; // canonical ALERT_SEVERITIES value
  cooldownMinutes: number;
  enabled: boolean;
}

function wholeNumber(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isSafeInteger(raw)) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/**
 * Validate a full rule payload (create + update share this).
 * `params` accepts either a JSON object ({ thresholdMinutes: 30 }) or the
 * canonical JSON string; output is ALWAYS the canonical JSON string.
 */
export function validateAlertRuleInput(raw: unknown): ValidationResult<AlertRuleInput> {
  if (typeof raw !== 'object' || raw === null) return fail('Rule payload must be an object');
  const obj = raw as Record<string, unknown>;

  const nameRaw = obj.name;
  if (typeof nameRaw !== 'string') return fail('name is required and must be a string');
  const name = nameRaw.trim();
  if (name.length === 0) return fail('name is required');
  if (name.length > MAX_RULE_NAME_LENGTH) {
    return fail(`name must be at most ${MAX_RULE_NAME_LENGTH} characters`);
  }

  const conditionTypeRaw = obj.conditionType;
  if (!isAlertRuleConditionType(conditionTypeRaw)) {
    return fail(
      `conditionType must be one of: ${ALERT_RULE_CONDITION_REGISTRY.map((c) => c.value).join(', ')}`
    );
  }
  const conditionType = conditionTypeRaw;

  // ── Params: strict per-condition validation ──────────────────────────────
  const def = conditionDefFor(conditionType)!;
  let paramSource: Record<string, unknown> | null = null;
  if (typeof obj.params === 'string') {
    try {
      const parsed = JSON.parse(obj.params) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        paramSource = parsed as Record<string, unknown>;
      }
    } catch {
      return fail('params must be a valid JSON object');
    }
  } else if (obj.params && typeof obj.params === 'object' && !Array.isArray(obj.params)) {
    paramSource = obj.params as Record<string, unknown>;
  }
  if (!paramSource) {
    return fail('params is required and must be an object of threshold values');
  }
  const validatedParams: Record<string, number> = {};
  for (const param of def.params) {
    const value = paramSource[param.key];
    const clamped = clampParam(param, value);
    if (clamped === null) {
      return fail(
        `params.${param.key} must be an integer between ${param.min} and ${param.max} (${param.unit})`
      );
    }
    validatedParams[param.key] = clamped;
  }
  // Unknown param keys are rejected (strict) — a typo must not silently pass.
  const knownKeys = new Set(def.params.map((p) => p.key));
  for (const key of Object.keys(paramSource)) {
    if (!knownKeys.has(key)) {
      return fail(`params.${key} is not a valid parameter for ${conditionType}`);
    }
  }
  const paramsJson = JSON.stringify(validatedParams);
  if (Buffer.byteLength(paramsJson, 'utf8') > MAX_PARAMS_JSON_BYTES) {
    return fail(`params must not exceed ${MAX_PARAMS_JSON_BYTES} bytes`);
  }

  // ── Severity: canonical enum only (matches the Alert model) ──────────────
  const severityRaw = obj.severity;
  const severity = severityRaw === undefined || severityRaw === null ? 'warning' : severityRaw;
  if (typeof severity !== 'string' || !isAlertSeverity(severity)) {
    return fail('severity must be one of: info, warning, error, critical');
  }

  // ── Cooldown (minutes between firings for the same entity) ───────────────
  const cooldownMinutesRaw = obj.cooldownMinutes;
  if (cooldownMinutesRaw === undefined || cooldownMinutesRaw === null) {
    return fail('cooldownMinutes is required');
  }
  const cooldownMinutes = wholeNumber(cooldownMinutesRaw);
  if (cooldownMinutes === null || cooldownMinutes < MIN_COOLDOWN_MINUTES || cooldownMinutes > MAX_COOLDOWN_MINUTES) {
    return fail(`cooldownMinutes must be an integer between ${MIN_COOLDOWN_MINUTES} and ${MAX_COOLDOWN_MINUTES}`);
  }

  const enabledRaw = obj.enabled;
  if (enabledRaw !== undefined && enabledRaw !== null && typeof enabledRaw !== 'boolean') {
    return fail('enabled must be a boolean when provided');
  }

  return {
    ok: true,
    value: {
      name,
      conditionType,
      params: paramsJson,
      severity,
      cooldownMinutes,
      enabled: enabledRaw === undefined || enabledRaw === null ? true : enabledRaw,
    },
  };
}

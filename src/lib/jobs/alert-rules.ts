/**
 * OmniSight — AlertRule evaluation job (Phase 5).
 *
 * Evaluates each org's ENABLED AlertRules against real telemetry on the shared
 * hourly scheduler under the crash-safe JobRun lease (`alert_rule_evaluation`).
 *
 * Guarantees:
 *  - Per-org isolation: one failing org never blocks the others
 *    (continue-on-error, errors collected for observability).
 *  - Fail-closed master switch: an org must enable `alert_rules_enabled`
 *    (OrganizationSetting, default false) or its rules are never evaluated —
 *    same safe-rollout semantics as every other server-side flag.
 *  - Bounded queries: activity loads are one org × one org-local day; device
 *    loads are one org. No per-rule N+1 over employees.
 *  - Deterministic evaluation: pure condition evaluators (fixed inputs →
 *    fixed verdicts), replayed runs produce the same candidates.
 *  - Cooldown + idempotency: one AlertRuleFiring row per (rule, entity); a
 *    firing writes the Alert (+ Notification for higher severities) and the
 *    firing row in ONE transaction, so a crash can never leave an alert
 *    without its state (and thus a duplicate on replay). The unique
 *    (rule, entity) constraint is the DB boundary.
 *  - The org's NotificationPreference is honored via createOrgNotification —
 *    a disabled type is skipped, never bypassed.
 */
import { db } from '@/lib/db';
import { claimJob, finishJob } from './run';
import { getOrgSetting } from './settings';
import { safeTimezone, localDayKey, zonedDayStart, zonedDayEnd } from '@/lib/timezone';
import { parseHHMM } from '@/lib/anomalies/time';
import { createOrgAlert, createOrgNotification } from '@/lib/notifications/service';
import { priorityFromSeverity } from '@/lib/notifications/constants';
import {
  isAlertRuleConditionType,
  resolveConditionParams,
  type AlertRuleConditionType,
} from '@/lib/alerts/conditions';
import {
  evaluateCondition,
  type ActivityLike,
  type OrgWindowLike,
} from '@/lib/alerts/evaluate';

export interface AlertRuleJobResult {
  orgsScanned: number;
  orgsSkipped: number; // flag off or no enabled rules
  orgsFailed: number;
  rulesEvaluated: number;
  candidates: number; // conditions that fired (before cooldown)
  alertsCreated: number;
  alertsSuppressedByCooldown: number;
  errors: string[];
}

interface OrgRuleRow {
  id: string;
  name: string;
  conditionType: string;
  params: string;
  severity: string;
  cooldownMinutes: number;
}

const RULE_MASTER_FLAG = 'alert_rules_enabled';

/** Cooldown boundary for one (rule, entity): true when allowed to fire now. */
function cooldownElapsed(lastFiredAt: Date, cooldownMinutes: number, now: Date): boolean {
  return now.getTime() - lastFiredAt.getTime() >= cooldownMinutes * 60_000;
}

/**
 * Persist ONE firing atomically: Alert + Notification (delivery-observable;
 * an org that disabled the 'security' notification type skips the record via
 * createOrgNotification — never bypassed) + the AlertRuleFiring state row, in
 * ONE transaction. Returns 'created' | 'cooldown' | 'skipped'. Volume is
 * bounded by the rule cooldown, so alert/notification creation can never
 * storm.
 */
async function persistFiring(
  orgId: string,
  rule: OrgRuleRow,
  entityType: 'employee' | 'device',
  entityId: string,
  measured: number,
  now: Date,
  description: string
): Promise<'created' | 'cooldown' | 'skipped'> {
  try {
    return await db.$transaction(async (tx) => {
      // Cooldown check INSIDE the same transaction as the state write: a
      // replayed run sees the committed lastFiredAt and cannot double-fire.
      const existing = await tx.alertRuleFiring.findUnique({
        where: {
          ruleId_entityType_entityId: {
            ruleId: rule.id,
            entityType,
            entityId,
          },
        },
        select: { id: true, lastFiredAt: true },
      });
      if (existing && !cooldownElapsed(existing.lastFiredAt, rule.cooldownMinutes, now)) {
        return 'cooldown' as const;
      }

      const alert = await createOrgAlert(tx, {
        title: `Alert Rule: ${rule.name}`,
        description,
        type: 'security',
        severity: rule.severity,
        status: 'pending',
        source: 'alert_rule',
        metadata: {
          ruleId: rule.id,
          conditionType: rule.conditionType,
          entityType,
          measured,
          firedAt: now.toISOString(),
        },
        ...(entityType === 'employee' ? { employeeId: entityId } : { deviceId: entityId }),
        organizationId: orgId,
      });

      // Notification for the firing — org NotificationPreference honored
      // (a disabled type returns null, never bypassed). Bounded by the same
      // cooldown that bounds alerts.
      await createOrgNotification(tx, {
        title: `Alert Rule Fired: ${rule.name}`,
        message: description.substring(0, 400),
        type: 'security',
        priority: priorityFromSeverity(rule.severity),
        status: 'unread',
        actionUrl: '/alerts',
        entityType: entityType === 'employee' ? 'employee' : 'device',
        entityId,
        ...(entityType === 'employee' ? { employeeId: entityId } : { deviceId: entityId }),
        organizationId: orgId,
      });

      await tx.alertRuleFiring.upsert({
        where: {
          ruleId_entityType_entityId: { ruleId: rule.id, entityType, entityId },
        },
        create: {
          organizationId: orgId,
          ruleId: rule.id,
          entityType,
          entityId,
          lastFiredAt: now,
          alertId: alert.id,
        },
        update: { lastFiredAt: now, alertId: alert.id },
      });

      return 'created' as const;
    });
  } catch (error) {
    // P2002 on the unique (rule, entity) — a concurrent evaluator won the
    // race; treat as a suppressed duplicate, never a failure.
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code: string }).code === 'P2002'
    ) {
      return 'cooldown' as const;
    }
    throw error;
  }
}

/** Evaluate one org: bounded telemetry loads + rule dispatch. */
export async function evaluateAlertRulesForOrg(
  orgId: string,
  now = new Date()
): Promise<Omit<AlertRuleJobResult, 'orgsScanned' | 'orgsSkipped' | 'orgsFailed' | 'errors'>> {
  const out = { rulesEvaluated: 0, candidates: 0, alertsCreated: 0, alertsSuppressedByCooldown: 0 };

  const org = await db.organization.findUnique({
    where: { id: orgId },
    select: { timezone: true },
  });
  if (!org) return out;
  const tz = safeTimezone(org.timezone);

  const rules = (await db.alertRule.findMany({
    where: { organizationId: orgId, enabled: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, conditionType: true, params: true, severity: true, cooldownMinutes: true },
  })) as OrgRuleRow[];
  if (rules.length === 0) return out;
  out.rulesEvaluated += rules.length;

  const [workStartRaw, workEndRaw] = await Promise.all([
    getOrgSetting(orgId, 'work_start_time', '09:00'),
    getOrgSetting(orgId, 'work_end_time', '18:00'),
  ]);
  const workStartMinutes = parseHHMM(workStartRaw) ?? 9 * 60;
  const workEndMinutes = parseHHMM(workEndRaw) ?? 18 * 60;

  // Org-local day window (true local midnights — never server-local).
  const dayKey = localDayKey(now, tz);
  const dayStart = zonedDayStart(dayKey, tz);
  const dayEndExclusive = new Date(zonedDayEnd(dayKey, tz).getTime() + 1);
  const window: OrgWindowLike = { dayStart, dayEndExclusive, workStartMinutes, workEndMinutes };

  const employeeRules = rules.filter((r) => r.conditionType !== 'device_offline');
  const deviceRules = rules.filter((r) => r.conditionType === 'device_offline');

  // ── Employee-scoped rules: ONE org-local-day activity load ───────────────
  if (employeeRules.length > 0) {
    const activities = await db.activity.findMany({
      where: {
        employee: { organizationId: orgId },
        timestamp: { gte: dayStart, lt: dayEndExclusive },
      },
      select: { employeeId: true, timestamp: true, duration: true, category: true, type: true, applicationName: true, title: true },
    });
    const byEmployee = new Map<string, ActivityLike[]>();
    for (const r of activities) {
      const list = byEmployee.get(r.employeeId) ?? [];
      list.push({
        timestamp: r.timestamp,
        duration: r.duration,
        category: r.category,
        type: r.type,
        applicationName: r.applicationName,
        title: r.title,
      });
      byEmployee.set(r.employeeId, list);
    }
    const employeeIds = [...byEmployee.keys()];
    // Only employees with any activity today can fire a day-bucket condition
    // (idle/unproductive/off-hours all require rows) — but a threshold rule
    // is about MEASURED rows, so employees with zero rows measured 0 < 5-min
    // minimum thresholds and never fire; skip the DB read entirely.
    for (const rule of employeeRules) {
      const conditionType = rule.conditionType as AlertRuleConditionType;
      if (!isAlertRuleConditionType(conditionType)) continue;
      const params = resolveConditionParams(conditionType, rule.params);
      for (const employeeId of employeeIds) {
        const result = evaluateCondition(
          conditionType,
          { activities: byEmployee.get(employeeId) },
          params,
          window,
          now
        );
        if (!result.fired) continue;
        out.candidates += 1;
        const status = await persistFiring(
          orgId,
          rule,
          'employee',
          employeeId,
          result.measured,
          now,
          `${rule.name}: ${result.measured} ${rule.conditionType === 'outside_hours_activity' ? 'event(s)' : 'min'} measured vs threshold ${result.threshold} ${rule.conditionType === 'outside_hours_activity' ? 'event(s)' : 'min'} (${rule.conditionType.replace(/_/g, ' ')} — org-local day ${dayKey})`
        );
        if (status === 'created') out.alertsCreated += 1;
        else if (status === 'cooldown') out.alertsSuppressedByCooldown += 1;
      }
    }
  }

  // ── device_offline rules: org devices (online status, active employee +
  //    monitoring consent — a consent-revoked device going silent is not an
  //    alert, mirroring the device-integrity criteria) ──────────────────────
  if (deviceRules.length > 0) {
    const devices = await db.device.findMany({
      where: {
        organizationId: orgId,
        status: 'online',
        employeeId: { not: null },
        employee: {
          status: 'active',
          consents: { some: { consentType: 'monitoring', status: 'granted' } },
        },
      },
      select: { id: true, lastHeartbeat: true },
    });
    for (const rule of deviceRules) {
      const conditionType = 'device_offline' as const;
      const params = resolveConditionParams(conditionType, rule.params);
      for (const device of devices) {
        const result = evaluateCondition(
          conditionType,
          { device: { id: device.id, lastHeartbeat: device.lastHeartbeat } },
          params,
          window,
          now
        );
        if (!result.fired) continue;
        out.candidates += 1;
        const status = await persistFiring(
          orgId,
          rule,
          'device',
          device.id,
          result.measured,
          now,
          `${rule.name}: no heartbeat for ${result.measured} min (threshold ${result.threshold}) — device may be offline, asleep, or the agent interrupted.`
        );
        if (status === 'created') out.alertsCreated += 1;
        else if (status === 'cooldown') out.alertsSuppressedByCooldown += 1;
      }
    }
  }

  return out;
}

export async function runAlertRulesJob(now = new Date()): Promise<AlertRuleJobResult> {
  const result: AlertRuleJobResult = {
    orgsScanned: 0,
    orgsSkipped: 0,
    orgsFailed: 0,
    rulesEvaluated: 0,
    candidates: 0,
    alertsCreated: 0,
    alertsSuppressedByCooldown: 0,
    errors: [],
  };

  if (!(await claimJob('alert_rule_evaluation'))) {
    return result; // lease held elsewhere — no-op this round
  }

  try {
    const orgs = await db.organization.findMany({
      where: { status: 'active' },
      select: { id: true },
    });

    for (const org of orgs) {
      try {
        // Fail closed: rule evaluation requires the org-level master flag.
        if ((await getOrgSetting(org.id, RULE_MASTER_FLAG, 'false')) !== 'true') {
          result.orgsSkipped += 1;
          continue;
        }
        const perOrg = await evaluateAlertRulesForOrg(org.id, now);
        result.orgsScanned += 1;
        result.rulesEvaluated += perOrg.rulesEvaluated;
        result.candidates += perOrg.candidates;
        result.alertsCreated += perOrg.alertsCreated;
        result.alertsSuppressedByCooldown += perOrg.alertsSuppressedByCooldown;
        if (perOrg.rulesEvaluated === 0) result.orgsSkipped += 1;
      } catch (error) {
        result.orgsFailed += 1;
        result.errors.push(`org ${org.id}: ${String(error)}`);
        console.error(`[jobs] alert-rule evaluation failed for org ${org.id}, continuing:`, error);
      }
    }

    await finishJob(
      'alert_rule_evaluation',
      result.errors.length > 0 ? result.errors.join('; ') : undefined,
      { ...result }
    );
    return result;
  } catch (error) {
    await finishJob('alert_rule_evaluation', String(error)).catch(() => {});
    throw error;
  }
}

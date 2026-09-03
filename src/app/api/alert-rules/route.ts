import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireManagerOrg, parseJsonBody, BodyParseError } from '@/lib/api';
import { validateAlertRuleInput } from '@/lib/alerts/validation';
import { MAX_RULES_PER_ORG } from '@/lib/alerts/conditions';
import { log, requestContext } from '@/lib/logger';

// GET  /api/alert-rules — list the org's alert rules (+ last firing per rule)
// POST /api/alert-rules — create a rule (manager+)
// Both org-scoped from the VERIFIED session — never from client input.
// Rules are configuration that produces alerts, so read is manager+ (same
// policy as the other monitoring/rule surfaces); mutations are manager+.

export async function GET(req: NextRequest) {
  try {
    const scope = await requireManagerOrg(req);
    if (!scope.ok) return authError(scope);
    const orgId = scope.organizationId;

    const rules = await db.alertRule.findMany({
      where: { organizationId: orgId },
      orderBy: [{ createdAt: 'asc' }],
    });

    // Bounded firing summary per rule (rows exist only for rules that have
    // fired — tiny; grouped once per org, never per rule).
    const firings = await db.alertRuleFiring.findMany({
      where: { organizationId: orgId },
      select: { ruleId: true, entityType: true, entityId: true, lastFiredAt: true, alertId: true },
      orderBy: { lastFiredAt: 'desc' },
    });
    const byRule = new Map<string, Array<{ entityType: string; entityId: string; lastFiredAt: Date; alertId: string | null }>>();
    for (const f of firings) {
      const list = byRule.get(f.ruleId) ?? [];
      list.push({ entityType: f.entityType, entityId: f.entityId, lastFiredAt: f.lastFiredAt, alertId: f.alertId });
      byRule.set(f.ruleId, list);
    }

    const data = rules.map((rule) => ({
      ...rule,
      params: (() => {
        try {
          return JSON.parse(rule.params) as Record<string, number>;
        } catch {
          return {} as Record<string, number>;
        }
      })(),
      firingCount: byRule.get(rule.id)?.length ?? 0,
      lastFiredAt: byRule.get(rule.id)?.[0]?.lastFiredAt ?? null,
      recentFirings: (byRule.get(rule.id) ?? []).slice(0, 5),
    }));

    return NextResponse.json({ data });
  } catch {
    log.error('api.alert-rules.', { error: String('Alert rules GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch alert rules' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const scope = await requireManagerOrg(req);
    if (!scope.ok) return authError(scope);
    const orgId = scope.organizationId;

    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(req);
    } catch (err) {
      if (err instanceof BodyParseError) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      throw err;
    }

    const parsed = validateAlertRuleInput(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 422 });
    }

    // Bounded rule count per org — the evaluation job loads every enabled
    // rule per org each run, so an unbounded table would degrade the job.
    const count = await db.alertRule.count({ where: { organizationId: orgId } });
    if (count >= MAX_RULES_PER_ORG) {
      return NextResponse.json(
        { error: `Maximum of ${MAX_RULES_PER_ORG} alert rules per organization` },
        { status: 422 }
      );
    }

    const rule = await db.alertRule.create({
      data: {
        organizationId: orgId,
        name: parsed.value.name,
        conditionType: parsed.value.conditionType,
        params: parsed.value.params,
        severity: parsed.value.severity,
        cooldownMinutes: parsed.value.cooldownMinutes,
        enabled: parsed.value.enabled,
      },
    });

    return NextResponse.json({ data: { ...rule, params: JSON.parse(rule.params) } }, { status: 201 });
  } catch {
    log.error('api.alert-rules.', { error: String('Alert rule create error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to create alert rule' }, { status: 500 });
  }
}

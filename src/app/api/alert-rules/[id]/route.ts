import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireManagerOrg, parseJsonBody, BodyParseError } from '@/lib/api';
import { validateAlertRuleInput } from '@/lib/alerts/validation';
import { log, requestContext } from '@/lib/logger';

// PATCH  /api/alert-rules/[id] — update a rule (manager+)
// DELETE /api/alert-rules/[id] — delete a rule (manager+)
// Org-isolated: the rule is loaded by id AND organizationId from the verified
// session — a cross-org id 404s (never leaks existence). Deleting a rule
// cascades its AlertRuleFiring state rows (schema onDelete: Cascade), so a
// deleted rule cannot leave stale cooldown state behind.

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireManagerOrg(req);
    if (!scope.ok) return authError(scope);
    const orgId = scope.organizationId;
    const { id } = await params;

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

    // Org-scoped find: a rule belonging to another org is indistinguishable
    // from a missing one (404), preserving tenant isolation.
    const existing = await db.alertRule.findFirst({
      where: { id, organizationId: orgId },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Alert rule not found' }, { status: 404 });
    }

    const rule = await db.alertRule.update({
      where: { id },
      data: {
        name: parsed.value.name,
        conditionType: parsed.value.conditionType,
        params: parsed.value.params,
        severity: parsed.value.severity,
        cooldownMinutes: parsed.value.cooldownMinutes,
        enabled: parsed.value.enabled,
      },
    });

    return NextResponse.json({ data: { ...rule, params: JSON.parse(rule.params) } });
  } catch {
    log.error('api.alert-rules.', { error: String('Alert rule update error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to update alert rule' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireManagerOrg(req);
    if (!scope.ok) return authError(scope);
    const orgId = scope.organizationId;
    const { id } = await params;

    const existing = await db.alertRule.findFirst({
      where: { id, organizationId: orgId },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Alert rule not found' }, { status: 404 });
    }

    await db.alertRule.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch {
    log.error('api.alert-rules.', { error: String('Alert rule delete error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to delete alert rule' }, { status: 500 });
  }
}

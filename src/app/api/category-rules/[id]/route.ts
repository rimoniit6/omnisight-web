import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireManagerOrg, parseJsonBody, BodyParseError } from '@/lib/api';
import { validateCategoryRuleInput } from '@/lib/classification/validation';
import { log, requestContext } from '@/lib/logger';

// PATCH /api/category-rules/[id] — update a rule (manager+)
// DELETE /api/category-rules/[id] — delete a rule (manager+)
// Org-isolated: the rule is loaded by id AND organizationId from the verified
// session — a cross-org id 404s (never leaks existence).

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

    const parsed = validateCategoryRuleInput(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 422 });
    }

    // Org-scoped find: a rule belonging to another org is indistinguishable
    // from a missing one (404), preserving tenant isolation.
    const existing = await db.categoryRule.findFirst({
      where: { id, organizationId: orgId },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Category rule not found' }, { status: 404 });
    }

    const rule = await db.categoryRule.update({
      where: { id },
      data: {
        name: parsed.value.name,
        matchType: parsed.value.matchType,
        pattern: parsed.value.pattern,
        category: parsed.value.category,
        priority: parsed.value.priority,
        enabled: parsed.value.enabled,
      },
    });

    return NextResponse.json({ data: rule });
  } catch {
    log.error('api.category-rules.', { error: String('Category rule update error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to update category rule' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const scope = await requireManagerOrg(req);
    if (!scope.ok) return authError(scope);
    const orgId = scope.organizationId;
    const { id } = await params;

    const existing = await db.categoryRule.findFirst({
      where: { id, organizationId: orgId },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Category rule not found' }, { status: 404 });
    }

    await db.categoryRule.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch {
    log.error('api.category-rules.', { error: String('Category rule delete error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to delete category rule' }, { status: 500 });
  }
}

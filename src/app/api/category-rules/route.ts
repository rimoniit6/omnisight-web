import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireManagerOrg, parseJsonBody, BodyParseError } from '@/lib/api';
import { validateCategoryRuleInput } from '@/lib/classification/validation';
import { MAX_RULES_PER_ORG } from '@/lib/classification/engine';
import { log, requestContext } from '@/lib/logger';

// GET /api/category-rules — list the org's classification rules
// POST /api/category-rules — create a rule (manager+)
// Both org-scoped from the VERIFIED session — never from client input.
// GET is manager+ (rules affect reported productivity/analytics, so they are
// not viewer-visible configuration); mutations are manager+ like the other
// monitoring surfaces.

export async function GET(req: NextRequest) {
  try {
    const scope = await requireManagerOrg(req);
    if (!scope.ok) return authError(scope);
    const orgId = scope.organizationId;

    const rules = await db.categoryRule.findMany({
      where: { organizationId: orgId },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });

    return NextResponse.json({ data: rules });
  } catch {
    log.error('api.category-rules.', { error: String('Category rules GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch category rules' }, { status: 500 });
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

    const parsed = validateCategoryRuleInput(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 422 });
    }

    // Bounded rule count per org — classification is evaluated on every
    // ingestion request, so an unbounded rule table would degrade the hot
    // path and defeat the documented performance bound.
    const count = await db.categoryRule.count({ where: { organizationId: orgId } });
    if (count >= MAX_RULES_PER_ORG) {
      return NextResponse.json(
        { error: `Maximum of ${MAX_RULES_PER_ORG} category rules per organization` },
        { status: 422 }
      );
    }

    const rule = await db.categoryRule.create({
      data: {
        organizationId: orgId,
        name: parsed.value.name,
        matchType: parsed.value.matchType,
        pattern: parsed.value.pattern,
        category: parsed.value.category,
        priority: parsed.value.priority,
        enabled: parsed.value.enabled,
      },
    });

    return NextResponse.json({ data: rule }, { status: 201 });
  } catch {
    log.error('api.category-rules.', { error: String('Category rule create error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to create category rule' }, { status: 500 });
  }
}

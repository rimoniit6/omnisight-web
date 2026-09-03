import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireManagerOrg, parseJsonBody, BodyParseError } from '@/lib/api';
import { classifyRow, orderRules, type CategoryRuleLike } from '@/lib/classification/engine';
import { validateCategoryRuleInput } from '@/lib/classification/validation';
import { normalizeWebsiteDomain } from '@/lib/domain';
import { log, requestContext } from '@/lib/logger';

// POST /api/category-rules/dry-run — preview classification outcomes WITHOUT
// persisting or enabling anything (the plan's "dry-run before enabling").
//
// Body:
//   {
//     samples: [{ type: 'application'|'website', title?, applicationName?, url? }],
//     rules?: [candidate rule payloads]   // optional: when absent, the org's
//                                         // SAVED enabled rules are evaluated
//   }
//
// Response: per-sample { category, ruleMatched, matchedRuleId?, source } plus
// which rule set was used. Nothing is written to the database.

const MAX_SAMPLES = 100;

interface DryRunSample {
  type?: unknown;
  title?: unknown;
  applicationName?: unknown;
  url?: unknown;
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

    const rawSamples = body.samples;
    if (!Array.isArray(rawSamples) || rawSamples.length === 0) {
      return NextResponse.json({ error: 'samples must be a non-empty array' }, { status: 422 });
    }
    if (rawSamples.length > MAX_SAMPLES) {
      return NextResponse.json({ error: `samples must be at most ${MAX_SAMPLES}` }, { status: 422 });
    }

    const samples: DryRunSample[] = rawSamples.map((s) =>
      typeof s === 'object' && s !== null ? (s as DryRunSample) : {}
    );
    for (const s of samples) {
      if (s.type !== 'application' && s.type !== 'website') {
        return NextResponse.json(
          { error: 'each sample type must be "application" or "website"' },
          { status: 422 }
        );
      }
      for (const field of ['title', 'applicationName', 'url'] as const) {
        if (s[field] !== undefined && s[field] !== null && typeof s[field] !== 'string') {
          return NextResponse.json({ error: `${field} must be a string when provided` }, { status: 422 });
        }
      }
    }

    // Candidate rules override the saved set when provided (validation is
    // shared with create/update so the preview is exactly what would persist).
    let rules: CategoryRuleLike[] | null = null;
    let usedSaved = false;
    if (body.rules !== undefined && body.rules !== null) {
      if (!Array.isArray(body.rules)) {
        return NextResponse.json({ error: 'rules must be an array' }, { status: 422 });
      }
      const parsed: CategoryRuleLike[] = [];
      for (const raw of body.rules) {
        const v = validateCategoryRuleInput(raw);
        if (!v.ok) return NextResponse.json({ error: v.error }, { status: 422 });
        parsed.push({ ...v.value, id: undefined });
      }
      rules = orderRules(parsed);
    } else {
      const saved = await db.categoryRule.findMany({
        where: { organizationId: orgId, enabled: true },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      });
      rules = saved;
      usedSaved = true;
    }

    const results = samples.map((s) => {
      // Website samples are normalized the SAME way ingestion normalizes them
      // (domain-only — full URLs/paths/queries are never classified), so a
      // dry-run preview matches exactly what would be stored + classified.
      const url =
        s.type === 'website' && typeof s.url === 'string' && s.url.trim() !== ''
          ? normalizeWebsiteDomain(s.url)
          : (s.url as string | null | undefined);
      const outcome = classifyRow(
        { type: s.type as string, title: s.title as string | null | undefined, applicationName: s.applicationName as string | null | undefined, url },
        rules ?? []
      );
      return {
        type: s.type,
        title: s.title ?? null,
        applicationName: s.applicationName ?? null,
        // Report the normalized domain (what rules actually see).
        url,
        category: outcome?.category ?? null,
        ruleMatched: outcome?.ruleMatched ?? false,
        matchedRuleId: outcome?.matchedRuleId ?? null,
        source: outcome ? (outcome.ruleMatched ? 'rule' : 'default-heuristic') : 'unchanged',
      };
    });

    return NextResponse.json({ data: results, evaluated: usedSaved ? 'saved-rules' : 'candidate-rules' });
  } catch {
    log.error('api.category-rules.dry-run.', { error: String('Category rule dry-run error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to evaluate dry-run' }, { status: 500 });
  }
}

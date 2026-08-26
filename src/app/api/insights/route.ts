import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, getSessionOrg, requireManagerOrg, parseJsonBody, BodyParseError } from '@/lib/api';
import { runAiInsightsAnalysis } from '@/lib/ai-insights/engine';
import { parseInsightFilters } from '@/lib/ai-insights/filters';
import { safeTimezone } from '@/lib/timezone';
import { log, requestContext } from '@/lib/logger';

export async function GET(req: NextRequest) {
  try {
    const org = await getSessionOrg(req);
    if (!org) return NextResponse.json({ error: 'No organization found' }, { status: 400 });
    const insights = await db.aiInsight.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: 'desc' },
    });
    return NextResponse.json({ data: insights });
  } catch (error) {
    log.error('api.insights.', { error: String('Insights GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch insights' }, { status: 500 });
  }
}

/**
 * POST /api/insights — GENERATE an insight.
 *
 * Flow: RBAC (manager+) → org-scoped filters → real data aggregation →
 * provider call → structured validation → persist with provenance metadata →
 * audit log.
 *
 * When the AI provider is available the persisted insight is mode=AI_ANALYSIS
 * (source database+ai, audit AI_ANALYSIS_GENERATED). When the provider is
 * unavailable/disabled/failing, a deterministic DATA_SUMMARY from the SAME
 * measured dataset is persisted with explicit mode=DATA_SUMMARY, source
 * database, provider/model null and the normalized fallbackReason (audit
 * DATA_SUMMARY_GENERATED). The fallback is NEVER stored or labeled as AI.
 */
export async function POST(req: NextRequest) {
  try {
    const scope = await requireManagerOrg(req);
    if (!scope.ok) return authError(scope);
    const orgId = scope.organizationId;

    const orgRow = await db.organization.findUnique({
      where: { id: orgId },
      select: { timezone: true },
    });
    const orgTz = safeTimezone(orgRow?.timezone);

    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      if (e instanceof BodyParseError) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      throw e;
    }

    const filterParams = {
      from: typeof body.from === 'string' ? body.from : undefined,
      to: typeof body.to === 'string' ? body.to : undefined,
      employeeId: typeof body.employeeId === 'string' ? body.employeeId : null,
      departmentId: typeof body.departmentId === 'string' ? body.departmentId : null,
      projectId: typeof body.projectId === 'string' ? body.projectId : null,
    };
    const parsed = await parseInsightFilters(orgId, orgTz, filterParams);
    if (!parsed.ok) return parsed.response;

    const result = await runAiInsightsAnalysis({
      organizationId: orgId,
      filters: parsed.filters,
    });

    const { analysis, meta, measured } = result;

    // Honest empty state: no employee data → nothing to summarize, nothing
    // persisted (an empty dataset can never produce a meaningful summary).
    // "Empty" = no employees matched OR no activity in the window (employees
    // may exist with zero tracked seconds).
    if (measured.employees.length === 0 || measured.totals.totalSeconds === 0) {
      log.warn('insights.generate.empty_dataset', {
        periodStart: meta.period.start,
        periodEnd: meta.period.end,
        filters: meta.filters,
      }, requestContext(req));
      return NextResponse.json({
        data: null,
        measured,
        ai: null,
        analysis,
        meta,
        message: 'No employee activity data is available for the selected filters and period.',
      });
    }

    // ── Build the persisted provenance + content from the analysis ─────────
    const isAi = analysis.mode === 'AI_ANALYSIS';
    const title = isAi
      ? (analysis.title?.slice(0, 90) || `AI Analysis — ${meta.period.start.slice(0, 10)} → ${meta.period.end.slice(0, 10)}`)
      : (analysis.title?.slice(0, 90) || `Data Summary — ${meta.period.start.slice(0, 10)} → ${meta.period.end.slice(0, 10)}`);
    const type = isAi
      ? (analysis.findings[0]?.type === 'risk' ? 'risk'
        : analysis.findings[0]?.type === 'trend' ? 'trend'
        : analysis.findings[0]?.type === 'project' ? 'recommendation'
        : analysis.findings[0]?.type === 'attendance' ? 'anomaly'
        : 'productivity')
      : 'productivity';
    const category =
      meta.filters.employeeId ? 'employee'
      : meta.filters.departmentId ? 'department'
      : meta.filters.projectId ? 'project'
      : 'team';

    // Provider/model are persisted ONLY for genuine AI output. A DATA_SUMMARY
    // fallback may know which provider/model was *attempted* (meta), but the
    // summary itself was produced from the database — storing the provider
    // would let it be mistaken for AI output.
    const persistedProvider = isAi ? meta.provider : null;
    const persistedModel = isAi ? meta.model : null;
    const metadata = JSON.stringify({
      mode: analysis.mode,
      source: meta.source,
      aiAvailable: meta.aiAvailable,
      fallbackUsed: meta.fallbackUsed,
      fallbackReason: meta.fallbackReason,
      provider: persistedProvider,
      model: persistedModel,
      generatedAt: meta.generatedAt,
      periodStart: meta.period.start,
      periodEnd: meta.period.end,
      filters: meta.filters,
      employeeIds: measured.employees.map((e) => e.employeeId),
      projectIds: measured.projects.map((p) => p.projectId),
      datasetHash: meta.datasetHash,
      aiStatus: meta.aiStatus,
      findings: analysis.findings.map((k) => ({
        type: k.type,
        severity: k.severity ?? null,
        title: k.title,
        statement: k.statement ?? null,
        description: k.description ?? null,
        employeeId: k.employeeId ?? null,
        projectId: k.projectId ?? null,
        evidence: k.evidence ?? null,
      })),
      evidence: analysis.evidence,
      measuredSnapshot: {
        totals: {
          productiveSeconds: measured.totals.productiveSeconds,
          totalSeconds: measured.totals.totalSeconds,
          productivityPct: measured.totals.productivityPct,
          activityCount: measured.totals.activityCount,
        },
      },
    });

    const insight = await db.$transaction(async (tx) => {
      const created = await tx.aiInsight.create({
        data: {
          title,
          content: analysis.summary,
          type,
          category,
          confidence: isAi ? null : null,
          metadata,
          organizationId: orgId,
        },
      });

      const action = isAi ? 'AI_ANALYSIS_GENERATED' : 'DATA_SUMMARY_GENERATED';
      const sourceLabel = isAi
        ? `AI analysis generated — provider ${meta.provider ?? 'n/a'}/${meta.model ?? 'n/a'}`
        : `Data summary generated — provider unavailable (${meta.fallbackReason ?? 'unknown'})`;
      await tx.auditLog.create({
        data: {
          action,
          resource: 'ai_insight',
          resourceId: created.id,
          description: `${sourceLabel}, period ${meta.period.start} → ${meta.period.end}, ${measured.employees.length} employee(s) analyzed`,
          userId: scope.userId,
          organizationId: orgId,
          metadata: JSON.stringify({
            mode: analysis.mode,
            source: meta.source,
            fallbackUsed: meta.fallbackUsed,
            fallbackReason: meta.fallbackReason,
            provider: meta.provider,
            model: meta.model,
            periodStart: meta.period.start,
            periodEnd: meta.period.end,
            filters: meta.filters,
            datasetHash: meta.datasetHash,
            employeesAnalyzed: measured.employees.length,
          }),
        },
      });

      return created;
    });

    return NextResponse.json(
      { data: insight, measured, ai: result.ai, analysis, meta },
      { status: isAi ? 201 : 201 }
    );
  } catch (error) {
    log.error('api.insights.', { error: String('Insights POST error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to generate insight' }, { status: 500 });
  }
}

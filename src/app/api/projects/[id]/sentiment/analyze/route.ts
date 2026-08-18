import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { callAIProvider } from '@/lib/ai-provider-helper';
import { requireManagerOrg, authError } from '@/lib/api';
import { hasActiveConsent } from '@/lib/consent';
import { checkRateLimit, getClientIpFromHeaders, RATE_LIMITS } from '@/lib/rate-limit';
import {
  calculateProjectSignals,
  calculateProjectScore,
  calculateProjectRiskFactors,
  determineProjectMood,
  generateProjectRulesInsight,
  projectSignalsPromptLines,
  type TimeEntryRow,
} from '@/lib/project-sentiment';

type ProjectAIOutcome =
  | { ok: true; insight: string; recommendation: string; provider: string; model: string }
  | { ok: false; error: string };

async function generateProjectAIInsight(
  employeeName: string,
  projectName: string,
  signals: ReturnType<typeof calculateProjectSignals>,
  score: number,
  mood: string,
  risks: string[]
): Promise<ProjectAIOutcome> {
  const systemPrompt =
    'You are a workforce sentiment analyst focused on project engagement. Given an employee\u2019s project-scoped activity signals, provide a brief analysis. Respond in exactly this JSON format: {"insight": "<2-sentence insight>", "recommendation": "<2-sentence recommendation>"}. No other text.';

  const userPrompt = [
    `Employee: ${employeeName}`,
    `Project: ${projectName}`,
    `Sentiment Score: ${score}/100 (${mood})`,
    `Risk Factors: ${risks.join(', ') || 'none'}`,
    '',
    'Project Activity Signals (TimeEntry-scoped):',
    ...projectSignalsPromptLines(signals),
  ].join('\n');

  const result = await callAIProvider(systemPrompt, userPrompt);
  if (!result || !result.text) {
    return { ok: false, error: result?.error || 'AI_UNAVAILABLE' };
  }

  try {
    const cleaned = result.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      ok: true,
      insight: parsed.insight || '',
      recommendation: parsed.recommendation || '',
      provider: result.provider,
      model: result.model,
    };
  } catch {
    return {
      ok: true,
      insight: result.text.substring(0, 300),
      recommendation: '',
      provider: result.provider,
      model: result.model,
    };
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

// In-process guard: one analysis run per (org, project, period start).
const runningProjectAnalyses = new Set<string>();

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // RBAC: analysis costs AI credits and mutates org data — manager+.
  const scope = await requireManagerOrg(req);
  if (!scope.ok) return authError(scope);
  const orgId = scope.organizationId;

  // Rate limit (AI-class): 10 runs/min/IP — the proxy rate-limits the
  // employee-level analyze route centrally; project analysis is per-project so
  // it is enforced here with the same budget.
  const rl = await checkRateLimit(
    `project-sentiment-analyze:${getClientIpFromHeaders(req.headers)}`,
    RATE_LIMITS.aiWrite.limit,
    RATE_LIMITS.aiWrite.windowMs
  );
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Rate limit exceeded. Try again in ${rl.retryAfterSeconds} seconds.` },
      { status: 429 }
    );
  }

  const { id } = await params;
  if (!id || id.length > 64) {
    return NextResponse.json({ error: 'Invalid project id' }, { status: 400 });
  }

  // Safe body parse (client error -> 400, never a 500).
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const b = (body ?? {}) as { employeeIds?: unknown; periodDays?: unknown };

  // ── Validation ──
  let periodDays = 7;
  if (b.periodDays !== undefined) {
    if (typeof b.periodDays !== 'number' || !Number.isInteger(b.periodDays) || b.periodDays < 1 || b.periodDays > 90) {
      return NextResponse.json({ error: 'periodDays must be an integer between 1 and 90' }, { status: 400 });
    }
    periodDays = b.periodDays;
  }

  let employeeIds: string[] | null = null;
  if (b.employeeIds !== undefined) {
    if (!Array.isArray(b.employeeIds)) {
      return NextResponse.json({ error: 'employeeIds must be an array of employee IDs' }, { status: 400 });
    }
    const ids = b.employeeIds as unknown[];
    if (ids.length > 50) {
      return NextResponse.json({ error: 'employeeIds may contain at most 50 employees per run' }, { status: 400 });
    }
    if (ids.some((x) => typeof x !== 'string' || x.length === 0 || x.length > 64)) {
      return NextResponse.json({ error: 'employeeIds must be non-empty strings' }, { status: 400 });
    }
    employeeIds = ids as string[];
  }

  // ── Project + membership resolution (tenant-scoped) ──
  const project = await db.project.findFirst({
    where: { id, organizationId: orgId },
    select: { id: true, name: true, status: true },
  });
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  // Active members only — sentiment is derived from project-assigned work.
  const memberships = await db.projectMember.findMany({
    where: { projectId: id, leftAt: null, organizationId: orgId },
    include: { employee: { select: { id: true, firstName: true, lastName: true, status: true } } },
  });

  let members = memberships.map((m) => m.employee);
  if (employeeIds && employeeIds.length > 0) {
    const allowed = new Set(members.map((e) => e.id));
    const unknown = employeeIds.filter((eid) => !allowed.has(eid));
    if (unknown.length > 0) {
      return NextResponse.json(
        { error: 'One or more employees are not active members of this project' },
        { status: 403 }
      );
    }
    members = members.filter((e) => employeeIds!.includes(e.id));
  }
  // Only active employees are analyzed.
  members = members.filter((e) => e.status === 'active');

  if (members.length === 0) {
    return NextResponse.json({
      data: [], analyzed: 0, total: 0, consentSkipped: 0, noData: 0,
      aiSuccess: 0, aiFallback: { count: 0, reasons: [] }, aiFailures: [],
      periodStart: null, periodEnd: null, project: { id: project.id, name: project.name },
    });
  }

  // ── Period windows (same UTC-midnight anchoring as employee-level) ──
  const now = new Date();
  const periodEnd = new Date(now);
  const periodStart = new Date(now);
  periodStart.setDate(periodStart.getDate() - periodDays);
  periodStart.setUTCHours(0, 0, 0, 0);

  const runKey = `${orgId}:${project.id}:${periodStart.toISOString()}`;
  if (runningProjectAnalyses.has(runKey)) {
    return NextResponse.json(
      { error: 'An analysis for this project and period is already running. Try again once it completes.' },
      { status: 409 }
    );
  }
  runningProjectAnalyses.add(runKey);

  try {
    // ── Consent gate (fail-closed, same semantics as employee-level) ──
    const consentResults = await Promise.all(
      members.map(async (e) => ({ employee: e, consented: await hasActiveConsent(e.id, 'activity_tracking') }))
    );
    const consented = consentResults.filter((r) => r.consented).map((r) => r.employee);
    const consentSkipped = members.length - consented.length;

    if (consented.length === 0) {
      return NextResponse.json({
        data: [], analyzed: 0, total: members.length, consentSkipped, noData: 0,
        aiSuccess: 0, aiFallback: { count: 0, reasons: [] }, aiFailures: [],
        periodStart, periodEnd, project: { id: project.id, name: project.name },
      });
    }

    const prevStart = new Date(periodStart);
    prevStart.setDate(prevStart.getDate() - periodDays);

    const employeeIdList = consented.map((e) => e.id);

    // ── Project-scoped activity: TimeEntry rows ONLY for this project ──
    // This is the privacy/data-truth boundary: an employee's hours on OTHER
    // projects (or general Activity rows) never enter project sentiment.
    const [currentEntries, previousEntries] = await Promise.all([
      db.timeEntry.findMany({
        where: {
          projectId: id,
          employeeId: { in: employeeIdList },
          date: { gte: periodStart, lte: periodEnd },
        },
        select: { employeeId: true, date: true, hours: true, category: true, billable: true },
      }),
      db.timeEntry.findMany({
        where: {
          projectId: id,
          employeeId: { in: employeeIdList },
          date: { gte: prevStart, lt: periodStart },
        },
        select: { employeeId: true, date: true, hours: true, category: true, billable: true },
      }),
    ]);

    const currentByEmployee = new Map<string, TimeEntryRow[]>();
    for (const e of currentEntries) {
      const list = currentByEmployee.get(e.employeeId) ?? [];
      list.push(e);
      currentByEmployee.set(e.employeeId, list);
    }
    const previousByEmployee = new Map<string, TimeEntryRow[]>();
    for (const e of previousEntries) {
      const list = previousByEmployee.get(e.employeeId) ?? [];
      list.push(e);
      previousByEmployee.set(e.employeeId, list);
    }

    // ── Per-member analysis (bounded AI concurrency) ──
    let aiSuccessCount = 0;
    const aiFallback: { count: number; reasons: string[] } = { count: 0, reasons: [] };
    const aiFailures: { employeeId: string; reason: string }[] = [];
    let noData = 0;

    type Member = (typeof consented)[number];

    const prepared = await mapWithConcurrency<Member, unknown>(consented, 3, async (member) => {
      try {
        const current = currentByEmployee.get(member.id) ?? [];
        const signals = calculateProjectSignals(current, previousByEmployee.get(member.id) ?? []);

        // No-data: zero time entries for this project in the window. Score is
        // NULL (mood 'no-data') — never a fabricated neutral.
        if (signals.entryCount === 0) {
          noData++;
          return {
            ok: true,
            employeeId: member.id,
            data: {
              employeeId: member.id,
              projectId: project.id,
              organizationId: orgId,
              score: null,
              mood: 'no-data',
              signals: JSON.stringify(signals),
              insight:
                'No project activity data (time entries) is available for this period, so this employee was not scored for this project.',
              riskFactors: '[]',
              recommendation:
                'Log project time entries for this employee, or verify the employee is actively assigned to the project.',
              periodStart,
              periodEnd,
              aiProviderUsed: 'none',
              aiModel: null,
            },
          };
        }

        const score = calculateProjectScore(signals);
        const mood = determineProjectMood(score);
        const riskFactors = calculateProjectRiskFactors(signals, score);

        const aiResult = await generateProjectAIInsight(
          `${member.firstName} ${member.lastName}`,
          project.name,
          signals,
          score,
          mood,
          riskFactors
        );

        let insight: string;
        let recommendation: string;
        let provider = 'rules';
        let model: string | null = null;

        if (aiResult.ok) {
          aiSuccessCount++;
          insight = aiResult.insight;
          recommendation = aiResult.recommendation;
          provider = aiResult.provider;
          model = aiResult.model;
        } else {
          aiFallback.count++;
          const reason = aiResult.error || 'AI_UNAVAILABLE';
          if (!aiFallback.reasons.includes(reason)) aiFallback.reasons.push(reason);
          const rules = generateProjectRulesInsight(signals, score, mood, riskFactors);
          insight = rules.insight;
          recommendation = rules.recommendation;
        }

        return {
          ok: true,
          employeeId: member.id,
          data: {
            employeeId: member.id,
            projectId: project.id,
            organizationId: orgId,
            score,
            mood,
            signals: JSON.stringify(signals),
            insight,
            riskFactors: JSON.stringify(riskFactors),
            recommendation,
            periodStart,
            periodEnd,
            aiProviderUsed: provider,
            aiModel: model,
          },
        };
      } catch (err) {
        console.error(`Failed to analyze project sentiment for employee ${member.id}:`, err);
        return { ok: false as const, employeeId: member.id, reason: String(err) };
      }
    });

    const valid = prepared.filter(
      (p): p is { ok: true; employeeId: string; data: Record<string, unknown> } => p !== null && typeof p === 'object' && (p as { ok?: boolean }).ok === true
    ) as Array<{ ok: true; employeeId: string; data: Record<string, unknown> }>;
    for (const p of prepared) {
      if (p !== null && typeof p === 'object' && (p as { ok?: boolean }).ok === false) {
        aiFailures.push({ employeeId: (p as { employeeId: string }).employeeId, reason: (p as { reason: string }).reason });
      }
    }

    const analyzedEmployeeIds = valid.map((v) => v.employeeId);

    // ── Atomic replace of this (project, employee, period) window ──
    // Reruns replace, never accumulate; other periods/projects are untouched.
    const writeOps = [
      db.sentimentRecord.deleteMany({
        where: {
          organizationId: orgId,
          projectId: project.id,
          employeeId: { in: analyzedEmployeeIds },
          periodStart: { equals: periodStart },
        },
      }),
      ...valid.map(({ data }) =>
        db.sentimentRecord.create({
          data: data as Parameters<typeof db.sentimentRecord.create>[0]['data'],
          include: {
            employee: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                designation: true,
                employeeId: true,
                department: { select: { id: true, name: true } },
              },
            },
          },
        })
      ),
    ];

    const txResults = await db.$transaction(writeOps);
    const results = txResults.slice(1) as unknown[];

    // Audit log for the run.
    await db.auditLog.create({
      data: {
        action: 'create',
        resource: 'sentiment_record',
        description: `Project sentiment analysis run for project "${project.name}" (${results.length} employee(s)) — ${aiSuccessCount} AI-generated, ${aiFallback.count} rules-based, ${noData} no-data, ${aiFailures.length} failed`,
        userId: scope.userId,
        organizationId: orgId,
      },
    });

    return NextResponse.json({
      data: results,
      analyzed: results.length,
      total: members.length,
      consentSkipped,
      noData,
      aiSuccess: aiSuccessCount,
      aiFallback,
      aiFailures,
      periodStart,
      periodEnd,
      project: { id: project.id, name: project.name },
    });
  } catch (error) {
    console.error('Project sentiment analyze error:', error);
    return NextResponse.json({ error: 'Failed to analyze project sentiment' }, { status: 500 });
  } finally {
    runningProjectAnalyses.delete(runKey);
  }
}

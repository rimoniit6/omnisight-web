import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { callAIProvider } from '@/lib/ai-provider-helper';
import { meterAiCall } from '@/lib/ai-metering';
import type { Prisma } from '@prisma/client';
import { requireManagerOrg, authError } from '@/lib/api';
import { hasActiveConsent } from '@/lib/consent';
import { log, requestContext } from '@/lib/logger';

interface Signals {
  productivityTrend: number;
  idleRate: number;
  overtimeHours: number;
  breakFrequency: number;
  loginConsistency: number;
  anomalyCount: number;
  activityDrop: boolean;
  productiveHoursThisWeek: number;
  productiveHoursLastWeek: number;
  totalHoursThisWeek: number;
  idleHoursThisWeek: number;
  activityCount: number;
}

type ActivityRow = {
  employeeId: string;
  timestamp: Date;
  duration: number;
  category: string | null;
  type: string;
};

type SentimentRecord = Awaited<ReturnType<typeof db.sentimentRecord.create>>;

function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map((v) => (v - mean) ** 2);
  return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / values.length);
}

// Loads signals for ALL employees in 3 batched queries (no N+1):
// 1 current-period activities, 1 previous-period activities, 1 anomaly count.
function calculateSignals(
  currentActivities: ActivityRow[],
  previousActivities: ActivityRow[],
  anomalyCount: number
): Signals {
  // Calculate hours (duration is in seconds)
  const toHours = (secs: number) => secs / 3600;

  const productiveThisWeek = currentActivities
    .filter((a) => a.category === 'productive')
    .reduce((sum, a) => sum + a.duration, 0);

  const productiveLastWeek = previousActivities
    .filter((a) => a.category === 'productive')
    .reduce((sum, a) => sum + a.duration, 0);

  const totalThisWeek = currentActivities.reduce(
    (sum, a) => sum + a.duration,
    0
  );
  const idleThisWeek = currentActivities
    .filter((a) => a.category === 'unproductive' || a.type === 'idle')
    .reduce((sum, a) => sum + a.duration, 0);

  // Productivity trend: percentage change this week vs last week
  const productivityTrend =
    productiveLastWeek > 0
      ? ((productiveThisWeek - productiveLastWeek) / productiveLastWeek) * 100
      : 0;

  // Idle rate
  const idleRate =
    totalThisWeek > 0 ? (idleThisWeek / totalThisWeek) * 100 : 0;

  // Overtime: hours beyond 8h/day average (for days with activity)
  const dayMap = new Map<string, number>();
  for (const a of currentActivities) {
    const day = a.timestamp.toISOString().split('T')[0];
    dayMap.set(day, (dayMap.get(day) || 0) + a.duration);
  }
  const dailyHours = Array.from(dayMap.values()).map(toHours);
  const overtimeHours = dailyHours.reduce(
    (sum, h) => sum + Math.max(0, h - 8),
    0
  );

  // Break frequency: how many distinct idle/unproductive sessions per day (avg)
  const idleSessions = currentActivities.filter(
    (a) => a.category === 'unproductive' || a.type === 'idle'
  );
  const idleDayMap = new Map<string, number>();
  for (const a of idleSessions) {
    const day = a.timestamp.toISOString().split('T')[0];
    idleDayMap.set(day, (idleDayMap.get(day) || 0) + 1);
  }
  const breakFrequency =
    idleDayMap.size > 0
      ? Array.from(idleDayMap.values()).reduce((a, b) => a + b, 0) /
        idleDayMap.size
      : 0;

  // Login consistency: std dev of daily first-activity timestamps (in hours from midnight)
  const loginTimes: number[] = [];
  const byDay = new Map<string, ActivityRow[]>();
  for (const a of currentActivities) {
    const day = a.timestamp.toISOString().split('T')[0];
    const list = byDay.get(day) ?? [];
    list.push(a);
    byDay.set(day, list);
  }
  for (const dayActivities of byDay.values()) {
    if (dayActivities.length === 0) continue;
    dayActivities.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const first = dayActivities[0].timestamp;
    loginTimes.push(
      first.getHours() + first.getMinutes() / 60 + first.getSeconds() / 3600
    );
  }
  const loginConsistency = standardDeviation(loginTimes);

  // Activity drop
  const activityDrop = productiveLastWeek > 0 && productivityTrend < -20;

  return {
    productivityTrend,
    idleRate,
    overtimeHours,
    breakFrequency,
    loginConsistency,
    anomalyCount,
    activityDrop,
    productiveHoursThisWeek: toHours(productiveThisWeek),
    productiveHoursLastWeek: toHours(productiveLastWeek),
    totalHoursThisWeek: toHours(totalThisWeek),
    idleHoursThisWeek: toHours(idleThisWeek),
    activityCount: currentActivities.length,
  };
}

function calculateScore(signals: Signals): number {
  let score = 50;

  if (signals.productivityTrend > 5) score += 10;
  else if (signals.productivityTrend > 0) score += 5;
  else if (signals.productivityTrend < -10) score -= 5;

  if (signals.idleRate > 30) score -= 10;
  else if (signals.idleRate > 20) score -= 5;

  if (signals.overtimeHours > 5) score -= 5;
  else if (signals.overtimeHours > 2) score -= 3;

  if (signals.loginConsistency < 0.5) score += 5;
  else if (signals.loginConsistency > 2) score -= 5;

  if (signals.activityDrop) score -= 15;

  if (signals.anomalyCount >= 3) score -= 10;
  else if (signals.anomalyCount >= 1) score -= 5;

  return Math.max(0, Math.min(100, score));
}

function determineMood(score: number): string {
  if (score > 70) return 'positive';
  if (score >= 40) return 'neutral';
  if (score >= 25) return 'negative';
  return 'critical';
}

function calculateRiskFactors(signals: Signals, score: number): string[] {
  const risks: string[] = [];
  if (signals.overtimeHours > 5 || signals.productivityTrend < -10) {
    risks.push('burnout_risk');
  }
  if (signals.idleRate > 30) {
    risks.push('disengaged');
  }
  if (signals.overtimeHours > 3) {
    risks.push('overworked');
  }
  if (score < 40) {
    risks.push('underperforming');
  }
  if (signals.loginConsistency > 2) {
    risks.push('irregular_hours');
  }
  return risks;
}

function generateRulesInsight(
  signals: Signals,
  score: number,
  mood: string,
  risks: string[]
): { insight: string; recommendation: string } {
  const parts: string[] = [];

  if (signals.productivityTrend > 5) {
    parts.push('Productivity has improved recently.');
  } else if (signals.productivityTrend < -10) {
    parts.push('Productivity has declined significantly.');
  }

  if (signals.idleRate > 30) {
    parts.push('High idle time detected.');
  }

  if (signals.overtimeHours > 3) {
    parts.push('Employee is working overtime regularly.');
  }

  if (signals.anomalyCount > 0) {
    parts.push(`${signals.anomalyCount} anomaly(s) detected in this period.`);
  }

  if (parts.length === 0) {
    parts.push('Employee sentiment is stable with no major concerns.');
  }

  const insight = parts.join(' ');

  let recommendation = 'Continue monitoring.';
  if (risks.includes('burnout_risk')) {
    recommendation =
      'Consider reviewing workload and encouraging work-life balance.';
  } else if (risks.includes('disengaged')) {
    recommendation =
      'Schedule a check-in to understand potential disengagement.';
  } else if (risks.includes('overworked')) {
    recommendation =
      'Evaluate task distribution to reduce overtime burden.';
  } else if (risks.includes('underperforming')) {
    recommendation =
      'Provide additional support or training to improve performance.';
  } else if (mood === 'positive') {
    recommendation =
      'Employee is performing well. Consider recognition or new challenges.';
  }

  return { insight, recommendation };
}

type AIOutcome =
  | { ok: true; insight: string; recommendation: string; provider: string; model: string }
  | { ok: false; error: string };

async function generateAIInsight(
  orgId: string,
  employeeName: string,
  signals: Signals,
  score: number,
  mood: string,
  risks: string[]
): Promise<AIOutcome> {
  const systemPrompt =
    'You are a workforce sentiment analyst. Given employee activity signals, provide a brief analysis. Respond in exactly this JSON format: {"insight": "<2-sentence insight>", "recommendation": "<2-sentence recommendation>"}. No other text.';

  const userPrompt = `Employee: ${employeeName}
Sentiment Score: ${score}/100 (${mood})
Risk Factors: ${risks.join(', ') || 'none'}

Activity Signals:
- Productivity trend: ${signals.productivityTrend > 0 ? '+' : ''}${signals.productivityTrend.toFixed(1)}%
- Idle rate: ${signals.idleRate.toFixed(1)}%
- Overtime hours: ${signals.overtimeHours.toFixed(1)}h
- Break frequency: ${signals.breakFrequency.toFixed(1)} sessions/day
- Login consistency (std dev): ${signals.loginConsistency.toFixed(2)}h
- Anomaly count: ${signals.anomalyCount}
- Activity drop >20%: ${signals.activityDrop}
- Productive hours this week: ${signals.productiveHoursThisWeek.toFixed(1)}h
- Total hours this week: ${signals.totalHoursThisWeek.toFixed(1)}h`;

  const result = await meterAiCall({ organizationId: orgId, operation: 'sentiment' }, () =>
    callAIProvider(systemPrompt, userPrompt)
  );
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
    // If JSON parse fails, try to use raw text as insight
    return {
      ok: true,
      insight: result.text.substring(0, 300),
      recommendation: '',
      provider: result.provider,
      model: result.model,
    };
  }
}

/**
 * Runs an async worker pool over items, at most `limit` concurrent
 * executions. Used to bound parallel AI calls so a large analysis run never
 * fires 50 simultaneous provider requests.
 */
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

// In-process guard: only one analysis run per (org, period start) at a time.
// The 409 is transient — the UI can simply retry after the current run ends.
const runningAnalyses = new Set<string>();

export async function POST(req: NextRequest) {
  // RBAC: running analyses costs AI credits and mutates org data — manager+.
  const scope = await requireManagerOrg(req);
  if (!scope.ok) return authError(scope);
  const orgId = scope.organizationId;

  // Safe body parse: a bodyless/malformed request is a client error (400),
  // never a 500.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const b = (body ?? {}) as { employeeIds?: unknown; periodDays?: unknown; startDate?: unknown; endDate?: unknown };

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
    if (ids.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 64)) {
      return NextResponse.json({ error: 'employeeIds must be non-empty strings' }, { status: 400 });
    }
    employeeIds = ids as string[];
  }

  const now = new Date();
  const periodEnd = new Date(now);
  const periodStart = new Date(now);
  periodStart.setDate(periodStart.getDate() - periodDays);
  // Anchor to UTC midnight so consecutive runs of the same period share the
  // same window identity — reruns replace, instead of stacking duplicates.
  periodStart.setUTCHours(0, 0, 0, 0);

  // Duplicate-run guard (per org + period window)
  const runKey = `${orgId}:${periodStart.toISOString()}`;
  if (runningAnalyses.has(runKey)) {
    return NextResponse.json(
      { error: 'An analysis for this period is already running. Try again once it completes.' },
      { status: 409 }
    );
  }
  runningAnalyses.add(runKey);

  try {
    // Determine employees to analyze (tenant-scoped: org always from the
    // verified session, client ids can only narrow the set).
    const employees = await db.employee.findMany({
      where: {
        status: 'active',
        organizationId: orgId,
        ...(employeeIds && employeeIds.length > 0 ? { id: { in: employeeIds } } : {}),
      },
    });

    if (employees.length === 0) {
      return NextResponse.json({
        data: [],
        analyzed: 0,
        total: 0,
        consentSkipped: 0,
        noData: 0,
        aiSuccess: 0,
        aiFallback: { count: 0, reasons: [] },
        aiFailures: [],
        periodStart,
        periodEnd,
      });
    }

    // ── Consent gate ──
    // Only employees with an ACTIVE activity_tracking consent are analyzed —
    // the same fail-closed check the agent itself applies before collecting
    // activity (hasActiveConsent). Employees without consent are skipped and
    // counted; their data was never collected, so no analysis is possible.
    const consentResults = await Promise.all(
      employees.map(async (e) => ({
        employee: e,
        consented: await hasActiveConsent(e.id, 'activity_tracking'),
      }))
    );
    const consented = consentResults.filter((r) => r.consented).map((r) => r.employee);
    const consentSkipped = employees.length - consented.length;

    if (consented.length === 0) {
      return NextResponse.json({
        data: [],
        analyzed: 0,
        total: employees.length,
        consentSkipped,
        noData: 0,
        aiSuccess: 0,
        aiFallback: { count: 0, reasons: [] },
        aiFailures: [],
        periodStart,
        periodEnd,
      });
    }

    const prevStart = new Date(periodStart);
    prevStart.setDate(prevStart.getDate() - periodDays);

    const employeeIdList = consented.map((e) => e.id);

    // Batch 1: current-period activities
    const currentActivities = await db.activity.findMany({
      where: {
        employeeId: { in: employeeIdList },
        timestamp: { gte: periodStart, lte: periodEnd },
      },
      select: { employeeId: true, timestamp: true, duration: true, category: true, type: true },
    });

    // Batch 2: previous-period activities
    const previousActivities = await db.activity.findMany({
      where: {
        employeeId: { in: employeeIdList },
        timestamp: { gte: prevStart, lt: periodStart },
      },
      select: { employeeId: true, timestamp: true, duration: true, category: true, type: true },
    });

    // Batch 3: anomaly counts in current period
    const anomalyCounts = await db.anomaly.groupBy({
      by: ['employeeId'],
      where: {
        employeeId: { in: employeeIdList },
        createdAt: { gte: periodStart, lte: periodEnd },
      },
      _count: { _all: true },
    });
    const anomalyCountByEmployee = new Map(
      anomalyCounts.map((a) => [a.employeeId, a._count._all])
    );

    const currentByEmployee = new Map<string, ActivityRow[]>();
    for (const a of currentActivities) {
      const list = currentByEmployee.get(a.employeeId) ?? [];
      list.push(a);
      currentByEmployee.set(a.employeeId, list);
    }
    const previousByEmployee = new Map<string, ActivityRow[]>();
    for (const a of previousActivities) {
      const list = previousByEmployee.get(a.employeeId) ?? [];
      list.push(a);
      previousByEmployee.set(a.employeeId, list);
    }

    // ── Per-employee analysis (bounded concurrency for AI calls) ──
    let aiSuccessCount = 0;
    const aiFallback: { count: number; reasons: string[] } = { count: 0, reasons: [] };
    const aiFailures: { employeeId: string; reason: string }[] = [];
    let noData = 0;

    type Employee = (typeof consented)[number];
    type PreparedOk = { ok: true; employee: Employee; data: Prisma.SentimentRecordUncheckedCreateInput };
    type Prepared = PreparedOk | { ok: false; employeeId: string; reason: string };

    const prepared = await mapWithConcurrency<Employee, Prepared>(consented, 3, async (employee) => {
      try {
        const current = currentByEmployee.get(employee.id) ?? [];
        const signals = calculateSignals(
          current,
          previousByEmployee.get(employee.id) ?? [],
          anomalyCountByEmployee.get(employee.id) ?? 0
        );

        // No-data state: zero activity in the window means we have nothing to
        // measure. Score is left NULL (mood 'no-data') — we never fabricate a
        // neutral score for an unmeasured employee.
        if (signals.activityCount === 0) {
          noData++;
          const data: Prisma.SentimentRecordUncheckedCreateInput = {
            employeeId: employee.id,
            organizationId: orgId,
            score: null,
            mood: 'no-data',
            signals: JSON.stringify(signals),
            insight:
              'No activity data available for this period, so this employee was not scored.',
            riskFactors: '[]',
            recommendation:
              'Activity data was not collected for this period. Check the agent connection and that the employee has active activity-tracking consent.',
            periodStart,
            periodEnd,
            aiProviderUsed: 'none',
            aiModel: null,
          };
          return { ok: true, employee, data };
        }

        const score = calculateScore(signals);
        const mood = determineMood(score);
        const riskFactors = calculateRiskFactors(signals, score);

        const aiResult = await generateAIInsight(
          orgId,
          `${employee.firstName} ${employee.lastName}`,
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
          const rules = generateRulesInsight(signals, score, mood, riskFactors);
          insight = rules.insight;
          recommendation = rules.recommendation;
        }

        const data: Prisma.SentimentRecordUncheckedCreateInput = {
          employeeId: employee.id,
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
        };
        return { ok: true, employee, data };
      } catch (err) {
        log.error('api.sentiment.analyze.', { error: String(`Failed to analyze employee ${employee.id}:`) }, requestContext(req));log.error('api.sentiment\analyze\route.ts.', { error: String(`Failed to analyze employee ${employee.id}:`) }, requestContext(req));
        return { ok: false as const, employeeId: employee.id, reason: String(err) };
      }
    });

    const valid = prepared.filter((p): p is PreparedOk => p.ok === true);
    for (const f of prepared) {
      if (!f.ok) aiFailures.push({ employeeId: f.employeeId, reason: f.reason });
    }

    const analyzedEmployeeIds = valid.map((v) => v.employee.id);

    // Atomic batch write: replace this exact period's records for the analyzed
    // employees (reruns replace, never accumulate), then insert the new rows.
    // Records from OTHER periods/windows are left untouched. The replace is
    // scoped to EMPLOYEE-LEVEL records (projectId IS NULL): project-scoped
    // sentiment rows are owned by the project analyze flow and must never be
    // deleted or overwritten by an org-wide run.
    const writeOps: Prisma.PrismaPromise<unknown>[] = [
      db.sentimentRecord.deleteMany({
        where: {
          organizationId: orgId,
          employeeId: { in: analyzedEmployeeIds },
          projectId: null,
          periodStart: { equals: periodStart },
        },
      }),
    ];

    for (const { data } of valid) {
      writeOps.push(
        db.sentimentRecord.create({
          data,
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
      );
    }

    const txResults = await db.$transaction(writeOps);
    const results = txResults.slice(1) as SentimentRecord[];

    // Audit log for the run (actor, org, outcome counters)
    await db.auditLog.create({
      data: {
        action: 'create',
        resource: 'sentiment_record',
        description: `Sentiment analysis run for ${results.length} employee(s) — ${aiSuccessCount} AI-generated, ${aiFallback.count} rules-based, ${noData} no-data, ${aiFailures.length} failed`,
        userId: scope.userId,
        organizationId: orgId,
      },
    });

    return NextResponse.json({
      data: results,
      analyzed: results.length,
      total: employees.length,
      consentSkipped,
      noData,
      aiSuccess: aiSuccessCount,
      aiFallback,
      aiFailures,
      periodStart,
      periodEnd,
    });
  } catch (error) {
    log.error('api.sentiment.analyze.', { error: String('Sentiment analyze error:') }, requestContext(req));
    return NextResponse.json(
      { error: 'Failed to analyze sentiment' },
      { status: 500 }
    );
  } finally {
    runningAnalyses.delete(runKey);
  }
}

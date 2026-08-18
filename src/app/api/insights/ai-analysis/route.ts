import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSessionOrg } from '@/lib/api';
import { excludeInternalAgentActivities } from '@/lib/agent-process';
import { isHeartbeatFresh } from '@/lib/presence';
import { runAiInsightsAnalysis } from '@/lib/ai-insights/engine';
import { parseInsightFilters } from '@/lib/ai-insights/filters';
import { safeTimezone } from '@/lib/timezone';

interface AnalysisInsight {
  title: string;
  content: string;
  type: 'productivity' | 'efficiency' | 'risk' | 'opportunity';
  confidence: number;
  recommendation: string;
  category: string;
}

export async function GET(req: NextRequest) {
  try {
    const org = await getSessionOrg(req);
    if (!org) return NextResponse.json({ error: 'No organization found' }, { status: 400 });

    // Org timezone for org-local day boundaries on the filters.
    const orgRow = await db.organization.findUnique({
      where: { id: org.id },
      select: { timezone: true },
    });
    const orgTz = safeTimezone(orgRow?.timezone);

    const { searchParams } = new URL(req.url);
    const filterParams = {
      from: searchParams.get('from') || undefined,
      to: searchParams.get('to') || undefined,
      employeeId: searchParams.get('employeeId'),
      departmentId: searchParams.get('departmentId'),
      projectId: searchParams.get('projectId'),
    };
    const parsed = await parseInsightFilters(org.id, orgTz, filterParams);
    if (!parsed.ok) return parsed.response;

    // ── Run the REAL AI analysis (engine) ─────────────────────────────────
    // Returns deterministic `measured` stats ALWAYS, plus `ai` when the
    // provider actually generated a validated response. Never labels the
    // rules engine as AI.
    const result = await runAiInsightsAnalysis({
      organizationId: org.id,
      filters: parsed.filters,
    });

    // ── Rule-based deterministic analysis (kept for compatibility + the
    //    "Measured" view — explicitly NOT AI). Same filters as the AI run so
    //    both always describe the same dataset. ─────────────────────────────
    const f = parsed.filters;
    const employees = await db.employee.findMany({
      where: {
        status: 'active',
        organizationId: org.id,
        ...(f.employeeId ? { id: f.employeeId } : {}),
        ...(f.departmentId ? { departmentId: f.departmentId } : {}),
      },
      include: {
        department: { select: { name: true } },
        activities: {
          where: {
            timestamp: { gte: f.periodStart, lte: f.periodEnd },
            ...(f.projectId ? {} : {}),
          },
          select: { category: true, duration: true, type: true, applicationName: true },
        },
      },
    });

    const departments = await db.department.findMany({
      where: { organizationId: org.id },
      include: {
        employees: {
          where: { status: 'active' },
          include: { activities: { select: { category: true, duration: true, applicationName: true } } },
        },
      },
    });

    const devices = await db.device.findMany({
      where: { organizationId: org.id },
      select: { status: true, operatingSystem: true, name: true, lastHeartbeat: true },
    });

    const recentActivities = excludeInternalAgentActivities(await db.activity.findMany({
      where: {
        employee: { organizationId: org.id },
        timestamp: { gte: f.periodStart, lte: f.periodEnd },
      },
      orderBy: { timestamp: 'desc' },
      take: 500,
      select: { category: true, duration: true, type: true, timestamp: true, applicationName: true },
    }));

    const insights: AnalysisInsight[] = [];

    const empProductivity = employees.map((e) => {
      const empActs = excludeInternalAgentActivities(e.activities);
      const productive = empActs
        .filter((a) => a.category === 'productive')
        .reduce((s, a) => s + a.duration, 0);
      const total = empActs.reduce((s, a) => s + a.duration, 0);
      const ratio = total > 0 ? productive / total : 0;
      return {
        name: `${e.firstName} ${e.lastName}`,
        dept: e.department?.name || 'Unassigned',
        productiveMinutes: Math.round(productive / 60),
        totalMinutes: Math.round(total / 60),
        ratio,
      };
    }).sort((a, b) => b.ratio - a.ratio);

    const topPerformers = empProductivity.slice(0, 3);
    const bottomPerformers = empProductivity.slice(-3).reverse();

    if (topPerformers.length > 0 && bottomPerformers.length > 0) {
      const avgTopRatio = topPerformers.reduce((s, e) => s + e.ratio, 0) / topPerformers.length;
      const avgBottomRatio = bottomPerformers.reduce((s, e) => s + e.ratio, 0) / bottomPerformers.length;
      const gap = avgTopRatio - avgBottomRatio;

      insights.push({
        title: 'Productivity Gap Analysis',
        content: `Top performers (${topPerformers.map((e) => e.name).join(', ')}) average ${Math.round(avgTopRatio * 100)}% productive time, while bottom performers (${bottomPerformers.map((e) => e.name).join(', ')}) average ${Math.round(avgBottomRatio * 100)}%. The ${Math.round(gap * 100)} percentage point gap indicates significant room for improvement in underperforming segments.`,
        type: 'productivity',
        confidence: Math.min(0.95, 0.5 + gap),
        recommendation: `Implement peer mentoring: pair ${bottomPerformers[0]?.name} with ${topPerformers[0]?.name}. Review workload distribution for the bottom 3 performers and consider targeted training sessions.`,
        category: 'team',
      });
    }

    const deptStats = departments
      .filter((d) => d.employees.length > 0)
      .map((d) => {
        const allActs = d.employees.flatMap((e) => excludeInternalAgentActivities(e.activities));
        const productive = allActs.filter((a) => a.category === 'productive').reduce((s, a) => s + a.duration, 0);
        const total = allActs.reduce((s, a) => s + a.duration, 0);
        return {
          name: d.name,
          employeeCount: d.employees.length,
          productiveMinutes: Math.round(productive / 60),
          totalMinutes: Math.round(total / 60),
          ratio: total > 0 ? productive / total : 0,
        };
      }).sort((a, b) => b.ratio - a.ratio);

    if (deptStats.length >= 2) {
      const best = deptStats[0];
      const worst = deptStats[deptStats.length - 1];
      const deptGap = best.ratio - worst.ratio;

      insights.push({
        title: 'Department Efficiency Comparison',
        content: `${best.name} leads with ${Math.round(best.ratio * 100)}% productive time across ${best.employeeCount} employees (${best.productiveMinutes}h productive). ${worst.name} trails at ${Math.round(worst.ratio * 100)}% with ${worst.employeeCount} employees. The ${Math.round(deptGap * 100)}pp spread across departments suggests process inconsistencies.`,
        type: 'efficiency',
        confidence: Math.min(0.95, 0.5 + deptGap),
        recommendation: `Benchmark ${best.name}'s workflows and practices. Schedule cross-departmental reviews to identify what drives ${best.name}'s higher productivity. Consider resource reallocation from ${worst.name} if capacity allows.`,
        category: 'department',
      });
    }

    const statusCounts: Record<string, number> = {};
    const osCounts: Record<string, number> = {};
    let onlineCount = 0;
    devices.forEach((d) => {
      const effective = d.status && ['maintenance', 'inactive', 'retired'].includes(d.status)
        ? d.status
        : d.lastHeartbeat && isHeartbeatFresh(new Date(d.lastHeartbeat)) ? 'online' : 'offline';
      statusCounts[effective] = (statusCounts[effective] || 0) + 1;
      if (d.operatingSystem) {
        const os = d.operatingSystem;
        osCounts[os] = (osCounts[os] || 0) + 1;
      }
      if (effective === 'online') onlineCount++;
    });

    const offlineCount = statusCounts['offline'] || 0;
    const maintCount = statusCounts['maintenance'] || 0;
    const needsAttention = offlineCount + maintCount;
    const totalDevices = devices.length;
    const uptimePercent = totalDevices > 0 ? Math.round((onlineCount / totalDevices) * 100) : 0;

    const riskLevel = needsAttention > totalDevices * 0.3 ? 'high' : needsAttention > totalDevices * 0.15 ? 'medium' : 'low';
    const fleetConfidence = totalDevices > 0 ? Math.min(0.95, 0.45 + (needsAttention / totalDevices) * 0.5) : 0.5;

    insights.push({
      title: 'Device Fleet Health Assessment',
      content: `Fleet uptime stands at ${uptimePercent}% with ${onlineCount}/${totalDevices} devices online. ${needsAttention} device(s) require attention (${offlineCount} offline, ${maintCount} in maintenance). OS distribution: ${Object.entries(osCounts).map(([os, c]) => `${os} (${c})`).join(', ') || 'N/A'}.`,
      type: 'risk',
      confidence: fleetConfidence,
      recommendation: riskLevel === 'high'
        ? `Critical: ${needsAttention} devices need immediate attention. Prioritize ${offlineCount} offline devices for diagnosis. Consider deploying backup devices for employees affected by maintenance units.`
        : `Monitor ${offlineCount} offline device(s) and schedule maintenance for ${maintCount} device(s). Proactively update agent versions on all devices to prevent future issues.`,
      category: 'organization',
    });

    const catTotals: Record<string, number> = {};
    const typeTotals: Record<string, number> = {};
    recentActivities.forEach((a) => {
      const cat = a.category || 'uncategorized';
      catTotals[cat] = (catTotals[cat] || 0) + a.duration;
      typeTotals[a.type] = (typeTotals[a.type] || 0) + a.duration;
    });

    const totalDuration = Object.values(catTotals).reduce((s, v) => s + v, 0);
    const productivePct = totalDuration > 0 ? ((catTotals['productive'] || 0) / totalDuration) * 100 : 0;
    const unproductivePct = totalDuration > 0 ? ((catTotals['unproductive'] || 0) / totalDuration) * 100 : 0;

    const opportunityScore = 100 - productivePct;
    const topActivityTypes = Object.entries(typeTotals)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([type, dur]) => `${type} (${Math.round(dur / 3600)}h)`);

    insights.push({
      title: 'Activity Pattern Optimization',
      content: `Recent activity shows ${Math.round(productivePct)}% productive, ${Math.round(unproductivePct)}% unproductive, and ${Math.round(100 - productivePct - unproductivePct)}% neutral time. Top activity types: ${topActivityTypes.join(', ')}. There is a ${Math.round(opportunityScore)}% opportunity window to convert neutral/idle time into productive work.`,
      type: 'opportunity',
      confidence: Math.min(0.95, 0.45 + Math.min(1, recentActivities.length / 500) * 0.45),
      recommendation: `Implement structured break scheduling to reduce unproductive time. Introduce focus-time blocks for top activity types (${topActivityTypes[0] || 'applications'}) and consider app usage policies to minimize distractions during core working hours.`,
      category: 'organization',
    });

    return NextResponse.json({
      // Backward-compatible rule-based array (label it as such in the UI).
      data: insights,
      // Real AI analysis + measured stats.
      measured: result.measured,
      ai: result.ai,
      // Unified analysis contract: mode AI_ANALYSIS or DATA_SUMMARY — the
      // dataset-backed fallback keeps the Insights experience alive whenever
      // the AI provider is unavailable/disabled/failing.
      analysis: result.analysis,
      meta: result.meta,
      rules: {
        generatedAt: new Date().toISOString(),
        period: { start: f.periodStart.toISOString(), end: f.periodEnd.toISOString() },
        filters: {
          employeeId: f.employeeId ?? null,
          departmentId: f.departmentId ?? null,
          projectId: f.projectId ?? null,
        },
      },
    });
  } catch (error) {
    console.error('AI Analysis GET error:', error);
    return NextResponse.json({ error: 'Failed to generate AI analysis' }, { status: 500 });
  }
}

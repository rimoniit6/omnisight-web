'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

export async function GET(req: NextRequest) {
  try {
    // Tenant isolation: sentiment summaries are organization-scoped from the
    // verified session — never queried globally.
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) {
      return NextResponse.json({
        averageScore: 0,
        moodDistribution: { positive: 0, neutral: 0, negative: 0, critical: 0 },
        departmentBreakdown: [],
        topAtRisk: [],
        topPositive: [],
        riskFactorDistribution: {},
        totalRecords: 0,
      });
    }
    const orgId = scope.organizationId;

    // All historical rows for the org are loaded once and collapsed to the
    // latest-per-employee set below. This endpoint is only consumed by
    // dashboard widgets (not per-employee lists), so the load is bounded by
    // org size; no page-request pagination applies.
    // Employee-level records only (projectId IS NULL) — project-scoped
    // sentiment is surfaced in the project context, never in the org-wide
    // summary.
    const records = await db.sentimentRecord.findMany({
      where: { employee: { organizationId: orgId }, projectId: null },
      include: {
        employee: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            designation: true,
            employeeId: true,
            avatar: true,
            department: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (records.length === 0) {
      return NextResponse.json({
        averageScore: 0,
        moodDistribution: { positive: 0, neutral: 0, negative: 0, critical: 0 },
        departmentBreakdown: [],
        topAtRisk: [],
        topPositive: [],
        riskFactorDistribution: {},
        totalRecords: 0,
      });
    }

    // Average score — no-data records (score NULL) are not scored and must
    // never drag the average down to a fabricated neutral.
    const scored = records.filter((r) => r.score !== null);
    const totalScore = scored.reduce((sum, r) => sum + (r.score ?? 0), 0);
    const averageScore = scored.length > 0 ? Math.round((totalScore / scored.length) * 10) / 10 : 0;

    // Mood distribution + department breakdown share the latest-per-employee
    // set (statistics must never be inflated by duplicate runs).
    const latestByEmployee = new Map<string, (typeof records)[0]>();
    for (const r of records) {
      const existing = latestByEmployee.get(r.employeeId);
      if (!existing || r.createdAt > existing.createdAt) {
        latestByEmployee.set(r.employeeId, r);
      }
    }

    const moodDistribution: Record<string, number> = {
      positive: 0,
      neutral: 0,
      negative: 0,
      critical: 0,
      'no-data': 0,
    };
    for (const r of latestByEmployee.values()) {
      if (moodDistribution[r.mood] !== undefined) moodDistribution[r.mood]++;
    }

    const deptMap: Record<string, { name: string; scores: number[]; count: number }> = {};
    for (const r of latestByEmployee.values()) {
      const deptId = r.employee.department?.id || 'unassigned';
      const deptName = r.employee.department?.name || 'Unassigned';
      if (!deptMap[deptId]) {
        deptMap[deptId] = { name: deptName, scores: [], count: 0 };
      }
      deptMap[deptId].count++;
      // No-data employees are members of the department but were never
      // scored — they must not pollute the department average.
      if (r.score !== null) deptMap[deptId].scores.push(r.score);
    }

    const departmentBreakdown = Object.entries(deptMap)
      .map(([id, d]) => ({
        departmentId: id,
        departmentName: d.name,
        averageScore: d.scores.length > 0 ? Math.round((d.scores.reduce((a, b) => a + b, 0) / d.scores.length) * 10) / 10 : null,
        employeeCount: d.count,
      }))
      .sort((a, b) => (a.averageScore ?? 100) - (b.averageScore ?? 100));

    // Top 5 at-risk (lowest score) — no-data records have no score and are
    // never ranked as at-risk.
    const scoredLatest = [...latestByEmployee.values()].filter((r) => r.score !== null);
    const sorted = scoredLatest.sort(
      (a, b) => (a.score ?? 0) - (b.score ?? 0)
    );
    const topAtRisk = sorted.slice(0, 5).map((r) => ({
      id: r.id,
      employeeId: r.employee.id,
      employeeName: `${r.employee.firstName} ${r.employee.lastName}`,
      designation: r.employee.designation,
      department: r.employee.department?.name || null,
      score: r.score,
      mood: r.mood,
      riskFactors: r.riskFactors,
      insight: r.insight,
    }));

    // Top 5 most positive (highest score)
    const topPositive = sorted
      .slice(-5)
      .reverse()
      .map((r) => ({
        id: r.id,
        employeeId: r.employee.id,
        employeeName: `${r.employee.firstName} ${r.employee.lastName}`,
        designation: r.employee.designation,
        department: r.employee.department?.name || null,
        score: r.score,
        mood: r.mood,
      }));

    // Risk factor distribution (latest per employee only)
    const riskFactorDistribution: Record<string, number> = {};
    for (const r of latestByEmployee.values()) {
      try {
        const risks = JSON.parse(r.riskFactors || '[]') as string[];
        for (const risk of risks) {
          riskFactorDistribution[risk] =
            (riskFactorDistribution[risk] || 0) + 1;
        }
      } catch {
        // skip
      }
    }

    return NextResponse.json({
      averageScore,
      moodDistribution,
      departmentBreakdown,
      topAtRisk,
      topPositive,
      riskFactorDistribution,
      // Latest-per-employee count — consistent with every other stat in this
      // payload (never inflated by duplicate runs of the same window).
      totalRecords: latestByEmployee.size,
    });
  } catch (error) {
    log.error('api.sentiment.summary.', { error: String('Sentiment summary error:') }, requestContext(req));
    return NextResponse.json(
      { error: 'Failed to fetch sentiment summary' },
      { status: 500 }
    );
  }
}

'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

const ALLOWED_MOODS = ['positive', 'neutral', 'negative', 'critical', 'no-data'];
const ALLOWED_SORTS = ['score_desc', 'score_asc', 'name_asc', 'newest'];

export async function GET(req: NextRequest) {
  try {
    // Tenant isolation: sentiment records are organization-scoped from the
    // verified session — never from client input. Org-less super_admins get
    // an empty payload (bootstrap state).
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) {
      return NextResponse.json({
        records: [], total: 0, page: 1, pageSize: 10, totalPages: 0,
        stats: { avgScore: 0, positiveCount: 0, negativeCount: 0, criticalCount: 0, neutralCount: 0, noDataCount: 0, burnoutRiskCount: 0, totalAnalyzed: 0, moodDistribution: [] },
        departments: [],
      });
    }
    const orgId = scope.organizationId;

    // ── Query param validation (invalid input → 400, never a 500) ──
    const { searchParams } = new URL(req.url);
    const mood = searchParams.get('mood') || '';
    const departmentId = searchParams.get('departmentId') || '';
    const search = searchParams.get('search') || '';
    const sort = searchParams.get('sort') || 'newest';
    const pageRaw = searchParams.get('page') || '1';
    const pageSizeRaw = searchParams.get('pageSize') || '10';

    const page = Number(pageRaw);
    const pageSize = Number(pageSizeRaw);
    if (!Number.isInteger(page) || page < 1) {
      return NextResponse.json({ error: 'page must be an integer >= 1' }, { status: 400 });
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return NextResponse.json({ error: 'pageSize must be an integer between 1 and 100' }, { status: 400 });
    }
    if (mood && !ALLOWED_MOODS.includes(mood)) {
      return NextResponse.json({ error: 'Invalid mood filter' }, { status: 400 });
    }
    if (!ALLOWED_SORTS.includes(sort)) {
      return NextResponse.json({ error: 'Invalid sort value' }, { status: 400 });
    }
    if (departmentId && departmentId.length > 64) {
      return NextResponse.json({ error: 'Invalid departmentId' }, { status: 400 });
    }
    if (search.length > 100) {
      return NextResponse.json({ error: 'search must be at most 100 characters' }, { status: 400 });
    }

    // ── Dedup: one (latest) record per employee ──
    // Re-runs create one row per employee per period; stats and the list must
    // reflect the LATEST analysis of each employee, never every historical
    // row (which inflated counts before). Ordering by createdAt desc + first
    // occurrence per employee yields the newest record for each.
    //
    // NOTE (performance tradeoff): the full org history is loaded here so the
    // dedup/filter/sort/stats can run server-side over the COMPLETE dataset
    // (C4 correctness). A true SQL-level "latest per employee" (window
    // function / distinct-on) would avoid the in-memory pass; the existing
    // [employeeId] and [organizationId] indexes keep the per-org fetch
    // bounded, and no speculative index was added.
    // EMPLOYEE-LEVEL records only (projectId IS NULL): the org-wide grid is
    // the employee sentiment surface. Project-scoped sentiment rows live in
    // the project context (GET /api/projects/[id]/sentiment) and must not
    // appear here, where they would be presented without their project
    // context.
    const allRecords = await db.sentimentRecord.findMany({
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
            status: true,
            departmentId: true,
            department: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const latestByEmployee = new Map<string, (typeof allRecords)[number]>();
    for (const r of allRecords) {
      if (!latestByEmployee.has(r.employeeId)) latestByEmployee.set(r.employeeId, r);
    }
    let records = [...latestByEmployee.values()];

    // ── Filters (server-side; the UI never truncates a client copy) ──
    if (mood) records = records.filter((r) => r.mood === mood);
    if (departmentId) records = records.filter((r) => r.employee.departmentId === departmentId);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      records = records.filter((r) =>
        r.employee.firstName.toLowerCase().includes(q) ||
        r.employee.lastName.toLowerCase().includes(q) ||
        r.employee.employeeId.toLowerCase().includes(q)
      );
    }

    // ── Sort (null scores always last) ──
    switch (sort) {
      case 'score_desc':
        records.sort((a, b) => {
          if (a.score === null) return 1;
          if (b.score === null) return -1;
          return b.score - a.score;
        });
        break;
      case 'score_asc':
        records.sort((a, b) => {
          if (a.score === null) return 1;
          if (b.score === null) return -1;
          return a.score - b.score;
        });
        break;
      case 'name_asc':
        records.sort((a, b) => {
          const na = `${a.employee.firstName} ${a.employee.lastName}`.toLowerCase();
          const nb = `${b.employee.firstName} ${b.employee.lastName}`.toLowerCase();
          return na.localeCompare(nb);
        });
        break;
      default:
        // newest: already ordered by createdAt desc
        break;
    }

    const total = records.length;
    const skip = (page - 1) * pageSize;
    const pageRecords = records.slice(skip, skip + pageSize);

    // ── Aggregate stats over the deduped latest-per-employee set ──
    const moodDist: Record<string, number> = { positive: 0, neutral: 0, negative: 0, critical: 0 };
    let totalScore = 0;
    let scoredCount = 0;
    let noDataCount = 0;
    const riskFactorCounts: Record<string, number> = {};
    let burnoutCount = 0;

    for (const r of records) {
      if (moodDist[r.mood] !== undefined) moodDist[r.mood]++;
      if (r.mood === 'no-data' || r.score === null) {
        noDataCount++;
        continue;
      }
      totalScore += r.score!;
      scoredCount++;

      try {
        const risks = JSON.parse(r.riskFactors || '[]') as string[];
        for (const risk of risks) {
          riskFactorCounts[risk] = (riskFactorCounts[risk] || 0) + 1;
          if (risk === 'burnout_risk') burnoutCount++;
        }
      } catch {
        // skip malformed JSON
      }
    }

    const avgScore = scoredCount > 0 ? totalScore / scoredCount : 0;

    // Departments for the department filter dropdown — same org scope
    const departments = await db.department.findMany({
      where: { organizationId: orgId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    return NextResponse.json({
      records: pageRecords,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      stats: {
        avgScore: Math.round(avgScore * 10) / 10,
        positiveCount: moodDist.positive,
        negativeCount: moodDist.negative,
        criticalCount: moodDist.critical,
        neutralCount: moodDist.neutral,
        noDataCount,
        burnoutRiskCount: burnoutCount,
        totalAnalyzed: records.length,
        // Array form: the SentimentPage mood bar iterates this as a list
        moodDistribution: (Object.keys(moodDist) as string[]).map((mood) => ({
          mood,
          count: moodDist[mood],
        })),
      },
      departments,
    });
  } catch (error) {
    log.error('api.sentiment.', { error: String('Sentiment GET error:') }, requestContext(req));
    return NextResponse.json(
      { error: 'Failed to fetch sentiment records' },
      { status: 500 }
    );
  }
}

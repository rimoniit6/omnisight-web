import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';

// GET /api/projects/[projectId]/sentiment
// Project-scoped sentiment records for a project.
//
// RBAC: any authenticated user in the org (viewer+) may read project
// sentiment, consistent with the other project GET routes. Cross-org project
// ids -> 404 (concealment, matching the project API convention).
//
// Contract:
//   { project, records (latest per employee), history (recent rows),
//     stats { avgScore, moodDistribution, analyzedCount, noDataCount } }

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    const { id } = await params;

    // Validate the project id shape early (defensive — the DB does the real
    // work; this just avoids pointless lookups on garbage).
    if (!id || id.length > 64) {
      return NextResponse.json({ error: 'Invalid project id' }, { status: 400 });
    }

    // Project must exist in the caller's org; cross-org ids -> 404.
    const project = await db.project.findFirst({
      where: { id, ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) },
      select: { id: true, name: true, status: true, organizationId: true },
    });
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // All project sentiment rows for this project (org is guaranteed by the
    // project FK, but scope defensively by projectId).
    const records = await db.sentimentRecord.findMany({
      where: { projectId: id },
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
        project: { id: project.id, name: project.name, status: project.status },
        records: [],
        history: [],
        stats: { avgScore: null, moodDistribution: [], analyzedCount: 0, noDataCount: 0 },
      });
    }

    // Latest record per employee (project-scoped).
    const latestByEmployee = new Map<string, (typeof records)[number]>();
    for (const r of records) {
      if (!latestByEmployee.has(r.employeeId)) latestByEmployee.set(r.employeeId, r);
    }
    const latest = [...latestByEmployee.values()];

    // Recent history (across all employees) — bounded to the last 12 rows for
    // the trend view; the full history is not exposed unbounded.
    const history = records.slice(0, 12);

    // Aggregates over the latest-per-employee set (never double-counted by
    // duplicate period runs).
    const moodDistribution: Record<string, number> = {};
    let scored = 0;
    let scoreSum = 0;
    let noDataCount = 0;
    for (const r of latest) {
      moodDistribution[r.mood] = (moodDistribution[r.mood] || 0) + 1;
      if (r.score === null) {
        noDataCount++;
      } else {
        scored++;
        scoreSum += r.score;
      }
    }

    return NextResponse.json({
      project: { id: project.id, name: project.name, status: project.status },
      records: latest,
      history,
      stats: {
        avgScore: scored > 0 ? Math.round((scoreSum / scored) * 10) / 10 : null,
        moodDistribution: Object.entries(moodDistribution).map(([mood, count]) => ({ mood, count })),
        analyzedCount: latest.length,
        noDataCount,
      },
    });
  } catch (error) {
    console.error('Project sentiment GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch project sentiment' }, { status: 500 });
  }
}

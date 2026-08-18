import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getScopedEmployee } from '@/lib/self-guard';

// GET /api/self/projects?employeeId=xxx
// Manager+ role (enforced by the proxy); employee scoped to caller's org.
//
// Returns ONLY the projects the employee is actively assigned to (member with
// leftAt = null). Other employees' projects never appear. Each project
// carries the employee's role, total logged hours, and — when a project
// sentiment record exists — the latest score/mood so My Portal can show
// "Sentiment available".
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const employeeId = searchParams.get('employeeId');

    if (!employeeId) {
      return NextResponse.json({ error: 'employeeId is required' }, { status: 400 });
    }

    // Tenant-scoped lookup: employee must belong to the caller's org.
    const { employee: scoped, error: scopeError } = await getScopedEmployee(req, employeeId);
    if (scopeError || !scoped) {
      return NextResponse.json({ error: scopeError || 'Employee not found' }, { status: 404 });
    }

    // Active memberships only — projects the employee is currently assigned to.
    const memberships = await db.projectMember.findMany({
      where: { employeeId: scoped.id, leftAt: null },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            status: true,
            priority: true,
            deadline: true,
            color: true,
            estimatedHours: true,
            organizationId: true,
          },
        },
      },
      orderBy: { joinedAt: 'asc' },
    });

    if (memberships.length === 0) {
      return NextResponse.json({ data: [] });
    }

    const projectIds = memberships.map((m) => m.projectId);

    // Total hours per project (TimeEntry is the project-scoped source).
    const hoursByProject = await db.timeEntry.groupBy({
      by: ['projectId'],
      where: { projectId: { in: projectIds }, employeeId: scoped.id },
      _sum: { hours: true },
    });
    const hoursMap = new Map(hoursByProject.map((h) => [h.projectId, h._sum.hours || 0]));

    // Latest project-scoped sentiment per (project, employee).
    const sentimentRows = await db.sentimentRecord.findMany({
      where: { projectId: { in: projectIds }, employeeId: scoped.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        projectId: true,
        score: true,
        mood: true,
        aiProviderUsed: true,
        periodStart: true,
        periodEnd: true,
        createdAt: true,
      },
    });
    const latestSentimentByProject = new Map<string, (typeof sentimentRows)[number]>();
    for (const s of sentimentRows) {
      if (s.projectId && !latestSentimentByProject.has(s.projectId)) latestSentimentByProject.set(s.projectId, s);
    }

    const data = memberships.map((m) => ({
      projectId: m.projectId,
      project: m.project,
      role: m.role,
      hoursPerWeek: m.hoursPerWeek,
      totalHours: hoursMap.get(m.projectId) || 0,
      sentiment: latestSentimentByProject.get(m.projectId) ?? null,
    }));

    return NextResponse.json({ data });
  } catch (error) {
    console.error('Self projects GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch assigned projects' }, { status: 500 });
  }
}

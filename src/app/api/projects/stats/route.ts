import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { authError, requireSessionOrg } from '@/lib/api';

export async function GET(req: NextRequest) {
  try {
    // Authenticated + org-scoped stats (previously only checked the session
    // existed — every aggregate below was computed across ALL organizations).
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    const projectOrgFilter: Prisma.ProjectWhereInput = scope.organizationId
      ? { organizationId: scope.organizationId }
      : {};
    const timeOrgFilter = scope.organizationId ? { organizationId: scope.organizationId } : {};
    const memberOrgFilter = scope.organizationId ? { organizationId: scope.organizationId } : {};

    // Current month boundaries
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    monthStart.setHours(0, 0, 0, 0);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    // Current week boundaries (Monday-Sunday)
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - mondayOffset);
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const [
      statusCounts,
      monthlyHours,
      topProjectsThisWeek,
      activeProjectIds,
      overdueProjects,
      budgetUtilization,
    ] = await Promise.all([
      // 1. Total projects by status
      db.project.groupBy({
        by: ['status'],
        where: projectOrgFilter,
        _count: { id: true },
      }),

      // 2. Total hours across all projects this month
      db.timeEntry.aggregate({
        where: { date: { gte: monthStart, lte: monthEnd }, ...timeOrgFilter },
        _sum: { hours: true },
      }),

      // 3. Top 5 projects by hours this week
      db.timeEntry.groupBy({
        by: ['projectId'],
        where: { date: { gte: weekStart, lte: weekEnd }, ...timeOrgFilter },
        _sum: { hours: true },
        orderBy: { _sum: { hours: 'desc' } },
        take: 5,
      }),

      // 4. All active project IDs (for employee workload)
      db.project.findMany({
        where: { status: 'active', ...projectOrgFilter },
        select: { id: true },
      }),

      // 5. Overdue projects
      db.project.findMany({
        where: {
          status: 'active',
          deadline: { lt: now },
          ...projectOrgFilter,
        },
        select: {
          id: true, name: true, deadline: true, priority: true,
          _count: { select: { members: true } },
        },
      }),

      // 6. Budget utilization: estimated vs actual hours per project
      db.project.findMany({
        where: { status: { in: ['active', 'on_hold'] }, ...projectOrgFilter },
        select: { id: true, name: true, estimatedHours: true, budgetType: true, hourlyRate: true },
      }),
    ]);

    // Build status counts map
    const byStatus: Record<string, number> = {};
    statusCounts.forEach((s) => { byStatus[s.status] = s._count.id; });

    // Enrich top projects with names
    const topProjectIds = topProjectsThisWeek.map((p) => p.projectId);
    const topProjectNames = topProjectIds.length > 0
      ? await db.project.findMany({
          where: { id: { in: topProjectIds }, ...projectOrgFilter },
          select: { id: true, name: true, color: true },
        })
      : [];
    const projectNameMap = new Map(topProjectNames.map((p) => [p.id, p]));

    const topProjects = topProjectsThisWeek.map((p) => ({
      projectId: p.projectId,
      name: projectNameMap.get(p.projectId)?.name || 'Unknown',
      color: projectNameMap.get(p.projectId)?.color || '#10b981',
      hoursThisWeek: p._sum.hours || 0,
    }));

    // Employee workload: how many active projects each active employee is on
    const activeProjectIdList = activeProjectIds.map((p) => p.id);
    let employeeWorkload: Array<{
      employeeId: string;
      firstName: string;
      lastName: string;
      avatar: string | null;
      projectCount: number;
      totalWeeklyHours: number;
    }> = [];

    if (activeProjectIdList.length > 0) {
      const memberships = await db.projectMember.findMany({
        where: { projectId: { in: activeProjectIdList }, leftAt: null, ...memberOrgFilter },
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, avatar: true, status: true } },
        },
      });

      // Group by employee, only active employees
      const empMap = new Map<string, { emp: typeof memberships[0]['employee']; projects: number; weeklyHours: number }>();
      memberships.forEach((m) => {
        if (m.employee.status !== 'active') return;
        const existing = empMap.get(m.employeeId);
        if (existing) {
          existing.projects += 1;
          existing.weeklyHours += m.hoursPerWeek;
        } else {
          empMap.set(m.employeeId, { emp: m.employee, projects: 1, weeklyHours: m.hoursPerWeek });
        }
      });

      employeeWorkload = Array.from(empMap.entries()).map(([employeeId, val]) => ({
        employeeId,
        firstName: val.emp.firstName,
        lastName: val.emp.lastName,
        avatar: val.emp.avatar,
        projectCount: val.projects,
        totalWeeklyHours: val.weeklyHours,
      })).sort((a, b) => b.projectCount - a.projectCount);
    }

    // Budget utilization: compute actual hours per project
    const budgetProjectIds = budgetUtilization.map((p) => p.id);
    const actualHours = budgetProjectIds.length > 0
      ? await db.timeEntry.groupBy({
          by: ['projectId'],
          where: { projectId: { in: budgetProjectIds }, ...timeOrgFilter },
          _sum: { hours: true },
        })
      : [];
    const actualHoursMap = new Map(actualHours.map((h) => [h.projectId, h._sum.hours || 0]));

    const budgetData = budgetUtilization.map((p) => {
      const actual = actualHoursMap.get(p.id) || 0;
      const utilization = p.estimatedHours > 0
        ? Math.round((actual / p.estimatedHours) * 100)
        : 0;
      return {
        projectId: p.id,
        name: p.name,
        budgetType: p.budgetType,
        hourlyRate: p.hourlyRate,
        estimatedHours: p.estimatedHours,
        actualHours: actual,
        utilizationPercent: Math.min(utilization, 999),
        remainingHours: Math.max(p.estimatedHours - actual, 0),
      };
    });

    return NextResponse.json({
      data: {
        byStatus,
        totalMonthlyHours: monthlyHours._sum.hours || 0,
        topProjectsThisWeek: topProjects,
        employeeWorkload,
        overdueProjects: overdueProjects.map((p) => ({
          ...p,
          memberCount: p._count.members,
          _count: undefined,
        })),
        budgetUtilization: budgetData,
      },
    });
  } catch (error) {
    console.error('Project stats GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch project stats' }, { status: 500 });
  }
}
